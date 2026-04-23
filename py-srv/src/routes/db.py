"""DB query endpoint (read-only SELECT)."""

from __future__ import annotations

import logging
from datetime import date, datetime

from flask import Blueprint, current_app, jsonify, request

from ..auth import flask_access_validation


logger = logging.getLogger(__name__)

bp = Blueprint("db", __name__)


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
