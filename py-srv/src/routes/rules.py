"""Rule-related endpoints (validate + dry-run)."""

from __future__ import annotations

import logging

from flask import Blueprint, current_app, jsonify, request

from ..auth import flask_access_validation


logger = logging.getLogger(__name__)

bp = Blueprint("rules", __name__)


@bp.route("/validate", methods=["POST"])
@flask_access_validation(required_scope="admin")
def validate_rule():
    try:
        data = request.get_json(silent=True)
        if not data:
            return jsonify({"error": "Request body must be JSON"}), 400

        code = data.get("code")
        if not code:
            return jsonify({"error": "Field 'code' is required"}), 400
        if not isinstance(code, str):
            return jsonify({"error": "'code' must be a string"}), 400

        engine = current_app.extensions["taskchain"]["engine"]
        result = engine.validate_syntax(code)
        return jsonify(result), (200 if result.get("valid") else 400)

    except Exception as e:
        logger.exception("Error during rule validation")
        return jsonify({"error": f"Validation error: {str(e)}"}), 500


@bp.route("/test", methods=["POST"])
@flask_access_validation(required_scope="admin")
def test_rule():
    try:
        data = request.get_json(silent=True)
        if not data:
            return jsonify({"error": "Request body deve essere JSON"}), 400

        code = data.get("code")
        if not code:
            return jsonify({"error": "Campo 'code' obbligatorio"}), 400
        if not isinstance(code, str):
            return jsonify({"error": "'code' deve essere una stringa"}), 400

        test_payload = data.get("payload", {})
        if not isinstance(test_payload, dict):
            return jsonify({"error": "'payload' deve essere un oggetto"}), 400

        engine = current_app.extensions["taskchain"]["engine"]
        result = engine.dry_run(code, test_payload)
        return jsonify(result), (200 if result.get("success") else 400)

    except Exception as e:
        logger.exception("Error during rule test")
        return jsonify({"error": f"Errore test: {str(e)}"}), 500
