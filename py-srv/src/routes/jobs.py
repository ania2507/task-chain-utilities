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

    # If DSP's API task passes "taskchain" in the body, look up step params that
    # were registered when the scheduler triggered that task chain run and inject
    # them into the IBP launch as the "parameters" list (key/value → name/values).
    taskchain_ctx = payload.get("taskchain")
    if taskchain_ctx and not payload.get("parameters"):
        from ..services.taskchain_executor import TaskchainExecutor
        step_params = TaskchainExecutor.consume_pending_step_params(taskchain_ctx)
        if step_params:
            # Build user-override map (keyed by IBP param name)
            user_overrides: dict = {}
            for _step_name, sparams in step_params.items():
                for p in sparams if isinstance(sparams, list) else []:
                    if p.get("active", True) and p.get("key"):
                        ibp_name = p.get("ibpParamName") or p["key"]
                        ibp_value = str(p.get("value", ""))
                        # P_VARVxx values need ABAP string constant format ('value')
                        if ibp_name.upper().startswith("P_VARV") and ibp_value:
                            if not (ibp_value.startswith("'") and ibp_value.endswith("'")):
                                ibp_value = f"'{ibp_value}'"
                        user_overrides[ibp_name] = {"name": ibp_name, "values": [{"low": ibp_value}]}
                        # Include the corresponding P_VARNxx (variable name param)
                        var_name_param = p.get("ibpVarNameParam")
                        if var_name_param and var_name_param not in user_overrides:
                            user_overrides[var_name_param] = {
                                "name": var_name_param,
                                "values": [{"low": p.get("key", "")}],
                            }

            # IBP requires ALL mandatory template params when JobParameterValues is non-empty.
            # Fetch the template defaults and merge: defaults + user overrides.
            merged: dict = {}
            try:
                from ..integrations.ibp import IBPJobClient as _IBPCls
                _ibp_cl = executor.get_client(IntegrationType.IBP)
                _tmpl_name = payload.get("template_name")
                if isinstance(_ibp_cl, _IBPCls) and _tmpl_name:
                    _tpl = _ibp_cl.read_template(_tmpl_name)
                    merged = _extract_all_seq_params_as_map(_tpl)
                    logger.info("Loaded %d template default params for '%s'", len(merged), _tmpl_name)
            except Exception as _te:
                logger.warning("Could not load IBP template defaults: %s", _te)

            # Apply user overrides on top of defaults
            merged.update(user_overrides)
            ibp_params = list(merged.values())

            if ibp_params:
                payload = {**payload, "parameters": ibp_params}
                logger.info(
                    "Injected %d param(s) (defaults+overrides) from taskchain '%s' into IBP launch",
                    len(ibp_params), taskchain_ctx,
                )

    try:
        result = executor.launch(integration, payload)
        return jsonify(result), 202
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        logger.exception("Error launching job on %s", integration)
        return jsonify({
            "error": "Internal error while launching job",
            "detail": str(e),
            # Include template info so DSP viewResponse logs always carry ibpTemplateName
            "details": {
                "template_name": payload.get("template_name", ""),
                "job_text": payload.get("job_text", ""),
            },
        }), 500


# ------------------------------------------------------------------
# Status
# ------------------------------------------------------------------


@bp.route("/<execution_id>", methods=["GET"])
@flask_access_validation(required_scope="admin")
def get_job_status(execution_id: str):
    """Poll the remote system for current job status.

    HTTP status codes follow the async polling convention expected by DSP:
      200 OK       – job completed successfully
      202 Accepted – job still running / pending (DSP keeps polling)
      500          – job failed or was cancelled
    """
    executor = _get_executor()

    try:
        result = executor.get_status(execution_id)
        job_status = result.get("status", "")
        if job_status == "COMPLETED":
            http_code = 200
        elif job_status in ("FAILED", "CANCELLED"):
            http_code = 500
        else:  # RUNNING, PENDING, UNKNOWN
            http_code = 202
        return jsonify(result), http_code
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


