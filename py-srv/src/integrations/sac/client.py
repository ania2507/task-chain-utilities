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
# Timeout for a single execution-status read (see get_job_status).
_STATUS_READ_TIMEOUT_SECONDS = 15
_MULTIACTION_PATH = "/api/v1/multiActions"


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


def _split_member_ids(raw: str) -> List[str]:
    """Split a plain-text value into individual dimension members.

    Lets users enter multiple members for the same parameter (e.g. two legal
    entities) as comma-separated text ("1000, 2000") instead of requiring
    raw JSON (``{"memberIds": ["1000","2000"], "hierarchyId": null}``).
    """
    return [v.strip() for v in raw.split(",") if v.strip()]


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
                value = {"memberIds": _split_member_ids(stripped), "hierarchyId": None}

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


class _UserSession:
    """SAC connection state for ONE caller identity: its own HTTP session
    (cookies), SAC access token and CSRF token. Never shared across callers -
    SAC binds its session cookies and CSRF token to the user they were issued
    for, so mixing them across users gets requests rejected."""

    def __init__(self, verify_ssl: bool):
        self.session = requests.Session()
        self.session.verify = verify_ssl
        self.access_token: Optional[str] = None
        self.token_expiry: float = 0
        self.csrf_token: Optional[str] = None
        self.last_used: float = time.time()
        self.lock = threading.RLock()


