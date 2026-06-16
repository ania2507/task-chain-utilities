"""Datasphere diagnostics endpoints.

These endpoints are meant for operator debugging in CF. They execute Datasphere CLI commands
and return sanitized outputs (no secrets/tokens) to help troubleshoot permissions/space/taskchain issues.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.request
from typing import Any, Dict, Optional

from flask import Blueprint, jsonify, request

from ..auth import flask_access_validation
from ..integrations.dsp import DSPDestinationClient


def _utc_str(value) -> str | None:
    """Convert a HANA timestamp to an ISO string with explicit UTC suffix."""
    if value is None:
        return None
    s = str(value)
    if s.endswith("Z") or "+" in s[10:]:
        return s
    return s.replace(" ", "T") + "Z"

bp = Blueprint("dsp", __name__)


_TOKEN_CACHE: dict[str, Any] = {
    "access_token": None,
    "expires_at": 0.0,
}



_REDACT_KEYS = {
    "client_secret",
    "access_token",
    "refresh_token",
    "code",
    "id_token",
}


def _extract_ibp_template_from_metadata(md: dict) -> str | None:
    """Try to extract an IBP job template name from a DWC deployment-metadata dict.

    DWC stores the task configuration as JSON in ``3VR_DEPL_METADATA_01``.
    For API-trigger steps the exact key names vary by DWC version; we probe
    all nested structures recursively, including URL patterns like
    JobTemplates('NAME') used in OData API task configurations.
    """
    if not isinstance(md, dict):
        return None

    _TEMPLATE_KEYS = {
        "templateName", "template_name", "jobTemplateName", "job_template_name",
        "ibpTemplateName", "ibpTemplate", "IBP_TEMPLATE", "JOB_TEMPLATE_NAME",
        "jobTemplate", "templateId", "job_template", "IBP_JOB_TEMPLATE",
        "ibpJobTemplateName", "procTemplateName", "applicationJobTemplate",
        "JobTemplateName", "TEMPLATE_NAME", "TEMPLATE_ID", "JOB_TEMPLATE",
    }

    # OData key predicate: JobTemplates('NAME') or JobTemplate(TemplateName='NAME')
    _URL_PATTERNS = [
        re.compile(r"JobTemplates\('([^']+)'\)", re.IGNORECASE),
        re.compile(r"JobTemplate\([^)]*TemplateName='([^']+)'", re.IGNORECASE),
        re.compile(r"[?&]jobTemplateId=([^&\s'\"]+)", re.IGNORECASE),
        re.compile(r"[?&]templateName=([^&\s'\"]+)", re.IGNORECASE),
        re.compile(r"[?&]job_template(?:_name)?=([^&\s'\"]+)", re.IGNORECASE),
    ]

    def _scan_string_for_template(s: str) -> str | None:
        """Look for IBP template name patterns in a plain string (URL or similar)."""
        for pat in _URL_PATTERNS:
            m = pat.search(s)
            if m:
                val = m.group(1).strip()
                if val:
                    return val
        return None

    def _deep_search(obj, depth=0):
        if depth > 8 or not isinstance(obj, dict):
            return None
        # First pass: check direct keys and scan string values for URL patterns
        for k, v in obj.items():
            if isinstance(k, str) and k in _TEMPLATE_KEYS and isinstance(v, str) and v.strip():
                return v.strip()
            if isinstance(v, str):
                stripped = v.strip()
                # Parse embedded JSON strings (e.g. Request Body field)
                if stripped.startswith("{"):
                    try:
                        import json as _json
                        parsed = _json.loads(stripped)
                        if isinstance(parsed, dict):
                            result = _deep_search(parsed, depth + 1)
                            if result:
                                return result
                    except Exception:
                        pass
                # Scan all non-empty strings for URL/OData patterns
                if stripped:
                    result = _scan_string_for_template(stripped)
                    if result:
                        return result
        # Second pass: recurse into nested dicts and lists
        for k, v in obj.items():
            if isinstance(v, dict):
                result = _deep_search(v, depth + 1)
                if result:
                    return result
            elif isinstance(v, list):
                for item in v:
                    if isinstance(item, dict):
                        result = _deep_search(item, depth + 1)
                        if result:
                            return result
        return None

    return _deep_search(md)


def _extract_sac_multiaction_from_metadata(md: dict) -> str | None:
    """Try to extract a SAC multi-action ID from a DWC deployment-metadata dict.

    SAC API-trigger steps store their config as JSON, e.g.::

        {"integration": "sac", "multiaction_id": "t.F:A8B06D852F1681322AE35493186B1970", "parameters": {}}

    possibly nested or embedded as a JSON string within other fields.
    """
    if not isinstance(md, dict):
        return None

    _KEYS = {"multiaction_id", "multiActionId", "MULTIACTION_ID", "MultiActionId", "MULTI_ACTION_ID"}

    def _deep_search(obj, depth=0):
        if depth > 8 or not isinstance(obj, dict):
            return None
        for k, v in obj.items():
            if isinstance(k, str) and k in _KEYS and isinstance(v, str) and v.strip():
                return v.strip()
            if isinstance(v, str):
                stripped = v.strip()
                if stripped.startswith("{"):
                    try:
                        parsed = json.loads(stripped)
                        if isinstance(parsed, dict):
                            result = _deep_search(parsed, depth + 1)
                            if result:
                                return result
                    except Exception:
                        pass
        for k, v in obj.items():
            if isinstance(v, dict):
                result = _deep_search(v, depth + 1)
                if result:
                    return result
            elif isinstance(v, list):
                for item in v:
                    if isinstance(item, dict):
                        result = _deep_search(item, depth + 1)
                        if result:
                            return result
        return None

    return _deep_search(md)


def _truncate(s: str, limit: int = 6000) -> str:
    s = s or ""
    if len(s) <= limit:
        return s
    return s[:limit] + f"\n... (truncated, {len(s)} chars total)"


def _redact_text(text: str) -> str:
    text = text or ""

    # Common patterns
    text = re.sub(r"(Bearer\s+)[A-Za-z0-9\-\._~\+\/]+=*", r"\1<redacted>", text, flags=re.I)
    text = re.sub(r"(client_secret\"?\s*[:=]\s*)\".*?\"", r"\1\"<redacted>\"", text, flags=re.I)
    text = re.sub(r"(access_token\"?\s*[:=]\s*)\".*?\"", r"\1\"<redacted>\"", text, flags=re.I)
    text = re.sub(r"(refresh_token\"?\s*[:=]\s*)\".*?\"", r"\1\"<redacted>\"", text, flags=re.I)

    # CLI flags that may contain secrets
    text = re.sub(r"(--client-secret\s+)(\S+)", r"\1<redacted>", text)
    text = re.sub(r"(-C\s+)(\S+)", r"\1<redacted>", text)
    text = re.sub(r"(--access-token\s+)(\S+)", r"\1<redacted>", text)
    text = re.sub(r"(-a\s+)(\S+)", r"\1<redacted>", text)
    text = re.sub(r"(--refresh-token\s+)(\S+)", r"\1<redacted>", text)
    text = re.sub(r"(-r\s+)(\S+)", r"\1<redacted>", text)

    return _truncate(text)


def _redact_json_payload(payload: Any) -> Any:
    if isinstance(payload, dict):
        out: dict = {}
        for k, v in payload.items():
            if isinstance(k, str) and k.lower() in _REDACT_KEYS:
                out[k] = "<redacted>"
            else:
                out[k] = _redact_json_payload(v)
        return out
    if isinstance(payload, list):
        return [_redact_json_payload(x) for x in payload]
    if isinstance(payload, str):
        return _redact_text(payload)
    return payload




def _get_dsp_rest_config() -> Dict[str, str]:
    dest_name = os.environ.get("DSP_DESTINATION_NAME", "").strip()
    if not dest_name:
        raise RuntimeError(
            "DSP destination not configured. Set DSP_DESTINATION_NAME and bind Destination Service."
        )

    dest_client = DSPDestinationClient.from_env()
    if not dest_client:
        raise RuntimeError(
            "DSP destination configured but Destination Service credentials are missing. "
            "Bind destination service or set DEST_* env vars."
        )

    conn = dest_client.get_connection()
    base_url = (conn.get("host") or "").rstrip("/")
    access_token = conn.get("access_token") or ""
    if not base_url:
        raise RuntimeError(
            f"DSP destination '{dest_name}' has no target URL configured"
        )
    if not access_token:
        raise RuntimeError(
            f"DSP destination '{dest_name}' did not return an auth token"
        )

    return {
        "base_url": base_url,
        "access_token": access_token,
        "destination_name": dest_name,
    }


def _get_dsp_access_token() -> str:
    cfg = _get_dsp_rest_config()
    return cfg["access_token"]


def _post_dsp_directexecute(payload: Dict[str, Any]) -> Dict[str, Any]:
    cfg = _get_dsp_rest_config()
    access_token = _get_dsp_access_token()
    url = f"{cfg['base_url']}/dwaas-core/tf/directexecute"

    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        resp_body = resp.read().decode("utf-8")
        if resp_body:
            try:
                return json.loads(resp_body)
            except Exception:
                return {"raw": resp_body}
        return {}


@bp.route("/diagnose", methods=["POST"])
@flask_access_validation(required_scope="admin")
def diagnose_dsp():
    """Datasphere diagnostics via BTP Destination Service (REST)."""

    checks: list[dict] = []

    # Check destination connectivity
    try:
        cfg = _get_dsp_rest_config()
        checks.append({
            "name": "destination",
            "ok": True,
            "host": cfg["base_url"],
            "destination_name": cfg["destination_name"],
        })
    except Exception as e:
        checks.append({"name": "destination", "ok": False, "error": str(e)})
        return jsonify({"success": False, "checks": checks}), 200

    # Optionally list spaces
    payload = request.get_json(silent=True) or {}
    spaceid = payload.get("spaceid") or payload.get("spaceId")
    taskchain = payload.get("taskchain") or payload.get("taskchain_name")
    base_url = cfg["base_url"]
    access_token = cfg["access_token"]

    try:
        req = urllib.request.Request(
            f"{base_url}/api/v1/spaces?$top=25",
            headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        spaces = [s.get("spaceDefinition", {}).get("spaceId") or s.get("id") for s in data.get("value", [])]
        checks.append({"name": "spaces.list", "ok": True, "count": len(spaces), "spaces": spaces[:10]})
    except Exception as e:
        checks.append({"name": "spaces.list", "ok": False, "error": str(e)})

    if spaceid and taskchain:
        try:
            req = urllib.request.Request(
                f"{base_url}/api/v1/tasks/spaces/{spaceid}/chains?$filter=technicalName eq '{taskchain}'",
                headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            checks.append({"name": "taskchain.check", "ok": True, "result": data})
        except Exception as e:
            checks.append({"name": "taskchain.check", "ok": False, "error": str(e)})

    ok = all(c.get("ok", True) for c in checks)
    return jsonify({"success": ok, "checks": checks}), 200


@bp.route("/debug-businessnames", methods=["GET"])
@flask_access_validation(required_scope="read")
def debug_businessnames():
    """Debug: inspect where business names are stored for a task chain's steps.

    Query params:
    - spaceId   (required)
    - taskchain (required)
    """
    import json as _json
    from flask import current_app

    space_id  = request.args.get("spaceId")
    taskchain = request.args.get("taskchain")
    if not space_id or not taskchain:
        return jsonify({"error": "spaceId and taskchain are required"}), 400

    db = current_app.extensions["taskchain"]["db_query_executor"]
    out = {}

    # 1. Raw metadata JSON for the task chain itself
    try:
        rows = db.query(
            'SELECT "JSON", "REPOSITORY_OBJECT_TYPE", "DEPLOYED_AT" '
            'FROM "ORCHESTRATION"."3VR_DEPL_METADATA_01" '
            'WHERE "NAME" = ? ORDER BY "DEPLOYED_AT" DESC LIMIT 1',
            (taskchain,)
        )
        if rows:
            raw = rows[0].get("JSON") or rows[0].get("json") or ""
            try:
                parsed = _json.loads(raw)
                out["taskchain_metadata_keys"] = list(parsed.keys()) if isinstance(parsed, dict) else str(type(parsed))
                # Extract nodes and show first node raw
                tc_section = (parsed.get("taskchains") or {}).get(taskchain)
                if isinstance(tc_section, dict):
                    nodes = tc_section.get("nodes") or []
                    out["node_count"] = len(nodes)
                    out["first_node_raw"] = nodes[0] if nodes else None
                    out["all_nodes_keys"] = [list(n.keys()) for n in nodes[:5] if isinstance(n, dict)]
                else:
                    out["taskchain_metadata_keys_top"] = list(parsed.keys())[:20]
            except Exception as e:
                out["taskchain_metadata_parse_error"] = str(e)
        else:
            out["taskchain_metadata"] = "NOT FOUND"
    except Exception as e:
        out["taskchain_metadata_error"] = str(e)

    # 2. Check if step artifacts have their own metadata rows
    # First derive object IDs from nodes we found above
    try:
        rows2 = db.query(
            'SELECT "JSON" FROM "ORCHESTRATION"."3VR_DEPL_METADATA_01" '
            'WHERE "NAME" = ? ORDER BY "DEPLOYED_AT" DESC LIMIT 1',
            (taskchain,)
        )
        if rows2:
            raw2 = rows2[0].get("JSON") or ""
            parsed2 = _json.loads(raw2) if raw2 else {}
            tc_sec = (parsed2.get("taskchains") or {}).get(taskchain)
            raw_nodes = (tc_sec.get("nodes") if isinstance(tc_sec, dict) else None) or []
            obj_ids = []
            for n in raw_nodes:
                tid = n.get("taskIdentifier") or {}
                oid = tid.get("objectId") or n.get("objectId") or ""
                if oid and oid not in obj_ids:
                    obj_ids.append(oid)
            out["step_objectIds"] = obj_ids
            if obj_ids:
                ph = ",".join(["?"] * len(obj_ids))
                step_rows = db.query(
                    f'SELECT "NAME", "REPOSITORY_OBJECT_TYPE", LEFT("JSON", 300) as "JSON_PREVIEW" '
                    f'FROM "ORCHESTRATION"."3VR_DEPL_METADATA_01" WHERE "NAME" IN ({ph})',
                    tuple(obj_ids)
                )
                out["step_metadata_rows_found"] = len(step_rows or [])
                out["step_metadata_preview"] = [
                    {"name": r.get("NAME"), "type": r.get("REPOSITORY_OBJECT_TYPE"), "json_preview": r.get("JSON_PREVIEW")}
                    for r in (step_rows or [])
                ]
    except Exception as e:
        out["step_metadata_error"] = str(e)

    # 3. Check DWC_TENANT_OWNER for entity/catalog tables
    try:
        cat_tables = db.query(
            "SELECT TABLE_NAME FROM SYS.TABLES "
            "WHERE SCHEMA_NAME = 'DWC_TENANT_OWNER' "
            "AND (TABLE_NAME LIKE '%ENTITY%' OR TABLE_NAME LIKE '%CATALOG%' "
            "     OR TABLE_NAME LIKE '%LABEL%' OR TABLE_NAME LIKE '%OBJECT%')"
        )
        out["dwc_tenant_owner_tables"] = [r.get("TABLE_NAME") for r in (cat_tables or [])]
    except Exception as e:
        out["dwc_tenant_owner_tables_error"] = str(e)

    return jsonify(out), 200


@bp.route("/debug-step-metadata", methods=["GET"])
@flask_access_validation(required_scope="read")
def debug_step_metadata():
    """Return full deployment metadata + raw DAG node for a given objectId / taskchain.

    Query params:
    - objectId  (required) – e.g. APITask_2231
    - taskchain (optional) – also show the raw node definition from the taskchain DAG
    - spaceId   (optional)
    """
    import json as _json
    from flask import current_app

    object_id = request.args.get("objectId")
    taskchain = request.args.get("taskchain")
    if not object_id:
        return jsonify({"error": "objectId is required"}), 400

    db = current_app.extensions["taskchain"]["db_query_executor"]
    out: dict = {"objectId": object_id}

    # 1. Full metadata row for the objectId itself
    try:
        rows = db.query(
            'SELECT "NAME", "REPOSITORY_OBJECT_TYPE", "JSON" '
            'FROM "ORCHESTRATION"."3VR_DEPL_METADATA_01" '
            'WHERE "NAME" = ? ORDER BY "DEPLOYED_AT" DESC LIMIT 1',
            (object_id,)
        )
        if rows:
            raw = rows[0].get("JSON") or rows[0].get("json") or ""
            try:
                out["metadata"] = _json.loads(raw)
            except Exception:
                out["metadata_raw"] = raw[:2000]
        else:
            out["metadata"] = None
    except Exception as e:
        out["metadata_error"] = str(e)

    # 2. Raw node definition from the taskchain deployment metadata (never-run DAG)
    if taskchain:
        try:
            rows2 = db.query(
                'SELECT "JSON" FROM "ORCHESTRATION"."3VR_DEPL_METADATA_01" '
                'WHERE "NAME" = ? ORDER BY "DEPLOYED_AT" DESC LIMIT 1',
                (taskchain,)
            )
            if rows2:
                tc_raw = rows2[0].get("JSON") or ""
                tc_meta = _json.loads(tc_raw) if tc_raw else {}
                tc_sec = (tc_meta.get("taskchains") or {}).get(taskchain) or {}
                nodes = tc_sec.get("nodes") or []
                matching = [
                    n for n in nodes
                    if (n.get("taskIdentifier") or {}).get("objectId") == object_id
                    or n.get("objectId") == object_id
                ]
                out["dag_nodes"] = matching
        except Exception as e:
            out["dag_nodes_error"] = str(e)

        # 3. Raw node definition from the latest run's DAG snapshot (has-run taskchains)
        try:
            space_id = request.args.get("spaceId")
            if space_id:
                run_rows = db.query(
                    'SELECT "JSON" FROM "ORCHESTRATION"."3VR_DWC_TASK_CHAIN_RUNS_01" '
                    'WHERE "SPACE_ID" = ? AND "TECHNICAL_NAME" = ? '
                    'ORDER BY "CHAIN_TASK_LOG_ID" DESC LIMIT 1',
                    (space_id, taskchain)
                )
            else:
                run_rows = db.query(
                    'SELECT "JSON" FROM "ORCHESTRATION"."3VR_DWC_TASK_CHAIN_RUNS_01" '
                    'WHERE "TECHNICAL_NAME" = ? '
                    'ORDER BY "CHAIN_TASK_LOG_ID" DESC LIMIT 1',
                    (taskchain,)
                )
            if run_rows:
                run_raw = run_rows[0].get("JSON") or run_rows[0].get("json") or ""
                run_dag = _json.loads(run_raw) if run_raw else {}
                run_sec = (run_dag.get("taskchains") or {}).get(taskchain) or {}
                run_nodes = run_sec.get("nodes") or []
                matching_run = [
                    n for n in run_nodes
                    if (n.get("taskIdentifier") or {}).get("objectId") == object_id
                    or n.get("objectId") == object_id
                ]
                out["run_dag_nodes"] = matching_run
            else:
                out["run_dag_nodes"] = []
        except Exception as e:
            out["run_dag_nodes_error"] = str(e)

    return jsonify(out), 200


@bp.route("/tf/remove-deleted-records", methods=["POST"])
@flask_access_validation(required_scope="admin")
def remove_deleted_records():
    payload = request.get_json(silent=True) if request.is_json else {}
    if not isinstance(payload, dict):
        return jsonify({"error": "Payload must be a JSON object"}), 400

    space_id = payload.get("spaceId") or payload.get("spaceid")
    object_id = payload.get("objectId") or payload.get("objectid")
    retention_days = payload.get("retentionTimeInDays")
    application_id = payload.get("applicationId") or "LOCAL_TABLE"

    if not space_id or not object_id or retention_days is None:
        return jsonify({"error": "Missing spaceId, objectId, or retentionTimeInDays"}), 400

    dsp_payload = {
        "applicationId": application_id,
        "spaceId": space_id,
        "objectId": object_id,
        "activity": "REMOVE_DELETED_RECORDS",
        "parameters": {"retentionTimeInDays": {"val": retention_days}},
    }

    try:
        result = _post_dsp_directexecute(dsp_payload)
        return jsonify(result), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/tf/delete-data", methods=["POST"])
@flask_access_validation(required_scope="admin")
def delete_data_marked():
    payload = request.get_json(silent=True) if request.is_json else {}
    if not isinstance(payload, dict):
        return jsonify({"error": "Payload must be a JSON object"}), 400

    space_id = payload.get("spaceId") or payload.get("spaceid")
    object_id = payload.get("objectId") or payload.get("objectid")
    application_id = payload.get("applicationId") or "LOCAL_TABLE"

    if not space_id or not object_id:
        return jsonify({"error": "Missing spaceId or objectId"}), 400

    dsp_payload = {
        "applicationId": application_id,
        "spaceId": space_id,
        "objectId": object_id,
        "activity": "DELETE_DATA",
        "parameters": {},
    }

    try:
        result = _post_dsp_directexecute(dsp_payload)
        return jsonify(result), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/tasklog-messages", methods=["GET"])
@flask_access_validation(required_scope="read")
def get_tasklog_messages():
    """Get log messages for a specific task execution.
    
    Query params:
    - taskLogId: the TASK_LOG_ID to get messages for (required)
    """
    from flask import current_app
    
    task_log_id = request.args.get("taskLogId")
    if not task_log_id:
        return jsonify({"success": False, "error": "taskLogId is required"}), 400
    
    try:
        db_query_executor = current_app.extensions["taskchain"]["db_query_executor"]
        
        sql = '''
            SELECT 
                "MESSAGE_NO" as "messageNo",
                "SEVERITY" as "severity",
                "TEXT" as "text",
                "DETAILS" as "details",
                "TIMESTAMP" as "timestamp",
                "MESSAGE_BUNDLE_KEY" as "messageKey"
            FROM "ORCHESTRATION"."3VR_DWC_TASK_LOG_MESSAGES_01"
            WHERE "TASK_LOG_ID" = ?
            ORDER BY "MESSAGE_NO" ASC
        '''
        
        rows = db_query_executor.query(sql, (task_log_id,))
        
        messages = []
        for row in rows:
            details = row.get("details")
            parsed_details = {}
            if details:
                try:
                    import json
                    parsed_details = json.loads(details)
                except:
                    parsed_details = {"raw": details}
            
            messages.append({
                "messageNo": row.get("messageNo"),
                "severity": row.get("severity"),
                "text": row.get("text"),
                "details": parsed_details,
                "timestamp": _utc_str(row.get("timestamp")),
                "messageKey": row.get("messageKey")
            })
        
        return jsonify({"success": True, "messages": messages}), 200
        
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@bp.route("/taskchain-run-nodes", methods=["GET"])
@flask_access_validation(required_scope="read")
def get_taskchain_run_nodes():
    """Get node execution details for a task chain run.
    
    Query params:
    - chainTaskLogId: the CHAIN_TASK_LOG_ID from TASK_CHAIN_RUNS (required)
    """
    from flask import current_app
    
    chain_task_log_id = request.args.get("chainTaskLogId")
    if not chain_task_log_id:
        return jsonify({"success": False, "error": "chainTaskLogId is required"}), 400
    
    try:
        db_query_executor = current_app.extensions["taskchain"]["db_query_executor"]
        
        # Get run info with DAG structure
        run_sql = '''
            SELECT 
                "CHAIN_TASK_LOG_ID" as "chainTaskLogId",
                "TECHNICAL_NAME" as "taskChainName",
                "SPACE_ID" as "spaceId",
                "FUTURE_STATUS" as "status",
                "JSON" as "dagJson",
                "PLAN" as "planJson"
            FROM "ORCHESTRATION"."3VR_DWC_TASK_CHAIN_RUNS_01"
            WHERE "CHAIN_TASK_LOG_ID" = ?
        '''
        
        run_rows = db_query_executor.query(run_sql, (chain_task_log_id,))
        
        if not run_rows:
            return jsonify({"success": False, "error": "Run not found"}), 404
        
        run_info = run_rows[0]
        
        # Get node execution details
        nodes_sql = '''
            SELECT 
                n."NODE_ID" as "nodeId",
                n."TASK_LOG_ID" as "taskLogId",
                n."REMAINING_RUNS" as "remainingRuns",
                l."STATUS" as "status",
                l."START_TIME" as "startTime",
                l."END_TIME" as "endTime",
                l."OBJECT_ID" as "objectId"
            FROM "ORCHESTRATION"."3VR_DWC_TASK_CHAIN_RUN_NODES_01" n
            LEFT JOIN "ORCHESTRATION"."3VR_DWC_TASK_LOGS_01" l ON n."TASK_LOG_ID" = l."TASK_LOG_ID"
            WHERE n."CHAIN_TASK_LOG_ID" = ?
            ORDER BY n."NODE_ID" ASC
        '''
        
        node_rows = db_query_executor.query(nodes_sql, (chain_task_log_id,))
        
        nodes = []
        for row in node_rows:
            status_raw = (row.get("status") or "").upper()
            status = "success" if status_raw == "COMPLETED" else "error" if status_raw in ("FAILED", "ERROR") else "running" if status_raw == "RUNNING" else "pending"
            
            # Calculate duration in minutes
            duration = None
            start_time = row.get("startTime")
            end_time = row.get("endTime")
            if start_time and end_time:
                try:
                    from datetime import datetime
                    if isinstance(start_time, str):
                        start_dt = datetime.fromisoformat(start_time.replace("Z", "+00:00").replace(" ", "T"))
                    else:
                        start_dt = start_time
                    if isinstance(end_time, str):
                        end_dt = datetime.fromisoformat(end_time.replace("Z", "+00:00").replace(" ", "T"))
                    else:
                        end_dt = end_time
                    duration = round((end_dt - start_dt).total_seconds() / 60, 2)
                except Exception as e:
                    pass
            
            nodes.append({
                "nodeId": row.get("nodeId"),
                "taskLogId": row.get("taskLogId"),
                "remainingRuns": row.get("remainingRuns"),
                "status": status,
                "startTime": _utc_str(row.get("startTime")),
                "endTime": _utc_str(row.get("endTime")),
                "objectId": row.get("objectId"),
                "duration": duration
            })
        
        # Parse DAG JSON
        dag_structure = None
        if run_info.get("dagJson"):
            try:
                import json
                dag_structure = json.loads(run_info["dagJson"])
            except:
                pass
        
        return jsonify({
            "success": True,
            "run": {
                "chainTaskLogId": run_info.get("chainTaskLogId"),
                "taskChainName": run_info.get("taskChainName"),
                "spaceId": run_info.get("spaceId"),
                "status": run_info.get("status")
            },
            "nodes": nodes,
            "dagStructure": dag_structure
        }), 200
        
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@bp.route("/taskchain-dag", methods=["GET"])
@flask_access_validation(required_scope="read")
def get_taskchain_dag():
    """Get DAG structure for a task chain.
    
    Query params:
    - spaceId: the space ID (required)
    - taskchain: the task chain name (required)
    - runId: optional specific run ID, otherwise gets latest
    """
    from flask import current_app
    import json
    
    space_id = request.args.get("spaceId")
    taskchain = request.args.get("taskchain")
    run_id = request.args.get("runId")
    
    if not space_id or not taskchain:
        return jsonify({"success": False, "error": "spaceId and taskchain are required"}), 400
    
    try:
        db_query_executor = current_app.extensions["taskchain"]["db_query_executor"]
        
        # Get the DAG structure from TASK_CHAIN_RUNS
        if run_id:
            sql = '''
                SELECT 
                    r."CHAIN_TASK_LOG_ID" as "chainTaskLogId",
                    r."JSON" as "dagJson",
                    r."PLAN" as "planJson",
                    r."FUTURE_STATUS" as "status"
                FROM "ORCHESTRATION"."3VR_DWC_TASK_CHAIN_RUNS_01" r
                WHERE r."CHAIN_TASK_LOG_ID" = ?
            '''
            rows = db_query_executor.query(sql, (run_id,))
        else:
            # Get latest run for this task chain
            sql = '''
                SELECT 
                    r."CHAIN_TASK_LOG_ID" as "chainTaskLogId",
                    r."JSON" as "dagJson",
                    r."PLAN" as "planJson",
                    r."FUTURE_STATUS" as "status"
                FROM "ORCHESTRATION"."3VR_DWC_TASK_CHAIN_RUNS_01" r
                WHERE r."SPACE_ID" = ? AND r."TECHNICAL_NAME" = ?
                ORDER BY r."CHAIN_TASK_LOG_ID" DESC
                LIMIT 1
            '''
            rows = db_query_executor.query(sql, (space_id, taskchain))
        
        if not rows:
            # Task chain has never run — build the DAG from deployment metadata
            meta_rows = db_query_executor.query(
                'SELECT "JSON" FROM "ORCHESTRATION"."3VR_DEPL_METADATA_01" '
                'WHERE "NAME" = ? ORDER BY "DEPLOYED_AT" DESC LIMIT 1',
                (taskchain,)
            )
            if not meta_rows:
                return jsonify({"success": False, "error": "Task chain not found"}), 404

            raw = (meta_rows[0].get("JSON") or meta_rows[0].get("json") or "")
            try:
                tc_meta = json.loads(raw) if raw else {}
            except Exception:
                tc_meta = {}

            raw_nodes, raw_links = [], []
            tc_section = (tc_meta.get("taskchains") or {}).get(taskchain)
            if isinstance(tc_section, dict):
                raw_nodes = tc_section.get("nodes") or []
                raw_links = tc_section.get("links") or []

            object_ids = sorted({
                (n.get("taskIdentifier") or {}).get("objectId")
                for n in raw_nodes
                if (n.get("taskIdentifier") or {}).get("objectId")
            })
            business_name_map = {}
            ibp_template_map = {}
            sac_multiaction_map = {}
            object_type_map = {}
            if object_ids:
                try:
                    ph = ",".join(["?"] * len(object_ids))
                    bname_rows = db_query_executor.query(
                        f'SELECT "NAME", "REPOSITORY_OBJECT_TYPE", "JSON" FROM "ORCHESTRATION"."3VR_DEPL_METADATA_01" WHERE "NAME" IN ({ph})',
                        tuple(object_ids)
                    )
                    for mr in bname_rows or []:
                        nm = mr.get("NAME") or mr.get("name")
                        rj = mr.get("JSON") or mr.get("json")
                        if not nm:
                            continue
                        otype = mr.get("REPOSITORY_OBJECT_TYPE") or mr.get("repository_object_type")
                        if otype:
                            object_type_map[nm] = otype
                        if not rj:
                            continue
                        try:
                            md = json.loads(rj)
                        except Exception:
                            continue
                        lbl = md.get("@EndUserText.label") or md.get("label") or md.get("business_name")
                        if not lbl:
                            csn = md.get("csn") if isinstance(md.get("csn"), dict) else None
                            if csn:
                                for cat_val in csn.values():
                                    if isinstance(cat_val, dict):
                                        obj = cat_val.get(nm)
                                        if isinstance(obj, dict):
                                            lbl = obj.get("@EndUserText.label") or obj.get("label")
                                            if lbl:
                                                break
                        if lbl:
                            business_name_map[nm] = lbl
                        tpl = _extract_ibp_template_from_metadata(md)
                        if tpl:
                            ibp_template_map[nm] = tpl
                        sac_ma = _extract_sac_multiaction_from_metadata(md)
                        if sac_ma:
                            sac_multiaction_map[nm] = sac_ma
                except Exception:
                    pass

            nodes, links = [], []
            for node in raw_nodes:
                task_id = node.get("taskIdentifier") or {}
                obj_id = task_id.get("objectId") or node.get("objectId")
                node_label = (
                    node.get("businessName") or node.get("label") or node.get("displayName")
                    or task_id.get("businessName") or task_id.get("label") or task_id.get("displayName")
                )
                # Discard node_label if it is just the technical name repeated
                if node_label and node_label == obj_id:
                    node_label = None
                business_name = (business_name_map.get(obj_id) if obj_id else None) or node_label or None
                ibp_tpl = (
                    (ibp_template_map.get(obj_id) if obj_id else None)
                    or _extract_ibp_template_from_metadata(task_id)
                    or _extract_ibp_template_from_metadata(node)
                )
                sac_ma_id = (
                    (sac_multiaction_map.get(obj_id) if obj_id else None)
                    or _extract_sac_multiaction_from_metadata(task_id)
                    or _extract_sac_multiaction_from_metadata(node)
                )
                nodes.append({
                    "id": node.get("id"),
                    "type": node.get("type", "TASK"),
                    "objectId": obj_id,
                    "applicationId": task_id.get("applicationId"),
                    "spaceId": task_id.get("spaceId"),
                    "label": business_name or node.get("name") or task_id.get("name"),
                    "businessName": business_name,
                    "description": node.get("description") or node.get("comment") or task_id.get("description"),
                    "status": "pending",
                    "ignoreError": node.get("ignoreError", False),
                    "taskLogId": None,
                    "ibpTemplateName": ibp_tpl,
                    "sacMultiActionId": sac_ma_id,
                    "objectType": object_type_map.get(obj_id) if obj_id else None,
                })
            for link in raw_links:
                links.append({
                    "id": link.get("id"),
                    "from": link.get("startNode", {}).get("nodeId"),
                    "to": link.get("endNode", {}).get("nodeId"),
                    "statusRequired": link.get("startNode", {}).get("statusRequired", "ANY")
                })
            return jsonify({
                "success": True,
                "chainTaskLogId": None,
                "taskChainName": taskchain,
                "spaceId": space_id,
                "overallStatus": "never_run",
                "nodes": nodes,
                "links": links
            }), 200

        row = rows[0]
        chain_task_log_id = row.get("chainTaskLogId")
        
        # Parse DAG JSON
        dag_data = None
        if row.get("dagJson"):
            try:
                dag_data = json.loads(row["dagJson"])
            except:
                pass
        
        # Parse plan JSON
        plan_data = None
        if row.get("planJson"):
            try:
                plan_data = json.loads(row["planJson"])
            except:
                pass
        
        # Get node execution statuses
        nodes_sql = '''
            SELECT 
                n."NODE_ID" as "nodeId",
                n."TASK_LOG_ID" as "taskLogId",
                l."STATUS" as "status",
                l."OBJECT_ID" as "objectId",
                l."START_TIME" as "startTime",
                l."END_TIME" as "endTime"
            FROM "ORCHESTRATION"."3VR_DWC_TASK_CHAIN_RUN_NODES_01" n
            LEFT JOIN "ORCHESTRATION"."3VR_DWC_TASK_LOGS_01" l ON n."TASK_LOG_ID" = l."TASK_LOG_ID"
            WHERE n."CHAIN_TASK_LOG_ID" = ?
        '''
        node_rows = db_query_executor.query(nodes_sql, (chain_task_log_id,))
        
        node_statuses = {}
        for nr in node_rows:
            status_raw = (nr.get("status") or "").upper()
            status = "success" if status_raw == "COMPLETED" else "error" if status_raw in ("FAILED", "ERROR") else "running" if status_raw == "RUNNING" else "pending"
            node_statuses[nr.get("nodeId")] = {
                "status": status,
                "taskLogId": nr.get("taskLogId"),
                "objectId": nr.get("objectId"),
                "startTime": _utc_str(nr.get("startTime")),
                "endTime": _utc_str(nr.get("endTime"))
            }

        # For API-type steps, extract the IBP template name from the task log
        # messages (MESSAGE_KEY='viewResponse', details.payload.details.template_name).
        ibp_template_from_logs = {}
        all_task_log_ids = [
            info["taskLogId"] for info in node_statuses.values() if info.get("taskLogId")
        ]
        if all_task_log_ids:
            try:
                ph = ",".join(["?"] * len(all_task_log_ids))
                log_msg_rows = db_query_executor.query(
                    f'SELECT "TASK_LOG_ID", "DETAILS" '
                    f'FROM "ORCHESTRATION"."3VR_DWC_TASK_LOG_MESSAGES_01" '
                    f'WHERE "TASK_LOG_ID" IN ({ph}) AND "MESSAGE_BUNDLE_KEY" = \'viewResponse\'',
                    tuple(all_task_log_ids)
                )
                for lr in log_msg_rows or []:
                    tid = lr.get("TASK_LOG_ID") or lr.get("task_log_id")
                    details_raw = lr.get("DETAILS") or lr.get("details")
                    if not tid or not details_raw:
                        continue
                    try:
                        details = json.loads(details_raw) if isinstance(details_raw, str) else details_raw
                        payload_raw = details.get("payload")
                        if payload_raw:
                            payload = json.loads(payload_raw) if isinstance(payload_raw, str) else payload_raw
                            inner = payload.get("details") or {}
                            tpl = inner.get("template_name") or inner.get("job_text")
                            if tpl and isinstance(tpl, str) and tpl.strip():
                                ibp_template_from_logs[tid] = tpl.strip()
                    except Exception:
                        pass
            except Exception:
                pass

        # Extract nodes and links from DAG
        nodes = []
        links = []
        
        if dag_data and "taskchains" in dag_data:
            tc_data = dag_data["taskchains"].get(taskchain, {})
            raw_nodes = tc_data.get("nodes", [])
            raw_links = tc_data.get("links", [])

            # ----------------------------------------------------------
            # Look up business names for the objects referenced by the
            # nodes from the DSP deployment-metadata view. The label is
            # stored either at the top level (`@EndUserText.label`, used
            # by replication flows) or nested in `csn.<category>.<name>.
            # @EndUserText.label` (used by transformation flows etc.).
            # ----------------------------------------------------------
            object_ids = sorted({
                (n.get("taskIdentifier") or {}).get("objectId")
                for n in raw_nodes
                if (n.get("taskIdentifier") or {}).get("objectId")
            })
            business_name_map = {}
            ibp_template_map = {}
            sac_multiaction_map = {}
            object_type_map = {}
            if object_ids:
                try:
                    placeholders = ",".join(["?"] * len(object_ids))
                    meta_sql = (
                        'SELECT "NAME", "REPOSITORY_OBJECT_TYPE", "JSON" FROM "ORCHESTRATION"."3VR_DEPL_METADATA_01" '
                        f'WHERE "NAME" IN ({placeholders})'
                    )
                    meta_rows = db_query_executor.query(meta_sql, tuple(object_ids))
                    for mr in meta_rows or []:
                        nm = mr.get("NAME") or mr.get("name")
                        raw_json = mr.get("JSON") or mr.get("json")
                        if not nm:
                            continue
                        otype = mr.get("REPOSITORY_OBJECT_TYPE") or mr.get("repository_object_type")
                        if otype:
                            object_type_map[nm] = otype
                        if not raw_json:
                            continue
                        try:
                            md = json.loads(raw_json)
                        except Exception:
                            continue
                        # 1) Top-level @EndUserText.label
                        lbl = md.get("@EndUserText.label") or md.get("label") or md.get("business_name")
                        # 2) csn.<category>.<NAME>.@EndUserText.label
                        if not lbl:
                            csn = md.get("csn") if isinstance(md.get("csn"), dict) else None
                            if csn:
                                for cat_val in csn.values():
                                    if isinstance(cat_val, dict):
                                        obj = cat_val.get(nm)
                                        if isinstance(obj, dict):
                                            lbl = obj.get("@EndUserText.label") or obj.get("label")
                                            if lbl:
                                                break
                        if lbl:
                            business_name_map[nm] = lbl
                        tpl = _extract_ibp_template_from_metadata(md)
                        if tpl:
                            ibp_template_map[nm] = tpl
                        sac_ma = _extract_sac_multiaction_from_metadata(md)
                        if sac_ma:
                            sac_multiaction_map[nm] = sac_ma
                except Exception as _e:  # metadata view may be missing — fall back silently
                    business_name_map = {}

            # Historical fallback: for objectIds still missing from ibp_template_map,
            # search previous COMPLETED runs' viewResponse logs.
            # This handles cases where the latest run failed and the error response
            # didn't carry the template_name (so the current-run log scan missed it).
            missing_obj_ids = [oid for oid in object_ids if oid and not ibp_template_map.get(oid)]
            if missing_obj_ids:
                try:
                    ph_miss = ",".join(["?"] * len(missing_obj_ids))
                    prev_run_rows = db_query_executor.query(
                        f'SELECT "OBJECT_ID", "TASK_LOG_ID" '
                        f'FROM "ORCHESTRATION"."3VR_DWC_TASK_LOGS_01" '
                        f'WHERE "OBJECT_ID" IN ({ph_miss}) AND "STATUS" = \'COMPLETED\' '
                        f'ORDER BY "END_TIME" DESC LIMIT {len(missing_obj_ids) * 5}',
                        tuple(missing_obj_ids)
                    )
                    tid_to_oid: dict = {}
                    for pr in prev_run_rows or []:
                        tid = pr.get("TASK_LOG_ID") or pr.get("task_log_id")
                        oid = pr.get("OBJECT_ID") or pr.get("object_id")
                        if tid and oid and oid not in ibp_template_map:
                            tid_to_oid.setdefault(tid, oid)
                    if tid_to_oid:
                        ph_tid = ",".join(["?"] * len(tid_to_oid))
                        hist_msg_rows = db_query_executor.query(
                            f'SELECT "TASK_LOG_ID", "DETAILS" '
                            f'FROM "ORCHESTRATION"."3VR_DWC_TASK_LOG_MESSAGES_01" '
                            f'WHERE "TASK_LOG_ID" IN ({ph_tid}) '
                            f'AND "MESSAGE_BUNDLE_KEY" = \'viewResponse\'',
                            tuple(tid_to_oid.keys())
                        )
                        for hmr in hist_msg_rows or []:
                            tid = hmr.get("TASK_LOG_ID") or hmr.get("task_log_id")
                            oid = tid_to_oid.get(tid)
                            if not oid or ibp_template_map.get(oid):
                                continue
                            details_raw = hmr.get("DETAILS") or hmr.get("details")
                            if not details_raw:
                                continue
                            try:
                                det = json.loads(details_raw) if isinstance(details_raw, str) else details_raw
                                pld_raw = det.get("payload")
                                if pld_raw:
                                    pld = json.loads(pld_raw) if isinstance(pld_raw, str) else pld_raw
                                    inner = pld.get("details") or {}
                                    tpl2 = inner.get("template_name") or inner.get("job_text")
                                    if tpl2 and isinstance(tpl2, str) and tpl2.strip():
                                        ibp_template_map[oid] = tpl2.strip()
                            except Exception:
                                pass
                except Exception:
                    pass

            for node in raw_nodes:
                node_id = node.get("id")
                node_type = node.get("type", "TASK")
                task_id = node.get("taskIdentifier", {})

                # Get execution status for this node
                exec_info = node_statuses.get(node_id, {})

                obj_id = task_id.get("objectId") or exec_info.get("objectId")
                business_name = business_name_map.get(obj_id) if obj_id else None
                ibp_tpl = (
                    (ibp_template_map.get(obj_id) if obj_id else None)
                    or _extract_ibp_template_from_metadata(task_id)
                    or _extract_ibp_template_from_metadata(node)
                    or ibp_template_from_logs.get(exec_info.get("taskLogId"))
                )
                sac_ma_id = (
                    (sac_multiaction_map.get(obj_id) if obj_id else None)
                    or _extract_sac_multiaction_from_metadata(task_id)
                    or _extract_sac_multiaction_from_metadata(node)
                )

                # Best-effort extraction of a human-readable label/description
                label = (
                    business_name
                    or node.get("label")
                    or node.get("name")
                    or node.get("displayName")
                    or task_id.get("label")
                    or task_id.get("name")
                    or task_id.get("displayName")
                )
                description = (
                    node.get("description")
                    or node.get("comment")
                    or task_id.get("description")
                )

                nodes.append({
                    "id": node_id,
                    "type": node_type,
                    "objectId": obj_id,
                    "applicationId": task_id.get("applicationId"),
                    "spaceId": task_id.get("spaceId"),
                    "label": label,
                    "businessName": business_name,
                    "description": description,
                    "status": exec_info.get("status", "pending"),
                    "ignoreError": node.get("ignoreError", False),
                    "taskLogId": exec_info.get("taskLogId"),
                    "ibpTemplateName": ibp_tpl,
                    "sacMultiActionId": sac_ma_id,
                    "objectType": object_type_map.get(obj_id) if obj_id else None,
                })
            
            for link in raw_links:
                links.append({
                    "id": link.get("id"),
                    "from": link.get("startNode", {}).get("nodeId"),
                    "to": link.get("endNode", {}).get("nodeId"),
                    "statusRequired": link.get("startNode", {}).get("statusRequired", "ANY")
                })
        
        return jsonify({
            "success": True,
            "chainTaskLogId": chain_task_log_id,
            "taskChainName": taskchain,
            "spaceId": space_id,
            "overallStatus": row.get("status"),
            "nodes": nodes,
            "links": links
        }), 200
        
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@bp.route("/taskchain-schedules", methods=["GET"])
@flask_access_validation(required_scope="read")
def get_taskchain_schedules():
    """Return native DSP task chain schedules.

    Reads from a HANA consumption view that exposes DWC_TENANT_OWNER.TASK_SCHEDULE
    (or equivalent). The fully-qualified view name is configurable via env
    DSP_SCHEDULES_VIEW (default: ORCHESTRATION.3VR_DWC_TASK_SCHEDULES_01).

    Expected view columns (case-insensitive, aliased on read):
      - taskchain | OBJECT_NAME | TASK_NAME           -> technical name
      - spaceId   | SPACE_ID                          -> DSP space
      - cronExpression | CRON_EXPRESSION              -> cron string
      - timezone  | TIMEZONE | TIME_ZONE              -> tz name
      - nextRunAt | NEXT_RUN_AT | NEXT_EXECUTION      -> timestamp
      - isActive  | IS_ACTIVE | ACTIVE | STATUS       -> boolean / status
      - scheduleId | SCHEDULE_ID                      -> identifier

    If the view does not exist (yet), returns success=true with an empty list
    so that the UI can render gracefully.
    """
    from flask import current_app
    from datetime import date, datetime as _dt

    view_name = os.environ.get("DSP_SCHEDULES_VIEW", "ORCHESTRATION.3VR_DWC_TASK_SCHEDULES_01")

    space_filter = (request.args.get("spaceId") or "").strip() or None
    taskchain_filter = (request.args.get("taskchain") or "").strip() or None

    # SELECT * with a defensive limit; map columns case-insensitively after fetch.
    where_parts = []
    params: list = []
    if space_filter:
        where_parts.append('UPPER("SPACE_ID") = UPPER(?)')
        params.append(space_filter)
    if taskchain_filter:
        # The DWC view uses OBJECT_ID for the technical chain name
        where_parts.append('UPPER("OBJECT_ID") = UPPER(?)')
        params.append(taskchain_filter)
    where_sql = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""

    sql = f'SELECT * FROM "{view_name.split(".")[0]}"."{view_name.split(".")[1]}" {where_sql} LIMIT 2000'

    try:
        db_query_executor = current_app.extensions["taskchain"]["db_query_executor"]
        rows = db_query_executor.query(sql, tuple(params))
    except Exception as e:
        msg = str(e)
        # View not deployed yet → return empty list gracefully (UI keeps working)
        not_found_markers = (
            "invalid table name",
            "could not find",
            "not found",
            "feature not supported",
            "sql syntax error",
            "no such table",
        )
        if any(m in msg.lower() for m in not_found_markers):
            return jsonify({
                "success": True,
                "view": view_name,
                "available": False,
                "message": f"View {view_name} not available yet",
                "data": [],
                "rowCount": 0,
            }), 200
        return jsonify({"success": False, "view": view_name, "error": msg, "data": []}), 500

    def _ci_get(d: dict, *aliases):
        if not isinstance(d, dict):
            return None
        # Build lowercase map once per row would be cheaper, but rows are small
        for a in aliases:
            for k in d.keys():
                if str(k).lower() == a.lower():
                    return d[k]
        return None

    def _to_bool_active(v):
        if v is None:
            return None
        if isinstance(v, bool):
            return v
        if isinstance(v, (int, float)):
            return bool(v)
        s = str(v).strip().upper()
        if s in ("TRUE", "Y", "YES", "1", "ACTIVE", "ENABLED", "RUNNING"):
            return True
        if s in ("FALSE", "N", "NO", "0", "INACTIVE", "DISABLED", "PAUSED", "STOPPED"):
            return False
        return None

    def _isoformat(v):
        if v is None:
            return None
        if isinstance(v, (date, _dt)):
            s = v.isoformat()
            return s if (s.endswith("Z") or "+" in s[10:]) else s + "Z"
        s = str(v)
        return s if (s.endswith("Z") or "+" in s[10:]) else s + "Z"

    def _compute_next_run(cron_expr, tz_name, is_active):
        """Compute the next run datetime from a cron expression in the given timezone."""
        if not cron_expr or is_active is False:
            return None
        try:
            from croniter import croniter
            try:
                from zoneinfo import ZoneInfo
                tz = ZoneInfo(tz_name) if tz_name else ZoneInfo("UTC")
            except Exception:
                tz = None
            now = _dt.now(tz) if tz else _dt.utcnow()
            expr = str(cron_expr).strip()
            # DSP sometimes uses 6-field cron (seconds first: "0 0 6 * * *").
            # croniter expects 5 fields — strip the leading seconds field.
            parts = expr.split()
            if len(parts) == 6:
                expr = " ".join(parts[1:])
            itr = croniter(expr, now)
            nxt = itr.get_next(_dt)
            return nxt.isoformat()
        except Exception:
            return None

    def _compute_next_run_from_frequency_json(frequency_str, is_active):
        """Compute next run from DSP Simple Schedule stored as a JSON string in FREQUENCY.

        DSP format: {"interval": 1, "type": "DAILY", "startDate": "2026-02-22T12:30:00.000Z"}
        startDate holds the exact UTC datetime of each recurring run.
        """
        if is_active is False:
            return None
        if not frequency_str or not isinstance(frequency_str, str):
            return None
        if not frequency_str.strip().startswith("{"):
            return None
        try:
            import json as _js
            freq = _js.loads(frequency_str)
        except Exception:
            return None
        freq_type = str(freq.get("type") or "").strip().upper()
        interval_val = int(freq.get("interval") or 1)
        start_str = freq.get("startDate") or ""
        if not start_str:
            return None
        try:
            from datetime import timedelta as _td, timezone as _utc
            # Normalise the ISO string (remove trailing .000 before Z)
            start_str_clean = start_str.replace(".000Z", "+00:00").replace("Z", "+00:00")
            start_dt = _dt.fromisoformat(start_str_clean)
            now = _dt.now(_utc.utc)
            if freq_type in ("DAILY", "DAY", "DAYS"):
                delta = _td(days=interval_val)
            elif freq_type in ("WEEKLY", "WEEK", "WEEKS"):
                delta = _td(weeks=interval_val)
            elif freq_type in ("MONTHLY", "MONTH", "MONTHS"):
                delta = _td(days=30 * interval_val)
            else:
                return None
            nxt = start_dt
            while nxt <= now:
                nxt += delta
            return nxt.isoformat()
        except Exception:
            return None

    def _compute_next_run_simple(frequency, at_time, interval, tz_name, is_active):
        """Compute next run for DSP 'Simple Schedule' (no cron expression).

        frequency: e.g. 'DAILY', 'WEEKLY', 'MONTHLY'
        at_time:   e.g. '13:30' or '13:30:00'
        interval:  recurrence interval (1 = every day/week/month)
        """
        if is_active is False:
            return None
        if not frequency or not at_time:
            return None
        try:
            from zoneinfo import ZoneInfo
            tz = ZoneInfo(tz_name) if tz_name else ZoneInfo("UTC")
        except Exception:
            tz = None
        try:
            freq_upper = str(frequency).strip().upper()
            time_parts = str(at_time).strip().split(":")
            run_hour = int(time_parts[0])
            run_min = int(time_parts[1]) if len(time_parts) > 1 else 0
            now = _dt.now(tz) if tz else _dt.utcnow()
            # Start candidate at today at the run time
            candidate = now.replace(hour=run_hour, minute=run_min, second=0, microsecond=0)
            delta_days = int(interval or 1)
            if freq_upper in ("DAILY", "DAY", "DAYS", "D"):
                if candidate <= now:
                    candidate = candidate + __import__("datetime").timedelta(days=delta_days)
            elif freq_upper in ("WEEKLY", "WEEK", "WEEKS", "W"):
                if candidate <= now:
                    candidate = candidate + __import__("datetime").timedelta(weeks=delta_days)
            elif freq_upper in ("MONTHLY", "MONTH", "MONTHS", "M"):
                # Approximate: add 30 days per interval
                if candidate <= now:
                    candidate = candidate + __import__("datetime").timedelta(days=30 * delta_days)
            else:
                return None
            return candidate.isoformat()
        except Exception:
            return None

    schedules = []
    for r in rows or []:
        cron_expr = _ci_get(r, "cronExpression", "CRON", "CRON_EXPRESSION", "SCHEDULE_PATTERN", "PATTERN", "SCHEDULE")
        tz_name = _ci_get(r, "timezone", "TZ_NAME", "TIMEZONE", "TIME_ZONE", "CRON_TIMEZONE")
        is_active = _to_bool_active(_ci_get(r, "isActive", "ACTIVATION_STATUS", "IS_ACTIVE", "ACTIVE", "STATUS"))
        frequency = _ci_get(r, "frequency", "FREQUENCY")
        at_time = _ci_get(r, "atTime", "AT_TIME", "TIME_OF_DAY", "RUN_TIME", "SCHEDULE_TIME", "AT", "TIME")
        interval = _ci_get(r, "interval", "INTERVAL", "EVERY", "RECURRENCE_INTERVAL", "SCHEDULE_INTERVAL")
        view_next = _isoformat(_ci_get(r, "nextRunAt", "NEXT_RUN_AT", "NEXT_EXECUTION", "NEXT_EXECUTION_AT", "NEXT_RUN_TIME", "NEXT_TRIGGER_AT", "NEXT_OCCURRENCE"))
        next_run = (view_next
                    or _compute_next_run(cron_expr, tz_name, is_active)
                    or _compute_next_run_from_frequency_json(frequency, is_active)
                    or _compute_next_run_simple(frequency, at_time, interval, tz_name, is_active))
        schedules.append({
            "taskchain": _ci_get(r, "taskchain", "OBJECT_ID", "OBJECT_NAME", "TASK_NAME"),
            "spaceId": _ci_get(r, "spaceId", "SPACE_ID"),
            "applicationId": _ci_get(r, "applicationId", "APPLICATION_ID"),
            "activity": _ci_get(r, "activity", "ACTIVITY"),
            "description": _ci_get(r, "description", "DESCRIPTION"),
            "cronExpression": cron_expr,
            "timezone": tz_name,
            "validFrom": _isoformat(_ci_get(r, "validFrom", "VALID_FROM")),
            "validTo": _isoformat(_ci_get(r, "validTo", "VALID_TO")),
            "nextRunAt": next_run,
            "isActive": is_active,
            "isPaused": is_active is False,
            "activationStatus": _ci_get(r, "activationStatus", "ACTIVATION_STATUS"),
            "scheduleId": _ci_get(r, "scheduleId", "SCHEDULE_ID"),
            "externalScheduleId": _ci_get(r, "externalScheduleId", "EXTERNAL_SCHEDULE_ID"),
            "frequency": frequency,
        })

    # Debug: expose raw column names from the first row so we can identify
    # the correct aliases for activation_status / at_time / next_run_at.
    raw_cols = sorted(rows[0].keys()) if rows else []
    raw_sample = [
        {k: v for k, v in r.items() if str(v).strip() not in ("", "None", "null")}
        for r in (rows or [])[:5]
    ]

    return jsonify({
        "success": True,
        "view": view_name,
        "available": True,
        "data": schedules,
        "rowCount": len(schedules),
        "_debug_columns": raw_cols,
        "_debug_sample": raw_sample,
    }), 200


@bp.route("/taskchain-steps", methods=["GET"])
@flask_access_validation(required_scope="read")
def get_taskchain_steps():
    """Return the distinct steps (objectId + businessName) for a task chain.

    Reads the task chain deployment-manifest JSON from DEPL_METADATA.
    The manifest embeds the node/task list and is available even before the
    first execution.  Business names are enriched from DEPL_METADATA.

    Query params:
    - spaceId  (required)
    - taskchain (required)
    """
    from flask import current_app
    import json as _json

    space_id  = request.args.get("spaceId")
    taskchain = request.args.get("taskchain")

    if not space_id or not taskchain:
        return jsonify({"success": False, "error": "spaceId and taskchain are required"}), 400

    try:
        db_query_executor = current_app.extensions["taskchain"]["db_query_executor"]

        # ------------------------------------------------------------------
        # Helper: look up business names and IBP template names for objectIds
        # ------------------------------------------------------------------
        def _build_metadata_maps(object_ids):
            bmap = {}
            ibp_tpl_map = {}
            sac_ma_map = {}
            otype_map = {}
            if not object_ids:
                return bmap, ibp_tpl_map, sac_ma_map, otype_map
            try:
                ph = ",".join(["?"] * len(object_ids))
                rows = db_query_executor.query(
                    f'SELECT "NAME", "REPOSITORY_OBJECT_TYPE", "JSON" FROM "ORCHESTRATION"."3VR_DEPL_METADATA_01" WHERE "NAME" IN ({ph})',
                    tuple(object_ids)
                )
                for mr in (rows or []):
                    nm  = mr.get("NAME") or mr.get("name")
                    raw = mr.get("JSON") or mr.get("json")
                    if not nm:
                        continue
                    otype = mr.get("REPOSITORY_OBJECT_TYPE") or mr.get("repository_object_type")
                    if otype:
                        otype_map[nm] = otype
                    if not raw:
                        continue
                    try:
                        md = _json.loads(raw)
                    except Exception:
                        continue
                    lbl = (md.get("@EndUserText.label") or md.get("label")
                           or md.get("business_name") or md.get("businessName"))
                    if not lbl:
                        csn = md.get("csn") if isinstance(md.get("csn"), dict) else None
                        if csn:
                            for cat_val in csn.values():
                                if isinstance(cat_val, dict):
                                    obj = cat_val.get(nm)
                                    if isinstance(obj, dict):
                                        lbl = obj.get("@EndUserText.label") or obj.get("label")
                                        if lbl:
                                            break
                    if not lbl:
                        logger.warning("[DIAG] businessName not found for '%s'. Top-level keys: %s", nm, list(md.keys())[:15])
                    if lbl:
                        bmap[nm] = lbl
                    tpl = _extract_ibp_template_from_metadata(md)
                    if tpl:
                        ibp_tpl_map[nm] = tpl
                    sac_ma = _extract_sac_multiaction_from_metadata(md)
                    if sac_ma:
                        sac_ma_map[nm] = sac_ma
            except Exception:
                pass
            return bmap, ibp_tpl_map, sac_ma_map, otype_map

        # ------------------------------------------------------------------
        # Read step IDs and descriptions from the deployment manifest JSON.
        # Query WITHOUT REPOSITORY_OBJECT_TYPE filter first so we find the
        # entry regardless of how the type is stored in this environment.
        # ------------------------------------------------------------------
        tc_meta = db_query_executor.query(
            'SELECT "JSON", "REPOSITORY_OBJECT_TYPE" '
            'FROM "ORCHESTRATION"."3VR_DEPL_METADATA_01" '
            'WHERE "NAME" = ? '
            'ORDER BY "DEPLOYED_AT" DESC LIMIT 1',
            (taskchain,)
        )

        debug_info = {
            "metadataFound": bool(tc_meta),
            "repoType": tc_meta[0].get("REPOSITORY_OBJECT_TYPE") if tc_meta else None,
            "topLevelKeys": [],
            "patternMatched": None,
        }

        if not tc_meta:
            return jsonify({"success": True, "steps": [], "debug": debug_info}), 200

        raw = tc_meta[0].get("JSON") or tc_meta[0].get("json") or ""
        try:
            tc_data = _json.loads(raw) if raw else {}
        except Exception:
            tc_data = {}

        debug_info["topLevelKeys"] = list(tc_data.keys()) if isinstance(tc_data, dict) else []

        # Walk every value recursively looking for a list of dicts that each
        # contain an objectId-like key.  This handles any unknown nesting depth.
        def _find_node_lists(obj, depth=0):
            """Return all lists-of-dicts found in obj that look like step nodes."""
            if depth > 6:
                return []
            results = []
            if isinstance(obj, list):
                if obj and all(isinstance(x, dict) for x in obj):
                    # Check if any dict has an objectId-like key
                    def _has_obj_id(d):
                        return (d.get("objectId") or d.get("taskId")
                                or (d.get("taskIdentifier") or {}).get("objectId"))
                    if any(_has_obj_id(x) for x in obj):
                        results.append(obj)
                for item in obj:
                    results.extend(_find_node_lists(item, depth + 1))
            elif isinstance(obj, dict):
                for v in obj.values():
                    results.extend(_find_node_lists(v, depth + 1))
            return results

        # Priority: well-known paths first, then exhaustive scan
        raw_nodes = []

        # Pattern A: taskchains.<name>.nodes  (mirrors the runtime DAG format)
        tc_section = (tc_data.get("taskchains") or {}).get(taskchain)
        if isinstance(tc_section, dict):
            raw_nodes = tc_section.get("nodes") or []
            if raw_nodes: debug_info["patternMatched"] = "taskchains.<name>.nodes"

        if not raw_nodes:
            for key in ("nodes", "tasks", "steps"):
                if tc_data.get(key):
                    raw_nodes = tc_data[key]
                    debug_info["patternMatched"] = f"top-level '{key}'"
                    break

        if not raw_nodes:
            for key in ("definition", "taskchainDefinition", "taskchain", "chain"):
                sub = tc_data.get(key)
                if isinstance(sub, dict):
                    for nkey in ("nodes", "tasks", "steps"):
                        if sub.get(nkey):
                            raw_nodes = sub[nkey]
                            debug_info["patternMatched"] = f"{key}.{nkey}"
                            break
                if raw_nodes:
                    break

        # Exhaustive recursive scan as last resort
        if not raw_nodes:
            candidates = _find_node_lists(tc_data)
            if candidates:
                raw_nodes = candidates[0]
                debug_info["patternMatched"] = "recursive-scan"

        if not raw_nodes:
            return jsonify({"success": True, "steps": [], "debug": debug_info}), 200

        # Extract objectIds
        object_ids_ordered = []
        seen = set()
        for node in raw_nodes:
            if not isinstance(node, dict):
                continue
            task_id = node.get("taskIdentifier") or {}
            obj_id = (
                task_id.get("objectId")
                or node.get("objectId")
                or node.get("taskId")
                or node.get("id")
                or ""
            )
            if obj_id and obj_id not in seen:
                seen.add(obj_id)
                object_ids_ordered.append((obj_id, node))

        if not object_ids_ordered:
            return jsonify({"success": True, "steps": [], "debug": debug_info}), 200

        bmap, ibp_tpl_map, sac_ma_map, otype_map = _build_metadata_maps([o for o, _ in object_ids_ordered])
        import logging as _logging
        _logging.getLogger(__name__).warning("[DIAG] raw nodes: %s", _json.dumps(object_ids_ordered, default=str))
        steps = []
        for i, (obj_id, node) in enumerate(object_ids_ordered):
            task_id = node.get("taskIdentifier") or {}
            node_label = (
                node.get("businessName") or node.get("label") or node.get("displayName")
                or task_id.get("businessName") or task_id.get("label") or task_id.get("displayName")
            )
            # Discard node_label if it is just the technical name repeated
            if node_label and node_label == obj_id:
                node_label = None
            ibp_tpl = (
                ibp_tpl_map.get(obj_id)
                or _extract_ibp_template_from_metadata(task_id)
                or _extract_ibp_template_from_metadata(node)
            )
            sac_ma_id = (
                sac_ma_map.get(obj_id)
                or _extract_sac_multiaction_from_metadata(task_id)
                or _extract_sac_multiaction_from_metadata(node)
            )
            steps.append({
                "id":              node.get("id") or obj_id,
                "order":           i + 1,
                "objectId":        obj_id,
                "applicationId":   task_id.get("applicationId") or node.get("applicationId") or "",
                "businessName":    bmap.get(obj_id) or node_label or "",
                "ibpTemplateName": ibp_tpl or "",
                "sacMultiActionId": sac_ma_id or "",
                "objectType":      otype_map.get(obj_id) or "",
            })

        return jsonify({"success": True, "steps": steps, "debug": debug_info}), 200

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@bp.route("/taskchain-runs", methods=["GET", "POST"])
@flask_access_validation(required_scope="read")
def get_taskchain_runs():
    """Get recent task chain execution runs from DSP.
    
    Query params or POST body:
    - spaceId: filter by space (optional)
    - taskchain: filter by taskchain name (optional)  
    - limit: max results (default 50)
    """
    from flask import current_app
    
    if request.method == "POST":
        payload = request.get_json(silent=True) or {}
    else:
        payload = {}
    
    space_id = payload.get("spaceId") or request.args.get("spaceId")
    taskchain = payload.get("taskchain") or request.args.get("taskchain")
    limit = int(payload.get("limit") or request.args.get("limit") or 50)
    
    try:
        db_query_executor = current_app.extensions["taskchain"]["db_query_executor"]
        
        # Build query with optional filters
        conditions = ["\"APPLICATION_ID\" = 'TASK_CHAINS'"]
        params = []
        
        if space_id:
            conditions.append("\"SPACE_ID\" = ?")
            params.append(space_id)
        
        if taskchain:
            # Match get_taskchain_schedules: OBJECT_ID casing in the DWC view
            # may differ from the taskchain name as stored/displayed in our app.
            conditions.append('UPPER("OBJECT_ID") = UPPER(?)')
            params.append(taskchain)
        
        where_clause = " AND ".join(conditions)
        
        sql = f'''
            SELECT 
                "TASK_LOG_ID" as "runId",
                "OBJECT_ID" as "taskChain",
                "SPACE_ID" as "spaceId",
                "STATUS" as "status",
                "START_TIME" as "startTime",
                "END_TIME" as "endTime"
            FROM "ORCHESTRATION"."3VR_DWC_TASK_LOGS_01"
            WHERE {where_clause}
            ORDER BY "START_TIME" DESC
            LIMIT {limit}
        '''
        
        rows = db_query_executor.query(sql, tuple(params))
        
        # Transform results
        runs = []
        for row in rows:
            start_time = row.get("startTime")
            end_time = row.get("endTime")
            duration = None
            
            if start_time and end_time:
                try:
                    from datetime import datetime
                    if isinstance(start_time, str):
                        start_dt = datetime.fromisoformat(start_time.replace("Z", "+00:00"))
                    else:
                        start_dt = start_time
                    if isinstance(end_time, str):
                        end_dt = datetime.fromisoformat(end_time.replace("Z", "+00:00"))
                    else:
                        end_dt = end_time
                    duration = round((end_dt - start_dt).total_seconds() / 60, 1)
                except:
                    pass
            
            status_raw = row.get("status", "").upper()
            status = "success" if status_raw == "COMPLETED" else "error" if status_raw in ("FAILED", "ERROR") else "running" if status_raw == "RUNNING" else "pending"
            
            runs.append({
                "runId": row.get("runId"),
                "taskChain": row.get("taskChain"),
                "spaceId": row.get("spaceId"),
                "status": status,
                "startTime": _utc_str(start_time),
                "endTime": _utc_str(end_time),
                "duration": duration,  # numeric value in minutes, or None
                "durationDisplay": f"{duration} min" if duration else "Running..."
            })
        
        return jsonify({"success": True, "runs": runs}), 200
        
    except Exception as e:
        import logging
        logging.getLogger(__name__).exception("taskchain-runs failed")
        return jsonify({"success": False, "error": str(e)}), 500


@bp.route("/tf/delete-data-physical", methods=["POST"])
@flask_access_validation(required_scope="admin")
def delete_data_physical():
    payload = request.get_json(silent=True) if request.is_json else {}
    if not isinstance(payload, dict):
        return jsonify({"error": "Payload must be a JSON object"}), 400

    space_id = payload.get("spaceId") or payload.get("spaceid")
    object_id = payload.get("objectId") or payload.get("objectid")
    application_id = payload.get("applicationId") or "LOCAL_TABLE"

    if not space_id or not object_id:
        return jsonify({"error": "Missing spaceId or objectId"}), 400

    dsp_payload = {
        "applicationId": application_id,
        "spaceId": space_id,
        "objectId": object_id,
        "activity": "DELETE_DATA",
        "parameters": {"isPhysicalDeletion": True},
    }

    try:
        result = _post_dsp_directexecute(dsp_payload)
        return jsonify(result), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/task-global-vars", methods=["GET"])
@flask_access_validation(required_scope="read")
def get_task_global_vars():
    """Return global variable definitions ($G_*) for a DSP task.

    Reads the deployment metadata JSON from HANA and scans for global variable
    definitions so the scheduler UI can show them in the match code.

    Query params:
    - taskName (required)
    """
    from flask import current_app
    import json as _json

    task_name = (request.args.get("taskName") or "").strip()
    if not task_name:
        return jsonify({"error": "taskName is required"}), 400

    def _scan_for_global_vars(obj, found=None, depth=0):
        if found is None:
            found = {}
        if depth > 14:
            return found
        if isinstance(obj, list):
            for item in obj:
                _scan_for_global_vars(item, found, depth + 1)
        elif isinstance(obj, dict):
            raw_name = str(obj.get("name") or obj.get("NAME") or
                          obj.get("technicalName") or obj.get("TECHNICAL_NAME") or "").strip()
            name_upper = raw_name.upper()
            # Match both "$G_SORG" and "G_SORG" (DSP stores without $)
            if name_upper.startswith("$G_") or name_upper.startswith("G_"):
                canonical = raw_name if name_upper.startswith("$G_") else ("$" + raw_name)
                if canonical not in found:
                    raw_val = (obj.get("value") or obj.get("VALUE") or
                               obj.get("defaultValue") or obj.get("default") or "")
                    if isinstance(raw_val, (int, float)):
                        raw_val = str(raw_val)
                    elif not isinstance(raw_val, str):
                        raw_val = ""
                    desc = str(
                        obj.get("description") or obj.get("DESCRIPTION") or
                        obj.get("label") or obj.get("LABEL") or
                        obj.get("comment") or obj.get("COMMENT") or ""
                    )
                    dtype = str(
                        obj.get("dataType") or obj.get("data_type") or
                        obj.get("type") or obj.get("TYPE") or ""
                    )
                    found[canonical] = {
                        "name": canonical,
                        "label": desc,
                        "currentValue": raw_val,
                        "dataType": dtype,
                    }
            for v in obj.values():
                if isinstance(v, str) and (v.strip().startswith("{") or v.strip().startswith("[")):
                    try:
                        _scan_for_global_vars(_json.loads(v), found, depth + 1)
                    except Exception:
                        pass
                elif isinstance(v, (dict, list)):
                    _scan_for_global_vars(v, found, depth + 1)
        return found

    try:
        db = current_app.extensions["taskchain"]["db_query_executor"]
        rows = db.query(
            'SELECT "JSON" FROM "ORCHESTRATION"."3VR_DEPL_METADATA_01" '
            'WHERE "NAME" = ? ORDER BY "DEPLOYED_AT" DESC LIMIT 1',
            (task_name,)
        )
        if not rows:
            return jsonify({"taskName": task_name, "globalVars": [], "_debug": "no metadata row found"}), 200

        raw = rows[0].get("JSON") or rows[0].get("json") or ""
        try:
            metadata = _json.loads(raw) if raw else {}
        except Exception:
            metadata = {}

        found = _scan_for_global_vars(metadata)
        global_vars = sorted(found.values(), key=lambda x: x["name"])

        # Debug: show top-level metadata keys and first 500 chars to diagnose structure
        debug_info = {
            "topKeys": list(metadata.keys()) if isinstance(metadata, dict) else [],
            "rawPreview": raw[:500] if raw else "",
        }

        return jsonify({
            "taskName": task_name,
            "globalVars": global_vars,
            "_debug": debug_info,
        }), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500
