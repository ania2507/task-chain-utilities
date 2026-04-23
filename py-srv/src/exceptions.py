"""Domain exceptions for taskchain routing microservice."""

from __future__ import annotations


class MissingRuleIdError(Exception):
    pass


class RuleNotFoundError(Exception):
    def __init__(self, ruleid: str):
        super().__init__(f"Rule not found: {ruleid}")
        self.ruleid = ruleid


class RuleExecutionError(Exception):
    pass


class InvalidRuleResultError(Exception):
    pass