@bp.route("/ibp/service-metadata", methods=["GET"])
@flask_access_validation(required_scope="admin")
def ibp_service_metadata():
    """Fetch the OData $metadata of the IBP BC_EXT_APPJOB_MANAGEMENT service.

    Returns parsed entity sets, function imports and association sets so we can
    discover additional endpoints for global variable descriptions.
    """
    executor = _get_executor()
    if not executor.has_client(IntegrationType.IBP):
        return jsonify({"error": "IBP integration not configured"}), 503

    from ..integrations.ibp import IBPJobClient
    client = executor.get_client(IntegrationType.IBP)
    if not isinstance(client, IBPJobClient):
        return jsonify({"error": "IBP client misconfigured"}), 500

    try:
        resp = client._odata.get("/$metadata")
        raw_xml = resp.text

        # Parse EDMX to extract entity sets and function imports
        import re as _re
        entity_sets = _re.findall(r'<EntitySet\s+Name="([^"]+)"', raw_xml)
        func_imports = _re.findall(r'<FunctionImport\s+Name="([^"]+)"', raw_xml)
        entity_types = _re.findall(r'<EntityType\s+Name="([^"]+)"', raw_xml)

        return jsonify({
            "entitySets": sorted(entity_sets),
            "functionImports": sorted(func_imports),
            "entityTypes": sorted(entity_types),
            "_rawPreview": raw_xml[:2000],
        }), 200
    except Exception as e:
        logger.exception("Error fetching IBP service metadata")
        return jsonify({"error": str(e)}), 500


