"""Integration layer – abstract base and registry for external job systems.

Every concrete integration (IBP, SAC, …) must subclass ``BaseJobClient``
and implement the three async-friendly methods:
    • launch_job   → trigger a remote job, return a job reference
    • get_job_status → poll the remote system for current status
    • cancel_job    → request cancellation (best-effort)

The ``IntegrationType`` enum is the single source of truth for supported
integration types.  Route / service code should never hard-code type strings.
"""

from __future__ import annotations

from .base import BaseJobClient, IntegrationType, JobReference, JobStatus

__all__ = [
    "BaseJobClient",
    "IntegrationType",
    "JobReference",
    "JobStatus",
]
