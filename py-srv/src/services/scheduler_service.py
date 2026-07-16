"""Scheduler service - APScheduler-based orchestrator for one-shot date triggers.

Loads active ScheduleEntry rows from the HDI container at startup and registers
one APScheduler date job per entry.  Each job, when fired, dispatches to the
DSP executor and writes a ScheduleRun record.

The CAP layer notifies us via POST /v1/scheduler/sync whenever ScheduleEntry
rows change, so we re-read the table and rebuild the job set.
"""

from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

try:
    from apscheduler.schedulers.background import BackgroundScheduler
    _APS_AVAILABLE = True
except Exception:
    BackgroundScheduler = None  # type: ignore
    _APS_AVAILABLE = False

try:
    from zoneinfo import ZoneInfo
except Exception:
    ZoneInfo = None  # type: ignore

from ..repository.schedule_repository import ScheduleRepository

logger = logging.getLogger(__name__)


class SchedulerService:
    """APScheduler facade for taskchain scheduling."""

    def __init__(
        self,
        repo: ScheduleRepository,
        taskchain_executor=None,
        job_executor=None,
        db_query_executor=None,
    ):
        self._repo = repo
        self._tc_exec = taskchain_executor
        self._job_exec = job_executor
        self._db_query = db_query_executor
        self._lock = threading.Lock()

        # Per-(spaceId, taskchain) in-memory queueing: prevents two scheduled
        # fires of the SAME task chain from launching concurrently in DSP.
        # While a taskchain's key is in `_running_taskchains`, any further
        # non-manual DSP fire for that key is appended to `_pending_queue`
        # instead of launching immediately; it's dequeued and launched once
        # the running execution reaches a terminal state (see _fire/_advance_
        # taskchain_queue). In-memory only — lost on a py-srv restart, same
        # limitation as the rest of the APScheduler job store.
        self._queue_lock = threading.Lock()
        self._running_taskchains: set = set()
        self._pending_queue: Dict[str, List[Dict[str, Any]]] = {}

        if not _APS_AVAILABLE:
            logger.warning("APScheduler not installed - SchedulerService runs in disabled mode")
            self._scheduler = None
            return

        self._scheduler = BackgroundScheduler()
        self._scheduler.start()
        logger.info("SchedulerService started (APScheduler BackgroundScheduler)")

    # ------------------------------------------------------------------
    def sync(self) -> Dict[str, Any]:
        """Reload CalendarEntry + Schedule rows and (re)build APScheduler jobs.

        Deliberately non-destructive: a job is only removed here if its backing
        DB row was deleted or deactivated. It is never removed just because its
        scheduled time has, in the meantime, moved into the past — sync() can
        run at any moment (including right after a fire is due), and wiping
        every job up front would race an about-to-fire or just-fired job out
        of existence before it gets a chance to run.
        """
        if not self._scheduler:
            return {"status": "disabled", "loaded": 0}

        with self._lock:
            errors: List[str] = []
            loaded = 0
            loaded_tl = 0
            valid_entry_ids: Optional[set] = None
            valid_tl_ids: Optional[set] = None
            try:
                loaded, valid_entry_ids = self._register_entries()
            except Exception as e:
                logger.exception("Failed to register calendar entries")
                errors.append(f"entries: {e}")
            try:
                loaded_tl, valid_tl_ids = self._register_traffic_light_schedules()
            except Exception as e:
                logger.exception("Failed to register traffic light schedules")
                errors.append(f"traffic_lights: {e}")

            # Prune only what's genuinely gone — skip pruning a category
            # entirely if its registration failed, since we can't tell valid
            # from stale without a successful read.
            for job in list(self._scheduler.get_jobs()):
                try:
                    if job.id.startswith("entry::") and valid_entry_ids is not None \
                            and job.id not in valid_entry_ids:
                        self._scheduler.remove_job(job.id)
                    elif job.id.startswith("tl::") and valid_tl_ids is not None \
                            and job.id not in valid_tl_ids:
                        self._scheduler.remove_job(job.id)
                except Exception:
                    pass

            logger.info("Scheduler sync complete: %d calendar entries, %d traffic light schedules", loaded, loaded_tl)
            return {"status": "ok", "loaded": loaded, "loaded_traffic_lights": loaded_tl, "errors": errors}

    def _register_entries(self) -> tuple[int, set]:
        """Register one-shot APScheduler jobs for active ScheduleEntry rows.

        Returns (count actually (re)scheduled, set of job IDs for every row
        that's still a legitimate active entry — including ones whose time
        has already passed today, which are intentionally NOT (re)scheduled
        but must still be protected from pruning in sync()).
        """
        if not self._scheduler or not hasattr(self._repo, "list_active_entries"):
            return 0, set()
        entries = self._repo.list_active_entries() or []
        now = datetime.now(timezone.utc)
        count = 0
        valid_ids: set = set()
        for e in entries:
            try:
                space_id = e.get("spaceId")
                taskchain = e.get("taskchain")
                run_date = e.get("runDate")  # YYYY-MM-DD
                run_time = e.get("runTime") or "00:00"  # HH:mm
                tz = e.get("timezone") or "Europe/Rome"
                if not (space_id and taskchain and run_date):
                    continue
                entry_id = e.get("ID") or f"{space_id}::{taskchain}::{run_date}T{run_time}"
                valid_ids.add(f"entry::{entry_id}")

                iso = f"{run_date}T{run_time}:00"
                run_at = datetime.fromisoformat(iso)
                if run_at.tzinfo is None and ZoneInfo:
                    run_at = run_at.replace(tzinfo=ZoneInfo(tz))
                if run_at <= now:
                    # Already due/passed — leave any existing job alone (see
                    # sync()'s pruning guard) rather than (re)scheduling it.
                    continue
                params = None
                if e.get("parameters"):
                    try:
                        params = json.loads(e["parameters"])
                    except Exception:
                        params = None
                job_id = f"entry::{entry_id}"
                sch = {
                    "ID": entry_id,
                    "targetType": "DSP",
                    "spaceId": space_id,
                    "taskchain": taskchain,
                    "parameters": json.dumps(params) if params else None,
                    "details": e.get("details"),
                }
                self._scheduler.add_job(
                    self._fire,
                    trigger="date",
                    run_date=run_at,
                    id=job_id,
                    kwargs={"entry_id": entry_id, "manual": False, "entry": sch},
                    replace_existing=True,
                    misfire_grace_time=300,
                )
                count += 1
            except Exception:
                logger.exception("Failed to register schedule entry %s", e.get("ID"))
        return count, valid_ids

    def _register_traffic_light_schedules(self) -> tuple[int, set]:
        """Register recurring interval jobs for active Schedule (Traffic Lights) rows.

        Each job ticks every `checkInterval` minutes (configured by the user in the
        "Monitoring interval" setting, stored inside the schedule's parameters JSON).
        On each tick the job checks TrafficLightStatus for the schedule's
        (spaceId, taskchain).  If status == 'ready' it fires the task chain in
        DSP and sets the semaphore to 'running'.  Otherwise the tick is skipped.

        Returns (count registered, set of job IDs for every active schedule).
        """
        if not self._scheduler or not hasattr(self._repo, "list_active_schedules"):
            return 0, set()
        schedules = self._repo.list_active_schedules() or []
        count = 0
        valid_ids: set = set()
        for s in schedules:
            try:
                space_id = s.get("spaceId")
                taskchain = s.get("taskchain")
                if not (space_id and taskchain):
                    continue
                tz = s.get("timezone") or "Europe/Rome"

                check_interval_min = 15
                if s.get("parameters"):
                    try:
                        tl_settings = json.loads(s["parameters"])
                        check_interval_min = int(tl_settings.get("checkInterval") or 15)
                    except Exception:
                        pass
                if check_interval_min <= 0:
                    check_interval_min = 15

                job_id = f"tl::{s['ID']}"
                valid_ids.add(job_id)
                self._scheduler.add_job(
                    self._fire_traffic_light,
                    trigger="interval",
                    minutes=check_interval_min,
                    timezone=tz,
                    id=job_id,
                    kwargs={"schedule": s},
                    replace_existing=True,
                    misfire_grace_time=300,
                )
                count += 1
            except Exception:
                logger.exception("Failed to register traffic light schedule %s", s.get("ID"))
        return count, valid_ids

    def _fire_traffic_light(self, schedule: Dict[str, Any]) -> Dict[str, Any]:
        """Interval tick handler for a Traffic Lights schedule.

        Reads TrafficLightStatus for (spaceId, taskchain).
        Conditions to launch:
          1. A record for (spaceId, taskchain) exists in TrafficLightStatus
          2. The status field of that record equals 'ready'
        If either condition is not met the tick is skipped.
        After launch the semaphore is set to 'running' to prevent duplicate launches.
        """
        schedule_id = schedule.get("ID", "unknown")
        space_id = schedule.get("spaceId")
        taskchain = schedule.get("taskchain")
        triggered_at = datetime.now(timezone.utc).isoformat()

        # Condition 0: isActive must be true
        is_active = schedule.get("isActive")
        if is_active is False or str(is_active).lower() in ("false", "0", "no"):
            logger.info(
                "Traffic light skip (isActive=False): schedule=%s spaceId=%s taskchain=%s",
                schedule_id, space_id, taskchain,
            )
            return {"entry_id": schedule_id, "status": "skipped", "tl_status": "(inactive)"}

        tl = self._repo.get_traffic_light(space_id, taskchain) if hasattr(self._repo, "get_traffic_light") else None

        # Condition 1: record must exist
        if tl is None:
            logger.info(
                "Traffic light skip (no record): schedule=%s spaceId=%s taskchain=%s",
                schedule_id, space_id, taskchain,
            )
            try:
                self._repo.update_schedule_run_status(schedule_id, "skipped", None)
            except Exception:
                pass
            return {"entry_id": schedule_id, "status": "skipped", "tl_status": "(no record)"}

        tl_status = (tl.get("status") or "").lower()

        try:
            tl_settings = json.loads(schedule.get("parameters") or "{}")
        except Exception:
            tl_settings = {}
        auto_reset = bool(tl_settings.get("autoReset"))
        reset_state = tl_settings.get("autoResetState") or "GREEN"

        # Self-heal: if the technical table is stuck on 'running' (e.g. the
        # in-process watch job was lost on a service restart before the run
        # finished), check DSP directly for the actual outcome and reconcile.
        if tl_status == "running":
            dsp_status = self._get_latest_dsp_run_status(space_id, taskchain)
            if dsp_status in ("COMPLETED", "SUCCESS", "FAILED", "ERROR", "CANCELLED"):
                finished_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
                new_status = "completed" if dsp_status in ("COMPLETED", "SUCCESS") else "error"
                try:
                    self._repo.set_traffic_light_status(
                        space_id, taskchain, new_status,
                        note=f"Run finished ({dsp_status.lower()}) at {finished_at} (reconciled from DSP)",
                    )
                except Exception:
                    logger.warning("Could not reconcile traffic light status for %s/%s", space_id, taskchain)
                self._apply_after_run_policy(schedule_id, space_id, taskchain, auto_reset, reset_state)

        # Condition 2: status must be 'ready'
        if tl_status != "ready":
            logger.info(
                "Traffic light skip (status=%s): schedule=%s spaceId=%s taskchain=%s",
                tl_status, schedule_id, space_id, taskchain,
            )
            try:
                self._repo.update_schedule_run_status(schedule_id, "skipped", None)
            except Exception:
                pass
            return {"entry_id": schedule_id, "status": "skipped", "tl_status": tl_status}

        # Set semaphore to 'running' before firing to prevent duplicate launches
        try:
            self._repo.set_traffic_light_status(space_id, taskchain, "running", note="Launched by scheduler")
        except Exception:
            logger.warning("Could not set traffic light to running for %s/%s", space_id, taskchain)

        # Build entry dict compatible with _fire()
        entry = {
            "ID": f"tl::{schedule_id}::{triggered_at}",
            "targetType": schedule.get("targetType") or "DSP",
            "spaceId": space_id,
            "taskchain": taskchain,
            "parameters": schedule.get("parameters"),
        }
        result = self._fire(entry_id=entry["ID"], manual=False, entry=entry)

        try:
            self._repo.update_schedule_run_status(schedule_id, result.get("status", "error"), None)
        except Exception:
            pass

        # Watch the remote execution so the semaphore never stays stuck on
        # 'running': once it finishes, mark the technical table 'completed' or
        # 'error' (the 'ready' status is only ever set by the external system).
        remote_id = result.get("remote_id")
        if remote_id and result.get("status") == "success":
            self._watch_traffic_light_completion(
                schedule_id, remote_id, space_id, taskchain,
                auto_reset=auto_reset, reset_state=reset_state,
            )
        else:
            # Fire failed immediately - no remote execution to watch
            run_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
            try:
                self._repo.set_traffic_light_status(
                    space_id, taskchain, "error",
                    note=f"Run failed at {run_at}: {result.get('error') or 'unknown error'}",
                )
            except Exception:
                logger.warning("Could not update traffic light after failed fire for %s/%s", space_id, taskchain)
            self._apply_after_run_policy(schedule_id, space_id, taskchain, auto_reset, reset_state)

        return result

    def _watch_traffic_light_completion(self, schedule_id: str, remote_id: str,
                                         space_id: str, taskchain: str,
                                         auto_reset: bool, reset_state: str) -> None:
        """Register a polling job that watches a fired execution and, once it
        finishes, marks the technical table 'completed' or 'error' and applies
        the "After each run" policy to the schedule's own lifecycle state.
        """
        if not self._scheduler or not self._tc_exec:
            return
        watch_job_id = f"tlwatch::{schedule_id}::{remote_id}"
        self._scheduler.add_job(
            self._check_traffic_light_completion,
            trigger="interval",
            seconds=60,
            id=watch_job_id,
            kwargs={
                "schedule_id": schedule_id,
                "remote_id": remote_id,
                "space_id": space_id,
                "taskchain": taskchain,
                "auto_reset": auto_reset,
                "reset_state": reset_state,
                "watch_job_id": watch_job_id,
            },
            replace_existing=True,
            misfire_grace_time=120,
        )

    def _check_traffic_light_completion(self, schedule_id: str, remote_id: str, space_id: str, taskchain: str,
                                         auto_reset: bool, reset_state: str, watch_job_id: str) -> None:
        """Poll a fired execution; once it reaches a terminal state, replace the
        technical table's 'ready' status with 'completed' (success) or 'error'
        (failure), record the run's date/time in the note, and apply the
        "After each run" policy to the schedule's own lifecycle state."""
        try:
            info = self._tc_exec.get_status(remote_id)
            status = (info.get("status") or "").upper()
        except Exception:
            logger.warning("Could not poll traffic light execution %s", remote_id)
            return

        if status not in ("COMPLETED", "SUCCESS", "FAILED", "ERROR", "CANCELLED"):
            return  # still running - keep watching

        finished_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        new_status = "completed" if status in ("COMPLETED", "SUCCESS") else "error"
        try:
            self._repo.set_traffic_light_status(
                space_id, taskchain, new_status,
                note=f"Run finished ({status.lower()}) at {finished_at}",
            )
        except Exception:
            logger.warning("Could not update traffic light after run for %s/%s", space_id, taskchain)

        self._apply_after_run_policy(schedule_id, space_id, taskchain, auto_reset, reset_state)

        try:
            self._scheduler.remove_job(watch_job_id)
        except Exception:
            pass

    def _get_latest_dsp_run_status(self, space_id: str, taskchain: str) -> Optional[str]:
        """Return the status (upper-case) of the most recent DSP run for
        (space_id, taskchain), or None if unavailable.

        Used to reconcile a technical table stuck on 'running' when the
        in-process watch job that would normally do this was lost
        (e.g. after a service restart).
        """
        if not self._db_query:
            return None
        try:
            rows = self._db_query.query(
                'SELECT "STATUS" as "status" '
                'FROM "ORCHESTRATION"."3VR_DWC_TASK_LOGS_01" '
                'WHERE "APPLICATION_ID" = \'TASK_CHAINS\' AND "SPACE_ID" = ? AND "OBJECT_ID" = ? '
                'ORDER BY "START_TIME" DESC LIMIT 1',
                (space_id, taskchain),
            )
        except Exception:
            logger.warning("Could not query latest DSP run status for %s/%s", space_id, taskchain)
            return None
        if not rows:
            return None
        return (rows[0].get("status") or "").upper()

    def _apply_after_run_policy(self, schedule_id: str, space_id: str, taskchain: str,
                                 auto_reset: bool, reset_state: str) -> None:
        """Apply the "After each run" policy once a run completes.

        - If "After each run" is enabled: set the Lifecycle / Current state
          (TrafficLightStatus.initialState, GREEN/RED) for (space_id, taskchain).
        - If disabled: the traffic lights schedule is deleted entirely (its
          job is removed and the Schedule row is deleted).
        """
        if not auto_reset:
            try:
                self._repo.delete_schedule(schedule_id)
            except Exception:
                logger.warning("Could not delete schedule %s", schedule_id)
            if self._scheduler:
                try:
                    self._scheduler.remove_job(f"tl::{schedule_id}")
                except Exception:
                    pass
            return
        new_state = "GREEN" if reset_state == "GREEN" else "RED"
        try:
            self._repo.set_traffic_light_initial_state(space_id, taskchain, new_state)
        except Exception:
            logger.warning("Could not update initialState for %s/%s", space_id, taskchain)

    # ------------------------------------------------------------------
    def run_now(self, schedule_id: str, schedule_payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Immediately fire a Traffic Lights schedule, bypassing the semaphore check.

        Looks up the Schedule row by ID (from the in-memory APScheduler job kwargs
        if available, or from the provided payload), then calls _fire_traffic_light
        with semaphore check disabled so the chain fires regardless of current status.
        """
        schedule: Optional[Dict[str, Any]] = schedule_payload

        if not schedule and self._scheduler:
            job_id = f"tl::{schedule_id}"
            job = self._scheduler.get_job(job_id)
            if job:
                schedule = (job.kwargs or {}).get("schedule")

        if not schedule:
            if hasattr(self._repo, "list_active_schedules"):
                for s in (self._repo.list_active_schedules() or []):
                    if str(s.get("ID")) == str(schedule_id):
                        schedule = s
                        break

        if not schedule:
            raise ValueError(f"Schedule '{schedule_id}' not found")

        space_id = schedule.get("spaceId")
        taskchain = schedule.get("taskchain")
        triggered_at = datetime.now(timezone.utc).isoformat()
        entry = {
            "ID": f"tl::{schedule_id}::{triggered_at}",
            "targetType": schedule.get("targetType") or "DSP",
            "spaceId": space_id,
            "taskchain": taskchain,
            "parameters": schedule.get("parameters"),
        }
        return self._fire(entry_id=entry["ID"], manual=True, entry=entry)

    # ------------------------------------------------------------------
    def run_adhoc(self, space_id: str, taskchain: str, parameters: Optional[Dict[str, Any]] = None,
                  details: Optional[str] = None) -> Dict[str, Any]:
        """Execute a DSP task chain immediately, without a persisted ScheduleEntry row."""
        entry = {
            "ID": f"adhoc::{space_id}::{taskchain}::{datetime.now(timezone.utc).isoformat()}",
            "targetType": "DSP",
            "spaceId": space_id,
            "taskchain": taskchain,
            "parameters": json.dumps(parameters) if parameters else None,
            "details": details,
        }
        return self._fire(entry_id=entry["ID"], manual=True, entry=entry)

    # ------------------------------------------------------------------
    def schedule_once(self, space_id: str, taskchain: str, run_at_iso: str,
                      parameters: Optional[Dict[str, Any]] = None,
                      tz: str = "Europe/Rome",
                      details: Optional[str] = None) -> Dict[str, Any]:
        """Register a one-shot APScheduler job at the given local datetime."""
        if not self._scheduler:
            raise RuntimeError("Scheduler is disabled (APScheduler not installed)")
        try:
            run_at = datetime.fromisoformat(run_at_iso)
        except Exception as e:
            raise ValueError(f"Invalid runAt '{run_at_iso}': {e}")
        if run_at.tzinfo is None and ZoneInfo:
            run_at = run_at.replace(tzinfo=ZoneInfo(tz))

        entry_id = f"once::{space_id}::{taskchain}::{run_at.isoformat()}"
        job_id = f"entry::{entry_id}"
        entry = {
            "ID": entry_id,
            "targetType": "DSP",
            "spaceId": space_id,
            "taskchain": taskchain,
            "parameters": json.dumps(parameters) if parameters else None,
            "details": details,
        }

        self._scheduler.add_job(
            self._fire,
            trigger="date",
            run_date=run_at,
            id=job_id,
            kwargs={"entry_id": entry_id, "manual": False, "entry": entry},
            replace_existing=True,
            misfire_grace_time=300,
        )
        return {"status": "scheduled", "job_id": job_id, "run_at": run_at.isoformat()}

    # ------------------------------------------------------------------
    def _fire(self, entry_id: str, manual: bool = False, entry: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Entry point for every scheduled/manual fire.

        Gates the actual launch through a per-(spaceId, taskchain) in-memory
        slot: if that taskchain is already running (a previous fire's
        execution hasn't reached a terminal DSP status yet), this fire is
        queued instead of launched, and the queue is drained (FIFO) once the
        running execution finishes. This applies to manual (Run Now / ad-hoc)
        fires too — triggering the same chain again while it's still running
        queues the new run rather than rejecting it outright. Traffic Lights
        fires keep their own separate semaphore (TrafficLightStatus) and opt
        out of this gate (see below).
        """
        if not entry:
            logger.warning("ScheduleEntry %s vanished before firing", entry_id)
            return {"status": "missing"}

        target_type = (entry.get("targetType") or "").upper()
        queue_key: Optional[str] = None
        # Traffic Lights fires (entry_id prefixed "tl::") already have their own
        # per-(spaceId, taskchain) semaphore (TrafficLightStatus) checked before
        # _fire is even called, and _fire_traffic_light's result handling doesn't
        # understand a "queued" status — so they opt out of this generic gate.
        if target_type == "DSP" and not str(entry_id or "").startswith("tl::"):
            space_id = entry.get("spaceId")
            taskchain = entry.get("taskchain")
            if space_id and taskchain:
                queue_key = f"{space_id}::{taskchain}"
                with self._queue_lock:
                    if queue_key in self._running_taskchains:
                        self._pending_queue.setdefault(queue_key, []).append(
                            {"entry_id": entry_id, "manual": manual, "entry": entry}
                        )
                        logger.info(
                            "Queueing fire for %s — taskchain already running (entry_id=%s)",
                            queue_key, entry_id,
                        )
                        triggered_at = datetime.now(timezone.utc).isoformat()
                        try:
                            self._insert_run(entry_id, triggered_at, triggered_at, "queued", target_type, None, None,
                                              details=entry.get("details"))
                        except Exception:
                            logger.exception("Failed to persist queued ScheduleRun for %s", entry_id)
                        return {
                            "entry_id": entry_id,
                            "status": "queued",
                            "remote_id": None,
                            "triggered_at": triggered_at,
                            "error": None,
                        }
                    self._running_taskchains.add(queue_key)

        result = self._launch(entry_id, manual, entry)

        if queue_key:
            remote_id = result.get("remote_id")
            if remote_id and result.get("status") == "success":
                self._watch_taskchain_completion(queue_key, remote_id)
            else:
                self._advance_taskchain_queue(queue_key)

        return result

    def _advance_taskchain_queue(self, queue_key: str) -> None:
        """Free up a (spaceId, taskchain) slot and launch the next queued fire, if any."""
        next_item: Optional[Dict[str, Any]] = None
        with self._queue_lock:
            self._running_taskchains.discard(queue_key)
            queue = self._pending_queue.get(queue_key)
            if queue:
                next_item = queue.pop(0)
            if queue is not None and not queue:
                self._pending_queue.pop(queue_key, None)
        if next_item:
            logger.info("Dequeuing next fire for %s: entry_id=%s", queue_key, next_item["entry_id"])
            self._fire(next_item["entry_id"], next_item["manual"], next_item["entry"])

    def _watch_taskchain_completion(self, queue_key: str, remote_id: str) -> None:
        """Poll a fired DSP execution; once it reaches a terminal state, free the
        (spaceId, taskchain) slot and launch the next queued fire, if any."""
        if not self._scheduler or not self._tc_exec:
            # Can't track completion without a scheduler/executor — advance
            # immediately rather than leaving the slot (and queue) stuck forever.
            self._advance_taskchain_queue(queue_key)
            return
        watch_job_id = f"tcwatch::{queue_key}"
        self._scheduler.add_job(
            self._check_taskchain_completion,
            trigger="interval",
            seconds=60,
            id=watch_job_id,
            kwargs={"queue_key": queue_key, "remote_id": remote_id, "watch_job_id": watch_job_id},
            replace_existing=True,
            misfire_grace_time=120,
        )

    def _check_taskchain_completion(self, queue_key: str, remote_id: str, watch_job_id: str) -> None:
        """Interval tick: check if the currently-running execution for `queue_key`
        has finished; if so, free the slot and dequeue the next pending fire."""
        try:
            info = self._tc_exec.get_status(remote_id)
            status = (info.get("status") or "").upper()
        except Exception:
            logger.warning("Could not poll queued-taskchain execution %s (%s)", remote_id, queue_key)
            return

        if status not in ("COMPLETED", "SUCCESS", "FAILED", "ERROR", "CANCELLED"):
            return  # still running - keep watching

        try:
            self._scheduler.remove_job(watch_job_id)
        except Exception:
            pass
        self._advance_taskchain_queue(queue_key)

    def _insert_run(self, entry_id: str, triggered_at: str, finished_at: str, status: str,
                     target_type: str, remote_id: Optional[str], error_msg: Optional[str],
                     details: Optional[str] = None) -> None:
        """Persist a ScheduleRun history row (shared by _launch and the queued-fire path)."""
        import re as _re
        # SCHEDULEENTRY_ID is a FK to ScheduleEntry.ID (UUID, 36 chars).
        # Adhoc/once/cron-fallback runs use synthetic IDs that are not UUIDs
        # and have no corresponding ScheduleEntry row — store NULL instead.
        _UUID_PAT = _re.compile(
            r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
            _re.IGNORECASE
        )
        sch_entry_id = entry_id if _UUID_PAT.match(entry_id or "") else None
        self._repo.insert_run(
            schedule_entry_id=sch_entry_id,
            triggered_at=triggered_at,
            finished_at=finished_at,
            status=status,
            target_type=target_type or "",
            remote_id=remote_id,
            error_message=error_msg,
            details=details,
        )

    def _launch(self, entry_id: str, manual: bool = False, entry: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Actually dispatch a single schedule entry to DSP/IBP/SAC and record the run."""
        triggered_at = datetime.now(timezone.utc).isoformat()
        target_type = (entry.get("targetType") or "").upper()
        remote_id: Optional[str] = None
        status = "running"
        error_msg: Optional[str] = None

        try:
            params: Dict[str, Any] = {}
            if entry.get("parameters"):
                try:
                    params = json.loads(entry["parameters"])
                except Exception:
                    params = {"raw": entry["parameters"]}

            logger.info(
                "_fire: entry_id=%s taskchain=%s has_params=%s param_keys=%s",
                entry_id,
                entry.get("taskchain"),
                bool(params),
                list(params.keys()) if isinstance(params, dict) else "n/a",
            )

            if target_type == "DSP":
                if not self._tc_exec:
                    raise RuntimeError("TaskchainExecutor not available")
                # Traffic-lights schedules embed step params under __stepParams to
                # avoid conflict with the TL config keys (checkInterval etc.).
                dsp_params = params.pop("__stepParams", None)
                if dsp_params is None:
                    dsp_params = params  # regular DSP schedule: params ARE the step params
                remote_id = self._tc_exec.execute_async_dsp(
                    entry.get("spaceId"), entry.get("taskchain"), dsp_params
                )
            elif target_type in ("IBP", "SAC"):
                if not self._job_exec:
                    raise RuntimeError("JobExecutor not available")
                launch_params = {**params, "job_template": entry.get("jobTemplate")}
                res = self._job_exec.launch(target_type.lower(), launch_params)
                remote_id = res.get("execution_id")
            else:
                raise ValueError(f"Unsupported targetType '{target_type}'")

            status = "success"
        except Exception as e:
            logger.exception("ScheduleEntry %s firing failed", entry_id)
            status = "error"
            error_msg = str(e)[:1900]

        finished_at = datetime.now(timezone.utc).isoformat()

        try:
            self._insert_run(entry_id, triggered_at, finished_at, status, target_type, remote_id, error_msg,
                              details=entry.get("details"))
        except Exception:
            logger.exception("Failed to persist ScheduleRun for %s", entry_id)

        return {
            "entry_id": entry_id,
            "status": status,
            "remote_id": remote_id,
            "triggered_at": triggered_at,
            "error": error_msg,
        }

    # ------------------------------------------------------------------
    @staticmethod
    def preview_cron(cron_expr: str, tz: str = "Europe/Rome", count: int = 5) -> List[str]:
        """Return the next N firing times for a cron expression as ISO strings."""
        from apscheduler.triggers.cron import CronTrigger
        parts = cron_expr.strip().split()
        if len(parts) < 5:
            raise ValueError(f"Invalid cron expression: '{cron_expr}'")
        minute, hour, day, month, day_of_week = parts[0], parts[1], parts[2], parts[3], parts[4]
        trigger = CronTrigger(
            minute=minute, hour=hour, day=day, month=month,
            day_of_week=day_of_week, timezone=tz,
        )
        now = datetime.now(timezone.utc)
        results: List[str] = []
        prev = now
        for _ in range(count):
            nxt = trigger.get_next_fire_time(prev, prev)
            if nxt is None:
                break
            results.append(nxt.isoformat())
            prev = nxt
        return results

    # ------------------------------------------------------------------
    def shutdown(self) -> None:
        if self._scheduler:
            try:
                self._scheduler.shutdown(wait=False)
            except Exception:
                pass
