"""SAC Multi Actions client.

Uses the SAP Analytics Cloud REST API to:
    • trigger a multi action   (POST /multiActions/{id}/executions)
    • poll execution status    (GET  /multiActions/{id}/executions/{execId})
    • cancel a running action  (DELETE /multiActions/{id}/executions/{execId})

Auth flow – two modes:

**Direct (client_credentials)**
    1. Obtain OAuth2 access token (client_credentials)
    2. Fetch CSRF token via GET /api/v1/csrf
    3. Use Bearer + CSRF for calls

    Works for read-only endpoints (Resources, stories, dataimport, …)
    but the ``/multiActions/…/executions`` endpoint returns 500 because
    it requires a **user context**.

**BTP Destination Service (SAML2.0 Bearer – user propagation)**
    As documented in the SAP blog "Use BTP destination service to call
    SAC multi-actions API":
    1. A BTP user JWT (from the incoming request) is forwarded to the
       BTP Destination Service together with a destination configured
       for ``OAuth2SAMLBearerAssertion``.
    2. The Destination Service exchanges the JWT for a SAC access-token
       that carries the propagated user identity.
    3. That token is used for CSRF + REST calls → ``/multiActions``
       works because SAC sees a real user.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Set
from urllib.parse import quote

import requests

from ..base import BaseJobClient, IntegrationType, JobReference, JobStatus

if TYPE_CHECKING:
    from .destination import DestinationClient

logger = logging.getLogger(__name__)

_TOKEN_PATH = "/api/v1/csrf"
_MULTIACTION_PATH = "/api/v1/multiActions"

# Patterns for step-level log error messages (SAC code 580000002)
_RE_NO_HIERARCHY = re.compile(
    r"No hierarchy was provided for parameter ['\"](.+?)['\"]", re.IGNORECASE
)
_RE_MEMBER_MISSING = re.compile(
    r"Member .+? (?:does not exist|is hidden) for parameter ['\"](.+?)['\"]", re.IGNORECASE
)


def _parse_sac_execution_errors(detail: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Extract validation errors from a SAC execution result detail dict.

    Handles two error structures that SAC uses:

    1. ``messages[].details[].parameterId`` — parameter-level validation errors
       (codes 501000509 "no input value", 501000516 "no members defined").
       Appear when a required parameter is missing/empty.

    2. ``messages[].details[].logs[].message`` — step-level execution errors
       (code 580000002 "run failed with step errors").
       Appear when a parameter *value* is provided but semantically wrong:
       "No hierarchy was provided for parameter 'X'"
       "Member 'X' does not exist or is hidden for parameter 'Y'"

    Results are deduplicated by normalized parameter ID (case-insensitive,
    ignoring spaces and underscores) — SAC sometimes emits the same error
    multiple times with slightly different identifier formats across codes
    501000509 / 502001002 / 580000002.
    """

    def _norm(s: str) -> str:
        return re.sub(r"[\s_]", "", s).lower()

    seen: Dict[str, bool] = {}  # normalised pid → already emitted
    errors: List[Dict[str, Any]] = []

    messages = (detail.get("executionResult") or {}).get("messages", [])
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        code = str(msg.get("code") or "")
        msg_text = msg.get("message") or ""
        for d in (msg.get("details") or []):
            if not isinstance(d, dict):
                continue
            # Type 1: parameterId directly in the detail object
            pid = d.get("parameterId") or ""
            if pid:
                norm = _norm(pid)
                if norm not in seen:
                    seen[norm] = True
                    errors.append({
                        "parameterId": pid,
                        "message": msg_text,
                        "code": code,
                        "needsHierarchyId": code == "501000516",
                    })
                continue
            # Type 2: nested log messages with free-text error descriptions
            for log_entry in (d.get("logs") or []):
                if not isinstance(log_entry, dict):
                    continue
                log_msg = (log_entry.get("message") or "").strip()
                if not log_msg:
                    continue
                # Remove step prefix "(StepName): " if present
                clean_msg = re.sub(r"^\([^)]+\):\s*", "", log_msg)
                m = _RE_NO_HIERARCHY.search(log_msg)
                if m:
                    norm = _norm(m.group(1))
                    if norm not in seen:
                        seen[norm] = True
                        errors.append({
                            "parameterId": m.group(1),
                            "message": clean_msg,
                            "code": code,
                            "needsHierarchyId": True,
                        })
                    continue
                m = _RE_MEMBER_MISSING.search(log_msg)
                if m:
                    norm = _norm(m.group(1))
                    if norm not in seen:
                        seen[norm] = True
                        errors.append({
                            "parameterId": m.group(1),
                            "message": clean_msg,
                            "code": code,
                            "needsHierarchyId": False,
                        })
    return errors


