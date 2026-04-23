"""Job Executor service – integration-agnostic orchestrator.

Wraps one or more ``BaseJobClient`` implementations behind a single
interface that the route layer can call without caring about the
concrete integration type.

Keeps an in-memory registry of running jobs so the caller can poll
status by a local ``execution_id`` instead of having to know the
remote system's identifiers.
"""

from __future__ import annotations

import logging
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional

from ..integrations.base import BaseJobClient, IntegrationType, JobReference, JobStatus

logger = logging.getLogger(__name__)


@dataclass
class JobExecution:
    """Local tracking record for a job launched on any integration."""
    execution_id: str
    integration_type: IntegrationType
    ref: JobReference
    params: Dict[str, Any]
    status: JobStatus
    created_at: datetime
    last_checked: Optional[datetime] = None
    remote_details: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "execution_id": self.execution_id,
            "integration": self.integration_type.value,
            "remote_id": self.ref.remote_id,
            "status": self.status.value,
            "created_at": self.created_at.isoformat(),
            "last_checked": self.last_checked.isoformat() if self.last_checked else None,
            "details": self.ref.details,
        }


class JobExecutor:
    """Facade over multiple integration clients."""

    def __init__(self):
        self._clients: Dict[IntegrationType, BaseJobClient] = {}
        self._executions: Dict[str, JobExecution] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Client registration
    # ------------------------------------------------------------------

    def register_client(self, client: BaseJobClient) -> None:
        self._clients[client.integration_type] = client
        logger.info("Registered integration client: %s", client.integration_type.value)

    def has_client(self, integration_type: IntegrationType) -> bool:
        return integration_type in self._clients

    def get_client(self, integration_type: IntegrationType) -> BaseJobClient:
        client = self._clients.get(integration_type)
        if not client:
            raise ValueError(
                f"No client registered for integration '{integration_type.value}'. "
                f"Available: {[c.value for c in self._clients]}"
            )
        return client

    # ------------------------------------------------------------------
    # Launch
    # ------------------------------------------------------------------

    def launch(self, integration: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """Launch a job on the specified integration.

        Parameters
        ----------
        integration : str
            One of ``IntegrationType`` values (``"ibp"``, ``"sac"``).
        params : dict
            Integration-specific parameters forwarded to the client.

        Returns
        -------
        dict
            ``{ execution_id, integration, remote_id, status }``
        """
        itype = IntegrationType(integration.strip().lower())
        client = self.get_client(itype)

        ref = client.launch_job(params)

        execution_id = f"{itype.value}__{uuid.uuid4().hex}"
        execution = JobExecution(
            execution_id=execution_id,
            integration_type=itype,
            ref=ref,
            params=params,
            status=JobStatus.PENDING,
            created_at=datetime.utcnow(),
        )

        with self._lock:
            self._executions[execution_id] = execution

        logger.info(
            "Job launched: execution_id=%s integration=%s remote_id=%s",
            execution_id, itype.value, ref.remote_id,
        )

        return {
            "execution_id": execution_id,
            "integration": itype.value,
            "remote_id": ref.remote_id,
            "status": JobStatus.PENDING.value,
            "details": ref.details,
        }

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    def get_status(self, execution_id: str) -> Dict[str, Any]:
        """Poll the remote system and return the latest status."""
        with self._lock:
            execution = self._executions.get(execution_id)

        if not execution:
            raise ValueError(f"Unknown execution_id: {execution_id}")

        client = self.get_client(execution.integration_type)

        try:
            remote_status = client.get_job_status(execution.ref)
        except Exception:
            logger.exception("Failed to poll status for %s", execution_id)
            raise

        new_status_str = remote_status.get("status", JobStatus.UNKNOWN.value)
        try:
            new_status = JobStatus(new_status_str)
        except ValueError:
            new_status = JobStatus.UNKNOWN

        with self._lock:
            execution.status = new_status
            execution.last_checked = datetime.utcnow()
            execution.remote_details = remote_status

        return {
            "execution_id": execution_id,
            **remote_status,
        }

    # ------------------------------------------------------------------
    # Cancel
    # ------------------------------------------------------------------

    def cancel(self, execution_id: str) -> Dict[str, Any]:
        """Cancel a running job."""
        with self._lock:
            execution = self._executions.get(execution_id)

        if not execution:
            raise ValueError(f"Unknown execution_id: {execution_id}")

        client = self.get_client(execution.integration_type)
        result = client.cancel_job(execution.ref)

        with self._lock:
            execution.status = JobStatus.CANCELLED
            execution.last_checked = datetime.utcnow()

        return {"execution_id": execution_id, **result}

    # ------------------------------------------------------------------
    # List
    # ------------------------------------------------------------------

    def list_executions(
        self,
        *,
        integration: Optional[str] = None,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        with self._lock:
            items = list(self._executions.values())

        if integration:
            itype = IntegrationType(integration.strip().lower())
            items = [e for e in items if e.integration_type == itype]

        items.sort(key=lambda e: e.created_at, reverse=True)
        return [e.to_dict() for e in items[:limit]]

    # ------------------------------------------------------------------
    # Health
    # ------------------------------------------------------------------

    def check_health(self) -> Dict[str, Any]:
        results = {}
        for itype, client in self._clients.items():
            try:
                results[itype.value] = client.check_health()
            except Exception as e:
                results[itype.value] = {"status": "error", "error": str(e)}
        return {"integrations": results}
