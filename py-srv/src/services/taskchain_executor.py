"""Taskchain Executor with optional DSP integration.

For this repo (option A), DSP execution is optional; when DSPHandler isn't available,
execution endpoints will return errors.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import json
import time
import uuid
from pathlib import Path
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any, Callable, Dict, Optional


logger = logging.getLogger(__name__)


def _ensure_thirdparty_on_syspath() -> None:
    # When running via unit tests or alternative entrypoints, app.py may not
    # have inserted the thirdparty folder into sys.path yet.
    # Find the nearest '<something>/thirdparty/metasphere' by walking upwards.
    here = os.path.abspath(os.path.dirname(__file__))
    thirdparty_dir: str | None = None
    for depth in range(0, 8):
        candidate = os.path.abspath(os.path.join(here, *(".." for _ in range(depth)), "thirdparty"))
        if os.path.isdir(os.path.join(candidate, "metasphere")):
            thirdparty_dir = candidate
            break

    if thirdparty_dir and thirdparty_dir not in sys.path:
        sys.path.insert(0, thirdparty_dir)


_ensure_thirdparty_on_syspath()

try:
    # Importing via `thirdparty.metasphere` can execute `metasphere/__init__.py`
    # under the wrong module name, which breaks absolute imports inside thirdparty.
    # Prefer importing the package as `metasphere.*` when thirdparty is on sys.path.
    from metasphere.src.dsp.dsp_handler_v2 import DSPHandler  # type: ignore

    DSP_AVAILABLE = True
except Exception as e:
    logger.warning("DSPHandler not available (metasphere import failed): %s", e)
    try:
        # Last-resort fallback for environments where `thirdparty` is a package.
        from thirdparty.metasphere.src.dsp.dsp_handler_v2 import DSPHandler  # type: ignore

        DSP_AVAILABLE = True
    except Exception as e2:
        logger.warning("DSPHandler not available (thirdparty.metasphere import failed): %s", e2)
        DSP_AVAILABLE = False
        DSPHandler = None  # type: ignore


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
        elif DSP_AVAILABLE:
            logger.info("TaskchainExecutor initialized with DSP support")
        else:
            logger.warning("DSPHandler not available - DSP execution disabled")

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

        if not DSP_AVAILABLE:
            raise RuntimeError("DSP not available - cannot execute real taskchains")

        assert DSPHandler is not None

        creds = self._get_dsp_cli_credentials()

        dsp = DSPHandler(**creds)

        logid = dsp.launch_task_chain(spaceid, taskchain_name)
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

        if not DSP_AVAILABLE:
            raise RuntimeError("DSP not available")

        assert DSPHandler is not None

        spaceid, logid = self.parse_execution_id(execution_id)
        if not spaceid or not logid:
            raise ValueError("Invalid execution_id format")

        creds = self._get_dsp_cli_credentials()

        dsp = DSPHandler(**creds)
        raw_status = dsp.get_chain_status(spaceid, logid)

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
    def _get_dsp_cli_credentials() -> Dict[str, str]:
        """Return DSP CLI credentials.

        Priority:
        1) Env vars (CF-friendly)
        2) Local file `dsp_credentials.json` next to `py-srv/app.py` (dev-friendly)
        """

        client_id = os.environ.get("DSP_CLIENT_ID")
        client_secret = os.environ.get("DSP_CLIENT_SECRET")
        hostname = os.environ.get("DSP_HOSTNAME")
        if client_id and client_secret and hostname:
            return {"client_id": client_id, "client_secret": client_secret, "hostname": hostname}

        # Local dev fallback (never on Cloud Foundry)
        if os.environ.get("VCAP_APPLICATION") or os.environ.get("CF_INSTANCE_INDEX"):
            raise RuntimeError(
                "DSP credentials missing (DSP_CLIENT_ID/DSP_CLIENT_SECRET/DSP_HOSTNAME). "
                "Refusing to read dsp_credentials.json on Cloud Foundry."
            )

        try:
            # taskchain_executor.py -> src/services -> src -> py-srv
            py_srv_dir = Path(__file__).resolve().parents[2]
            creds_path = py_srv_dir / "dsp_credentials.json"
            if creds_path.exists():
                data = json.loads(creds_path.read_text(encoding="utf-8"))
                file_client_id = (data.get("client_id") or "").strip()
                file_client_secret = (data.get("client_secret") or "").strip()
                file_hostname = (data.get("hostname") or "").strip()
                if file_client_id and file_client_secret and file_hostname:
                    return {
                        "client_id": file_client_id,
                        "client_secret": file_client_secret,
                        "hostname": file_hostname,
                    }
        except Exception:
            # Keep error surfaced as "missing credentials" below.
            pass

        raise RuntimeError("DSP credentials missing (DSP_CLIENT_ID/DSP_CLIENT_SECRET/DSP_HOSTNAME or dsp_credentials.json)")

    def list_executions(self, limit: int = 50) -> list[Dict[str, Any]]:
        with self._lock:
            items = list(self._executions.values())
        items.sort(key=lambda e: e.created_at, reverse=True)
        return [e.to_dict() for e in items[:limit]]