def _extract_params_from_error(body: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Try to infer parameter IDs from a SAC validation-error response body.

    SAC uses several error shapes depending on API version; we try all of them:

    Shape A – ``details`` array with ``parameter`` or ``field`` keys::

        {"errorCode": "...", "details": [{"parameter": "TargetVersion", ...}, ...]}

    Shape B – ``parameterValues`` or ``parameters`` array in the error::

        {"error": {"parameterValues": [{"parameterId": "X"}, ...]}}

    Shape C – flat message text ``"... parameter 'X' ..."`` (regex fallback)
    """
    found: Dict[str, Dict[str, Any]] = {}  # id → entry

    def _add(param_id: str, label: str = "", mandatory: bool = True) -> None:
        if param_id and param_id not in found:
            found[param_id] = {"id": param_id, "label": label or param_id, "mandatory": mandatory}

    def _walk(node: Any) -> None:
        if isinstance(node, dict):
            # Shape A: explicit parameter/field keys
            pid = (
                node.get("parameter") or node.get("parameterId") or
                node.get("field") or node.get("fieldName") or ""
            )
            if pid:
                label = node.get("description") or node.get("message") or node.get("label") or ""
                _add(str(pid), str(label))
            # Recurse into all values
            for v in node.values():
                _walk(v)
        elif isinstance(node, list):
            for item in node:
                _walk(item)

    _walk(body)

    # Shape C: regex scan of the full serialised body for quoted/apostrophed names
    if not found:
        text = json.dumps(body)
        for match in re.finditer(
            r"[Pp]arameter[sS]?\s*['\"]([A-Za-z0-9_\-.]+)['\"]", text
        ):
            _add(match.group(1))

    return list(found.values())


def _build_parameter_values(run_params: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Convert a flat ``{parameterId: value}`` dict into SAC's
    ``parameterValues`` array: ``[{"parameterId": ..., "value": ...}]``.

    String values that look like JSON (e.g.
    ``{"memberIds": [...], "hierarchyId": "..."}``) are parsed as-is, so
    parameters with a non-default ``hierarchyId`` (e.g. time dimensions)
    can be supplied as JSON text.

    Plain (non-JSON) string values are wrapped into SAC's dimension-member
    shape ``{"memberIds": [value], "hierarchyId": None}``, since most multi
    action parameters (versions, legal entities, profit centers, ...) expect
    that object rather than a bare string, and the step-execution validation
    expects the ``hierarchyId`` key to be present (even if ``null``) -
    omitting it entirely causes "No hierarchy was provided" errors.
    Parameters that need a specific (non-null) ``hierarchyId`` (e.g. ``Date``,
    ``FunctionalArea``) can be supplied as JSON text, e.g.
    ``{"memberIds": ["202502"], "hierarchyId": "YQM"}``.
    """
    parameter_values: List[Dict[str, Any]] = []
    for parameter_id, value in (run_params or {}).items():
        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                continue
            if stripped[0] in "{[":
                try:
                    value = json.loads(stripped)
                except ValueError:
                    value = {"memberIds": [stripped], "hierarchyId": None}
            elif stripped == "*":
                value = {"memberIds": [{"memberType": "AllMember"}], "hierarchyId": "parentId"}
            else:
                value = {"memberIds": [stripped], "hierarchyId": None}

        if not isinstance(value, dict):
            continue

        member_ids = value.get("memberIds") or []
        hierarchy = value.get("hierarchyId") or value.get("hierarchy") or None

        # All-Members: SAC expects {"memberIds": [{"memberType": "AllMember"}], "hierarchyId": "parentId"}
        # Triggered by: type="All", memberIds=["*"], or bare "*" value already handled above.
        if value.get("type") == "All" or member_ids == ["*"]:
            parameter_values.append({
                "parameterId": parameter_id,
                "value": {"memberIds": [{"memberType": "AllMember"}], "hierarchyId": hierarchy or "parentId"},
            })
            continue

        # If memberIds already contains {"memberType":"AllMember"} pass through as-is
        parameter_values.append({"parameterId": parameter_id, "value": value})
    return parameter_values


class _SACSession:
    """Manages OAuth2 token + CSRF for SAC REST calls.

    Supports two token-acquisition strategies:
      • **direct** – client_credentials grant (default, no user context)
      • **destination** – BTP Destination Service SAML Bearer (user propagation)

    When a ``DestinationClient`` is provided, the destination path is used
    and requires a BTP user JWT from the current Flask request.
    """

    def __init__(
        self,
        host: str,
        token_url: str,
        client_id: str,
        client_secret: str,
        *,
        destination_client: Optional["DestinationClient"] = None,
        verify_ssl: bool = True,
    ):
        self._host = host.rstrip("/")
        self._token_url = token_url
        self._client_id = client_id
        self._client_secret = client_secret
        self._destination_client = destination_client
        self._verify = verify_ssl

        self._session = requests.Session()
        self._session.verify = verify_ssl
        self._access_token: Optional[str] = None
        self._token_expiry: float = 0
        self._csrf_token: Optional[str] = None
        self._last_user_jwt: Optional[str] = None
        # JWT injected explicitly when running outside Flask request context (e.g. background threads)
        self._override_jwt: Optional[str] = None

    def set_user_jwt(self, jwt: Optional[str]) -> None:
        """Override the JWT used for SAML Bearer token exchange.

        Use this when calling SAC methods from a background thread that has no
        Flask request context.  Pass ``None`` to revert to the dynamic lookup.
        """
        self._override_jwt = jwt

    # ------------------------------------------------------------------
    # Token acquisition
    # ------------------------------------------------------------------

    @staticmethod
    def _get_user_jwt() -> Optional[str]:
        """Extract the caller's BTP JWT from the current Flask request."""
        try:
            from flask import has_request_context, request as flask_request

            if has_request_context():
                auth = flask_request.headers.get("Authorization", "")
                if auth.startswith("Bearer "):
                    return auth[7:]
        except ImportError:
            pass
        return None

    def _ensure_access_token(self) -> str:
        """Return a valid SAC access token, refreshing if needed.

        Prefers the Destination Service path when available.
        In pure user-propagation mode, a caller JWT is required.
        """
        # ------ destination (SAML Bearer) path ------
        if self._destination_client:
            user_jwt = self._override_jwt or self._get_user_jwt()
            if not user_jwt:
                raise RuntimeError(
                    "SAC destination requires an authenticated user context "
                    "for user propagation"
                )
            return self._ensure_token_via_destination(user_jwt)

        # ------ direct client_credentials path ------
        if self._access_token and time.time() < self._token_expiry:
            return self._access_token

        resp = requests.post(
            self._token_url,
            data={"grant_type": "client_credentials"},
            auth=(self._client_id, self._client_secret),
            verify=self._verify,
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        self._access_token = data["access_token"]
        self._token_expiry = time.time() + int(data.get("expires_in", 3600)) - 60
        self._session.headers.update({"Authorization": f"Bearer {self._access_token}"})
        self._csrf_token = None  # new token → CSRF must be re-fetched
        self._last_user_jwt = None
        return self._access_token

    def _ensure_token_via_destination(self, user_jwt: Optional[str] = None) -> str:
        """Get a SAC token through the BTP Destination Service (SAML Bearer).

        The caller JWT is forwarded as ``X-user-token`` so the Destination
        Service can perform SAML Bearer user propagation.
        """
        # Invalidate cache when the calling user changes
        if user_jwt != self._last_user_jwt:
            self._access_token = None
            self._token_expiry = 0

        if self._access_token and time.time() < self._token_expiry:
            return self._access_token

        mode = f"user_jwt propagation (user={user_jwt[:20]}...)"
        logger.debug(f"SAC: exchanging token via BTP Destination ({mode})")
        token_data = self._destination_client.get_sac_token(user_jwt)
        self._access_token = token_data["access_token"]
        self._token_expiry = (
            time.time() + int(token_data.get("expires_in", 3600)) - 60
        )
        self._session.headers.update({"Authorization": f"Bearer {self._access_token}"})
        self._csrf_token = None
        self._last_user_jwt = user_jwt
        logger.info(f"SAC token obtained via BTP Destination Service ({mode})")
        return self._access_token

    def _fetch_csrf(self) -> str:
        self._ensure_access_token()
        resp = self._session.get(
            f"{self._host}{_TOKEN_PATH}",
            headers={"x-csrf-token": "Fetch"},
            timeout=30,
        )
        resp.raise_for_status()
        token = resp.headers.get("x-csrf-token", "").strip()
        if not token:
            raise RuntimeError("SAC: failed to obtain CSRF token")
        self._csrf_token = token
        return token

    def get(self, path: str, **kwargs) -> requests.Response:
        self._ensure_access_token()
        url = f"{self._host}{path}"
        resp = self._session.get(url, timeout=60, **kwargs)
        resp.raise_for_status()
        return resp

    def post(self, path: str, **kwargs) -> requests.Response:
        self._ensure_access_token()
        if not self._csrf_token:
            self._fetch_csrf()
        url = f"{self._host}{path}"
        headers = kwargs.pop("headers", {})
        headers["x-csrf-token"] = self._csrf_token
        # SAC returns 415 if Content-Type is not explicitly application/json
        headers.setdefault("Content-Type", "application/json")
        resp = self._session.post(url, headers=headers, timeout=120, **kwargs)
        if resp.status_code == 403:
            self._fetch_csrf()
            headers["x-csrf-token"] = self._csrf_token
            resp = self._session.post(url, headers=headers, timeout=120, **kwargs)
        resp.raise_for_status()
        return resp

    def delete(self, path: str, **kwargs) -> requests.Response:
        self._ensure_access_token()
        if not self._csrf_token:
            self._fetch_csrf()
        url = f"{self._host}{path}"
        headers = kwargs.pop("headers", {})
        headers["x-csrf-token"] = self._csrf_token
        resp = self._session.delete(url, headers=headers, timeout=60, **kwargs)
        if resp.status_code == 403:
            self._fetch_csrf()
            headers["x-csrf-token"] = self._csrf_token
            resp = self._session.delete(url, headers=headers, timeout=60, **kwargs)
        resp.raise_for_status()
        return resp


class SACJobClient(BaseJobClient):
    """Concrete integration for SAC Multi Actions."""

    # Probe result cache: multiaction_id → {"parameters": [...]} or {"parameters": [], "done": True}
    # Populated by the background probe thread; avoids gateway timeouts on the first call.
    _probe_cache: Dict[str, Dict[str, Any]] = {}
    _probe_running: Set[str] = set()

    def __init__(
        self,
        host: str,
        token_url: str,
        client_id: str,
        client_secret: str,
        *,
        destination_client: Optional["DestinationClient"] = None,
        verify_ssl: bool = True,
    ):
        self._sac = _SACSession(
            host, token_url, client_id, client_secret,
            destination_client=destination_client,
            verify_ssl=verify_ssl,
        )

    @property
    def integration_type(self) -> IntegrationType:
        return IntegrationType.SAC

    # ------------------------------------------------------------------
    # BaseJobClient interface
    # ------------------------------------------------------------------

    def launch_job(self, params: Dict[str, Any]) -> JobReference:
        """Run a SAC multi action.

        Required ``params`` keys:
            • ``multiaction_id`` – technical ID  (e.g. ``t.16:9C88…``)

        Optional:
            • ``parameters``  – dict of ``{parameterId: value}`` input
              parameters for the multi action, sent as SAC's
              ``parameterValues`` array. String values that look like JSON
              (e.g. ``{"memberIds": [...], "hierarchyId": "..."}``) are
              parsed so dimension-type parameters can be passed as JSON text.
        """
        multiaction_id = params.get("multiaction_id")
        if not multiaction_id:
            raise ValueError("SAC: 'multiaction_id' is required")

        run_params = params.get("parameters", {})

        # REST endpoint as documented in the SAP blog:
        #   POST /multiActions/{id}/executions
        path = f"{_MULTIACTION_PATH}/{quote(multiaction_id, safe='.:')}/executions"

        body: Dict[str, Any] = {"parameterValues": _build_parameter_values(run_params)}
        logger.info("SAC launch_job: POST %s body=%s", path, json.dumps(body)[:500])

        try:
            resp = self._sac.post(path, json=body)
        except requests.HTTPError as e:
            body_text = e.response.text[:1000] if e.response is not None else ""
            logger.error("SAC launch_job: HTTP %s — body: %s", e.response.status_code if e.response is not None else "?", body_text)
            raise RuntimeError(f"{e} | SAC response: {body_text}") from e

        data = resp.json() if resp.content else {}
        run_id = (
            data.get("executionId")
            or data.get("runId")
            or data.get("RunId")
            or data.get("id")
            or ""
        )

        if not run_id:
            # Some SAC versions return the id in the Location header
            location = resp.headers.get("Location", "")
            if location:
                run_id = location.rstrip("/").rsplit("/", 1)[-1]

        if not run_id:
            raise RuntimeError(f"SAC MultiAction run did not return an executionId. Response: {data}")

        return JobReference(
            integration_type=IntegrationType.SAC,
            remote_id=f"{multiaction_id}:{run_id}",
            details={
                "multiaction_id": multiaction_id,
                "execution_id": run_id,
            },
        )

    def get_multiaction_definition(self, multiaction_id: str) -> Dict[str, Any]:
        """Return the raw multi action definition including parameters.

        Strategy (each step is a fallback for the previous):
        1. GET /multiActions/{id}          — standard read endpoint
        2. GET /multiActions               — list endpoint, filter by id
        3. POST /executions (empty params) — parse SAC validation error for param names
        """
        path = f"{_MULTIACTION_PATH}/{quote(multiaction_id, safe='.:')}"
        try:
            resp = self._sac.get(path)
            return resp.json() if resp.content else {}
        except Exception as e:
            if "404" not in str(e):
                raise
            logger.info(
                "SAC GET /multiActions/%s returned 404 — trying list endpoint",
                multiaction_id,
            )

        # Fallback 1: fetch the full list and find by id
        try:
            resp = self._sac.get(_MULTIACTION_PATH)
            data = resp.json() if resp.content else {}
            items = (
                data.get("value")
                or data.get("multiActions")
                or data.get("items")
                or (data if isinstance(data, list) else [])
            )
            for item in items:
                if not isinstance(item, dict):
                    continue
                item_id = (
                    item.get("id") or item.get("multiActionId") or item.get("multiaction_id") or ""
                )
                if item_id == multiaction_id:
                    return item
        except Exception as e:
            if "404" not in str(e):
                raise
            logger.info(
                "SAC list endpoint GET /multiActions also returned 404 — "
                "falling back to probe via POST executions"
            )

        # Fallback 2: probe via background thread to avoid gateway timeout.
        # Return cached result if already done; otherwise start the probe and return empty
        # so the caller can retry in a few seconds.
        if multiaction_id in self._probe_cache:
            cached = self._probe_cache[multiaction_id]
            logger.info("SAC probe: returning cached result for %s (%d params)", multiaction_id, len(cached.get("parameters") or []))
            return cached

        if multiaction_id not in self._probe_running:
            self._probe_running.add(multiaction_id)
            # Capture the JWT now (still in Flask request context); the background
            # thread won't have request context so we pass it explicitly.
            captured_jwt = self._sac._override_jwt or self._sac._get_user_jwt()
            t = threading.Thread(
                target=self._run_probe_background,
                args=(multiaction_id, captured_jwt),
                daemon=True,
            )
            t.start()
            logger.info("SAC probe: background thread started for %s — return empty for now", multiaction_id)

        # Signal to the caller that a probe is in progress so it can retry later
        return {"probing": True}

    def _run_probe_background(self, multiaction_id: str, user_jwt: Optional[str]) -> None:
        """Run the probe in a background thread and store the result in _probe_cache."""
        try:
            # Re-inject the captured JWT so the SAC session can authenticate
            self._sac.set_user_jwt(user_jwt)
            result = self._probe_multiaction_parameters(multiaction_id)
            self._probe_cache[multiaction_id] = result if result else {"parameters": [], "done": True}
        except Exception as e:
            logger.warning("SAC probe background thread failed: %s", e)
            self._probe_cache[multiaction_id] = {"parameters": [], "done": True}
        finally:
            self._probe_running.discard(multiaction_id)

    def _probe_multiaction_parameters(self, multiaction_id: str) -> Dict[str, Any]:
        """Infer parameters by running a dry-run POST with no parameterValues.

        SAC accepts the empty execution immediately (status: running), then
        quickly transitions to status: failed with validation messages that
        name every required parameter.  We poll until the execution reaches a
        terminal state, parse ``executionResult.messages[].details[].parameterId``
        and return a synthetic definition dict.
        """
        import time as _time

        exec_path = f"{_MULTIACTION_PATH}/{quote(multiaction_id, safe='.:')}/executions"
        logger.info("SAC probe: POST empty params to %s", exec_path)

        # --- 1. Launch with no parameters ----------------------------------
        try:
            resp = self._sac.post(exec_path, json={"parameterValues": []})
        except Exception as e:
            logger.warning("SAC probe POST failed: %s", e)
            return {}

        if resp.status_code not in (200, 202):
            logger.warning("SAC probe: unexpected status %s", resp.status_code)
            return {}

        exec_data = resp.json() if resp.content else {}
        exec_id = (
            exec_data.get("executionId") or exec_data.get("runId") or exec_data.get("id") or ""
        )
        if not exec_id:
            logger.warning("SAC probe: no executionId in POST response")
            return {}

        logger.info("SAC probe: execution %s started — polling for terminal state", exec_id)

        # --- 2. Poll until terminal (max 30 s, 1 s interval) ---------------
        status_path = f"{exec_path}/{exec_id}"
        detail: Dict[str, Any] = {}
        for _ in range(60):
            _time.sleep(1)
            try:
                status_resp = self._sac.get(status_path)
                detail = status_resp.json() if status_resp.content else {}
            except Exception as e:
                logger.warning("SAC probe: poll error: %s", e)
                break
            raw = (detail.get("status") or "").strip().lower()
            if raw not in ("running", "pending", "queued", ""):
                break

        logger.info(
            "SAC probe: terminal state '%s', messages: %s",
            detail.get("status"),
            json.dumps((detail.get("executionResult") or {}).get("messages", []))[:800],
        )

        # --- 3. Extract parameterId from validation messages ---------------
        # Error codes:
        #   501000509 → "no input value"        → standard param, hierarchyId can be null
        #   501000516 → "no members defined"    → hierarchyId required
        seen: Dict[str, Dict[str, Any]] = {}
        messages = (detail.get("executionResult") or {}).get("messages", [])
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            code = str(msg.get("code") or "")
            needs_hierarchy = code == "501000516"
            for d in (msg.get("details") or []):
                if not isinstance(d, dict):
                    continue
                pid = d.get("parameterId") or ""
                if not pid:
                    continue
                if pid not in seen:
                    label = pid
                    text = msg.get("message") or ""
                    m = re.search(r"parameter\s+(.+?)\s+(has|have|,)", text, re.IGNORECASE)
                    if m:
                        label = m.group(1).strip()
                    seen[pid] = {
                        "id": pid,
                        "label": label,
                        "mandatory": True,
                        "needsHierarchyId": needs_hierarchy,
                    }
                elif needs_hierarchy:
                    # A later message (501000516) upgrades the flag
                    seen[pid]["needsHierarchyId"] = True

        # --- 4. Cancel the probe execution (best-effort) -------------------
        try:
            self._sac.delete(status_path)
            logger.info("SAC probe: cancelled execution %s", exec_id)
        except Exception:
            pass

        if seen:
            logger.info("SAC probe: found %d parameter(s): %s", len(seen), list(seen.keys()))
            return {"parameters": list(seen.values())}

        logger.warning("SAC probe: execution reached '%s' but no parameterId found", detail.get("status"))
        return {}

    def validate_parameters(self, multiaction_id: str, param_values: List[Dict]) -> Dict[str, Any]:
        """POST a test execution with the provided values and return validation errors.

        Polls for up to 20 s.  If SAC rejects the execution immediately
        (status: failed) the validation errors are parsed and returned.
        If the execution succeeds (all values are valid and the multi action
        actually runs) we still return valid=True with a warning.
        If the execution is still running after 20 s we cancel it and
        return a timeout indicator.
        """
        import time as _time

        exec_path = f"{_MULTIACTION_PATH}/{quote(multiaction_id, safe='.:')}/executions"

        def _norm_pid(s: str) -> str:
            return re.sub(r"[\s_]", "", s).lower()

        sac_params: List[Dict] = []
        intentionally_skipped: set = set()  # normalised pids the user left empty/*

        for p in param_values:
            pid = p.get("key") or p.get("parameterId") or ""
            if not pid:
                continue
            raw_val = (p.get("value") or "").strip()
            hierarchy_id: Optional[str] = (p.get("hierarchyId") or "").strip() or None

            # Empty value or "*" → All Members
            if not raw_val or raw_val == "*":
                sac_params.append({
                    "parameterId": pid,
                    "value": {"memberIds": [{"memberType": "AllMember"}], "hierarchyId": hierarchy_id or "parentId"},
                })
                continue

            member_ids: List[Any] = []
            if raw_val.startswith("{"):
                try:
                    parsed = json.loads(raw_val)
                    p_type = parsed.get("type")
                    p_members = parsed.get("memberIds") or []
                    p_hier = parsed.get("hierarchyId") or parsed.get("hierarchy") or hierarchy_id
                    if p_type == "All" or p_members == ["*"]:
                        sac_params.append({
                            "parameterId": pid,
                            "value": {"memberIds": [{"memberType": "AllMember"}], "hierarchyId": p_hier or "parentId"},
                        })
                        continue
                    member_ids = p_members
                    hierarchy_id = p_hier
                except Exception:
                    member_ids = [raw_val]
            else:
                member_ids = [raw_val]

            sac_params.append({
                "parameterId": pid,
                "value": {"memberIds": member_ids, "hierarchyId": hierarchy_id},
            })

        body = {"parameterValues": sac_params}
        logger.info("SAC validate: POST %d params to %s — body: %s", len(sac_params), exec_path, json.dumps(body))
        try:
            resp = self._sac.post(exec_path, json=body)
        except Exception as e:
            return {"valid": None, "error": str(e)}

        if resp.status_code not in (200, 202):
            return {"valid": None, "error": f"SAC returned {resp.status_code}"}

        exec_data = resp.json() if resp.content else {}
        exec_id = (
            exec_data.get("executionId") or exec_data.get("runId") or exec_data.get("id") or ""
        )
        if not exec_id:
            return {"valid": None, "error": "No executionId returned by SAC"}

        status_path = f"{exec_path}/{exec_id}"
        detail: Dict[str, Any] = {}
        status = "running"

        # Poll for ~15 s only.  SAC rejects invalid parameters within 2-3 s
        # (same behaviour as the empty-param probe).  If the execution is still
        # running after 15 s the values were accepted by SAC → cancel immediately
        # so we don't trigger a real data-writing execution.
        _schedule = [3, 3, 3, 3, 3]
        for _wait in _schedule:
            _time.sleep(_wait)
            try:
                sr = self._sac.get(status_path)
                detail = sr.json() if sr.content else {}
            except Exception as e:
                logger.warning("SAC validate: poll error: %s", e)
                break
            status = (detail.get("status") or "").strip().lower()
            if status not in ("running", "pending", "queued", ""):
                break

        try:
            self._sac.delete(status_path)
            logger.info("SAC validate: cancelled execution %s (status=%s)", exec_id, status)
        except Exception:
            pass

        if status in ("running", "pending", "queued", ""):
            # Still running after 15 s → SAC accepted all parameter values
            return {"valid": True, "warning": "Parameters accepted by SAC"}

        if status in ("successful", "completed", "done"):
            return {"valid": True, "status": status,
                    "warning": "Test execution ran successfully — all parameters are valid"}

        logger.info("SAC validate: execution result raw: %s", json.dumps(detail)[:2000])
        errors = _parse_sac_execution_errors(detail)
        if errors:
            logger.info("SAC validate: %d error(s): %s", len(errors), [e["parameterId"] for e in errors])
            return {"valid": False, "errors": errors}
        return {"valid": True, "status": status}

    def get_dimension_members(self, model_id: str, dimension_id: str) -> Dict[str, Any]:
        """Fetch members of a SAC planning model dimension via the Data Export API.

        Tries:
          GET /api/v1/dataexport/providers/{modelId}/dimensions/{dimensionId}/members
          GET /api/v1/dataexport/providers/{modelId}/dimensions/{dimensionId}
        Falls back to listing providers if modelId unknown.
        """
        base = "/api/v1/dataexport/providers"
        results: Dict[str, Any] = {}

        if not model_id:
            try:
                r = self._sac.get(base)
                results["providers"] = r.json() if r.content else {}
            except Exception as e:
                results["providers_error"] = str(e)
            return results

        dim_path = f"{base}/{quote(model_id, safe='')}/dimensions/{quote(dimension_id, safe='')}/members"
        try:
            r = self._sac.get(dim_path)
            results["status"] = r.status_code
            results["members"] = r.json() if r.content else {}
        except Exception as e:
            results["error"] = str(e)

        return results

    def list_dataexport_providers(self) -> Dict[str, Any]:
        """List SAC Data Export providers (= planning models)."""
        try:
            r = self._sac.get("/api/v1/dataexport/providers")
            return {"status": r.status_code, "data": r.json() if r.content else {}}
        except Exception as e:
            return {"error": str(e)}

    def probe_multiaction(self, multiaction_id: str) -> Dict[str, Any]:
        """Try to GET the multi-action definition and related paths to discover model/param info."""
        clean_id = multiaction_id.split(":")[-1] if ":" in multiaction_id else multiaction_id
        paths = [
            f"/api/v1/multiActions/{quote(multiaction_id, safe='')}",
            f"/api/v1/multiActions/{quote(clean_id, safe='')}",
            f"/api/v1/multiActions/{quote(multiaction_id, safe='')}/steps",
            f"/api/v1/multiActions/{quote(clean_id, safe='')}/steps",
            f"/api/v1/multiActions/{quote(multiaction_id, safe='')}/parameters",
            f"/api/v1/multiActions/{quote(clean_id, safe='')}/parameters",
        ]
        self._sac._ensure_access_token()
        results = {}
        for path in paths:
            url = f"{self._sac._host}{path}"
            try:
                r = self._sac._session.get(url, timeout=15)
                try:
                    body = r.json()
                except Exception:
                    body = r.text[:500]
                results[path] = {"status": r.status_code, "body": body}
            except Exception as e:
                results[path] = {"error": str(e)}
        return results

    def probe_dimension(self, model_id: str, dimension_id: str) -> Dict[str, Any]:
        """Try multiple SAC API paths to find dimension members using user JWT."""
        dim_variants = [dimension_id]
        if dimension_id and not dimension_id.startswith(model_id):
            dim_variants.append(f"{model_id}_{dimension_id}")

        paths = []
        qmod = quote(model_id, safe="")
        for dim in dim_variants:
            qdim = quote(dim, safe="")
            paths.append(f"/api/v1/dataexport/providers/{qmod}/dimensions/{qdim}/members")
            paths.append(f"/api/v1/dataexport/providers/{qmod}/dimensions/{qdim}")
        paths += [
            f"/api/v1/dataexport/providers/{qmod}",
            "/api/v1/dataexport/providers",
        ]

        self._sac._ensure_access_token()
        results = {}
        for path in paths:
            url = f"{self._sac._host}{path}"
            try:
                r = self._sac._session.get(url, timeout=15)
                try:
                    body = r.json()
                except Exception:
                    body = r.text[:500]
                results[path] = {"status": r.status_code, "body": body}
            except Exception as e:
                results[path] = {"error": str(e)}
        return results

    def get_job_status(self, ref: JobReference) -> Dict[str, Any]:
        """Poll SAC for multi action execution status."""
        multiaction_id, exec_id = ref.remote_id.rsplit(":", 1)

        # GET /multiActions/{id}/executions/{execId}
        path = (
            f"{_MULTIACTION_PATH}/{quote(multiaction_id, safe='.:')}"
            f"/executions/{quote(exec_id, safe='')}"
        )

        resp = self._sac.get(path)
        data = resp.json() if resp.content else {}

        raw_status = (
            data.get("status") or data.get("Status") or data.get("state") or ""
        ).strip().upper()
        status = self._map_status(raw_status)

        if status.value in ("FAILED", "CANCELLED"):
            logger.warning(
                "SAC execution %s finished with status %s — full response: %s",
                exec_id, raw_status, json.dumps(data)[:2000]
            )
        elif status.value == "UNKNOWN":
            logger.warning(
                "SAC execution %s returned unrecognised status %r — full response: %s",
                exec_id, raw_status, json.dumps(data)[:2000]
            )

        return {
            "status": status.value,
            "integration": IntegrationType.SAC.value,
            "multiaction_id": multiaction_id,
            "execution_id": exec_id,
            "raw_status": raw_status,
            "details": data,
        }

    def cancel_job(self, ref: JobReference) -> Dict[str, Any]:
        """Cancel a running SAC multi action."""
        multiaction_id, exec_id = ref.remote_id.rsplit(":", 1)

        # DELETE /multiActions/{id}/executions/{execId}
        path = (
            f"{_MULTIACTION_PATH}/{quote(multiaction_id, safe='.:')}"
            f"/executions/{quote(exec_id, safe='')}"
        )

        resp = self._sac.delete(path)
        return {
            "cancelled": True,
            "multiaction_id": multiaction_id,
            "execution_id": exec_id,
        }

    def check_health(self) -> Dict[str, Any]:
        """Check SAC connectivity with graceful fallback for auth scenarios.
        
        In pure user-propagation mode this endpoint is expected to run without
        a caller JWT, so SAC is reported as degraded rather than broken.
        """
        try:
            self._sac.get(f"{_MULTIACTION_PATH}?$top=1")
            return {"status": "ok", "integration": IntegrationType.SAC.value}
        except Exception as e:
            error_str = str(e)
            if (
                "Cannot determine user to propagate" in error_str
                or "requires an authenticated user context" in error_str
            ):
                logger.warning(
                    "SAC health check: destination requires a user JWT for "
                    "OAuth2SAMLBearerAssertion. This endpoint runs without "
                    "an authenticated caller, so the result is degraded by design. "
                    "Error: %s",
                    error_str,
                )
                return {
                    "status": "degraded",
                    "integration": IntegrationType.SAC.value,
                    "note": "SAC validation requires an authenticated caller JWT; use POST /v1/jobs/launch from the UI",
                    "error": error_str,
                }
            # Other errors are real problems
            return {"status": "error", "integration": IntegrationType.SAC.value, "error": error_str}

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    @staticmethod
    def _map_status(raw: str) -> JobStatus:
        if raw in {"COMPLETED", "SUCCESS", "SUCCESSFUL", "FINISHED", "DONE", "WARNING"}:
            return JobStatus.COMPLETED
        if raw in {"FAILED", "ERROR", "ABORTED"}:
            return JobStatus.FAILED
        if raw in {"RUNNING", "ACTIVE", "IN_PROGRESS", "PROCESSING"}:
            return JobStatus.RUNNING
        if raw in {"PENDING", "QUEUED", "SCHEDULED", "WAITING"}:
            return JobStatus.PENDING
        if raw in {"CANCELLED", "CANCELED"}:
            return JobStatus.CANCELLED
        return JobStatus.UNKNOWN
