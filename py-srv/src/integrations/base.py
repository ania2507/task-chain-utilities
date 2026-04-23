"""Base abstractions for external job integrations."""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, Optional


class IntegrationType(Enum):
    """Supported integration backends."""
    IBP = "ibp"
    SAC = "sac"


class JobStatus(Enum):
    """Normalised job status across all integrations."""
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    UNKNOWN = "UNKNOWN"


@dataclass
class JobReference:
    """Opaque handle returned after launching a remote job.

    ``integration_type`` + ``remote_id`` uniquely identify a running job.
    ``details`` carries any integration-specific metadata (log handles, etc.).
    """
    integration_type: IntegrationType
    remote_id: str
    details: Dict[str, Any] = field(default_factory=dict)


class BaseJobClient(abc.ABC):
    """Contract every integration client must fulfil."""

    @property
    @abc.abstractmethod
    def integration_type(self) -> IntegrationType:
        """Return the integration type this client handles."""

    @abc.abstractmethod
    def launch_job(self, params: Dict[str, Any]) -> JobReference:
        """Start a job on the remote system.

        Parameters
        ----------
        params : dict
            Integration-specific parameters.  The route layer is responsible
            for validating that the right keys are present.

        Returns
        -------
        JobReference
            A handle the caller uses to poll / cancel the job.

        Raises
        ------
        RuntimeError
            If the remote system rejects the request.
        """

    @abc.abstractmethod
    def get_job_status(self, ref: JobReference) -> Dict[str, Any]:
        """Poll the remote system for the current job status.

        Returns
        -------
        dict
            Must contain at least ``{"status": "<JobStatus.value>"}``.
            May contain extra integration-specific fields.
        """

    @abc.abstractmethod
    def cancel_job(self, ref: JobReference) -> Dict[str, Any]:
        """Request cancellation of the remote job (best-effort).

        Returns
        -------
        dict
            Confirmation / error detail from the remote system.
        """

    def check_health(self) -> Dict[str, Any]:
        """Optional health/connectivity check.

        Default returns ``{"status": "ok"}``; override for real pings.
        """
        return {"status": "ok", "integration": self.integration_type.value}
