"""Taskchain endpoints (route + execute + status + list)."""

from __future__ import annotations

import logging

from flask import Blueprint, current_app, jsonify, request

from ..auth import flask_access_validation
from ..exceptions import InvalidRuleResultError, MissingRuleIdError, RuleExecutionError, RuleNotFoundError


logger = logging.getLogger(__name__)

bp = Blueprint("tasks", __name__)


def _is_truthy(value) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "y"}
    return False


def _is_dummy_value(value: str | None) -> bool:
    if value is None:
        return False
    return value.strip().lower() == "dummy"


def _get_step_status_from_dsp_logs(
    db_query_executor,
    taskchain: str,
    stepid: str,
    step_to_check: str,
    spaceid: str,
    check_strategy: str,
    step_type: str,
    target_spaceid: str | None,
) -> str | None:
    target_object_id = step_to_check
    if step_type == "TASKCHAIN":
        target_object_id = step_to_check

    if check_strategy != "CURRENT":
        if step_type == "TASKCHAIN" and target_spaceid:
            status_rows = db_query_executor.query(
                (
                    "SELECT \"STATUS\" "
                    "FROM \"DWC_GLOBAL\".\"TASK_LOGS\" "
                    "WHERE \"OBJECT_ID\" = ? AND \"SPACE_ID\" = ? "
                    "ORDER BY \"START_TIME\" DESC LIMIT 1"
                ),
                (target_object_id, target_spaceid),
            )
        else:
            status_rows = db_query_executor.query(
                (
                    "SELECT \"STATUS\" "
                    "FROM \"DWC_GLOBAL\".\"TASK_LOGS\" "
                    "WHERE \"OBJECT_ID\" = ? "
                    "ORDER BY \"START_TIME\" DESC LIMIT 1"
                ),
                (target_object_id,),
            )
        if status_rows:
            return status_rows[0].get("STATUS")
        return None

    if step_type == "TASKCHAIN" and target_spaceid:
        status_rows = db_query_executor.query(
            (
                "SELECT \"STATUS\" "
                "FROM \"DWC_GLOBAL\".\"TASK_LOGS\" "
                "WHERE \"OBJECT_ID\" = ? AND \"SPACE_ID\" = ? "
                "ORDER BY \"START_TIME\" DESC LIMIT 1"
            ),
            (target_object_id, target_spaceid),
        )
        if status_rows:
            return status_rows[0].get("STATUS")
        return None

    running_rows = db_query_executor.query(
        (
            "SELECT \"TASK_LOG_ID\" "
            "FROM \"DWC_GLOBAL\".\"TASK_LOGS\" "
            "WHERE \"OBJECT_ID\" = ? AND \"SPACE_ID\" = ? AND \"STATUS\" = 'RUNNING'"
        ),
        (stepid, spaceid),
    )
    if not running_rows:
        return None

    task_log_id = running_rows[0].get("TASK_LOG_ID")
    if not task_log_id:
        return None

    chain_rows = db_query_executor.query(
        (
            "SELECT TOP 1000 \"CHAIN_TASK_LOG_ID\", \"TASK_LOG_ID\" "
            "FROM \"DWC_GLOBAL\".\"TASK_CHAIN_RUN_NODES\" "
            "WHERE \"TASK_LOG_ID\" = ?"
        ),
        (task_log_id,),
    )
    if not chain_rows:
        return None

    chain_task_log_id = chain_rows[0].get("CHAIN_TASK_LOG_ID")
    if not chain_task_log_id:
        return None

    chain_verify = db_query_executor.query(
        (
            "SELECT \"TASK_LOG_ID\" "
            "FROM \"DWC_GLOBAL\".\"TASK_LOGS\" "
            "WHERE \"TASK_LOG_ID\" = ? AND \"OBJECT_ID\" = ? AND \"SPACE_ID\" = ?"
        ),
        (chain_task_log_id, taskchain, spaceid),
    )
    if not chain_verify:
        return None

    chain_nodes = db_query_executor.query(
        (
            "SELECT \"TASK_LOG_ID\" "
            "FROM \"DWC_GLOBAL\".\"TASK_CHAIN_RUN_NODES\" "
            "WHERE \"CHAIN_TASK_LOG_ID\" = ?"
        ),
        (chain_task_log_id,),
    )
    if not chain_nodes:
        return None

    task_log_ids = [row.get("TASK_LOG_ID") for row in chain_nodes if row.get("TASK_LOG_ID")]
    if not task_log_ids:
        return None

    placeholders = ", ".join(["?" for _ in task_log_ids])
    status_rows = db_query_executor.query(
        (
            "SELECT \"STATUS\" "
            "FROM \"DWC_GLOBAL\".\"TASK_LOGS\" "
            f"WHERE \"TASK_LOG_ID\" IN ({placeholders}) AND \"OBJECT_ID\" = ?"
            "ORDER BY \"START_TIME\" DESC LIMIT 1"
        ),
        tuple(task_log_ids + [target_object_id]),
    )
    if status_rows:
        return status_rows[0].get("STATUS")
    return None




