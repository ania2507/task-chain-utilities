"""Scheduler routes - sync trigger, run-now, cron preview."""

from __future__ import annotations

import logging

from flask import Blueprint, current_app, jsonify, request

from ..auth import flask_access_validation

logger = logging.getLogger(__name__)

bp = Blueprint("scheduler", __name__)


def _svc():
    svc = current_app.extensions.get("taskchain", {}).get("scheduler_service")
    if not svc:
        raise RuntimeError("SchedulerService not initialised")
    return svc


@bp.route("/jobscheduler-callback", methods=["POST"])
@flask_access_validation(required_scope="admin")
def jobscheduler_callback():
    """Action endpoint invoked by SAP Job Scheduling service when a schedule fires.

    The request body is exactly the `data` payload given to
    JobSchedulerClient.create_schedule() when the schedule was created (see
    SchedulerService._register_entries() / _register_traffic_light_schedules()).
    Authenticated the same way as every other route here: the service's
    technical client carries the `admin` scope via the `grant-as-authority-to-apps`
    entry in xs-security.json.
    """
    payload = request.get_json(silent=True) or {}
    kind = payload.get("kind")
    try:
        if kind == "entry":
            result = _svc()._fire(payload.get("entry_id"), manual=False, entry=payload.get("entry"))
        elif kind == "traffic_light":
            result = _svc()._fire_traffic_light(payload.get("schedule") or {})
        else:
            logger.warning("jobscheduler_callback: unknown or missing kind %r", kind)
            return jsonify({"error": f"unknown kind '{kind}'"}), 400
        return jsonify(result)
    except Exception as e:
        logger.exception("jobscheduler_callback failed (kind=%s)", kind)
        return jsonify({"error": str(e)}), 500


@bp.route("/jobscheduler-delete", methods=["POST"])
@flask_access_validation(required_scope="admin")
def jobscheduler_delete():
    """Delete one SAP Job Scheduling service schedule immediately, called by
    the CAP layer right after a ScheduleEntry/Schedule row is hard-deleted
    (see srv/schedules.js) - sync()'s own reconciliation can't find a deleted
    row to read its jobSchedulerScheduleId from, so this is the only way that
    schedule ever gets cleaned up.
    """
    payload = request.get_json(silent=True) or {}
    kind = payload.get("kind")
    schedule_id = payload.get("scheduleId")
    if kind not in ("entry", "traffic_light") or not schedule_id:
        return jsonify({"error": "expected {kind: 'entry'|'traffic_light', scheduleId: '...'}"}), 400
    try:
        _svc().delete_external_schedule(kind, schedule_id)
        return jsonify({"status": "ok"})
    except Exception as e:
        logger.exception("jobscheduler_delete failed (kind=%s, scheduleId=%s)", kind, schedule_id)
        return jsonify({"error": str(e)}), 500


@bp.route("/sync", methods=["POST"])
@flask_access_validation(required_scope="admin")
def sync():
    """Reload all active schedules from DB and rebuild the job set."""
    try:
        result = _svc().sync()
        return jsonify(result)
    except Exception as e:
        logger.exception("Scheduler sync failed")
        return jsonify({"error": str(e)}), 500


@bp.route("/traffic-light", methods=["GET"])
@flask_access_validation(required_scope="admin")
def get_traffic_light():
    """Return the current TrafficLightStatus for a given (spaceId, taskchain).

    Query params: spaceId, taskchain
    """
    try:
        svc = _svc()
        repo = getattr(svc, "_repo", None)
        if not repo or not hasattr(repo, "get_traffic_light"):
            return jsonify({"error": "Repository not available"}), 503
        space_id = request.args.get("spaceId", "")
        taskchain = request.args.get("taskchain", "")
        if not space_id or not taskchain:
            return jsonify({"error": "spaceId and taskchain are required"}), 400
        row = repo.get_traffic_light(space_id, taskchain)
        if row is None:
            return jsonify({"found": False, "spaceId": space_id, "taskchain": taskchain,
                            "hint": "No record in TrafficLightStatus. Insert one with status='ready' to enable firing."}), 200
        return jsonify({"found": True, **row}), 200
    except Exception as e:
        logger.exception("get_traffic_light failed")
        return jsonify({"error": str(e)}), 500


@bp.route("/traffic-light", methods=["POST"])
@flask_access_validation(required_scope="admin")
def set_traffic_light():
    """Upsert the TrafficLightStatus for a given (spaceId, taskchain).

    Body: { "spaceId": "...", "taskchain": "...", "status": "ready"|"running"|"done", "note": "..." }
    Set status to "ready" to allow the next cron tick to fire the task chain.
    """
    try:
        svc = _svc()
        repo = getattr(svc, "_repo", None)
        if not repo or not hasattr(repo, "set_traffic_light_status"):
            return jsonify({"error": "Repository not available"}), 503
        body = request.get_json(silent=True) or {}
        space_id = body.get("spaceId", "")
        taskchain = body.get("taskchain", "")
        status = body.get("status", "")
        note = body.get("note")
        if not space_id or not taskchain or not status:
            return jsonify({"error": "spaceId, taskchain and status are required"}), 400
        repo.set_traffic_light_status(space_id, taskchain, status, note)
        return jsonify({"ok": True, "spaceId": space_id, "taskchain": taskchain, "status": status}), 200
    except Exception as e:
        logger.exception("set_traffic_light failed")
        return jsonify({"error": str(e)}), 500


