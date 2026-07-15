"""Scheduler routes - sync trigger, run-now, cron preview."""

from __future__ import annotations

import logging

from flask import Blueprint, current_app, jsonify, request

logger = logging.getLogger(__name__)

bp = Blueprint("scheduler", __name__)


def _svc():
    svc = current_app.extensions.get("taskchain", {}).get("scheduler_service")
    if not svc:
        raise RuntimeError("SchedulerService not initialised")
    return svc


@bp.route("/sync", methods=["POST"])
def sync():
    """Reload all active schedules from DB and rebuild APScheduler jobs."""
    try:
        result = _svc().sync()
        return jsonify(result)
    except Exception as e:
        logger.exception("Scheduler sync failed")
        return jsonify({"error": str(e)}), 500


@bp.route("/traffic-light", methods=["GET"])
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
        return jsonify(result)
    except Exception as e:
        logger.exception("run-now-adhoc failed")
        return jsonify({"error": str(e)}), 500


@bp.route("/schedule-once", methods=["POST"])
def schedule_once():
    """Schedule a DSP task chain for a single firing at the given datetime."""
    try:
        body = request.get_json(silent=True) or {}
        space_id = body.get("spaceId")
        taskchain = body.get("taskchain")
        run_at = body.get("runAt")
        parameters = body.get("parameters")
        tz = body.get("timezone") or "Europe/Rome"
        details = body.get("details")
        if not space_id or not taskchain or not run_at:
            return jsonify({"error": "spaceId, taskchain and runAt are required"}), 400
        result = _svc().schedule_once(space_id, taskchain, run_at, parameters, tz, details)
        return jsonify(result)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        logger.exception("schedule-once failed")
        return jsonify({"error": str(e)}), 500


@bp.route("/schedule-once", methods=["DELETE"])
def cancel_schedule_once():
    """Remove a once-off APScheduler job by spaceId + taskchain + runAt."""
    from datetime import datetime
    try:
        from zoneinfo import ZoneInfo
    except ImportError:
        ZoneInfo = None
    try:
        body = request.get_json(force=True, silent=True) or {}
        space_id = (body.get("spaceId") or "").strip()
        taskchain = (body.get("taskchain") or "").strip()
        run_at_iso = (body.get("runAt") or "").strip()
        if not space_id or not taskchain or not run_at_iso:
            return jsonify({"error": "spaceId, taskchain, runAt required"}), 400

        svc = _svc()
        sched = getattr(svc, "_scheduler", None)
        if not sched:
            return jsonify({"status": "no_scheduler", "removed": []}), 200

        removed = []
        try:
            run_at = datetime.fromisoformat(run_at_iso)
            if run_at.tzinfo is None and ZoneInfo:
                run_at = run_at.replace(tzinfo=ZoneInfo("Europe/Rome"))
            job_id = f"entry::once::{space_id}::{taskchain}::{run_at.isoformat()}"
            sched.remove_job(job_id)
            removed.append(job_id)
        except Exception:
            pass

        if not removed:
            # Fallback: scan for jobs matching space+chain+time prefix (handles tz format differences)
            prefix = f"entry::once::{space_id}::{taskchain}::"
            run_at_prefix = run_at_iso[:16]  # YYYY-MM-DDTHH:MM
            for job in sched.get_jobs():
                if job.id.startswith(prefix) and run_at_prefix in job.id:
                    try:
                        sched.remove_job(job.id)
                        removed.append(job.id)
                    except Exception:
                        pass

        logger.info("cancel_schedule_once: removed=%s", removed)
        return jsonify({"status": "ok", "removed": removed})
    except Exception as e:
        logger.exception("cancel_schedule_once failed")
        return jsonify({"error": str(e)}), 500


@bp.route("/preview", methods=["GET"])
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
def list_jobs():
    """Return APScheduler's current in-memory job set (debug)."""
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
