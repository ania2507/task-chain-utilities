"""Rule Engine for executing Python code rules in a sandboxed environment."""

from __future__ import annotations

import ast
import json
import logging
import math
import re
import time
from datetime import date, datetime, timedelta
from typing import Any, Callable

from src.exceptions import InvalidRuleResultError, RuleExecutionError


logger = logging.getLogger(__name__)


ALLOWED_MODULES = {
    "datetime": {"datetime": datetime, "date": date, "timedelta": timedelta},
    "time": {
        "time": time.time,
        "sleep": lambda x: None,
        "strftime": time.strftime,
        "strptime": time.strptime,
        "localtime": time.localtime,
        "gmtime": time.gmtime,
    },
    "json": {"loads": json.loads, "dumps": json.dumps},
    "re": {
        "match": re.match,
        "search": re.search,
        "findall": re.findall,
        "sub": re.sub,
        "split": re.split,
        "compile": re.compile,
        "IGNORECASE": re.IGNORECASE,
        "MULTILINE": re.MULTILINE,
        "I": re.I,
        "M": re.M,
    },
    "math": {
        "ceil": math.ceil,
        "floor": math.floor,
        "sqrt": math.sqrt,
        "pow": math.pow,
        "log": math.log,
        "log10": math.log10,
        "exp": math.exp,
        "pi": math.pi,
        "e": math.e,
    },
}


def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    if name not in ALLOWED_MODULES:
        raise ImportError(
            f"Import del modulo '{name}' non consentito. Moduli permessi: {list(ALLOWED_MODULES.keys())}"
        )

    class MockModule:
        pass

    module = MockModule()
    module.__name__ = name  # type: ignore

    for attr_name, attr_value in ALLOWED_MODULES[name].items():
        setattr(module, attr_name, attr_value)

    return module