@bp.route("/ibp/global-var-descriptions", methods=["POST"])
@flask_access_validation(required_scope="admin")
def ibp_global_var_descriptions():
    """Try to fetch global variable descriptions from IBP using various entity sets.

    Request body: {"template_name": "...", "var_names": ["$G_SORG", "$G_FCSTTYPE"]}
    """
    if not request.is_json:
        return jsonify({"error": "Request body must be JSON"}), 400

    payload = request.get_json(silent=True) or {}
    var_names = payload.get("var_names", [])

    executor = _get_executor()
    if not executor.has_client(IntegrationType.IBP):
        return jsonify({"error": "IBP integration not configured"}), 503

    from ..integrations.ibp import IBPJobClient
    from urllib.parse import quote as _quote
    client = executor.get_client(IntegrationType.IBP)
    if not isinstance(client, IBPJobClient):
        return jsonify({"error": "IBP client misconfigured"}), 500

    results = {}
    attempts = []

    # Try known IBP entity sets that might have global variable descriptions
    candidate_paths = [
        "GlobalVariableSet",
        "SelectionConditionSet",
        "JobParameterTextSet",
        "JobParameterHelpSet",
        "GlobalSelectionConditionSet",
        "VariableSet",
    ]
    for path in candidate_paths:
        try:
            resp = client._odata.get(f"/{path}?$top=5&$format=json")
            data = resp.json()
            attempts.append({"path": path, "status": "ok", "preview": str(data)[:300]})
        except Exception as ex:
            attempts.append({"path": path, "status": "error", "error": str(ex)[:200]})

    return jsonify({"attempts": attempts, "results": results}), 200


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
        global_vars = _find_global_selection_vars(data)
        resp: dict = {
            "template_name": template_name,
            "steps": steps,
            "globalVars": global_vars,
            "_debug_global_vars_found": len(global_vars),
            "_debug_template_top_keys": list(data.keys()) if isinstance(data, dict) else [],
        }
        # Debug: expose full OData response fields beyond TemplateData
        resp["_debug_odata_extra"] = data.get("_odata_extra", {})

        # Debug: fetch IBP service $metadata — must use XML Accept header
        try:
            import re as _re
            # Bypass session's default json Accept header for $metadata (requires XML)
            _meta_resp = client._odata._session.get(
                f"{client._odata.base_url}/$metadata",
                headers={"Accept": "application/xml,text/xml,*/*"},
                timeout=30,
            )
            _meta_resp.raise_for_status()
            _xml = _meta_resp.text
            _entity_sets = _re.findall(r'<EntitySet\s+Name="([^"]+)"', _xml)
            _func_imports = _re.findall(r'<FunctionImport\s+Name="([^"]+)"', _xml)
            resp["_debug_ibp_entity_sets"] = sorted(_entity_sets)
            resp["_debug_ibp_func_imports"] = sorted(_func_imports)
            _gv_candidates = [s for s in _entity_sets + _func_imports if any(
                kw in s.upper() for kw in ("GLOBAL", "VAR", "SELECTION", "COND", "TEXT", "PARAM", "HELP")
            )]
            resp["_debug_ibp_gv_candidates"] = _gv_candidates
            # Try the most promising entity sets / function imports for descriptions
            _probes = {}
            from urllib.parse import quote as _q
            _tn = _q(template_name, safe='')
            # Collect P_VARNxx param names from extracted steps (step-level globalVars)
            _varn01_names = []
            for _step in steps:
                for _gv in (_step.get("globalVars") or []):
                    _vp = _gv.get("ibpVarNameParam")
                    if _vp and _vp not in _varn01_names:
                        _varn01_names.append(_vp)
            _first_varn01 = _q(_varn01_names[0], safe='') if _varn01_names else ""
            _first_varn01_raw = _varn01_names[0] if _varn01_names else ""
            _probe_paths = [
                # Full entity for P_VARN01 — look for ParameterText/Label/Description field
                f"JobTemplateParameterSet(JobTemplateName='{_tn}',JobTemplateVersion='0',JobTemplateParameterName='{_first_varn01}')?$format=json" if _first_varn01 else None,
                # F4 value list for the Variable Name param — should have $G_SORG + description
                f"JobTemplateParamValueDataSet?$filter=JobTemplateName eq '{template_name}' and JobTemplateParameterName eq '{_first_varn01_raw}'&$top=20&$format=json" if _first_varn01_raw else None,
                # Same for JobTemplateParameterValueDataSet
                f"JobTemplateParameterValueDataSet?$filter=JobTemplateName eq '{template_name}' and JobTemplateParameterName eq '{_first_varn01_raw}'&$top=20&$format=json" if _first_varn01_raw else None,
                f"TemplateValuesStructGet?JobTemplateName='{_tn}'",
            ]
            _probe_paths = [p for p in _probe_paths if p]
            for _path in _probe_paths:
                try:
                    _pr = client._odata.get(_path)
                    try:
                        _pj = _pr.json()
                        # Show parsed JSON with all keys, truncated values
                        _d = _pj.get("d", _pj)
                        if isinstance(_d, dict) and "results" in _d:
                            _items = _d["results"][:3]
                            _probes[_path[:60]] = {"parsed_results": [
                                {k: (str(v)[:100] if isinstance(v, str) else v)
                                 for k, v in item.items() if k != "__metadata"}
                                for item in _items
                            ]}
                        elif isinstance(_d, dict):
                            _probes[_path[:60]] = {"parsed_entity": {
                                k: (str(v)[:100] if isinstance(v, str) else v)
                                for k, v in _d.items() if k != "__metadata"
                            }}
                        else:
                            _probes[_path[:60]] = _pr.text[:800]
                    except Exception:
                        _probes[_path[:60]] = _pr.text[:800]
                except Exception as _pe:
                    _probes[_path[:60]] = f"ERROR: {str(_pe)[:200]}"
            resp["_debug_ibp_probes"] = _probes
        except Exception as _me:
            resp["_debug_ibp_meta_error"] = str(_me)
        # Debug: expose full template[0] keys to find where descriptions are stored
        if isinstance(data, dict):
            templates = data.get("templates") or []
            if templates and isinstance(templates, list):
                tpl0 = templates[0] or {}
                resp["_debug_template0_keys"] = list(tpl0.keys())
                # Show all keys EXCEPT sequences (too large) to find global variable section
                resp["_debug_template0_non_seq"] = {
                    k: v for k, v in tpl0.items()
                    if k not in ("sequences", "SEQUENCES") and not isinstance(v, list)
                }
                # Show first items of non-sequence list fields (e.g. global_variables, selection_conds)
                resp["_debug_template0_lists"] = {
                    k: (v[:3] if isinstance(v, list) else v)
                    for k, v in tpl0.items()
                    if k not in ("sequences", "SEQUENCES") and isinstance(v, list)
                }
                seqs = tpl0.get("sequences") or []
                if seqs and isinstance(seqs, list):
                    resp["_debug_first_seq_keys"] = list(seqs[0].keys()) if seqs[0] else []
        if not steps:
            resp["_debug_keys"] = list(data.keys()) if isinstance(data, dict) else repr(type(data))
            resp["_debug_raw"] = data
        return jsonify(resp), 200
    except Exception:
        logger.exception("Error reading IBP template steps for %s", template_name)
        return jsonify({"error": "Failed to read IBP template steps"}), 500


