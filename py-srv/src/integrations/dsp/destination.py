"""BTP Destination Service client for DSP connectivity.

Resolves destination configuration and returns endpoint/auth material
for DSP REST calls.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Dict, Optional

import requests

logger = logging.getLogger(__name__)


class DSPDestinationClient:
    """Resolve a DSP destination via Destination Service."""

    def __init__(
        self,
        service_url: str,
        token_url: str,
        client_id: str,
        client_secret: str,
        destination_name: str,
        *,
        verify_ssl: bool = True,
    ):
        self._service_url = service_url.rstrip("/")
        self._token_url = token_url
        self._client_id = client_id
        self._client_secret = client_secret
        self._destination_name = destination_name
        self._verify = verify_ssl
        self._service_token: Optional[str] = None
        self._service_token_expiry: float = 0

    def get_connection(self, user_jwt: str | None = None) -> Dict[str, Any]:
        """Return destination URL and auth material for DSP."""
        service_token = self._ensure_service_token()
        url = (
            f"{self._service_url}/destination-configuration/v1"
            f"/destinations/{self._destination_name}"
        )
        headers: Dict[str, str] = {
            "Authorization": f"Bearer {service_token}",
        }
        if user_jwt:
            headers["X-user-token"] = user_jwt

        resp = requests.get(url, headers=headers, verify=self._verify, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        cfg = data.get("destinationConfiguration", {})
        base_url = (cfg.get("URL") or "").rstrip("/")
        auth = (cfg.get("Authentication") or "").strip()

        if not base_url:
            raise RuntimeError(
                f"Destination '{self._destination_name}' has no URL configured"
            )

        connection: Dict[str, Any] = {
            "name": self._destination_name,
            "host": base_url,
            "authentication": auth,
        }

        # OAuth destinations (e.g. OAuth2ClientCredentials) usually return authTokens.
        auth_tokens = data.get("authTokens", [])
        if auth_tokens:
            token_info = auth_tokens[0]
            if token_info.get("error"):
                raise RuntimeError(
                    f"Destination token exchange error: {token_info['error']} "
                    f"(destination={self._destination_name})"
                )
            connection["access_token"] = token_info.get("value")
            connection["expires_in"] = int(token_info.get("expires_in_seconds", 3600))

        # Basic fallback support, if needed in future.
        if auth == "BasicAuthentication":
            connection["user"] = cfg.get("User")
            connection["password"] = cfg.get("Password")

        return connection

    def _ensure_service_token(self) -> str:
        if self._service_token and time.time() < self._service_token_expiry:
            return self._service_token

        last_exc: Exception | None = None
        for attempt in range(2):
            if attempt:
                time.sleep(2)
            try:
                resp = requests.post(
                    self._token_url,
                    data={"grant_type": "client_credentials"},
                    auth=(self._client_id, self._client_secret),
                    verify=self._verify,
                    timeout=30,
                )
                if not resp.ok:
                    logger.warning(
                        "Token fetch failed (attempt %d): HTTP %s — %s",
                        attempt + 1, resp.status_code, resp.text[:500],
                    )
                resp.raise_for_status()
                data = resp.json()
                self._service_token = data["access_token"]
                self._service_token_expiry = (
                    time.time() + int(data.get("expires_in", 3600)) - 60
                )
                return self._service_token
            except Exception as exc:
                last_exc = exc
                self._service_token = None
                self._service_token_expiry = 0

        raise last_exc  # type: ignore[misc]

    @classmethod
    def from_env(cls) -> Optional["DSPDestinationClient"]:
        dest_name = os.environ.get("DSP_DESTINATION_NAME", "").strip()
        if not dest_name:
            return None

        verify_ssl = os.environ.get("DSP_DEST_VERIFY_SSL", "true").lower() != "false"

        vcap = os.environ.get("VCAP_SERVICES")
        if vcap:
            try:
                services = json.loads(vcap)
                for svc in services.get("destination", []):
                    creds = svc.get("credentials", {})
                    uri = (creds.get("uri") or "").rstrip("/")
                    url = (creds.get("url") or "").rstrip("/")
                    cid = creds.get("clientid", "")
                    csec = creds.get("clientsecret", "")
                    if uri and url and cid and csec:
                        return cls(
                            service_url=uri,
                            token_url=f"{url}/oauth/token",
                            client_id=cid,
                            client_secret=csec,
                            destination_name=dest_name,
                            verify_ssl=verify_ssl,
                        )
            except json.JSONDecodeError:
                logger.warning("Failed to parse VCAP_SERVICES for DSP destination")

        svc_url = os.environ.get("DEST_SERVICE_URL", "").strip()
        tok_url = os.environ.get("DEST_TOKEN_URL", "").strip()
        cid = os.environ.get("DEST_CLIENT_ID", "").strip()
        csec = os.environ.get("DEST_CLIENT_SECRET", "").strip()

        if svc_url and tok_url and cid and csec:
            return cls(
                service_url=svc_url,
                token_url=tok_url,
                client_id=cid,
                client_secret=csec,
                destination_name=dest_name,
                verify_ssl=verify_ssl,
            )

        logger.info(
            "DSP_DESTINATION_NAME=%s but no destination service credentials found",
            dest_name,
        )
        return None
