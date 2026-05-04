"""BTP Destination Service client for IBP connectivity.

Resolves the destination configuration and returns connection material
for the IBP OData client (host + auth strategy).
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Dict, Optional

import requests

logger = logging.getLogger(__name__)


class IBPDestinationClient:
    """Resolve an IBP destination through BTP Destination Service."""

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
        """Return IBP connection details from destination config.

        Result keys:
            - host (required)
            - user/password (for BasicAuthentication)
            - access_token (for OAuth-based destination)
        """
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

        destination_cfg = data.get("destinationConfiguration", {})
        host = (destination_cfg.get("URL") or "").rstrip("/")
        if not host:
            raise RuntimeError(
                f"Destination '{self._destination_name}' has no URL configured"
            )

        auth_type = (destination_cfg.get("Authentication") or "").strip()
        conn: Dict[str, Any] = {"host": host, "authentication": auth_type}

        if auth_type == "BasicAuthentication":
            user = destination_cfg.get("User") or ""
            password = destination_cfg.get("Password") or ""
            if not user or not password:
                raise RuntimeError(
                    f"Destination '{self._destination_name}' missing User/Password"
                )
            conn["user"] = user
            conn["password"] = password
            return conn

        auth_tokens = data.get("authTokens", [])
        if auth_tokens:
            token_info = auth_tokens[0]
            if token_info.get("error"):
                raise RuntimeError(
                    f"Destination token exchange error: {token_info['error']} "
                    f"(destination={self._destination_name})"
                )
            conn["access_token"] = token_info.get("value")
            return conn

        raise RuntimeError(
            "Unsupported IBP destination authentication. "
            "Use BasicAuthentication or an OAuth-based destination that returns authTokens."
        )

    def _ensure_service_token(self) -> str:
        if self._service_token and time.time() < self._service_token_expiry:
            return self._service_token

        resp = requests.post(
            self._token_url,
            data={"grant_type": "client_credentials"},
            auth=(self._client_id, self._client_secret),
            verify=self._verify,
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        self._service_token = data["access_token"]
        self._service_token_expiry = (
            time.time() + int(data.get("expires_in", 3600)) - 60
        )
        return self._service_token

    @classmethod
    def from_env(cls) -> Optional["IBPDestinationClient"]:
        dest_name = os.environ.get("IBP_DESTINATION_NAME", "").strip()
        if not dest_name:
            return None

        verify_ssl = os.environ.get("IBP_DEST_VERIFY_SSL", "true").lower() != "false"

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
                logger.warning("Failed to parse VCAP_SERVICES for IBP destination")

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
            "IBP_DESTINATION_NAME=%s but no destination service credentials found",
            dest_name,
        )
        return None
