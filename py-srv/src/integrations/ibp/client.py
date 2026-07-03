"""IBP Application Job client.

Uses the SAP ``BC_EXT_APPJOB_MANAGEMENT;v=0002`` OData service to:
    • read template metadata  (``JobTemplateRead``)
    • schedule a job          (``JobSchedule``)
    • poll job status/logs    (``JobHeaderSet`` with ``$expand``)
    • cancel a running job    (``JobCancel``)

All HTTP interactions go through the helper ``_ODataSession`` which
handles CSRF token fetching and cookie persistence automatically.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional
from urllib.parse import quote

import requests

from ..base import BaseJobClient, IntegrationType, JobReference, JobStatus

logger = logging.getLogger(__name__)

_SERVICE_PATH = "/sap/opu/odata/sap/BC_EXT_APPJOB_MANAGEMENT;v=0002"


class _ODataSession:
    """Thin wrapper that keeps a CSRF token + cookies alive."""

    def __init__(
        self,
        host: str,
        user: str | None = None,
        password: str | None = None,
        *,
        bearer_token: str | None = None,
        verify_ssl: bool = True,
    ):
        self._host = host.rstrip("/")
        self._session = requests.Session()
        if bearer_token:
            self._session.headers.update({"Authorization": f"Bearer {bearer_token}"})
        elif user and password:
            self._session.auth = (user, password)
        else:
            raise ValueError("IBP client requires either user/password or bearer_token")
        self._session.verify = verify_ssl
        self._session.headers.update({"Accept": "application/json"})
        self._csrf_token: Optional[str] = None

    @property
    def base_url(self) -> str:
        return f"{self._host}{_SERVICE_PATH}"

    def _fetch_csrf(self) -> str:
        resp = self._session.get(
            f"{self.base_url}/",
            headers={"X-CSRF-Token": "Fetch"},
            timeout=30,
        )
        resp.raise_for_status()
        token = resp.headers.get("x-csrf-token", "")
        if not token:
            raise RuntimeError("IBP: failed to obtain CSRF token")
        self._csrf_token = token
        return token

    def get(self, path: str, **kwargs) -> requests.Response:
        url = f"{self.base_url}/{path.lstrip('/')}"
        resp = self._session.get(url, timeout=60, **kwargs)
        resp.raise_for_status()
        return resp

    def post(self, path: str, **kwargs) -> requests.Response:
        if not self._csrf_token:
            self._fetch_csrf()
        url = f"{self.base_url}/{path.lstrip('/')}"
        headers = kwargs.pop("headers", {})
        headers["X-CSRF-Token"] = self._csrf_token
        resp = self._session.post(url, headers=headers, timeout=120, **kwargs)
        if resp.status_code == 403:
            # Token may have expired – retry once.
            self._fetch_csrf()
            headers["X-CSRF-Token"] = self._csrf_token
            resp = self._session.post(url, headers=headers, timeout=120, **kwargs)
        if not resp.ok:
            raise requests.HTTPError(
                f"{resp.status_code} {resp.reason} for url: {resp.url} | IBP response: {resp.text[:500]}",
                response=resp,
            )
        return resp


def _build_param_values_json(parameters: list[Dict[str, Any]]) -> str:
    """Convert a user-friendly parameter list into the IBP ``JobParameterValues`` JSON string.

    Expected input format::

        [
            {"name": "P_AREA", "values": [{"low": "Z1DUNIFPA"}]},
            {"name": "S_VERS", "values": [
                {"low": "__BASELINE", "sign": "I", "option": "EQ"}
            ]},
        ]

    Missing ``sign`` / ``option`` / ``high`` default to ``I`` / ``EQ`` / ``""``.
    """
    entries = []
    for p in parameters:
        # Accept both IBP format {"name":...} and our UI format {"key":...}
        name = p.get("name") or p.get("key")
        if not name:
            continue
        t_values = []
        for v in p.get("values", []):
            t_values.append({
                "SIGN": v.get("sign", "I"),
                "OPTION": v.get("option", "EQ"),
                "LOW": str(v.get("low", "")),
                "HIGH": str(v.get("high", "")),
            })
        if not t_values:
            raw_val = p.get("value") if p.get("value") is not None else p.get("low", "")
            t_values.append({"SIGN": "I", "OPTION": "EQ", "LOW": str(raw_val), "HIGH": ""})
        entries.append({"NAME": name, "T_VALUE": t_values})
    return json.dumps({"VALUES": entries}, separators=(",", ":"))


class IBPJobClient(BaseJobClient):
    """Concrete integration for SAP IBP Application Jobs."""

    def __init__(
        self,
        host: str,
        user: str | None = None,
        password: str | None = None,
        *,
        bearer_token: str | None = None,
        verify_ssl: bool = True,
    ):
        self._odata = _ODataSession(
            host,
            user,
            password,
            bearer_token=bearer_token,
            verify_ssl=verify_ssl,
        )

    @property
    def integration_type(self) -> IntegrationType:
        return IntegrationType.IBP

    # ------------------------------------------------------------------
    # Template helpers
    # ------------------------------------------------------------------

    def list_templates(self) -> list[Dict[str, Any]]:
        """Return all IBP job templates as [{"name": ..., "description": ...}, …].

        Used to populate a match-code / value-help picker so users don't need
        to already know the exact technical template name.
        """
        resp = self._odata.get("JobTemplateSet?$format=json")
        results = resp.json().get("d", {}).get("results", [])
        templates = [
            {
                "name": r.get("JobTemplateName", ""),
                "description": r.get("JobTemplateText") or r.get("Text") or "",
            }
            for r in results
            if r.get("JobTemplateName")
        ]
        templates.sort(key=lambda t: t["description"] or t["name"])
        return templates

    def read_template(self, template_name: str) -> Dict[str, Any]:
        """Return parsed template metadata (sequences, parameters, …)."""
        path = f"JobTemplateRead?JobTemplateName='{quote(template_name, safe='')}'"
        resp = self._odata.get(path)
        data = resp.json()
        d = data.get("d", {})
        raw = d.get("TemplateData", "{}")
        parsed = json.loads(raw)
        # Inject the full OData entity keys (excluding TemplateData) so callers
        # can inspect additional fields (e.g. selection condition texts, global var descriptions)
        parsed["_odata_extra"] = {
            k: v for k, v in d.items()
            if k not in ("TemplateData", "__metadata") and not isinstance(v, dict)
        }
        return parsed

    # ------------------------------------------------------------------
    # BaseJobClient interface
    # ------------------------------------------------------------------

    def launch_job(self, params: Dict[str, Any]) -> JobReference:
        """Schedule an IBP application job template.

        Required ``params`` keys:
            • ``template_name``  – e.g. ``"SAP_IBP_PROC_COPY_OPERATOR"``
            • ``job_text``       – human-readable job name
            • ``job_user``       – SAP user that owns the scheduled job

        Optional:
            • ``parameters``     – list of param dicts (see ``_build_param_values_json``)
            • ``test_mode``      – bool (default ``False``)
        """
        # DSP represents an unset payload field as an empty list (e.g. "job_text": []),
        # not as a missing key or empty string — coerce any non-string value to "" so
        # it's treated as absent rather than crashing quote() downstream.
        def _as_str(v):
            return v if isinstance(v, str) else ""

        template_name = _as_str(params.get("template_name"))
        job_user = _as_str(params.get("job_user"))
        test_mode = str(params.get("test_mode", False)).lower()
        job_parameters = params.get("parameters", [])

        if not template_name:
            raise ValueError("IBP: 'template_name' is required")
        if not job_user:
            raise ValueError("IBP: 'job_user' is required")

        # JobText always mirrors the template being launched, so IBP's job history
        # shows at a glance which template ran — regardless of what (if anything)
        # was supplied for job_text.
        job_text = template_name

        param_json = _build_param_values_json(job_parameters) if job_parameters else ""

        path = (
            f"JobSchedule?"
            f"JobTemplateName='{quote(template_name, safe='')}'"
            f"&JobText='{quote(job_text, safe='')}'"
            f"&JobUser='{quote(job_user, safe='')}'"
            f"&TestModeInd={test_mode}"
            f"&JobParameterValues='{quote(param_json, safe='')}'"
        )

        resp = self._odata.post(path)
        data = resp.json().get("d", {})

        job_name = data.get("JobName", "")
        job_run_count = data.get("JobRunCount", "")

        if not job_name:
            raise RuntimeError(f"IBP JobSchedule did not return a JobName. Response: {data}")

        return JobReference(
            integration_type=IntegrationType.IBP,
            remote_id=f"{job_name}:{job_run_count}",
            details={
                "job_name": job_name,
                "job_run_count": job_run_count,
                "template_name": template_name,
                "job_text": job_text,
            },
        )

    def get_job_status(self, ref: JobReference) -> Dict[str, Any]:
        """Poll IBP for job header + step + log info."""
        job_name, job_run_count = ref.remote_id.split(":", 1)

        path = (
            f"JobHeaderSet(JobName='{quote(job_name, safe='')}'"
            f",JobRunCount='{quote(job_run_count, safe='')}')"
            f"?$expand=JobStepSet/JobStepLogInfoSet/JobLogMessageSet&$format=json"
        )

        resp = self._odata.get(path)
        data = resp.json().get("d", {})

        raw_status = (data.get("JobStatus") or "").strip().upper()
        status = self._map_status(raw_status)

        steps = []
        for step in (data.get("JobStepSet", {}).get("results", [])):
            raw_step_status = (step.get("StepStatus") or "").strip().upper()
            step_status = self._map_status(raw_step_status)
            logger.warning(
                "[DIAG][ibp-status] job=%s:%s raw_job_status=%r step_number=%r raw_step_status=%r "
                "mapped_step_status=%s app_rc=%r",
                job_name, job_run_count, raw_status, step.get("StepNumber"),
                raw_step_status, step_status.value, step.get("StepAppRC"),
            )
            step_info: Dict[str, Any] = {
                "step_number": step.get("StepNumber"),
                "catalog_entry": step.get("JobCatalogEntryName"),
                "status": step_status.value,
                "app_rc": step.get("StepAppRC"),
            }
            logs = []
            for log_info in (step.get("JobStepLogInfoSet", {}).get("results", [])):
                messages = []
                for msg in (log_info.get("JobLogMessageSet", {}).get("results", [])):
                    messages.append({
                        "type": msg.get("MsgType"),
                        "text": msg.get("MsgText"),
                        "id": msg.get("MsgId"),
                        "number": msg.get("MsgNo"),
                    })
                logs.append({
                    "log_handle": log_info.get("LogHandle"),
                    "severity": log_info.get("SeverityText"),
                    "msg_count": log_info.get("MsgCntAll"),
                    "messages": messages,
                })
            step_info["logs"] = logs
            steps.append(step_info)
            if logs:
                logger.warning("[DIAG][ibp-status] job=%s:%s step_logs=%s", job_name, job_run_count, logs)

        # The top-level JobStatus can lag behind (e.g. stay RUNNING/UNKNOWN) even
        # after a step has aborted on a bad parameter value, since IBP doesn't
        # always flip the job header to a terminal state right away. Treat any
        # failed/cancelled step as authoritative so DSP doesn't poll forever.
        if status not in (JobStatus.COMPLETED,) and any(
            s["status"] in (JobStatus.FAILED.value, JobStatus.CANCELLED.value) for s in steps
        ):
            status = JobStatus.FAILED

        return {
            "status": status.value,
            "integration": IntegrationType.IBP.value,
            "job_name": job_name,
            "job_run_count": job_run_count,
            "job_text": data.get("JobText"),
            "template": data.get("JobTemplateName"),
            "created_by": data.get("JobCreatedBy"),
            "start_time": data.get("JobStartDateTime"),
            "end_time": data.get("JobEndDateTime"),
            "steps": steps,
        }

    def cancel_job(self, ref: JobReference) -> Dict[str, Any]:
        """Cancel an IBP application job."""
        job_name, job_run_count = ref.remote_id.split(":", 1)

        path = (
            f"JobCancel?"
            f"JobName='{quote(job_name, safe='')}'"
            f"&JobRunCount='{quote(job_run_count, safe='')}'"
        )

        resp = self._odata.post(path)
        return {
            "cancelled": True,
            "job_name": job_name,
            "job_run_count": job_run_count,
        }

    def check_health(self) -> Dict[str, Any]:
        try:
            self._odata.get("/")
            return {"status": "ok", "integration": IntegrationType.IBP.value}
        except Exception as e:
            return {"status": "error", "integration": IntegrationType.IBP.value, "error": str(e)}

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    @staticmethod
    def _map_status(raw: str) -> JobStatus:
        """Map IBP 1-char job status to normalized ``JobStatus``."""
        # IBP uses single-char codes: F=Finished, A=Aborted, R=Released/Running, …
        # Also handle textual statuses from the API.
        if raw in {"F", "FINISHED", "COMPLETED", "SUCCESS"}:
            return JobStatus.COMPLETED
        if raw in {"A", "ABORTED", "FAILED", "ERROR"}:
            return JobStatus.FAILED
        if raw in {"R", "RUNNING", "ACTIVE"}:
            return JobStatus.RUNNING
        if raw in {"P", "RELEASED", "SCHEDULED", "READY", "PENDING", "QUEUED"}:
            return JobStatus.PENDING
        if raw in {"C", "CANCELLED", "CANCELED"}:
            return JobStatus.CANCELLED
        return JobStatus.UNKNOWN
