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
    """Reload all active schedules from DB (or from posted payload)."""
    try:
        body = request.get_json(silent=True) or {}
        result = _svc().sync(payload_schedules=body.get("schedules"))
        return jsonify(result)
    except Exception as e:
        logger.exception("Scheduler sync failed")
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
        if not space_id or not taskchain:
            return jsonify({"error": "spaceId and taskchain are required"}), 400
        result = _svc().run_adhoc(space_id, taskchain, parameters)
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
        if not space_id or not taskchain or not run_at:
            return jsonify({"error": "spaceId, taskchain and runAt are required"}), 400
        result = _svc().schedule_once(space_id, taskchain, run_at, parameters, tz)
        return jsonify(result)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        logger.exception("schedule-once failed")
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
        jobs = [
            {
                "id": j.id,
                "next_run_time": j.next_run_time.isoformat() if j.next_run_time else None,
                "trigger": str(j.trigger),
            }
            for j in sched.get_jobs()
        ]
        return jsonify({"jobs": jobs, "count": len(jobs)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