class RuleEngine:
    SAFE_BUILTINS = {
        "str": str,
        "int": int,
        "float": float,
        "bool": bool,
        "list": list,
        "dict": dict,
        "tuple": tuple,
        "set": set,
        "len": len,
        "range": range,
        "enumerate": enumerate,
        "zip": zip,
        "sorted": sorted,
        "reversed": reversed,
        "min": min,
        "max": max,
        "sum": sum,
        "abs": abs,
        "round": round,
        "isinstance": isinstance,
        "type": type,
        "any": any,
        "all": all,
        "map": map,
        "filter": filter,
        "None": None,
        "True": True,
        "False": False,
        "__import__": _safe_import,
        "__build_class__": __builtins__["__build_class__"] if isinstance(__builtins__, dict) else getattr(__builtins__, "__build_class__"),
    }

    def __init__(self, db_query_func: Callable[[str, tuple], list[dict]] | None = None):
        self._db_query_func = db_query_func

    def _create_db_query_helper(self):
        if self._db_query_func is None:
            def no_db(*args, **kwargs):
                raise RuntimeError("Database query non disponibile: db_query_func non configurato")
            return no_db

        db_func = self._db_query_func

        def safe_db_query(sql: str, params: tuple = None) -> list:  # type: ignore
            sql_upper = sql.strip().upper()
            forbidden = [
                "INSERT",
                "UPDATE",
                "DELETE",
                "DROP",
                "CREATE",
                "ALTER",
                "TRUNCATE",
                "GRANT",
                "REVOKE",
                "EXEC",
                "EXECUTE",
                "CALL",
            ]
            for keyword in forbidden:
                if keyword in sql_upper:
                    raise PermissionError(f"Operazione '{keyword}' non consentita. Solo SELECT permesso.")
            if not sql_upper.startswith("SELECT"):
                raise PermissionError("Solo query SELECT consentite.")

            try:
                return db_func(sql, params or ())
            except Exception as e:
                logger.error("DB query error: %s", e)
                raise RuntimeError(f"Errore query database: {str(e)}")

        return safe_db_query

    def validate_syntax(self, rule_code: str) -> dict:
        result: dict[str, Any] = {"valid": True, "error": None, "line": None, "warnings": []}

        try:
            compile(rule_code, "<rule>", "exec")
        except SyntaxError as e:
            result["valid"] = False
            result["error"] = f"Syntax error: {e.msg}"
            result["line"] = e.lineno
            return result

        # Validate imports & do light static checks
        tree = ast.parse(rule_code)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name not in ALLOWED_MODULES:
                        result["valid"] = False
                        result["error"] = f"Import not allowed: '{alias.name}'. Allowed modules: {list(ALLOWED_MODULES.keys())}"
                        result["line"] = getattr(node, "lineno", None)
                        return result
            if isinstance(node, ast.ImportFrom):
                if node.module and node.module not in ALLOWED_MODULES:
                    result["valid"] = False
                    result["error"] = f"Import not allowed: '{node.module}'. Allowed modules: {list(ALLOWED_MODULES.keys())}"
                    result["line"] = getattr(node, "lineno", None)
                    return result

        # Contract checks (original behavior): require explicit assignments
        # to both variables 'spaceId' and 'taskchain'.
        has_taskchain_assignment = False
        has_spaceid_assignment = False
        spaceid_value = None
        taskchain_value = None

        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id == "taskchain":
                        has_taskchain_assignment = True
                        if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                            taskchain_value = node.value.value
                    if isinstance(target, ast.Name) and target.id == "spaceId":
                        has_spaceid_assignment = True
                        if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                            spaceid_value = node.value.value
            elif isinstance(node, ast.AnnAssign):
                if isinstance(node.target, ast.Name) and node.target.id == "taskchain":
                    has_taskchain_assignment = True
                if isinstance(node.target, ast.Name) and node.target.id == "spaceId":
                    has_spaceid_assignment = True

        if not has_spaceid_assignment:
            result["valid"] = False
            result["error"] = "Variable 'spaceId' is not defined. Add: spaceId = \"YOUR_SPACE_ID\""
            return result

        if not has_taskchain_assignment:
            result["valid"] = False
            if spaceid_value:
                result["error"] = (
                    f"Variable 'taskchain' is not defined (spaceId: {spaceid_value}). "
                    "The rule must assign a value to 'taskchain'."
                )
            else:
                result["error"] = "Variable 'taskchain' is not defined. The rule must assign a value to 'taskchain'."
            result["spaceId"] = spaceid_value
            return result

        # Add extracted values to result for informational purposes
        result["spaceId"] = spaceid_value
        result["taskchain"] = taskchain_value

        # Warnings (non-blocking) - match original behavior
        if "while True" in rule_code or "while 1" in rule_code:
            result["warnings"].append("Possible infinite loop detected (while True)")
        if "open(" in rule_code or "file(" in rule_code:
            result["warnings"].append("File access attempt (blocked at runtime)")
        if "eval(" in rule_code or "exec(" in rule_code:
            result["warnings"].append("Use of eval/exec (blocked at runtime)")

        return result

    def execute(self, rule_code: str, payload: dict[str, Any]) -> Any:
        """Execute rule code and return the taskchain (and optional spaceid).

        Contract (as in the original `conditional-app`):
        - the rule must set a `taskchain` variable (string)
        - optionally sets `spaceId` or `spaceid` (string)

        Backwards-compatible: if `taskchain` is missing but `result` exists,
        attempt to derive the taskchain from it.
        """

        try:
            exec_globals = {"__builtins__": self.SAFE_BUILTINS}
            exec_locals: dict[str, Any] = {
                "payload": payload,
                "db_query": self._create_db_query_helper(),
            }

            exec(rule_code, exec_globals, exec_locals)

            taskchain: Any | None = exec_locals.get("taskchain")

            # Legacy support: allow returning `result` as either string or dict.
            if taskchain is None and "result" in exec_locals:
                legacy_result = exec_locals.get("result")
                if isinstance(legacy_result, str):
                    taskchain = legacy_result
                elif isinstance(legacy_result, dict):
                    taskchain = legacy_result.get("taskchain") or legacy_result.get("taskchain_name")
                    if taskchain is None:
                        for k, v in legacy_result.items():
                            if isinstance(k, str) and k.lower() in ("taskchain", "taskchain_name"):
                                taskchain = v
                                break
                    if "spaceid" not in exec_locals and "spaceId" not in exec_locals:
                        for k, v in legacy_result.items():
                            if isinstance(k, str) and k.lower() == "spaceid":
                                exec_locals["spaceid"] = v
                                break

            if taskchain is None:
                raise InvalidRuleResultError("La regola non ha impostato la variabile 'taskchain'")
            if not isinstance(taskchain, str):
                raise InvalidRuleResultError(f"'taskchain' deve essere una stringa, ricevuto: {type(taskchain).__name__}")
            if not taskchain.strip():
                raise InvalidRuleResultError("'taskchain' non può essere una stringa vuota")

            spaceid = exec_locals.get("spaceid")
            if spaceid is None:
                spaceid = exec_locals.get("spaceId")

            if spaceid is not None:
                if not isinstance(spaceid, str):
                    raise InvalidRuleResultError(f"'spaceid' deve essere una stringa, ricevuto: {type(spaceid).__name__}")
                if not spaceid.strip():
                    raise InvalidRuleResultError("'spaceid' non può essere una stringa vuota")
                return {"taskchain": taskchain, "spaceid": spaceid}

            return taskchain
        except InvalidRuleResultError:
            raise
        except Exception as e:
            raise RuleExecutionError(str(e))

    def dry_run(self, rule_code: str, payload: dict[str, Any]) -> dict[str, Any]:
        start = time.time()

        response: dict[str, Any] = {
            "success": False,
            "result": None,
            "spaceId": None,
            "error": None,
            "execution_time_ms": 0,
        }

        validation = self.validate_syntax(rule_code)
        if not validation.get("valid"):
            response["error"] = validation.get("error")
            response["spaceId"] = validation.get("spaceId")
            response["execution_time_ms"] = round((time.time() - start) * 1000, 2)
            return response

        response["spaceId"] = validation.get("spaceId")

        try:
            res = self.execute(rule_code, payload)
            response["success"] = True
            response["result"] = res

            # Convenience fields for clients (UI): expose common fields top-level.
            if isinstance(res, dict):
                response["taskchain"] = res.get("taskchain") or res.get("taskchain_name")
                response["spaceId"] = res.get("spaceId") or res.get("spaceid")
            elif isinstance(res, str):
                response["taskchain"] = res

            return response
        except (RuleExecutionError, InvalidRuleResultError) as e:
            response["error"] = str(e)
            return response
        finally:
            response["execution_time_ms"] = round((time.time() - start) * 1000, 2)
