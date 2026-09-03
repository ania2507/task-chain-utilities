"""SAP Job Scheduling service client (standard plan, XSUAA authentication).

Docs:
  https://help.sap.com/docs/job-scheduling
  https://api.sap.com/api/sap-btpjss-admin-v1/overview

Auth: client_credentials against ``credentials.uaa.url/oauth/token`` using
``credentials.uaa.clientid``/``clientsecret`` from the VCAP_SERVICES binding
(label ``jobscheduler``), then Bearer against ``credentials.url/scheduler/...``.

Model: a "Job" (name + action URL + httpMethod) owns one or more "Schedules",
each with its own trigger (cron/time/repeatInterval/repeatAt) and a free-form
``data`` payload that the service forwards verbatim to the action endpoint
when the schedule fires.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Dict, Optional

import requests

logger = logging.getLogger(__name__)


class JobSchedulerRateLimitError(Exception):
    """Raised on a 429/503 from the Job Scheduling service. `retry_after` is in seconds."""

    def __init__(self, retry_after: float):
        self.retry_after = retry_after
        super().__init__(f"Job Scheduling service rate-limited, retry after {retry_after}s")


class JobSchedulerClient:
    """Calls the SAP Job Scheduling service REST API."""

    def __init__(self, service_url: str, uaa_url: str, client_id: str, client_secret: str,
                 *, verify_ssl: bool = True):
        self._service_url = service_url.rstrip("/")
        self._uaa_url = uaa_url.rstrip("/")
        self._client_id = client_id
        self._client_secret = client_secret
        self._verify = verify_ssl

        self._token: Optional[str] = None
        self._token_expiry: float = 0
        # Job lookup/creation costs a network round-trip; a job is created
        # once and reused for the process lifetime, so cache its ID here
        # rather than re-resolving it on every schedule create/delete.
        self._job_id_cache: Dict[str, int] = {}

    # ------------------------------------------------------------------
    # Factory
    # ------------------------------------------------------------------
    @classmethod
    def from_env(cls) -> Optional["JobSchedulerClient"]:
        """Build a client from VCAP_SERVICES (label ``jobscheduler``, standard plan).

        Returns None when the service isn't bound or credentials are incomplete
        (e.g. local dev, or a binding using x509 instead of clientsecret) -
        callers fall back to the in-process scheduler in that case.
        """
        vcap = os.environ.get("VCAP_SERVICES")
        if not vcap:
            return None
        try:
            services = json.loads(vcap)
        except json.JSONDecodeError:
            logger.warning("Failed to parse VCAP_SERVICES for jobscheduler")
            return None

        for svc in services.get("jobscheduler", []):
            creds = svc.get("credentials", {})
            url = (creds.get("url") or "").rstrip("/")
            uaa = creds.get("uaa", {})
            uaa_url = (uaa.get("url") or "").rstrip("/")
            client_id = uaa.get("clientid") or ""
            client_secret = uaa.get("clientsecret") or ""
            if url and uaa_url and client_id and client_secret:
                logger.info("JobSchedulerClient configured from VCAP_SERVICES (url=%s)", url)
                return cls(service_url=url, uaa_url=uaa_url, client_id=client_id, client_secret=client_secret)

        logger.info("jobscheduler service not bound or credentials incomplete (XSUAA plan expected)")
        return None

    # ------------------------------------------------------------------
    # Public - Jobs
    # ------------------------------------------------------------------
    def find_or_create_job(self, name: str, description: str, action_url: str,
                            http_method: str = "POST") -> int:
        """Return the jobId for `name`, creating the job if it doesn't exist yet."""
        cached = self._job_id_cache.get(name)
        if cached is not None:
            return cached

        found = self._request(
            "GET", "/scheduler/jobs",
            params={"filter": f"name eq '{name}'", "page_size": 10},
        )
        for job in (found or {}).get("results", []):
            if job.get("name") == name:
                job_id = job.get("jobId", job.get("_id"))
                self._job_id_cache[name] = job_id
                return job_id

        body = {
            "name": name,
            "description": description,
            "action": action_url,
            "active": True,
            "httpMethod": http_method,
            "endTime": None,
            # Required by the API ("Schedules must be an array") even though
            # we always add real schedules afterwards via create_schedule().
            "schedules": [],
        }
        created = self._request("POST", "/scheduler/jobs", json_body=body)
        job_id = created.get("jobId", created.get("_id"))
        self._job_id_cache[name] = job_id
        logger.info("Created Job Scheduling service job '%s' (jobId=%s)", name, job_id)
        return job_id

    def get_job_count(self) -> Dict[str, int]:
        """Return {"active": N, "inactive": N} for the bound service instance."""
        return self._request("GET", "/scheduler/jobCount")

    # ------------------------------------------------------------------
    # Public - Schedules
    # ------------------------------------------------------------------
    def create_schedule(self, job_id: int, *, description: str, data: Dict[str, Any],
                         cron: Optional[str] = None, time_: Optional[str] = None,
                         repeat_interval: Optional[str] = None, repeat_at: Optional[str] = None,
                         start_time: Optional[Dict[str, str]] = None, active: bool = True) -> str:
        """Create a schedule under `job_id`.

        Exactly one of cron/time_/repeat_interval/repeat_at must be given -
        the service rejects a request specifying more than one trigger mode.
        """
        modes = [m for m in (cron, time_, repeat_interval, repeat_at) if m is not None]
        if len(modes) != 1:
            raise ValueError("Exactly one of cron/time_/repeat_interval/repeat_at must be provided")

        body: Dict[str, Any] = {"active": active, "description": description, "data": data}
        if cron is not None:
            body["cron"] = cron
        if time_ is not None:
            body["time"] = time_
        if repeat_interval is not None:
            body["repeatInterval"] = repeat_interval
        if repeat_at is not None:
            body["repeatAt"] = repeat_at
        if start_time is not None:
            body["startTime"] = start_time

        created = self._request("POST", f"/scheduler/jobs/{job_id}/schedules", json_body=body)
        return created.get("scheduleId")

    def delete_schedule(self, job_id: int, schedule_id: str) -> None:
        """Delete a schedule. Best-effort: logs and swallows errors (e.g. already gone)."""
        try:
            self._request("DELETE", f"/scheduler/jobs/{job_id}/schedules/{schedule_id}")
        except Exception as e:
            logger.warning("delete_schedule(job=%s, schedule=%s) failed: %s", job_id, schedule_id, e)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------
    def _ensure_token(self) -> str:
        if self._token and time.time() < self._token_expiry:
            return self._token
        resp = requests.post(
            f"{self._uaa_url}/oauth/token",
            data={"grant_type": "client_credentials"},
            auth=(self._client_id, self._client_secret),
            verify=self._verify,
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        self._token = data["access_token"]
        self._token_expiry = time.time() + int(data.get("expires_in", 3600)) - 60
        return self._token

    def _request(self, method: str, path: str, *, params: Optional[Dict[str, Any]] = None,
                 json_body: Optional[Dict[str, Any]] = None) -> Any:
        token = self._ensure_token()
        url = f"{self._service_url}{path}"
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        resp = requests.request(
            method, url, headers=headers, params=params, json=json_body,
            verify=self._verify, timeout=30,
        )
        if resp.status_code in (429, 503):
            retry_after = float(resp.headers.get("retry-after", resp.headers.get("Retry-After", 5)))
            raise JobSchedulerRateLimitError(retry_after)
        resp.raise_for_status()
        if not resp.content:
            return {}
        return resp.json()