def _find_global_selection_vars(template_data: dict) -> list:
    """Scan the IBP template JSON for global variable parameters ($G_*).

    IBP typically stores global variables as PAIRS inside seq_param_val:
      entry i:   label="Variable Name N",  value[0].low = "$G_SORG"
      entry i+1: label="Variable Value N", value[0].low = "'IT10|DE10|BE40'"
    We also handle formats where $G_* appears as a direct field value.
    """
    import re as _re
    import json as _json

    found: dict = {}

    def _first_low(param_obj):
        vals = param_obj.get("value") or param_obj.get("VALUE") or []
        if isinstance(vals, str):
            try:
                vals = _json.loads(vals)
            except Exception:
                return ""
        if isinstance(vals, dict) and "results" in vals:
            vals = vals["results"]
        if isinstance(vals, list) and vals:
            return str(vals[0].get("low") or vals[0].get("LOW") or "")
        return ""

    def _strip_quotes(s):
        return _re.sub(r"^'(.*)'$", r"\1", s.strip())

    def _process_seq_params(seq_params):
        """Process a seq_param_val list for P_VARNxx/P_VARVxx global variable pairs."""
        if not isinstance(seq_params, list):
            return
        pmap: dict = {}
        for p in seq_params:
            if not isinstance(p, dict):
                continue
            pname = str(p.get("name") or "").strip()
            if pname:
                pmap[pname] = {"low": _first_low(p), "label": str(p.get("label") or "")}
        for pname, pdata in pmap.items():
            import re as _re2
            m = _re2.match(r'^P_VARN(\d+)', pname, _re2.IGNORECASE)
            if not m:
                continue
            var_name = pdata["low"].strip()
            if not var_name or not var_name.upper().startswith("$G_"):
                continue
            if var_name in found:
                continue
            idx = m.group(1)
            current_val = ""
            for vpname, vpdata in pmap.items():
                if _re2.match(rf'^P_VARV{idx}', vpname, _re2.IGNORECASE):
                    raw = vpdata["low"].strip()
                    if raw:
                        current_val = _strip_quotes(raw)
                    break
            found[var_name] = {"name": var_name, "label": pdata["label"], "currentValue": current_val}

    def _scan(obj, depth=0):
        if depth > 12:
            return
        if isinstance(obj, list):
            _process_seq_params(obj)
            for item in obj:
                _scan(item, depth + 1)
        elif isinstance(obj, dict):
            for k, v in obj.items():
                if isinstance(v, str):
                    sv = v.strip()
                    if sv.startswith("{") or sv.startswith("["):
                        try:
                            _scan(_json.loads(sv), depth + 1)
                        except Exception:
                            pass
                elif isinstance(v, (dict, list)):
                    _scan(v, depth + 1)

    _scan(template_data)

    # Regex fallback: names only (no values), if structural scan found nothing
    if not found:
        try:
            raw_str = _json.dumps(template_data)
            for gp in sorted(set(_re.findall(r'\$G_[A-Z0-9_]+', raw_str))):
                if gp not in found:
                    found[gp] = {"name": gp, "label": "", "currentValue": ""}
        except Exception:
            pass

    return sorted(found.values(), key=lambda x: x["name"])