@bp.route("/route", methods=["POST"])
@flask_access_validation(required_scope="admin")
def route_taskchain():
    if not request.is_json:
        return jsonify({"error": "Request body must be JSON"}), 400

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Payload must be a JSON object"}), 400

    routing_service = current_app.extensions["taskchain"]["routing_service"]

    try:
        routing_result = routing_service.route(payload)
        if isinstance(routing_result, dict):
            taskchain = routing_result.get("taskchain") or routing_result.get("taskchain_name")
            spaceid = None
            for k in routing_result.keys():
                if k.lower() == "spaceid":
                    spaceid = routing_result[k]
                    break

            response = {"taskchain": taskchain}
            if spaceid:
                response["spaceid"] = spaceid
            return jsonify(response), 200

        return jsonify({"taskchain": routing_result}), 200

    except MissingRuleIdError:
        return jsonify({"error": "Campo 'ruleid' mancante o non valido nel payload"}), 400
    except RuleNotFoundError as e:
        return jsonify({"error": str(e)}), 404
    except (RuleExecutionError, InvalidRuleResultError) as e:
        return jsonify({"error": f"Errore esecuzione regola: {str(e)}"}), 500
    except Exception:
        logger.exception("Unexpected error during routing")
        return jsonify({"error": "Errore interno del server"}), 500


@bp.route("/execute", methods=["POST"])
@flask_access_validation(required_scope="admin")
def execute_taskchain():
    if not request.is_json:
        return jsonify({"error": "Request body must be JSON"}), 400

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Payload must be a JSON object"}), 400

    spaceid = payload.get("spaceid") or payload.get("spaceId")
    taskchain = payload.get("taskchain") or payload.get("taskchain_name")

    shared_payload = _is_truthy(
        payload.get("sharedPayload")
        or payload.get("shared")
        or payload.get("isShared")
    )

    routing_service = current_app.extensions["taskchain"]["routing_service"]
    taskchain_executor = current_app.extensions["taskchain"]["taskchain_executor"]

    if not spaceid or not taskchain:
        try:
            routing_result = routing_service.route(payload)
            if isinstance(routing_result, dict):
                taskchain = routing_result.get("taskchain") or routing_result.get("taskchain_name")
                for k in routing_result.keys():
                    if k.lower() == "spaceid":
                        spaceid = routing_result[k]
                        break
            else:
                taskchain = routing_result
        except Exception as e:
            return jsonify({"error": f"Impossibile dedurre automaticamente spaceid/taskchain_name: {e}"}), 400

    if _is_dummy_value(spaceid) and _is_dummy_value(taskchain):
        execution_id = taskchain_executor.create_dummy_execution(taskchain or "__dummy__", payload)
        return (
            jsonify(
                {
                    "execution_id": execution_id,
                    "taskchain": taskchain or "__dummy__",
                    "spaceid": spaceid,
                    "status": "completed",
                    "kind": "dummy",
                    "message": "Dummy execution for shared payload",
                }
            ),
            202,
        )

    if not spaceid or not taskchain:
        return jsonify({"error": "'spaceid' e 'taskchain_name' sono obbligatori"}), 400

    try:
        execution_id = taskchain_executor.execute_async_dsp(spaceid, taskchain, payload)
        return (
            jsonify(
                {
                    "execution_id": execution_id,
                    "taskchain": taskchain,
                    "status": "pending",
                    "message": "Taskchain execution started",
                }
            ),
            202,
        )
    except Exception as e:
        logger.exception("Error during DSP taskchain execution")
        return jsonify({"error": f"Errore esecuzione DSP: {str(e)}"}), 500


