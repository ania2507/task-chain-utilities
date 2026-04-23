"""Datasphere diagnostics endpoints.

These endpoints are meant for operator debugging in CF. They execute Datasphere CLI commands
and return sanitized outputs (no secrets/tokens) to help troubleshoot permissions/space/taskchain issues.
"""

from __future__ import annotations

import json
import os
import re
import time
import base64
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Optional

from flask import Blueprint, jsonify, request

from ..auth import flask_access_validation

bp = Blueprint("dsp", __name__)


_TOKEN_CACHE: dict[str, Any] = {
    "access_token": None,
    "expires_at": 0.0,
}


@dataclass
class CliResult:
    ok: bool
    rc: int
    stdout: str
    stderr: str
    command: str


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


def _sanitize_cli_result(r: Dict[str, Any]) -> Dict[str, Any]:
    stdout = r.get("stdout") or ""
    stderr = r.get("stderr") or ""

    # If stdout/stderr are JSON, redact keys.
    def maybe_json(s: str) -> Optional[Any]:
        s = (s or "").strip()
        if not s:
            return None
        if not (s.startswith("{") or s.startswith("[")):
            return None
        try:
            return json.loads(s)
        except Exception:
            return None

    stdout_json = maybe_json(stdout)
    stderr_json = maybe_json(stderr)

    sanitized: Dict[str, Any] = {
        "ok": bool(r.get("ok")),
        "rc": int(r.get("rc", -1)),
        "command": _redact_text(str(r.get("command") or "")),
        "stdout": None,
        "stderr": None,
    }

    # Optional metadata
    if "timed_out" in r:
        sanitized["timed_out"] = bool(r.get("timed_out"))
    if "timeout_sec" in r:
        try:
            sanitized["timeout_sec"] = int(r.get("timeout_sec")) if r.get("timeout_sec") is not None else None
        except Exception:
            sanitized["timeout_sec"] = r.get("timeout_sec")

    if stdout_json is not None:
        sanitized["stdout"] = _redact_json_payload(stdout_json)
    else:
        sanitized["stdout"] = _redact_text(stdout)

    if stderr_json is not None:
        sanitized["stderr"] = _redact_json_payload(stderr_json)
    else:
        sanitized["stderr"] = _redact_text(stderr)

    return sanitized


def _exec_cli(command: str, *, timeout_sec: int | None = 120) -> Dict[str, Any]:
    # Prefer metasphere tool (it also resolves local datasphere binary on CF)
    try:
        from thirdparty.metasphere.src.tools.dsp_tools import exec_command_result  # type: ignore

        return exec_command_result(command, timeout_sec=timeout_sec)
    except Exception:
        # Minimal fallback: run via subprocess with NODE_ENV removed.
        import platform
        import shlex
        import subprocess
        from pathlib import Path

        env = os.environ.copy()
        env.pop("NODE_ENV", None)

        # Try local node_modules binary if present (CF droplet)
        cli = None
        for p in [
            Path.cwd() / "node_modules" / ".bin" / "datasphere",
            Path("/home/vcap/app/node_modules/.bin/datasphere"),
        ]:
            try:
                if p.exists():
                    cli = str(p)
                    break
            except Exception:
                pass

        if command.strip().startswith("datasphere ") and cli:
            command = f"{shlex.quote(cli)} " + command.strip()[len("datasphere ") :]

        is_windows = platform.system() == "Windows"
        if is_windows:
            p = subprocess.run(command, shell=True, text=True, capture_output=True, env=env, timeout=timeout_sec)
        else:
            p = subprocess.run(shlex.split(command), text=True, capture_output=True, env=env, timeout=timeout_sec)

        return {
            "ok": p.returncode == 0,
            "rc": p.returncode,
            "stdout": (p.stdout or "").strip(),
            "stderr": (p.stderr or "").strip(),
            "command": command,
            "timeout_sec": timeout_sec,
        }