def _extract_all_seq_params_as_map(template_data: dict) -> dict:
    """Extract all changeable seq_param_val entries from ALL sequences as a name→entry map.

    IBP requires every mandatory parameter to be present in JobParameterValues when any
    override is supplied.  This function returns the full set of template defaults so they
    can be merged with user-specified overrides before scheduling.
    """
    import json as _jss

    def _get_low(p):
        vals = p.get("value") or []
        if isinstance(vals, str):
            try: vals = _jss.loads(vals)
            except Exception: return None
        if isinstance(vals, dict) and "results" in vals:
            vals = vals["results"]
        if isinstance(vals, list) and vals:
            low = vals[0].get("low") or vals[0].get("LOW")
            return str(low) if low is not None else ""
        return None

    result: dict = {}

    def _process(seq_params):
        for p in (seq_params or []):
            if not isinstance(p, dict):
                continue
            if not p.get("change_able", False):
                continue
            pname = str(p.get("name") or "").strip()
            if not pname or pname in result:
                continue
            low = _get_low(p)
            if low is None:
                continue  # skip params with no value at all
            result[pname] = {"name": pname, "values": [{"low": low}]}

    def _scan(obj, depth=0):
        if depth > 10:
            return
        if isinstance(obj, list):
            # Detect seq_param_val lists by presence of change_able field
            if obj and any(isinstance(x, dict) and "change_able" in x for x in obj[:5]):
                _process(obj)
            for item in obj:
                _scan(item, depth + 1)
        elif isinstance(obj, dict):
            for k, v in obj.items():
                if isinstance(v, (dict, list)):
                    _scan(v, depth + 1)

    _scan(template_data)
    return result


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

    def _extract_step_global_vars(seq_params):
        """Extract $G_* global variables from an IBP HCI_DI step's seq_param_val.

        IBP stores global variables as numbered parameter pairs:
          P_VARNxx...  label="Variable Name N"  value[0].low = "$G_SORG"
          P_VARVxx...  label="Variable Value N"  value[0].low = "'IT10|DE10|BE40'"
        where xx is a two-digit index (01-15). The pairs are NOT adjacent.
        """
        import re as _re2
        import json as _jv

        def _get_low(p):
            vals = p.get("value") or []
            if isinstance(vals, str):
                try: vals = _jv.loads(vals)
                except Exception: return ""
            if isinstance(vals, dict) and "results" in vals:
                vals = vals["results"]
            return str(vals[0].get("low") or vals[0].get("LOW") or "").strip() if (isinstance(vals, list) and vals) else ""

        pmap: dict = {}
        for p in (seq_params or []):
            if not isinstance(p, dict):
                continue
            pname = str(p.get("name") or "").strip()
            if pname:
                pmap[pname] = {"low": _get_low(p), "label": str(p.get("label") or "")}

        global_vars = []
        seen: set = set()
        for pname, pdata in pmap.items():
            m = _re2.match(r'^P_VARN(\d+)', pname, _re2.IGNORECASE)
            if not m:
                continue
            var_name = pdata["low"]
            if not var_name or not var_name.upper().startswith("$G_"):
                continue
            if var_name in seen:
                continue
            seen.add(var_name)
            idx = m.group(1)
            current_val = ""
            ibp_param_name = ""   # P_VARVxx (value param name)
            raw_val_with_quotes = ""  # original value WITH ABAP quotes
            for vpname, vpdata in pmap.items():
                if _re2.match(rf'^P_VARV{idx}', vpname, _re2.IGNORECASE):
                    raw = vpdata["low"]
                    if raw:
                        raw_val_with_quotes = raw  # keep 'IT10|DE10|BE40' format
                        current_val = _re2.sub(r"^'(.*)'$", r"\1", raw)
                    ibp_param_name = vpname
                    break
            global_vars.append({
                "name": var_name,
                "label": pdata["label"],
                "currentValue": current_val,
                "ibpParamName": ibp_param_name,    # P_VARVxx
                "ibpVarNameParam": pname,           # P_VARNxx (the name param)
                "ibpRawValue": raw_val_with_quotes, # original ABAP format with quotes
            })
        return global_vars

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

    def _add(catalog, text, seq_no=None, step_no=None, params=None, name_hint=None, global_vars=None):
        counter[0] += 1
        catalog_str = str(catalog or "").strip()
        catalog_display = _CATALOG_DISPLAY_NAMES.get(catalog_str)
        display_name = name_hint or catalog_display or catalog_str or f"Step {counter[0]}"
        if name_hint:
            desc = catalog_str
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
            "globalVars": global_vars or [],
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
                step_global_vars = _extract_step_global_vars(seq_params)
                _add(catalog, text, seq_no=str(i), step_no=str(i), params=seq_params,
                     name_hint=name_hint, global_vars=step_global_vars)
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
