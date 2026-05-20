"""Scheduler service - APScheduler-based cron orchestrator.

Loads active schedules from the HDI container at startup and registers
one APScheduler job per schedule.  Each job, when fired, dispatches to the
appropriate executor (DSP / IBP / SAC) and writes a ScheduleRun record.

The CAP layer notifies us via POST /v1/scheduler/sync whenever schedules
change, so we re-read the table and rebuild the job set.
"""

from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

try:
    from apscheduler.schedulers.background import BackgroundScheduler
    from apscheduler.triggers.cron import CronTrigger
    _APS_AVAILABLE = True
except Exception:
    BackgroundScheduler = None  # type: ignore
    CronTrigger = None  # type: ignore
    _APS_AVAILABLE = False

try:
    from croniter import croniter
    _CRON_AVAILABLE = True
except Exception:
    croniter = None  # type: ignore
    _CRON_AVAILABLE = False

try:
    from zoneinfo import ZoneInfo
except Exception:
    ZoneInfo = None  # type: ignore

from ..repository.schedule_repository import ScheduleRepository

logger = logging.getLogger(__name__)


class SchedulerService:
    """APScheduler facade for taskchain/job scheduling."""

    def __init__(
        self,
        repo: ScheduleRepository,
        taskchain_executor=None,
        job_executor=None,
    ):
        self._repo = repo
        self._tc_exec = taskchain_executor
        self._job_exec = job_executor
        self._lock = threading.Lock()

        if not _APS_AVAILABLE:
            logger.warning("APScheduler not installed - SchedulerService runs in disabled mode")
            self._scheduler = None
            return

        self._scheduler = BackgroundScheduler()
        self._scheduler.start()
        logger.info("SchedulerService started (APScheduler BackgroundScheduler)")

    # ------------------------------------------------------------------
    def sync(self, payload_schedules=None) -> Dict[str, Any]:
        """Reload schedules and rebuild jobs.

        If ``payload_schedules`` is provided (list of dicts), it overrides the
        repository read.  Useful when CAP pushes the authoritative state
        (e.g. sqlite-backed local dev).
        """
        if not self._scheduler:
            return {"status": "disabled", "loaded": 0}

        with self._lock:
            for job in list(self._scheduler.get_jobs()):
                try:
                    self._scheduler.remove_job(job.id)
                except Exception:
                    pass

            if payload_schedules is not None:
                schedules = [s for s in payload_schedules if s.get("isActive")]
                # Mirror into in-memory repo so run-now works without a payload
                if hasattr(self._repo, "_mem_schedules"):
                    self._repo._mem_schedules = {s["ID"]: s for s in payload_schedules if s.get("ID")}
            else:
                schedules = self._repo.list_active()

            loaded = 0
            errors: List[str] = []
            for sch in schedules:
                try:
                    self._register(sch)
                    loaded += 1
                except Exception as e:
                    logger.exception("Failed to register schedule %s", sch.get("ID"))
                    errors.append(f"{sch.get('ID')}: {e}")

            # Also register persisted Custom Calendar / On-Demand entries
            # (one-shot date triggers stored in HDI).
            cal_loaded = 0
            try:
                cal_loaded = self._register_calendar_entries()
            except Exception as e:
                logger.exception("Failed to register calendar entries")
                errors.append(f"calendar: {e}")

            logger.info(
                "Scheduler sync complete: %d cron schedules + %d calendar entries loaded",
                loaded, cal_loaded,
            )
            return {"status": "ok", "loaded": loaded, "calendar_loaded": cal_loaded, "errors": errors}

    def _register_calendar_entries(self) -> int:
        """Register one-shot APScheduler jobs for active CalendarEntry rows."""
        if not self._scheduler or not hasattr(self._repo, "list_active_calendar_entries"):
            return 0
        entries = self._repo.list_active_calendar_entries() or []
        now = datetime.now(timezone.utc)
        count = 0
        for e in entries:
            try:
                space_id = e.get("spaceId")
                taskchain = e.get("taskchain")
                run_date = e.get("runDate")  # YYYY-MM-DD
                run_time = e.get("runTime") or "00:00"  # HH:mm
                tz = e.get("timezone") or "Europe/Rome"
                if not (space_id and taskchain and run_date):
                    continue
                iso = f"{run_date}T{run_time}:00"
                run_at = datetime.fromisoformat(iso)
                if run_at.tzinfo is None and ZoneInfo:
                    run_at = run_at.replace(tzinfo=ZoneInfo(tz))
                if run_at <= now:
                    continue
                params = None
                if e.get("parameters"):
                    try:
                        params = json.loads(e["parameters"])
                    except Exception:
                        params = None
                job_id = f"cal::{e.get('ID') or (space_id + '::' + taskchain + '::' + iso)}"
                sch = {
                    "ID": job_id,
                    "targetType": "DSP",
                    "spaceId": space_id,
                    "taskchain": taskchain,
                    "parameters": json.dumps(params) if params else None,
                }
                if hasattr(self._repo, "_mem_schedules"):
                    self._repo._mem_schedules[job_id] = sch
                self._scheduler.add_job(
                    self._fire,
                    trigger="date",
                    run_date=run_at,
                    id=job_id,
                    kwargs={"schedule_id": job_id, "manual": False, "schedule": sch},
                    replace_existing=True,
                    misfire_grace_time=300,
                )
                count += 1
            except Exception:
                logger.exception("Failed to register calendar entry %s", e.get("ID"))
        return count

    def _register(self, schedule: Dict[str, Any]) -> None:
        if not self._scheduler:
            return
        sched_id = schedule["ID"]
        cron = (schedule.get("cronExpression") or "").strip()
        if not cron:
            raise ValueError("empty cron expression")
        tz = schedule.get("timezone") or "Europe/Rome"

        trigger = CronTrigger.from_crontab(cron, timezone=tz)
        self._scheduler.add_job(
            self._fire,
            trigger=trigger,
            id=sched_id,
            kwargs={"schedule_id": sched_id, "manual": False},
            replace_existing=True,
            misfire_grace_time=300,
        )

        # Persist next run time
        try:
            next_dt = trigger.get_next_fire_time(None, datetime.now(tz=ZoneInfo(tz) if ZoneInfo else timezone.utc))
            self._repo.update_run_state(
                sched_id,
                last_run_at=None,
                last_run_status=schedule.get("lastRunStatus"),
                next_run_at=next_dt.isoformat() if next_dt else None,
            )
        except Exception:
            pass

    # ------------------------------------------------------------------
    def run_now(self, schedule_id: str, schedule_payload=None) -> Dict[str, Any]:
        """Trigger a schedule immediately, regardless of cron.

        Accepts an optional ``schedule_payload`` (CAP-pushed dict) so the
        py-srv can fire jobs even when its own repo is empty (local dev).
        """
        sch = schedule_payload or self._repo.get(schedule_id)
        if not sch:
            raise ValueError(f"Schedule {schedule_id} not found")
        if hasattr(self._repo, "_mem_schedules") and schedule_payload:
            self._repo._mem_schedules[schedule_id] = schedule_payload
        return self._fire(schedule_id=schedule_id, manual=True, schedule=sch)

    # ------------------------------------------------------------------
    def _fire(self, schedule_id: str, manual: bool = False, schedule: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Execute a single schedule fire."""
        sch = schedule or self._repo.get(schedule_id)
        if not sch:
            logger.warning("Schedule %s vanished before firing", schedule_id)
            return {"status": "missing"}

        triggered_at = datetime.now(timezone.utc).isoformat()
        target_type = (sch.get("targetType") or "").upper()
        remote_id: Optional[str] = None
        status = "running"
        error_msg: Optional[str] = None

        try:
            params: Dict[str, Any] = {}
            if sch.get("parameters"):
                try:
                    params = json.loads(sch["parameters"])
                except Exception:
                    params = {"raw": sch["parameters"]}

            if target_type == "DSP":
                if not self._tc_exec:
                    raise RuntimeError("TaskchainExecutor not available")
                remote_id = self._tc_exec.execute_async_dsp(
                    sch.get("spaceId"), sch.get("taskchain"), params
                )
            elif target_type in ("IBP", "SAC"):
                if not self._job_exec:
                    raise RuntimeError("JobExecutor not available")
                launch_params = {**params, "job_template": sch.get("jobTemplate")}
                res = self._job_exec.launch(target_type.lower(), launch_params)
                remote_id = res.get("execution_id")
            else:
                raise ValueError(f"Unsupported targetType '{target_type}'")

            status = "success"
        except Exception as e:
            logger.exception("Schedule %s firing failed", schedule_id)
            status = "error"
            error_msg = str(e)[:1900]

        finished_at = datetime.now(timezone.utc).isoformat()

        try:
            self._repo.insert_run(
                schedule_id=schedule_id,
                triggered_at=triggered_at,
                finished_at=finished_at,
                status=status,
                target_type=target_type or "",
                remote_id=remote_id,
                error_message=error_msg,
            )
        except Exception:
            logger.exception("Failed to persist ScheduleRun for %s", schedule_id)

        # Update next run time
        next_iso: Optional[str] = None
        try:
            if self._scheduler:
                job = self._scheduler.get_job(schedule_id)
                if job and job.next_run_time:
                    next_iso = job.next_run_time.isoformat()
        except Exception:
            pass
        try:
            self._repo.update_run_state(
                schedule_id,
                last_run_at=triggered_at,
                last_run_status=status,
                next_run_at=next_iso,
            )
        except Exception:
            pass

        return {
            "schedule_id": schedule_id,
            "status": status,
            "remote_id": remote_id,
            "triggered_at": triggered_at,
            "error": error_msg,
        }

    # ------------------------------------------------------------------
    def run_adhoc(self, space_id: str, taskchain: str, parameters: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Execute a DSP task chain immediately, without a persisted Schedule row."""
        sch = {
            "ID": f"adhoc::{space_id}::{taskchain}::{datetime.now(timezone.utc).isoformat()}",
            "targetType": "DSP",
            "spaceId": space_id,
            "taskchain": taskchain,
            "parameters": json.dumps(parameters) if parameters else None,
        }
        return self._fire(schedule_id=sch["ID"], manual=True, schedule=sch)

    # ------------------------------------------------------------------
    def schedule_once(self, space_id: str, taskchain: str, run_at_iso: str,
                      parameters: Optional[Dict[str, Any]] = None,
                      tz: str = "Europe/Rome") -> Dict[str, Any]:
        """Register a one-shot APScheduler job at the given local datetime."""
        if not self._scheduler:
            raise RuntimeError("Scheduler is disabled (APScheduler not installed)")
        try:
            run_at = datetime.fromisoformat(run_at_iso)
        except Exception as e:
            raise ValueError(f"Invalid runAt '{run_at_iso}': {e}")
        if run_at.tzinfo is None and ZoneInfo:
            run_at = run_at.replace(tzinfo=ZoneInfo(tz))

        job_id = f"once::{space_id}::{taskchain}::{run_at.isoformat()}"
        sch = {
            "ID": job_id,
            "targetType": "DSP",
            "spaceId": space_id,
            "taskchain": taskchain,
            "parameters": json.dumps(parameters) if parameters else None,
        }
        if hasattr(self._repo, "_mem_schedules"):
            self._repo._mem_schedules[job_id] = sch

        self._scheduler.add_job(
            self._fire,
            trigger="date",
            run_date=run_at,
            id=job_id,
            kwargs={"schedule_id": job_id, "manual": False, "schedule": sch},
            replace_existing=True,
            misfire_grace_time=300,
        )
        return {"status": "scheduled", "job_id": job_id, "run_at": run_at.isoformat()}

    # ------------------------------------------------------------------
    @staticmethod
    def preview_cron(cron_expr: str, tz: str, count: int = 5) -> List[str]:
        """Return the next ``count`` fire timestamps (ISO 8601) for a cron expr."""
        if not cron_expr:
            raise ValueError("cron expression is required")

        # Prefer APScheduler CronTrigger when available - same semantics as runtime.
        if _APS_AVAILABLE:
            trigger = CronTrigger.from_crontab(cron_expr, timezone=tz or "Europe/Rome")
            now = datetime.now(tz=ZoneInfo(tz) if ZoneInfo else timezone.utc)
            out: List[str] = []
            prev = None
            for _ in range(max(int(count or 5), 1)):
                nxt = trigger.get_next_fire_time(prev, now)
                if not nxt:
                    break
                out.append(nxt.isoformat())
                prev = nxt
            return out

        if _CRON_AVAILABLE:
            base = datetime.now()
            it = croniter(cron_expr, base)
            return [it.get_next(datetime).isoformat() for _ in range(int(count or 5))]

        raise RuntimeError("No cron library available (install apscheduler or croniter)")

    # ------------------------------------------------------------------
    def shutdown(self) -> None:
        if self._scheduler:
            try:
                self._scheduler.shutdown(wait=False)
            except Exception:
                pass