@bp.route("/run-now/<schedule_id>", methods=["POST"])
@flask_access_validation(required_scope="admin")
def run_now(schedule_id: str):
    try:
        body = request.get_json(silent=True) or {}
        result = _svc().run_now(schedule_id, schedule_payload=body.get("schedule"))
        return jsonify(result)
    except ValueError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        logger.exception("run-now failed for %s", schedule_id)
        return jsonify({"error": str(e)}), 500


@bp.route("/run-now-adhoc", methods=["POST"])
@flask_access_validation(required_scope="admin")
def run_now_adhoc():
    """Trigger a DSP task chain immediately without a persisted Schedule row."""
    try:
        body = request.get_json(silent=True) or {}
        space_id = body.get("spaceId")
        taskchain = body.get("taskchain")
        parameters = body.get("parameters")
        details = body.get("details")
        if not space_id or not taskchain:
            return jsonify({"error": "spaceId and taskchain are required"}), 400
        result = _svc().run_adhoc(space_id, taskchain, parameters, details)
        # _fire/_launch catch their own exceptions and always return 200-shaped
        # JSON with status embedded — surface a launch failure (e.g. "already
        # running") as a real HTTP error, or the frontend has no way to tell
        # a rejected launch apart from a successful one.
        if result.get("status") == "error":
            return jsonify(result), 409
        return jsonify(result)
    except Exception as e:
        logger.exception("run-now-adhoc failed")
        return jsonify({"error": str(e)}), 500


@bp.route("/preview", methods=["GET"])
@flask_access_validation(required_scope="admin")
def preview():
    cron_expr = (request.args.get("cron") or "").strip()
    tz = request.args.get("tz") or "Europe/Rome"
    try:
        count = int(request.args.get("count") or 5)
    except ValueError:
        count = 5
    try:
        from ..services.scheduler_service import SchedulerService
        next_runs = SchedulerService.preview_cron(cron_expr, tz, count)
        return jsonify({"cron": cron_expr, "timezone": tz, "next": next_runs})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@bp.route("/jobs", methods=["GET"])
@flask_access_validation(required_scope="admin")
def list_jobs():
    """Return the in-process scheduler's current job set (debug)."""
    try:
        svc = _svc()
        sched = getattr(svc, "_scheduler", None)
        if not sched:
            return jsonify({"jobs": [], "status": "disabled"})
        def _job_entry_info(j):
            entry = (j.kwargs or {}).get("entry") or {}
            return {
                "spaceId": entry.get("spaceId"),
                "taskchain": entry.get("taskchain"),
            }

        jobs = [
            {
                "id": j.id,
                "next_run_time": j.next_run_time.isoformat() if j.next_run_time else None,
                "trigger": str(j.trigger),
                **_job_entry_info(j),
            }
            for j in sched.get_jobs()
        ]
        return jsonify({"jobs": jobs, "count": len(jobs)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/active-taskchains", methods=["GET"])
@flask_access_validation(required_scope="admin")
def list_active_taskchains():
    """Return the in-memory "already running" guard state (debug).

    Each entry blocks a new Run Now / schedule fire for that taskchain until
    it's cleared by the background completion watcher (or the safety-net
    expiry passes). Useful to see why a launch is being rejected as
    "already running", and how long until it self-clears.
    """
    try:
        from ..services import taskchain_executor as tce
        import time as _time
        now = _time.time()
        with tce._ACTIVE_TASKCHAINS_LOCK:
            items = [
                {
                    "taskchain": name,
                    "execution_id": execution_id,
                    "expires_in_seconds": round(expiry - now, 1),
                }
                for name, (execution_id, expiry) in tce._ACTIVE_TASKCHAINS.items()
            ]
        return jsonify({"active": items, "count": len(items)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/active-taskchains/<path:taskchain>", methods=["DELETE"])
@flask_access_validation(required_scope="admin")
def clear_active_taskchain(taskchain):
    """Manually clear the "already running" guard for a taskchain (debug/unblock)."""
    try:
        from ..services import taskchain_executor as tce
        with tce._ACTIVE_TASKCHAINS_LOCK:
            existed = tce._ACTIVE_TASKCHAINS.pop(taskchain, None) is not None
        return jsonify({"cleared": existed, "taskchain": taskchain})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
