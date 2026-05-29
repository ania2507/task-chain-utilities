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


@bp.route("/ibp/debug-conn", methods=["GET"])
@flask_access_validation(required_scope="admin")
def debug_ibp_connection():
    """Debug: show what credentials the IBP Destination Service resolves."""
    import os
    from ..integrations.ibp.destination import IBPDestinationClient
    dest_name = os.environ.get("IBP_DESTINATION_NAME", "")
    if not dest_name:
        return jsonify({"error": "IBP_DESTINATION_NAME not set"}), 400
    try:
        dest_client = IBPDestinationClient.from_env()
        if not dest_client:
            return jsonify({"error": "Destination client could not be built"}), 500
        conn = dest_client.get_connection()
        return jsonify({
            "destination_name": dest_name,
            "host": conn.get("host"),
            "authentication": conn.get("authentication"),
            "user": conn.get("user"),
            "has_password": bool(conn.get("password")),
            "has_token": bool(conn.get("access_token")),
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


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
    except Exception as e:
        logger.exception("Error launching job on %s", integration)
        return jsonify({"error": "Internal error while launching job", "detail": str(e)}), 500


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


@bp.route("/ibp/template-steps", methods=["POST"])
@flask_access_validation(required_scope="admin")
def read_ibp_template_steps():
    """Return normalized step list for an IBP job template.

    Request body::

        {"template_name": "SAP_IBP_PROC_COPY_OPERATOR"}

    Response::

        {
            "template_name": "...",
            "steps": [
                {"id": "step_1", "order": 1, "name": "CATALOG_ENTRY", "description": "Step text"}
            ]
        }
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
        steps = _extract_ibp_template_steps(data)
        resp: dict = {"template_name": template_name, "steps": steps}
        # Include raw sequences for debugging (first 2 params of each seq)
        if isinstance(data, dict):
            templates = data.get("templates") or []
            if templates and isinstance(templates, list):
                seqs = (templates[0] or {}).get("sequences") or []
                if seqs and isinstance(seqs, list):
                    resp["_debug_first_seq_keys"] = list(seqs[0].keys()) if seqs[0] else []
                    resp["_debug_all_seqs"] = [
                        {
                            "basic_jce_name": s.get("basic_jce_name"),
                            "seq_position": s.get("seq_position"),
                            "all_keys": list(s.keys()),
                            "seq_param_val_type": type(s.get("seq_param_val")).__name__,
                            "seq_param_val_len": len(s.get("seq_param_val") or []) if isinstance(s.get("seq_param_val"), list) else None,
                            "all_params": s.get("seq_param_val") or [],
                        }
                        for s in seqs
                    ]
        if not steps:
            resp["_debug_keys"] = list(data.keys()) if isinstance(data, dict) else repr(type(data))
            resp["_debug_raw"] = data
        return jsonify(resp), 200
    except Exception:
        logger.exception("Error reading IBP template steps for %s", template_name)
        return jsonify({"error": "Failed to read IBP template steps"}), 500


def _extract_ibp_template_steps(template_data: dict) -> list:
    """Extract a normalized step list from raw IBP TemplateData JSON.

    Supported structures (in priority order):
      1. templates[].sequences[]  — actual IBP BC_EXT_APPJOB format:
             { "templates": [{ "sequences": [{ "basic_jce_name": "...", ... }] }] }
      2. sequences[].steps[]      — camelCase / UPPER variants
      3. JOB_TASK_SEQUENCES[].JOB_TASKS[]
      4. flat top-level steps[] / STEPS[]
    """
    # Human-readable display names for common IBP catalog entries
    _CATALOG_DISPLAY_NAMES = {
        "/IBP/OP_SNPSHT": "Snapshot Operator",
        "/IBP/HCI_DI": "HCI Data Integration",
        "/IBP/EXTRACT": "Extract",
        "/IBP/LOAD": "Load",
        "/IBP/TRANSFORM": "Transform",
        "/IBP/CONSOLIDATE": "Consolidate",
        "/IBP/COPY_OPERATOR": "Copy Operator",
        "/IBP/DATA_EXPORT": "Data Export",
        "/IBP/DATA_IMPORT": "Data Import",
        "/IBP/PLANNING_AREA": "Planning Area",
        "/IBP/MASS_CHANGE": "Mass Change",
        "/IBP/EXEC_ALGO": "Execute Algorithm",
        "/IBP/EXEC_MACRO": "Execute Macro",
    }

    # Base param ID prefixes that carry a meaningful step name.
    # IBP appends a hash suffix separated by spaces: "P_TSKID C16C59BF..."
    _NAME_PARAM_PREFIXES = {
        "P_TSKID",   # "Task Name" for /IBP/HCI_DI steps — value[0].low = iFlow task name
        "P_IFLOW_ID", "P_IFLOW_NAME", "IFLOW_ID", "IFLOW_NAME",
        "P_INTERFACE_ID", "INTERFACE_ID", "INTERFACE_NAME",
        "INTEGRATION_FLOW", "FLOW_ID", "HCI_IFLOW_ID",
        "PROGRAM_NAME", "P_PROGRAM", "PROC_NAME", "P_PROC_NAME",
    }
    # Human-readable labels that identify the step-name parameter
    _NAME_PARAM_LABELS = {"Task Name", "Task ID", "IFlow ID", "IFlow Name",
                          "Interface ID", "Interface Name"}

    def _get_param_name(seq_params):
        """Extract a meaningful step name from sequence parameters.

        IBP format: each param has 'name' (e.g. 'P_TSKID C16C59BF...'),
        'label' (e.g. 'Task Name'), and 'value': [{'low': '<the value>', ...}].
        """
        def _first_low(p):
            vals = p.get("value") or []
            if isinstance(vals, list) and vals:
                v = str(vals[0].get("low") or "").strip()
                return v if v else None
            return None

        for p in seq_params:
            # Match by label first — most reliable
            if p.get("label") in _NAME_PARAM_LABELS:
                val = _first_low(p)
                if val:
                    return val
            # Match by param name prefix (strip the hash suffix after first space)
            raw_name = str(p.get("name") or "").strip()
            base_id = raw_name.split()[0].upper() if raw_name else ""
            if base_id in _NAME_PARAM_PREFIXES:
                val = _first_low(p)
                if val:
                    return val
        return None

    def _coerce_list(v):
        if isinstance(v, list):
            return v
        if isinstance(v, dict) and "results" in v:
            return v["results"]
        return []

    def _get(d, *keys):
        for k in keys:
            if k in d:
                return d[k]
        return None

    steps = []
    counter = [0]

    def _add(catalog, text, seq_no=None, step_no=None, params=None, name_hint=None):
        counter[0] += 1
        catalog_str = str(catalog or "").strip()
        catalog_display = _CATALOG_DISPLAY_NAMES.get(catalog_str)
        # Best display name: param-derived hint > catalog display > technical name
        display_name = name_hint or catalog_display or catalog_str or f"Step {counter[0]}"
        # Description: show technical name for context when we have a better display name
        if name_hint:
            desc = catalog_str  # show /IBP/HCI_DI as technical reference, not "HCI Data Integration"
        else:
            desc = str(text or "").strip() or catalog_str or ""
        steps.append({
            "id": f"step_{counter[0]}",
            "order": counter[0],
            "name": display_name,
            "description": desc,
            "sequenceNumber": seq_no,
            "stepNumber": step_no,
            "parameters": params or [],
        })

    # Pattern 1 (real IBP format): { "templates": [{ "sequences": [{ "basic_jce_name": ... }] }] }
    templates = _get(template_data, "templates")
    if templates:
        for tpl in _coerce_list(templates):
            seqs = _get(tpl, "sequences", "SEQUENCES")
            for i, seq in enumerate(_coerce_list(seqs or []), start=1):
                catalog = _get(seq, "basic_jce_name", "BASIC_JCE_NAME", "jce_name",
                               "catalogEntryName", "CATALOG_ENTRY_NAME", "name", "NAME")
                text = _get(seq, "description", "text", "label", "seq_text", "SEQ_TEXT",
                            "stepText", "STEP_TEXT")
                seq_params = _coerce_list(_get(seq, "seq_param_val", "SEQ_PARAM_VAL",
                                               "parameters", "params") or [])
                name_hint = _get_param_name(seq_params)
                _add(catalog, text, seq_no=str(i), step_no=str(i), params=seq_params,
                     name_hint=name_hint)
        if steps:
            return steps

    # Pattern 2: sequences[].steps[]  (camelCase / UPPER)
    seqs = _get(template_data, "sequences", "SEQUENCES")
    if seqs:
        for seq in _coerce_list(seqs):
            seq_no = _get(seq, "sequenceNumber", "SEQUENCE_NUMBER", "sequence_number")
            raw_steps = _get(seq, "steps", "STEPS")
            for s in _coerce_list(raw_steps or []):
                catalog = _get(s, "catalogEntryName", "CATALOG_ENTRY_NAME", "catalogEntry",
                               "CATALOG_ENTRY", "jobCatalogEntryName", "JOB_CATALOG_ENTRY_NAME")
                text = _get(s, "stepText", "STEP_TEXT", "description", "DESCRIPTION",
                            "stepDescription", "STEP_DESCRIPTION", "name", "NAME")
                step_no = _get(s, "stepNumber", "STEP_NUMBER", "step_number")
                _add(catalog, text, seq_no, step_no)
        if steps:
            return steps

    # Pattern 3: JOB_TASK_SEQUENCES[].JOB_TASKS[]
    task_seqs = _get(template_data, "JOB_TASK_SEQUENCES", "jobTaskSequences")
    if task_seqs:
        for seq in _coerce_list(task_seqs):
            seq_no = _get(seq, "JOB_TASK_SEQUENCE", "jobTaskSequence")
            tasks = _get(seq, "JOB_TASKS", "jobTasks")
            for t in _coerce_list(tasks or []):
                catalog = _get(t, "JOB_CATALOG_ENTRY_NAME", "jobCatalogEntryName",
                               "CATALOG_ENTRY_NAME", "catalogEntryName")
                text = _get(t, "JOB_TASK_NAME", "jobTaskName", "STEP_TEXT", "stepText",
                            "description", "DESCRIPTION")
                step_no = _get(t, "JOB_TASK_NO", "jobTaskNo", "STEP_NUMBER", "stepNumber")
                _add(catalog, text, seq_no, step_no)
        if steps:
            return steps

    # Pattern 4: flat steps[] / STEPS[] at root
    flat = _get(template_data, "steps", "STEPS")
    if flat:
        for s in _coerce_list(flat):
            catalog = _get(s, "catalogEntryName", "CATALOG_ENTRY_NAME", "catalogEntry",
                           "CATALOG_ENTRY", "name", "NAME")
            text = _get(s, "stepText", "STEP_TEXT", "description", "DESCRIPTION")
            step_no = _get(s, "stepNumber", "STEP_NUMBER")
            _add(catalog, text, None, step_no)
        if steps:
            return steps

    return steps
