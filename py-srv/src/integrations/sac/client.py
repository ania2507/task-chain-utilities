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

import logging
import time
from typing import TYPE_CHECKING, Any, Dict, Optional
from urllib.parse import quote

import requests

from ..base import BaseJobClient, IntegrationType, JobReference, JobStatus

if TYPE_CHECKING:
    from .destination import DestinationClient

logger = logging.getLogger(__name__)

_TOKEN_PATH = "/api/v1/csrf"
_MULTIACTION_PATH = "/api/v1/multiActions"


class _SACSession:
    """Manages OAuth2 token + CSRF for SAC REST calls.

    Supports two token-acquisition strategies:
      • **direct** – client_credentials grant (default, no user context)
      • **destination** – BTP Destination Service SAML Bearer (user propagation)

    When a ``DestinationClient`` is provided *and* a BTP user JWT is
    available in the current Flask request, the destination path is used
    automatically.  Otherwise the session falls back to client_credentials.
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
        # Track which JWT was used so we invalidate on user change
        self._last_user_jwt: Optional[str] = None

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
        When the BTP Destination has a SystemUser, no user JWT is needed.
        """
        # ------ destination (SAML Bearer) path ------
        if self._destination_client:
            # Try with user JWT if available (real user propagation),
            # otherwise call without it (SystemUser mode from the blog).
            user_jwt = self._get_user_jwt()
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

        When the BTP Destination has a ``SystemUser`` property, no
        ``user_jwt`` is required — the Destination Service creates the
        SAML assertion for the SystemUser automatically.

        If ``user_jwt`` is provided it is forwarded as ``X-user-token``
        for real user-propagation scenarios.
        """
        # Invalidate cache when the calling user changes
        if user_jwt != self._last_user_jwt:
            self._access_token = None
            self._token_expiry = 0

        if self._access_token and time.time() < self._token_expiry:
            return self._access_token

        token_data = self._destination_client.get_sac_token(user_jwt)
        self._access_token = token_data["access_token"]
        self._token_expiry = (
            time.time() + int(token_data.get("expires_in", 3600)) - 60
        )
        self._session.headers.update({"Authorization": f"Bearer {self._access_token}"})
        self._csrf_token = None
        self._last_user_jwt = user_jwt
        logger.info("SAC token obtained via BTP Destination Service (SAML Bearer)")
        return self._access_token

    def _fetch_csrf(self) -> str:
        self._ensure_access_token()
        resp = self._session.get(
            f"{self._host}{_TOKEN_PATH}",
            headers={"x-csrf-token": "Fetch", "x-sap-sac-custom-auth": "true"},
            timeout=30,
        )
        resp.raise_for_status()
        token = resp.headers.get("x-csrf-token", "")
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
        headers["x-sap-sac-custom-auth"] = "true"
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
        headers["x-sap-sac-custom-auth"] = "true"
        resp = self._session.delete(url, headers=headers, timeout=60, **kwargs)
        if resp.status_code == 403:
            self._fetch_csrf()
            headers["x-csrf-token"] = self._csrf_token
            resp = self._session.delete(url, headers=headers, timeout=60, **kwargs)
        resp.raise_for_status()
        return resp


class SACJobClient(BaseJobClient):
    """Concrete integration for SAC Multi Actions."""

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
            • ``parameters``  – dict of input parameters for the multi action
        """
        multiaction_id = params.get("multiaction_id")
        if not multiaction_id:
            raise ValueError("SAC: 'multiaction_id' is required")

        run_params = params.get("parameters", {})

        # REST endpoint as documented in the SAP blog:
        #   POST /multiActions/{id}/executions
        path = f"{_MULTIACTION_PATH}/{quote(multiaction_id, safe='.:')}/executions"

        body: Dict[str, Any] = {}
        if run_params:
            body["parameters"] = run_params

        resp = self._sac.post(path, json=body if body else None)

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

    def get_job_status(self, ref: JobReference) -> Dict[str, Any]:
        """Poll SAC for multi action execution status."""
        multiaction_id, exec_id = ref.remote_id.split(":", 1)

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
        multiaction_id, exec_id = ref.remote_id.split(":", 1)

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
        try:
            self._sac.get(f"{_MULTIACTION_PATH}?$top=1")
            return {"status": "ok", "integration": IntegrationType.SAC.value}
        except Exception as e:
            return {"status": "error", "integration": IntegrationType.SAC.value, "error": str(e)}

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    @staticmethod
    def _map_status(raw: str) -> JobStatus:
        if raw in {"COMPLETED", "SUCCESS", "FINISHED", "DONE"}:
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
