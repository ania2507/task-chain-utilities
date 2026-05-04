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
            FROM "DWC_GLOBAL"."TASK_LOG_MESSAGES"
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
                "timestamp": str(row.get("timestamp")) if row.get("timestamp") else None,
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
            FROM "DWC_GLOBAL"."TASK_CHAIN_RUNS"
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
            FROM "DWC_GLOBAL"."TASK_CHAIN_RUN_NODES" n
            LEFT JOIN "DWC_GLOBAL"."TASK_LOGS" l ON n."TASK_LOG_ID" = l."TASK_LOG_ID"
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
                "startTime": str(row.get("startTime")) if row.get("startTime") else None,
                "endTime": str(row.get("endTime")) if row.get("endTime") else None,
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
                FROM "DWC_GLOBAL"."TASK_CHAIN_RUNS" r
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
                FROM "DWC_GLOBAL"."TASK_CHAIN_RUNS" r
                WHERE r."SPACE_ID" = ? AND r."TECHNICAL_NAME" = ?
                ORDER BY r."CHAIN_TASK_LOG_ID" DESC
                LIMIT 1
            '''
            rows = db_query_executor.query(sql, (space_id, taskchain))
        
        if not rows:
            return jsonify({"success": False, "error": "Task chain run not found"}), 404
        
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
            FROM "DWC_GLOBAL"."TASK_CHAIN_RUN_NODES" n
            LEFT JOIN "DWC_GLOBAL"."TASK_LOGS" l ON n."TASK_LOG_ID" = l."TASK_LOG_ID"
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
                "startTime": str(nr.get("startTime")) if nr.get("startTime") else None,
                "endTime": str(nr.get("endTime")) if nr.get("endTime") else None
            }
        
        # Extract nodes and links from DAG
        nodes = []
        links = []
        
        if dag_data and "taskchains" in dag_data:
            tc_data = dag_data["taskchains"].get(taskchain, {})
            raw_nodes = tc_data.get("nodes", [])
            raw_links = tc_data.get("links", [])
            
            for node in raw_nodes:
                node_id = node.get("id")
                node_type = node.get("type", "TASK")
                task_id = node.get("taskIdentifier", {})
                
                # Get execution status for this node
                exec_info = node_statuses.get(node_id, {})
                
                nodes.append({
                    "id": node_id,
                    "type": node_type,
                    "objectId": task_id.get("objectId") or exec_info.get("objectId"),
                    "applicationId": task_id.get("applicationId"),
                    "spaceId": task_id.get("spaceId"),
                    "status": exec_info.get("status", "pending"),
                    "ignoreError": node.get("ignoreError", False),
                    "taskLogId": exec_info.get("taskLogId")
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
            conditions.append("\"OBJECT_ID\" = ?")
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
            FROM "DWC_GLOBAL"."TASK_LOGS"
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
                "startTime": str(start_time) if start_time else None,
                "endTime": str(end_time) if end_time else None,
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
