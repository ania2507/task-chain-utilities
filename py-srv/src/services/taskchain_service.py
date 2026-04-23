"""Taskchain Routing Service - orchestrates rule retrieval and execution."""

from __future__ import annotations

import logging
from typing import Any

from src.engine import RuleEngine
from src.exceptions import MissingRuleIdError, RuleNotFoundError
from src.repository import RuleRepository


logger = logging.getLogger(__name__)


class TaskchainRoutingService:
    def __init__(self, repository: RuleRepository, engine: RuleEngine):
        self.repository = repository
        self.engine = engine

    def route(self, payload: dict[str, Any]) -> Any:
        ruleid = payload.get("ruleid")
        if not ruleid or not isinstance(ruleid, str) or not ruleid.strip():
            raise MissingRuleIdError()

        ruleid = ruleid.strip()
        rule_code = self.repository.get_code(ruleid)
        if rule_code is None:
            raise RuleNotFoundError(ruleid)

        result = self.engine.execute(rule_code, payload)

        if isinstance(result, dict):
            response: dict[str, Any] = {}
            if "taskchain" in result or "taskchain_name" in result:
                response["taskchain"] = result.get("taskchain") or result.get("taskchain_name")
            for k in result.keys():
                if k.lower() == "spaceid":
                    response["spaceid"] = result[k]
                    break
            return response

        if isinstance(result, str):
            response = {"taskchain": result}
            try:
                validation = self.engine.validate_syntax(rule_code)
                space_from_validation = validation.get("spaceId") or validation.get("spaceid")
                if space_from_validation:
                    response["spaceid"] = space_from_validation
            except Exception:
                pass
            return response

        return result

    def check_status(self) -> dict[str, Any]:
        db_ok = self.repository.check_health()
        return {"status": "ok" if db_ok else "degraded", "components": {"db": "ok" if db_ok else "error"}}
