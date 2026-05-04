"""BTP Destination Service client for SAC token exchange.

Implements the OAuth 2.0 SAML Bearer Assertion flow described in:
  https://community.sap.com/t5/technology-blog-posts-by-sap/
  run-the-sac-multi-action-public-api-using-oauth-2-0-saml-bearer-assertion/
  ba-p/14349490

Flow:
  1. Obtain a **service token** for the Destination Service (client_credentials
      against the Destination Service's own XSUAA).
  2. Call ``GET /destination-configuration/v1/destinations/{name}``
      with the service token as Bearer.
  3. Forward the caller JWT as ``X-user-token`` so the Destination Service
      can generate the SAML assertion and exchange it with SAC for a user-bound
      access token.
  4. The returned ``authTokens[0].value`` is used as Bearer for all
      subsequent SAC REST calls (CSRF + multiActions).
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Dict, Optional

import requests

logger = logging.getLogger(__name__)


class DestinationClient:
    """Calls BTP Destination Service to obtain SAC access tokens
    via OAuth2 SAML Bearer Assertion user propagation."""

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

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------

    def get_connection(self, user_jwt: str | None = None) -> Dict[str, Any]:
        """Return destination URL and optional token material for SAC."""
        data = self._fetch_destination(user_jwt)
        cfg = data.get("destinationConfiguration", {})
        base_url = self._normalize_host((cfg.get("URL") or "").rstrip("/"))
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

        auth_tokens = data.get("authTokens", [])
        if auth_tokens and not auth_tokens[0].get("error"):
            connection["access_token"] = auth_tokens[0].get("value")
            connection["expires_in"] = int(
                auth_tokens[0].get("expires_in_seconds", 3600)
            )

        return connection

    def get_sac_token(self, user_jwt: str | None = None) -> Dict[str, Any]:
        """Exchange for a SAC access token via the BTP Destination Service.

        The caller JWT is forwarded as ``X-user-token`` so the Destination
        Service can perform user propagation toward SAC.

        Returns a dict::

            {"access_token": "...", "expires_in": 3600, "type": "Bearer"}
        """
        data = self._fetch_destination(user_jwt)

        auth_tokens = data.get("authTokens", [])
        if not auth_tokens:
            raise RuntimeError(
                f"Destination '{self._destination_name}' returned no authTokens. "
                f"Check the SAML Bearer / Trusted IDP configuration in SAC and BTP."
            )

        token_info = auth_tokens[0]
        if token_info.get("error"):
            logger.error(
                "SAC authTokens full detail: %s",
                json.dumps(token_info, indent=2),
            )
            raise RuntimeError(
                f"Destination token exchange error: {token_info['error']} "
                f"(destination={self._destination_name})"
            )

        return {
            "access_token": token_info["value"],
            "expires_in": int(token_info.get("expires_in_seconds", 3600)),
            "type": token_info.get("type", "Bearer"),
        }

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _ensure_service_token(self) -> str:
        """Obtain / refresh the Destination Service's own client_credentials token."""
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

    def _fetch_destination(self, user_jwt: str | None = None) -> Dict[str, Any]:
        """Load the raw destination payload from Destination Service."""
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

        resp = requests.get(
            url,
            headers=headers,
            verify=self._verify,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    @staticmethod
    def _normalize_host(url: str) -> str:
        """Strip API suffixes because the SAC client appends /api/v1 itself."""
        if url.endswith("/api/v1"):
            return url[: -len("/api/v1")]
        return url

    # ------------------------------------------------------------------
    # Factory
    # ------------------------------------------------------------------

    @classmethod
    def from_env(cls) -> Optional["DestinationClient"]:
        """Build a DestinationClient from VCAP_SERVICES (CF) or env vars.

        Returns ``None`` when the required credentials are not available.
        """
        dest_name = os.environ.get("SAC_DESTINATION_NAME", "").strip()
        if not dest_name:
            return None

        # 1) Try VCAP_SERVICES (Cloud Foundry)
        vcap = os.environ.get("VCAP_SERVICES")
        if vcap:
            try:
                services = json.loads(vcap)
                for svc in services.get("destination", []):
                    creds = svc.get("credentials", {})
                    uri = creds.get("uri", "").rstrip("/")
                    url = creds.get("url", "").rstrip("/")
                    cid = creds.get("clientid", "")
                    csec = creds.get("clientsecret", "")
                    if uri and cid and csec:
                        token_url = f"{url}/oauth/token" if url else ""
                        logger.info(
                            "DestinationClient from VCAP_SERVICES "
                            "(dest=%s, uri=%s)", dest_name, uri,
                        )
                        return cls(
                            service_url=uri,
                            token_url=token_url,
                            client_id=cid,
                            client_secret=csec,
                            destination_name=dest_name,
                        )
            except json.JSONDecodeError:
                logger.warning("Failed to parse VCAP_SERVICES for destination")

        # 2) Fallback: explicit env vars (local dev)
        svc_url = os.environ.get("DEST_SERVICE_URL", "").strip()
        tok_url = os.environ.get("DEST_TOKEN_URL", "").strip()
        cid = os.environ.get("DEST_CLIENT_ID", "").strip()
        csec = os.environ.get("DEST_CLIENT_SECRET", "").strip()

        if svc_url and tok_url and cid and csec:
            logger.info(
                "DestinationClient from env vars (dest=%s, url=%s)",
                dest_name, svc_url,
            )
            return cls(
                service_url=svc_url,
                token_url=tok_url,
                client_id=cid,
                client_secret=csec,
                destination_name=dest_name,
            )

        logger.info(
            "SAC_DESTINATION_NAME=%s but no destination service credentials found",
            dest_name,
        )
        return None
