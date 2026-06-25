"""Taskchain Executor - DSP execution via BTP Destination Service."""

from __future__ import annotations

import logging
import os
import threading
import urllib.request
import json
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any, Callable, Dict, Optional


logger = logging.getLogger(__name__)

# Pending step-parameters registered by the scheduler when it fires a task
# chain run.  Keyed by taskchain name; each entry holds all steps for that
# run so multiple SAC/IBP steps in the same chain can each look up their own
# params.  Entries expire after TTL_SECONDS to avoid unbounded growth.
_PENDING_STEP_PARAMS: Dict[str, Any] = {}
_PENDING_STEP_PARAMS_LOCK = threading.Lock()
_PENDING_STEP_PARAMS_TTL: Dict[str, float] = {}
_STEP_PARAMS_TTL_SECONDS = 7200  # 2 hours — longer than any realistic task chain run


class TaskchainStatus(Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


@dataclass
class TaskchainExecution:
    execution_id: str
    taskchain_name: str
    status: TaskchainStatus
    payload: Dict[str, Any]
    created_at: datetime

    def to_dict(self) -> Dict[str, Any]:
        return {
            "execution_id": self.execution_id,
            "taskchain_name": self.taskchain_name,
            "status": self.status.value,
            "created_at": self.created_at.isoformat(),
        }


class TaskchainExecutor:
    def __init__(self):
        self._executions: Dict[str, TaskchainExecution] = {}
        self._lock = threading.Lock()

        self._simulate = os.environ.get("DSP_SIMULATE", "false").lower() == "true"

        if self._simulate:
            logger.warning("TaskchainExecutor using simulated DSP execution (DSP_SIMULATE=true)")
        else:
            logger.info("TaskchainExecutor initialized (DSP via BTP Destination)")

    @staticmethod
    def store_pending_step_params(taskchain: str, params: Dict[str, Any]) -> None:
        """Store step-level params for *taskchain* so the job-launch endpoint can pick them up."""
        with _PENDING_STEP_PARAMS_LOCK:
            _PENDING_STEP_PARAMS[taskchain] = params
            _PENDING_STEP_PARAMS_TTL[taskchain] = time.time() + _STEP_PARAMS_TTL_SECONDS
            # Evict expired entries to prevent unbounded growth.
            expired = [k for k, exp in _PENDING_STEP_PARAMS_TTL.items() if exp < time.time()]
            for k in expired:
                _PENDING_STEP_PARAMS.pop(k, None)
                _PENDING_STEP_PARAMS_TTL.pop(k, None)

    @staticmethod
    def consume_pending_step_params(taskchain: str) -> Optional[Dict[str, Any]]:
        """Return stored step params for *taskchain* without removing them.

        Params are kept so multiple steps in the same task chain can each
        read their own params.  Entries expire via TTL set in store_pending_step_params.
        """
        with _PENDING_STEP_PARAMS_LOCK:
            entry = _PENDING_STEP_PARAMS.get(taskchain)
            if entry is None:
                return None
            exp = _PENDING_STEP_PARAMS_TTL.get(taskchain, 0)
            if exp and time.time() > exp:
                _PENDING_STEP_PARAMS.pop(taskchain, None)
                _PENDING_STEP_PARAMS_TTL.pop(taskchain, None)
                return None
            return entry

    @staticmethod
    def make_execution_id(space: str, logid: str) -> str:
        return f"{space}__{logid}"

    @staticmethod
    def parse_execution_id(execution_id: str) -> tuple[Optional[str], Optional[str]]:
        parts = execution_id.split("__", 1)
        if len(parts) == 2:
            return parts[0], parts[1]
        return None, None

    def execute_async_dsp(self, spaceid: str, taskchain_name: str, payload: Dict[str, Any]) -> str:
        if self._simulate:
            execution_id = self.make_execution_id(spaceid, datetime.utcnow().strftime("%Y%m%d%H%M%S%f"))
            with self._lock:
                self._executions[execution_id] = TaskchainExecution(
                    execution_id=execution_id,
                    taskchain_name=taskchain_name,
                    status=TaskchainStatus.PENDING,
                    payload=payload,
                    created_at=datetime.utcnow(),
                )

            def _runner():
                try:
                    with self._lock:
                        if execution_id in self._executions:
                            self._executions[execution_id].status = TaskchainStatus.RUNNING
                    import time

                    time.sleep(2)
                    with self._lock:
                        if execution_id in self._executions:
                            self._executions[execution_id].status = TaskchainStatus.COMPLETED
                except Exception:
                    logger.exception("Simulated DSP execution failed")
                    with self._lock:
                        if execution_id in self._executions:
                            self._executions[execution_id].status = TaskchainStatus.FAILED

            threading.Thread(target=_runner, daemon=True).start()
            return execution_id

        # Store step params so the API-task's /v1/jobs/launch call can pick them up.
        if payload:
            TaskchainExecutor.store_pending_step_params(taskchain_name, payload)

        logid = self._dsp_run_task_chain(spaceid, taskchain_name)
        if not logid or str(logid).strip().lower() == "none":
            raise RuntimeError("DSP taskchain launch did not return a logId")
        execution_id = self.make_execution_id(spaceid, logid)

        with self._lock:
            self._executions[execution_id] = TaskchainExecution(
                execution_id=execution_id,
                taskchain_name=taskchain_name,
                status=TaskchainStatus.PENDING,
                payload=payload,
                created_at=datetime.utcnow(),
            )

        return execution_id

    def wait_async(self, duration_seconds: float, payload: Optional[Dict[str, Any]] = None) -> str:
        execution_id = f"wait__{uuid.uuid4().hex}"
        wait_payload = payload or {}
        wait_payload.setdefault("kind", "wait")
        wait_payload["duration_seconds"] = duration_seconds

        with self._lock:
            self._executions[execution_id] = TaskchainExecution(
                execution_id=execution_id,
                taskchain_name="__wait__",
                status=TaskchainStatus.PENDING,
                payload=wait_payload,
                created_at=datetime.utcnow(),
            )

        def _runner():
            try:
                with self._lock:
                    if execution_id in self._executions:
                        self._executions[execution_id].status = TaskchainStatus.RUNNING
                time.sleep(max(duration_seconds, 0))
                with self._lock:
                    if execution_id in self._executions:
                        self._executions[execution_id].status = TaskchainStatus.COMPLETED
            except Exception:
                logger.exception("Async wait failed")
                with self._lock:
                    if execution_id in self._executions:
                        self._executions[execution_id].status = TaskchainStatus.FAILED

        threading.Thread(target=_runner, daemon=True).start()
        return execution_id

    def create_dummy_execution(self, taskchain_name: str, payload: Optional[Dict[str, Any]] = None) -> str:
        execution_id = f"dummy__{uuid.uuid4().hex}"
        dummy_payload = payload or {}
        dummy_payload.setdefault("kind", "dummy")

        with self._lock:
            self._executions[execution_id] = TaskchainExecution(
                execution_id=execution_id,
                taskchain_name=taskchain_name or "__dummy__",
                status=TaskchainStatus.COMPLETED,
                payload=dummy_payload,
                created_at=datetime.utcnow(),
            )

        return execution_id

    def skip_check_async(
        self,
        taskchain_name: str,
        stepid: str,
        step_to_be_checked: str,
        payload: Optional[Dict[str, Any]] = None,
        override_check: Optional[Callable[[], bool]] = None,
        override_reset: Optional[Callable[[], None]] = None,
        step_status_check: Optional[Callable[[], Optional[str]]] = None,
    ) -> str:
        execution_id = f"skip__{uuid.uuid4().hex}"
        skip_payload = payload or {}
        skip_payload.setdefault("kind", "skip")
        skip_payload["taskchain"] = taskchain_name
        skip_payload["stepid"] = stepid
        skip_payload["steptobechecked"] = step_to_be_checked

        with self._lock:
            self._executions[execution_id] = TaskchainExecution(
                execution_id=execution_id,
                taskchain_name=taskchain_name,
                status=TaskchainStatus.PENDING,
                payload=skip_payload,
                created_at=datetime.utcnow(),
            )

        def _runner():
            try:
                with self._lock:
                    if execution_id in self._executions:
                        self._executions[execution_id].status = TaskchainStatus.RUNNING

                has_override = bool(override_check() if override_check else False)
                skip_payload["override"] = has_override

                if has_override:
                    if override_reset:
                        try:
                            override_reset()
                        except Exception:
                            logger.exception("Failed to reset skip override")
                    skip_payload["step_status"] = "OVERRIDDEN"
                    skip_payload["message"] = "Override found: step skipped"
                    final_status = TaskchainStatus.COMPLETED
                else:
                    step_status = step_status_check() if step_status_check else None
                    skip_payload["step_status"] = step_status
                    if step_status and str(step_status).strip().upper() in {"FAILED", "ERROR"}:
                        skip_payload["message"] = "Step failed and no override present"
                        final_status = TaskchainStatus.FAILED
                    else:
                        skip_payload["message"] = "Step not failed or status unavailable"
                        final_status = TaskchainStatus.COMPLETED

                with self._lock:
                    if execution_id in self._executions:
                        self._executions[execution_id].status = final_status
            except Exception as e:
                logger.exception("Skip check async failed")
                skip_payload["error"] = str(e)
                with self._lock:
                    if execution_id in self._executions:
                        self._executions[execution_id].status = TaskchainStatus.FAILED

        threading.Thread(target=_runner, daemon=True).start()
        return execution_id

    def get_status_dsp(self, execution_id: str) -> Dict[str, Any]:
        if self._simulate:
            with self._lock:
                ex = self._executions.get(execution_id)
            if not ex:
                raise ValueError("Unknown execution_id")

            spaceid, logid = self.parse_execution_id(execution_id)
            return {
                "execution_id": execution_id,
                "spaceid": spaceid,
                "logid": logid,
                "status": ex.status.value,
                "simulated": True,
            }

        spaceid, logid = self.parse_execution_id(execution_id)
        if not spaceid or not logid:
            raise ValueError("Invalid execution_id format")

        raw_status = self._dsp_get_chain_status(spaceid, logid)

        s = (raw_status or "").strip().strip('"').strip().upper()
        if "RUNNING" in s:
            status = TaskchainStatus.RUNNING.value
        elif "PENDING" in s or "QUEUED" in s:
            status = TaskchainStatus.PENDING.value
        elif "COMPLETED" in s or "SUCCESS" in s or "FINISHED" in s:
            status = TaskchainStatus.COMPLETED.value
        elif "FAILED" in s or "ERROR" in s:
            status = TaskchainStatus.FAILED.value
        else:
            status = s or TaskchainStatus.FAILED.value

        return {"execution_id": execution_id, "spaceid": spaceid, "logid": logid, "status": status}

    def get_status(self, execution_id: str) -> Dict[str, Any]:
        with self._lock:
            ex = self._executions.get(execution_id)

        if ex and ex.payload.get("kind") == "wait":
            return {
                "execution_id": execution_id,
                "status": ex.status.value,
                "kind": "wait",
                "duration_seconds": ex.payload.get("duration_seconds"),
            }

        if ex and ex.payload.get("kind") == "dummy":
            return {
                "execution_id": execution_id,
                "status": ex.status.value,
                "kind": "dummy",
                "taskchain": ex.taskchain_name,
            }

        if ex and ex.payload.get("kind") == "skip":
            return {
                "execution_id": execution_id,
                "status": ex.status.value,
                "kind": "skip",
                "taskchain": ex.payload.get("taskchain"),
                "stepid": ex.payload.get("stepid"),
                "steptobechecked": ex.payload.get("steptobechecked"),
                "override": ex.payload.get("override"),
                "step_status": ex.payload.get("step_status"),
                "message": ex.payload.get("message"),
                "error": ex.payload.get("error"),
            }

        return self.get_status_dsp(execution_id)

    @staticmethod
    def _get_dsp_connection() -> Dict[str, str]:
        """Return DSP base URL and access token via BTP Destination Service."""
        from ..integrations.dsp import DSPDestinationClient

        client = DSPDestinationClient.from_env()
        if not client:
            raise RuntimeError(
                "DSP destination not configured. Set DSP_DESTINATION_NAME and bind Destination Service."
            )
        conn = client.get_connection()
        base_url = (conn.get("host") or "").rstrip("/")
        access_token = conn.get("access_token") or ""
        if not base_url:
            raise RuntimeError("DSP destination has no target URL configured")
        if not access_token:
            raise RuntimeError("DSP destination did not return an auth token")
        return {"base_url": base_url, "access_token": access_token}

    @staticmethod
    def _dsp_run_task_chain(spaceid: str, taskchain_name: str) -> str:
        """Launch a DSP task chain via the directexecute endpoint and return the logId.

        DSP's native scheduler uses applicationId=TASK_CHAINS, activity=RUN_CHAIN
        on /dwaas-core/tf/directexecute. The REST path
        /api/v1/tasks/spaces/{space}/chains/{name} returns 404 in this tenant.
        """
        conn = TaskchainExecutor._get_dsp_connection()
        url = f"{conn['base_url']}/dwaas-core/tf/directexecute"
        body = json.dumps({
            "applicationId": "TASK_CHAINS",
            "spaceId": spaceid,
            "objectId": taskchain_name,
            "activity": "RUN_CHAIN",
        }).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Authorization": f"Bearer {conn['access_token']}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
        try:
            data = json.loads(raw) if raw else {}
        except Exception:
            data = {"raw": raw}
        # directexecute returns various shapes; try common keys for the log/run id
        logid = (
            data.get("logId")
            or data.get("taskLogId")
            or data.get("logID")
            or data.get("id")
            or (data.get("result") or {}).get("logId")
            if isinstance(data, dict) else None
        )
        if not logid:
            raise RuntimeError(f"DSP task chain launch did not return a logId. Response: {data}")
        return str(logid)

    @staticmethod
    def _dsp_get_chain_status(spaceid: str, logid: str) -> str:
        """Get the status of a DSP task chain execution via REST API."""
        conn = TaskchainExecutor._get_dsp_connection()
        url = f"{conn['base_url']}/api/v1/tasks/spaces/{spaceid}/logs/{logid}"
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {conn['access_token']}",
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data.get("status", "")

    def list_executions(self, limit: int = 50) -> list[Dict[str, Any]]:
        with self._lock:
            items = list(self._executions.values())
        items.sort(key=lambda e: e.created_at, reverse=True)
        return [e.to_dict() for e in items[:limit]]