def _get_dsp_rest_config() -> Dict[str, str]:
    auth_url = os.environ.get("DSP_AUTH_URL") or os.environ.get("DSP_TOKEN_URL")
    client_id = os.environ.get("DSP_CLIENT_ID")
    client_secret = os.environ.get("DSP_CLIENT_SECRET")
    base_url = os.environ.get("DSP_REST_BASE_URL") or os.environ.get("DSP_HOSTNAME")

    if not (auth_url and client_id and client_secret and base_url):
        raise RuntimeError(
            "DSP REST config missing. Set DSP_AUTH_URL (or DSP_TOKEN_URL), "
            "DSP_CLIENT_ID, DSP_CLIENT_SECRET, and DSP_REST_BASE_URL (or DSP_HOSTNAME)."
        )

    if base_url.endswith("/"):
        base_url = base_url[:-1]

    return {
        "auth_url": auth_url,
        "client_id": client_id,
        "client_secret": client_secret,
        "base_url": base_url,
    }


def _get_dsp_access_token() -> str:
    now = time.time()
    if _TOKEN_CACHE.get("access_token") and _TOKEN_CACHE.get("expires_at", 0) > now + 30:
        return _TOKEN_CACHE["access_token"]

    cfg = _get_dsp_rest_config()
    token_url = cfg["auth_url"].rstrip("/")
    if not token_url.endswith("/oauth/token"):
        token_url = token_url + "/oauth/token"

    payload = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode("utf-8")
    basic = f"{cfg['client_id']}:{cfg['client_secret']}".encode("utf-8")
    headers = {
        "Authorization": "Basic " + base64.b64encode(basic).decode("ascii"),
        "Content-Type": "application/x-www-form-urlencoded",
    }

    req = urllib.request.Request(token_url, data=payload, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    access_token = data.get("access_token")
    if not access_token:
        raise RuntimeError("DSP token response missing access_token")

    expires_in = float(data.get("expires_in", 600))
    _TOKEN_CACHE["access_token"] = access_token
    _TOKEN_CACHE["expires_at"] = now + expires_in
    return access_token


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
    """Run a few Datasphere CLI diagnostics.

    Body (optional):
      - spaceid: space ID to check
      - taskchain: technical name to check

    Returns sanitized stdout/stderr (no client_secret/access_token).
    """

    payload = request.get_json(silent=True) if request.is_json else {}
    if payload is None:
        payload = {}

    spaceid = payload.get("spaceid") or payload.get("spaceId")
    taskchain = payload.get("taskchain") or payload.get("taskchain_name")

    # Keep endpoint responsive even when CLI hangs.
    try:
        requested_timeout = payload.get("timeout_sec")
        base_timeout_sec = int(requested_timeout) if requested_timeout is not None else 60
    except Exception:
        base_timeout_sec = 60
    base_timeout_sec = max(5, min(base_timeout_sec, 300))

    # Optional: attempt a non-interactive login (client credentials) so cache init can complete.
    attempt_login = payload.get("attempt_login")
    if attempt_login is None:
        attempt_login = True

    dsp_hostname = os.environ.get("DSP_HOSTNAME")

    checks: list[dict] = []

    # Basic env presence (no secrets)
    checks.append(
        {
            "name": "env",
            "data": {
                "DSP_SIMULATE": os.environ.get("DSP_SIMULATE"),
                "DSP_HOSTNAME_set": bool(os.environ.get("DSP_HOSTNAME")),
                "DSP_CLIENT_ID_set": bool(os.environ.get("DSP_CLIENT_ID")),
                "DSP_CLIENT_SECRET_set": bool(os.environ.get("DSP_CLIENT_SECRET")),
            },
        }
    )

    # What secrets the CLI has (sanitized)
    def run_check(name: str, command: str, *, timeout_sec: int) -> None:
        started = time.monotonic()
        raw = _exec_cli(command, timeout_sec=timeout_sec)
        elapsed_ms = int((time.monotonic() - started) * 1000)
        checks.append(
            {
                "name": name,
                "timeout_sec": timeout_sec,
                "elapsed_ms": elapsed_ms,
                "result": _sanitize_cli_result(raw),
            }
        )

    run_check("cli.config.secrets.show", "datasphere config secrets show", timeout_sec=base_timeout_sec)

    # Identify the CLI that is actually being executed (version/help can reveal mismatched binaries).
    run_check("cli.version", "datasphere --version", timeout_sec=min(20, base_timeout_sec))
    run_check("cli.help", "datasphere --help", timeout_sec=min(20, base_timeout_sec))
    run_check("cli.config.host.show", "datasphere config host show", timeout_sec=min(20, base_timeout_sec))

    # Some CLI versions require login + cache initialization before other commands.
    if dsp_hostname:
        dsp_client_id = os.environ.get("DSP_CLIENT_ID")
        dsp_client_secret = os.environ.get("DSP_CLIENT_SECRET")
        if attempt_login and dsp_client_id and dsp_client_secret:
            run_check(
                "cli.login.client_credentials",
                " ".join(
                    [
                        "datasphere login",
                        f'--host "{dsp_hostname}"',
                        "--authorization-flow client_credentials",
                        f'--client-id "{dsp_client_id}"',
                        f'--client-secret "{dsp_client_secret}"',
                    ]
                ),
                timeout_sec=max(60, base_timeout_sec),
            )

            run_check(
                "cli.config.secrets.show.after_login",
                "datasphere config secrets show",
                timeout_sec=min(30, base_timeout_sec),
            )

        run_check(
            "cli.config.cache.init",
            f"datasphere config cache init --host \"{dsp_hostname}\"",
            timeout_sec=max(120, base_timeout_sec),
        )

        # Help for subcommands (useful when the CLI behaves differently in CF)
        run_check(
            "cli.spaces.list.help",
            "datasphere spaces list --help",
            timeout_sec=min(30, base_timeout_sec),
        )
        run_check(
            "cli.objects.task-chains.list.help",
            "datasphere objects task-chains list --help",
            timeout_sec=min(30, base_timeout_sec),
        )
        run_check(
            "cli.tasks.chains.run.help",
            "datasphere tasks chains run --help",
            timeout_sec=min(30, base_timeout_sec),
        )

    # Spaces list (may fail if permissions are missing). Try a simple call first.
    spaces_cmd_simple = "datasphere spaces list"
    spaces_cmd_full = "datasphere spaces list -Q 25 -S id,name,displayName"
    if dsp_hostname:
        spaces_cmd_simple = f"datasphere spaces list --host \"{dsp_hostname}\""
        spaces_cmd_full = f"datasphere spaces list --host \"{dsp_hostname}\" -Q 25 -S id,name,displayName"
    run_check("cli.spaces.list", spaces_cmd_simple, timeout_sec=max(60, base_timeout_sec))
    run_check("cli.spaces.list.full", spaces_cmd_full, timeout_sec=max(60, base_timeout_sec))

    if spaceid and taskchain:
        host_arg = f" --host \"{dsp_hostname}\"" if dsp_hostname else ""
        run_check(
            "cli.objects.task-chains.list.simple",
            f"datasphere objects task-chains list{host_arg} --space \"{spaceid}\" --technical-names \"{taskchain}\"",
            timeout_sec=max(60, base_timeout_sec),
        )
        run_check(
            "cli.objects.task-chains.list",
            f"datasphere objects task-chains list{host_arg} --space \"{spaceid}\" --technical-names \"{taskchain}\" -S technicalName,status",
            timeout_sec=max(30, base_timeout_sec),
        )

        # Attempt a dry-ish run (this will actually trigger the run; only do when explicitly requested)
        if payload.get("attempt_run") is True:
            run_check(
                "cli.tasks.chains.run",
                f"datasphere tasks chains run{host_arg} --space \"{spaceid}\" --object \"{taskchain}\"",
                timeout_sec=max(60, base_timeout_sec),
            )

    ok = True
    for c in checks:
        r = c.get("result")
        if isinstance(r, dict) and r.get("ok") is False:
            ok = False

    return jsonify({"success": ok, "checks": checks}), (200 if ok else 200)


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