class _SACSession:
    """Manages OAuth2 token + CSRF for SAC REST calls.

    Supports two token-acquisition strategies:
      • **direct** – client_credentials grant (default, no user context)
      • **destination** – BTP Destination Service SAML Bearer (user propagation)

    When a ``DestinationClient`` is provided, the destination path is used
    and requires a BTP user JWT: the current Flask request's one or, only
    when there is none (background threads), the one set for the current
    thread via ``set_user_jwt()``.

    Each caller identity gets its own ``_UserSession`` (cookies, SAC token,
    CSRF token), so concurrent or successive calls on behalf of different
    users never reuse each other's SAC session.
    """

    # Drop per-user sessions idle for longer than this (their SAC token has
    # expired by then anyway) so the cache doesn't grow without bound.
    _SESSION_IDLE_SECONDS = 2 * 3600
    _CLIENT_CREDENTIALS_KEY = "__client_credentials__"

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

        self._sessions: Dict[str, _UserSession] = {}
        self._sessions_lock = threading.Lock()
        # JWT injected explicitly for code running outside a Flask request
        # (e.g. the parameter-probe background thread). Thread-local, so it
        # can never leak into other threads or later requests.
        self._local = threading.local()

    def set_user_jwt(self, jwt: Optional[str]) -> None:
        """Set the JWT used for SAML Bearer token exchange by the CURRENT
        THREAD when it has no Flask request context of its own. Pass ``None``
        to clear it - callers must do so when done (e.g. in a ``finally``)."""
        self._local.override_jwt = jwt

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

    def current_user_jwt(self) -> Optional[str]:
        """The caller JWT to propagate: the current request's own token wins;
        the thread's explicitly-set one is only a fallback when there is no
        request token (background threads)."""
        return self._get_user_jwt() or getattr(self._local, "override_jwt", None)

    def _user_session(self) -> tuple[_UserSession, Optional[str]]:
        """Return (session for the current caller identity, caller JWT)."""
        if self._destination_client:
            user_jwt = self.current_user_jwt()
            if not user_jwt:
                raise RuntimeError(
                    "SAC destination requires an authenticated user context "
                    "for user propagation"
                )
            key = user_jwt
        else:
            user_jwt = None
            key = self._CLIENT_CREDENTIALS_KEY

        now = time.time()
        with self._sessions_lock:
            for k in [k for k, s in self._sessions.items()
                      if k != key and now - s.last_used > self._SESSION_IDLE_SECONDS]:
                self._sessions.pop(k).session.close()
            us = self._sessions.get(key)
            if us is None:
                us = _UserSession(self._verify)
                self._sessions[key] = us
            us.last_used = now
        return us, user_jwt

    def _ensure_access_token(self, us: Optional[_UserSession] = None,
                             user_jwt: Optional[str] = None) -> str:
        """Return a valid SAC access token for the current caller, refreshing
        if needed. Prefers the Destination Service path when available; in
        that mode a caller JWT is required."""
        if us is None:
            us, user_jwt = self._user_session()
        with us.lock:
            if us.access_token and time.time() < us.token_expiry:
                return us.access_token

            if self._destination_client:
                mode = f"user_jwt propagation (user={user_jwt[:20]}...)"
                logger.debug(f"SAC: exchanging token via BTP Destination ({mode})")
                token_data = self._destination_client.get_sac_token(user_jwt)
                access_token = token_data["access_token"]
                expires_in = int(token_data.get("expires_in", 3600))
                logger.info(f"SAC token obtained via BTP Destination Service ({mode})")
            else:
                resp = requests.post(
                    self._token_url,
                    data={"grant_type": "client_credentials"},
                    auth=(self._client_id, self._client_secret),
                    verify=self._verify,
                    timeout=30,
                )
                resp.raise_for_status()
                data = resp.json()
                access_token = data["access_token"]
                expires_in = int(data.get("expires_in", 3600))

            us.access_token = access_token
            us.token_expiry = time.time() + expires_in - 60
            us.session.headers.update({"Authorization": f"Bearer {access_token}"})
            us.csrf_token = None  # new token → CSRF must be re-fetched
            return access_token

    def _fetch_csrf(self, us: _UserSession) -> str:
        """Fetch a CSRF token. If SAC answers without one (typically it didn't
        accept the session the request arrived with and served a login/generic
        page instead), drop that session's cookies and try exactly once more.
        Only the token request is repeated - never the multi action launch,
        whose retries are DSP's call."""
        for attempt in (1, 2):
            resp = us.session.get(
                f"{self._host}{_TOKEN_PATH}",
                headers={"x-csrf-token": "Fetch"},
                timeout=30,
            )
            resp.raise_for_status()
            token = resp.headers.get("x-csrf-token", "").strip()
            if token:
                us.csrf_token = token
                return token
            if attempt == 1:
                logger.warning(
                    "SAC: no CSRF token in response (HTTP %s, content-type %r) - "
                    "clearing session cookies and retrying once",
                    resp.status_code, resp.headers.get("content-type", ""),
                )
                us.session.cookies.clear()
        raise RuntimeError("SAC: failed to obtain CSRF token")

    def _ready(self, with_csrf: bool) -> _UserSession:
        us, user_jwt = self._user_session()
        self._ensure_access_token(us, user_jwt)
        if with_csrf:
            with us.lock:
                if not us.csrf_token:
                    self._fetch_csrf(us)
        return us

    def raw_get(self, path: str, **kwargs) -> requests.Response:
        """GET without raise_for_status() - for probing callers that inspect
        the status code themselves."""
        us = self._ready(with_csrf=False)
        return us.session.get(f"{self._host}{path}", **kwargs)

    def get(self, path: str, timeout: float = 60, **kwargs) -> requests.Response:
        us = self._ready(with_csrf=False)
        resp = us.session.get(f"{self._host}{path}", timeout=timeout, **kwargs)
        resp.raise_for_status()
        return resp

    def post(self, path: str, **kwargs) -> requests.Response:
        us = self._ready(with_csrf=True)
        url = f"{self._host}{path}"
        headers = kwargs.pop("headers", {})
        headers["x-csrf-token"] = us.csrf_token
        # SAC returns 415 if Content-Type is not explicitly application/json
        headers.setdefault("Content-Type", "application/json")
        resp = us.session.post(url, headers=headers, timeout=120, **kwargs)
        if resp.status_code == 403:
            with us.lock:
                self._fetch_csrf(us)
            headers["x-csrf-token"] = us.csrf_token
            resp = us.session.post(url, headers=headers, timeout=120, **kwargs)
        resp.raise_for_status()
        return resp

    def delete(self, path: str, **kwargs) -> requests.Response:
        us = self._ready(with_csrf=True)
        url = f"{self._host}{path}"
        headers = kwargs.pop("headers", {})
        headers["x-csrf-token"] = us.csrf_token
        resp = us.session.delete(url, headers=headers, timeout=60, **kwargs)
        if resp.status_code == 403:
            with us.lock:
                self._fetch_csrf(us)
            headers["x-csrf-token"] = us.csrf_token
            resp = us.session.delete(url, headers=headers, timeout=60, **kwargs)
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

        # If "Load Parameters" or "Validate" is currently running a test execution
        # against this same multi action (see _probe_running), wait for it to
        # finish rather than launching a second, real execution concurrently —
        # two overlapping executions of the same multi action can interfere with
        # each other on SAC's side. Bounded so a real task-chain launch can never
        # be blocked indefinitely if the probe/validate flow gets stuck.
        _max_wait_seconds = 90
        _waited = 0
        while multiaction_id in self._probe_running and _waited < _max_wait_seconds:
            logger.info(
                "SAC launch_job: multiaction '%s' is being probed/validated — waiting (%ds elapsed)",
                multiaction_id, _waited,
            )
            time.sleep(3)
            _waited += 3
        if multiaction_id in self._probe_running:
            logger.warning(
                "SAC launch_job: multiaction '%s' still marked as probing after %ds — proceeding anyway",
                multiaction_id, _waited,
            )

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

    def get_multiaction_definition(self, multiaction_id: str, allow_probe: bool = False) -> Dict[str, Any]:
        """Return the raw multi action definition including parameters.

        Strategy (each step is a fallback for the previous):
        1. GET /multiActions/{id}          — standard read endpoint
        2. GET /multiActions               — list endpoint, filter by id
        3. GET /multiActions/{id}/executions — infer params from past executions (no side effects)
        4. POST /executions (empty params) — parse SAC validation error for param names

        Step 4 launches a REAL execution of the multi action in SAC, so it only
        runs when ``allow_probe`` is True - i.e. when the user explicitly
        confirmed it in the UI. Otherwise (e.g. the automatic load when a step
        is selected) only side-effect-free reads are used and, if they find
        nothing, ``{"parameters": [], "probeRequired": True}`` is returned.
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

        # Fallback 2: look at recent past executions to infer parameter IDs.
        # This avoids launching a new execution (probe side-effect) and uses the public API.
        try:
            exec_list_path = f"{_MULTIACTION_PATH}/{quote(multiaction_id, safe='.:')}/executions?$top=5"
            resp = self._sac.get(exec_list_path)
            exec_data = resp.json() if resp.content else {}
            executions = (
                exec_data.get("value")
                or exec_data.get("executions")
                or (exec_data if isinstance(exec_data, list) else [])
            )
            seen: Dict[str, Dict[str, Any]] = {}
            for ex in executions:
                if not isinstance(ex, dict):
                    continue
                for pv in (ex.get("parameterValues") or []):
                    pid = pv.get("parameterId") or ""
                    if pid and pid not in seen:
                        seen[pid] = {"id": pid, "label": pid, "mandatory": True, "needsHierarchyId": False}
            if seen:
                logger.info(
                    "SAC executions fallback: found %d param(s) from past executions for %s: %s",
                    len(seen), multiaction_id, list(seen.keys())
                )
                return {"parameters": list(seen.values())}
            logger.info(
                "SAC executions fallback: no parameterValues in past executions for %s — falling back to probe",
                multiaction_id,
            )
        except Exception as e:
            logger.info("SAC executions fallback failed for %s: %s — falling back to probe", multiaction_id, e)

        # Fallback 3: probe via background thread to avoid gateway timeout.
        # Return cached result if already done; otherwise start the probe and return empty
        # so the caller can retry in a few seconds.
        if not allow_probe and multiaction_id not in self._probe_cache:
            logger.info(
                "SAC probe for %s not allowed for this call (no explicit user confirmation) - "
                "returning probeRequired instead of launching an execution", multiaction_id,
            )
            return {"parameters": [], "probeRequired": True}
        if multiaction_id in self._probe_cache:
            cached = self._probe_cache[multiaction_id]
            logger.info("SAC probe: returning cached result for %s (%d params)", multiaction_id, len(cached.get("parameters") or []))
            return cached

        if multiaction_id not in self._probe_running:
            self._probe_running.add(multiaction_id)
            # Capture the JWT now (still in Flask request context); the background
            # thread won't have request context so we pass it explicitly.
            captured_jwt = self._sac.current_user_jwt()
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
            # Clear it so this thread's JWT can never be reused for anything else.
            self._sac.set_user_jwt(None)
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
        results = {}
        for path in paths:
            try:
                r = self._sac.raw_get(path, timeout=15)
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

        results = {}
        for path in paths:
            try:
                r = self._sac.raw_get(path, timeout=15)
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
        # Kept well under DSP's 60s API-task timeout (worst case together with
        # the ~30s Destination token exchange): if SAC hangs, py-srv must still
        # answer DSP in time - see routes/jobs.py, which then reports the
        # execution as still running instead of failing the DSP step.
        multiaction_id, exec_id = ref.remote_id.rsplit(":", 1)

        # GET /multiActions/{id}/executions/{execId}
        path = (
            f"{_MULTIACTION_PATH}/{quote(multiaction_id, safe='.:')}"
            f"/executions/{quote(exec_id, safe='')}"
        )

        resp = self._sac.get(path, timeout=_STATUS_READ_TIMEOUT_SECONDS)
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
