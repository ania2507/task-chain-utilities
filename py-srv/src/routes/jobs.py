"""Generic job endpoints – integration-agnostic.

All endpoints delegate to the ``JobExecutor`` service which dispatches
to the correct integration client (IBP, SAC, …) based on the
``integration`` field in the request body.

Endpoints
---------
POST /v1/jobs/launch          – start a job on any integration
GET  /v1/jobs/<execution_id>  – poll status
POST /v1/jobs/<execution_id>/cancel – cancel
GET  /v1/jobs                 – list recent executions
GET  /v1/jobs/health          – health of registered integrations
POST /v1/jobs/ibp/template    – read IBP template metadata (helper)
"""

from __future__ import annotations

import logging

from flask import Blueprint, current_app, jsonify, request

from ..auth import flask_access_validation
from ..integrations.base import IntegrationType

logger = logging.getLogger(__name__)

bp = Blueprint("jobs", __name__)


def _get_executor():
    return current_app.extensions["taskchain"]["job_executor"]


# ------------------------------------------------------------------
# Launch
# ------------------------------------------------------------------


@bp.route("/launch", methods=["POST"])
@flask_access_validation(required_scope="admin")
def launch_job():
    """Launch an async job on any registered integration.

    Request body (JSON)::

        {
            "integration": "ibp" | "sac",
            ...integration-specific params...
        }

    **IBP** required params::

        {
            "integration": "ibp",
            "template_name": "SAP_IBP_PROC_COPY_OPERATOR",
            "job_text": "My Job",
            "job_user": "MYUSER",
            "parameters": [
                {"name": "P_AREA", "values": [{"low": "Z1DUNIFPA"}]},
                ...
            ]
        }

    **SAC** required params::

        {
            "integration": "sac",
            "multiaction_id": "action_XXXXXXXX",
            "parameters": { ... }
        }
    """
    if not request.is_json:
        return jsonify({"error": "Request body must be JSON"}), 400

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Payload must be a JSON object"}), 400

    integration = payload.get("integration")
    if not integration:
        return jsonify({"error": "'integration' is required (e.g. 'ibp', 'sac')"}), 400

    try:
        IntegrationType(integration.strip().lower())
    except ValueError:
        valid = [t.value for t in IntegrationType]
        return jsonify({"error": f"Unknown integration '{integration}'. Valid: {valid}"}), 400

    executor = _get_executor()

    try:
        result = executor.launch(integration, payload)
        return jsonify(result), 202
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception:
        logger.exception("Error launching job on %s", integration)
        return jsonify({"error": "Internal error while launching job"}), 500


# ------------------------------------------------------------------
# Status
# ------------------------------------------------------------------


@bp.route("/<execution_id>", methods=["GET"])
@flask_access_validation(required_scope="admin")
def get_job_status(execution_id: str):
    """Poll the remote system for current job status."""
    executor = _get_executor()

    try:
        result = executor.get_status(execution_id)
        return jsonify(result), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 404
    except Exception:
        logger.exception("Error polling status for %s", execution_id)
        return jsonify({"error": "Internal error while polling job status"}), 500


# ------------------------------------------------------------------
# Cancel
# ------------------------------------------------------------------


@bp.route("/<execution_id>/cancel", methods=["POST"])
@flask_access_validation(required_scope="admin")
def cancel_job(execution_id: str):
    """Cancel a running job."""
    executor = _get_executor()

    try:
        result = executor.cancel(execution_id)
        return jsonify(result), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 404
    except Exception:
        logger.exception("Error cancelling job %s", execution_id)
        return jsonify({"error": "Internal error while cancelling job"}), 500


# ------------------------------------------------------------------
# List
# ------------------------------------------------------------------


@bp.route("", methods=["GET"])
@flask_access_validation(required_scope="admin")
def list_jobs():
    """List recent job executions, optionally filtered by integration."""
    executor = _get_executor()
    integration = request.args.get("integration")
    limit = request.args.get("limit", 50, type=int)
    limit = min(limit, 100)

    try:
        executions = executor.list_executions(integration=integration, limit=limit)
        return jsonify({"executions": executions, "count": len(executions)}), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


# ------------------------------------------------------------------
# Health
# ------------------------------------------------------------------


@bp.route("/health", methods=["GET"])
def jobs_health():
    """Check connectivity to all registered integrations."""
    executor = _get_executor()
    return jsonify(executor.check_health()), 200


# ------------------------------------------------------------------
# IBP-specific helpers
# ------------------------------------------------------------------


@bp.route("/ibp/template", methods=["POST"])
@flask_access_validation(required_scope="admin")
def read_ibp_template():
    """Read IBP job template metadata (parameters, steps, …).

    Request body::

        {"template_name": "SAP_IBP_PROC_COPY_OPERATOR"}
    """
    if not request.is_json:
        return jsonify({"error": "Request body must be JSON"}), 400

    payload = request.get_json(silent=True)
    template_name = (payload or {}).get("template_name")
    if not template_name:
        return jsonify({"error": "'template_name' is required"}), 400

    executor = _get_executor()

    if not executor.has_client(IntegrationType.IBP):
        return jsonify({"error": "IBP integration not configured"}), 503

    from ..integrations.ibp import IBPJobClient

    client = executor.get_client(IntegrationType.IBP)
    if not isinstance(client, IBPJobClient):
        return jsonify({"error": "IBP client misconfigured"}), 500

    try:
        data = client.read_template(template_name)
        return jsonify(data), 200
    except Exception:
        logger.exception("Error reading IBP template %s", template_name)
        return jsonify({"error": "Failed to read IBP template"}), 500