@bp.route("/skip", methods=["POST"])
@flask_access_validation(required_scope="admin")
def skip_taskchain():
    if not request.is_json:
        return jsonify({"error": "Request body must be JSON"}), 400

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Payload must be a JSON object"}), 400

    taskchain = payload.get("taskchain") or payload.get("taskchain_name")
    stepid = payload.get("stepid") or payload.get("stepId")
    step_to_check = payload.get("steptobechecked") or payload.get("stepToBeChecked")
    spaceid = payload.get("spaceid") or payload.get("spaceId")

    if not taskchain or not stepid or not step_to_check or not spaceid:
        return (
            jsonify({"error": "'spaceid', 'taskchain', 'stepid' e 'steptobechecked' sono obbligatori"}),
            400,
        )

    execution_id = payload.get("execution_id") or payload.get("executionId")
    logid = payload.get("logid") or payload.get("logId")

    taskchain_executor = current_app.extensions["taskchain"]["taskchain_executor"]
    repository = current_app.extensions["taskchain"]["repository"]
    db_query_executor = current_app.extensions["taskchain"]["db_query_executor"]
    if execution_id and not logid:
        try:
            spaceid_from_exec, logid_from_exec = taskchain_executor.parse_execution_id(execution_id)
            logid = logid_from_exec or logid
            spaceid = spaceid_from_exec or spaceid
        except Exception:
            pass


    def _override_check() -> bool:
        sql = (
            "SELECT OVERRIDE FROM CONDITIONAL_APP_TASKCHAINS_SKIPOVERRIDE "
            "WHERE SPACEID = ? AND TASKCHAIN = ? AND STEPID = ? AND STEPTOBECHECKED = ?"
        )
        rows = repository.query(sql, (spaceid, taskchain, stepid, step_to_check))
        if rows:
            raw = rows[0].get("OVERRIDE") or rows[0].get("override")
            return _is_truthy(raw)
        return False

    def _override_reset() -> None:
        try:
            repository.set_skip_override(spaceid, taskchain, stepid, step_to_check, False)
        except Exception:
            logger.exception("Failed to reset skip override")

    def _step_status_check() -> str | None:
        if payload.get("stepStatus") is not None:
            return str(payload.get("stepStatus"))
        if payload.get("step_status") is not None:
            return str(payload.get("step_status"))
        check_strategy = str(payload.get("checkstrategy") or payload.get("checkStrategy") or "CURRENT")
        check_strategy = check_strategy.strip().upper()
        step_type = str(payload.get("steptype") or payload.get("stepType") or "STEP")
        step_type = step_type.strip().upper()
        target_spaceid = payload.get("targetspaceid") or payload.get("targetSpaceId")
        return _get_step_status_from_dsp_logs(
            db_query_executor,
            taskchain,
            stepid,
            step_to_check,
            spaceid,
            check_strategy,
            step_type,
            target_spaceid,
        )

    execution_id = taskchain_executor.skip_check_async(
        taskchain,
        stepid,
        step_to_check,
        payload=dict(payload),
        override_check=_override_check,
        override_reset=_override_reset,
        step_status_check=_step_status_check,
    )

    return (
        jsonify(
            {
                "execution_id": execution_id,
                "status": "pending",
                "kind": "skip",
                "spaceid": spaceid,
                "taskchain": taskchain,
                "stepid": stepid,
                "steptobechecked": step_to_check,
                "message": "Skip check started",
            }
        ),
        202,
    )


@bp.route("/wait", methods=["POST"])
@flask_access_validation(required_scope="admin")
def wait_taskchain():
    if not request.is_json:
        return jsonify({"error": "Request body must be JSON"}), 400

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Payload must be a JSON object"}), 400

    duration = payload.get("duration")
    unit = (payload.get("unit") or "s").strip().lower()

    if duration is None:
        return jsonify({"error": "Missing 'duration' in payload"}), 400

    try:
        duration_value = float(duration)
    except Exception:
        return jsonify({"error": "'duration' must be a number"}), 400

    if duration_value < 0:
        return jsonify({"error": "'duration' must be >= 0"}), 400

    if unit in {"ms", "millis", "milliseconds"}:
        duration_seconds = duration_value / 1000.0
    elif unit in {"s", "sec", "secs", "second", "seconds"}:
        duration_seconds = duration_value
    else:
        return jsonify({"error": "Invalid 'unit'. Use 's' or 'ms'"}), 400

    taskchain_executor = current_app.extensions["taskchain"]["taskchain_executor"]
    execution_id = taskchain_executor.wait_async(duration_seconds, payload={"duration": duration_value, "unit": unit})

    return (
        jsonify(
            {
                "execution_id": execution_id,
                "status": "pending",
                "kind": "wait",
                "duration_seconds": duration_seconds,
                "message": "Wait started",
            }
        ),
        202,
    )


@bp.route("/executions/<execution_id>", methods=["GET"])
@flask_access_validation(required_scope="admin")
def get_taskchain_status(execution_id: str):
    try:
        taskchain_executor = current_app.extensions["taskchain"]["taskchain_executor"]
        status_info = taskchain_executor.get_status(execution_id)
        return jsonify(status_info), 200
    except Exception as e:
        logger.exception("Error during DSP status fetch")
        return jsonify({"error": f"Errore fetch status DSP: {str(e)}"}), 500


@bp.route("/executions", methods=["GET"])
@flask_access_validation(required_scope="admin")
def list_taskchain_executions():
    taskchain_executor = current_app.extensions["taskchain"]["taskchain_executor"]
    limit = request.args.get("limit", 50, type=int)
    limit = min(limit, 100)
    executions = taskchain_executor.list_executions(limit=limit)
    return jsonify({"executions": executions, "count": len(executions)}), 200
