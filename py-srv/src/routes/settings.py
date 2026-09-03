"""App settings routes - read-only access to the generic key/value config
table (AppSetting) used for small values that should be editable without a
redeploy (e.g. IBP_JOB_USER). Rows are written directly against HANA (see
repository/app_settings_repository.py); this route requires the same `admin`
scope as everything else in this app.
"""

from __future__ import annotations

import json
import logging

from flask import Blueprint, current_app, jsonify, Response

from ..auth import flask_access_validation

logger = logging.getLogger(__name__)

bp = Blueprint("settings", __name__)


def _repo():
    repo = current_app.extensions.get("taskchain", {}).get("app_settings_repo")
    if not repo:
        raise RuntimeError("AppSettingsRepository not initialised")
    return repo


@bp.route("", methods=["GET"])
@flask_access_validation(required_scope="admin")
def list_settings():
    try:
        # jsonify() sorts keys alphabetically by default, which would put
        # "description" before "name"/"value" - build the response directly
        # to keep list_all()'s field order (name, value, description).
        body = json.dumps(_repo().list_all(), sort_keys=False)
        return Response(body, mimetype="application/json")
    except Exception as e:
        logger.exception("list_settings failed")
        return jsonify({"error": str(e)}), 500
