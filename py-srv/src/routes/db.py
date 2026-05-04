"""DB query endpoint (read-only SELECT)."""

from __future__ import annotations

import json
import logging
import urllib.request
from datetime import date, datetime

from flask import Blueprint, current_app, jsonify, request

from ..auth import flask_access_validation
from ..integrations.dsp import DSPDestinationClient


logger = logging.getLogger(__name__)

bp = Blueprint("db", __name__)


@bp.route("/taskchains", methods=["GET"])
@flask_access_validation()
def db_taskchains_endpoint():
    """Return taskchains from DSP via REST API (BTP Destination Service)."""
    try:
        client = DSPDestinationClient.from_env()
        if not client:
            return jsonify({"success": False, "error": "DSP destination not configured", "data": [], "rowCount": 0}), 500

        conn = client.get_connection()
        base_url = conn["host"].rstrip("/")
        token = conn["access_token"]
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

        # 1. List spaces
        req = urllib.request.Request(f"{base_url}/api/v1/spaces?$top=100", headers=headers)
        with urllib.request.urlopen(req, timeout=30) as resp:
            spaces_data = json.loads(resp.read().decode("utf-8"))
        spaces = spaces_data.get("value", [])

        taskchains = []
        for space in spaces:
            space_id = (
                space.get("spaceDefinition", {}).get("spaceId")
                or space.get("id")
                or space.get("spaceId")
            )
            if not space_id:
                continue

            # 2. List task chains for each space
            try:
                tc_req = urllib.request.Request(
                    f"{base_url}/api/v1/tasks/spaces/{space_id}/chains?$top=500",
                    headers=headers,
                )
                with urllib.request.urlopen(tc_req, timeout=30) as tc_resp:
                    tc_data = json.loads(tc_resp.read().decode("utf-8"))
                for tc in tc_data.get("value", []):
                    technical_name = tc.get("technicalName") or tc.get("name")
                    business_name = tc.get("businessName") or tc.get("label") or technical_name
                    taskchains.append({
                        "name": technical_name,
                        "spaceId": space_id,
                        "businessName": business_name,
                        "owner": tc.get("createdBy") or tc.get("changedBy") or "",
                        "deployedBy": tc.get("changedBy") or "",
                        "deployedAt": tc.get("changedAt") or tc.get("createdAt"),
                        "modificationDate": tc.get("changedAt"),
                    })
            except Exception as e:
                logger.warning("Could not fetch task chains for space '%s': %s", space_id, e)

        return jsonify({"success": True, "data": taskchains, "error": None, "rowCount": len(taskchains)}), 200
    except Exception as e:
        logger.exception("Error fetching DSP taskchains")
        return jsonify({"success": False, "error": str(e), "data": [], "rowCount": 0}), 500


@bp.route("/query", methods=["POST"])
@flask_access_validation(required_scope="admin")
def db_query_endpoint():
    try:
        data = request.get_json(silent=True)
        if not data:
            return (
                jsonify({"success": False, "error": "Request body deve essere JSON", "data": [], "rowCount": 0}),
                400,
            )

        sql = data.get("sql")
        if not sql:
            return jsonify({"success": False, "error": "Campo 'sql' obbligatorio", "data": [], "rowCount": 0}), 400
        if not isinstance(sql, str):
            return jsonify({"success": False, "error": "'sql' deve essere una stringa", "data": [], "rowCount": 0}), 400

        sql_upper = sql.strip().upper()
        if not sql_upper.startswith("SELECT"):
            return jsonify({"success": False, "error": "Solo query SELECT consentite", "data": [], "rowCount": 0}), 400

        params = data.get("params", [])
        if not isinstance(params, (list, tuple)):
            return jsonify({"success": False, "error": "'params' deve essere un array", "data": [], "rowCount": 0}), 400

        db_query_executor = current_app.extensions["taskchain"]["db_query_executor"]
        rows = db_query_executor.query(sql, tuple(params))

        def serialize_row(row):
            out = {}
            for key, value in row.items():
                if isinstance(value, (datetime, date)):
                    out[key] = value.isoformat()
                else:
                    out[key] = value
            return out

        serialized_rows = [serialize_row(r) for r in rows] if rows else []
        return (
            jsonify({"success": True, "data": serialized_rows, "error": None, "rowCount": len(serialized_rows)}),
            200,
        )

    except Exception as e:
        logger.exception("Error executing db-query")
        return jsonify({"success": False, "error": str(e), "data": [], "rowCount": 0}), 500
