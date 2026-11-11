"""The pending-step-params snapshot must be persisted to the DB also when the
launch happens outside a Flask request - a queued fire dequeued, or a launch
retried, from a background scheduler thread. Otherwise the DB keeps the
PREVIOUS run's params, and a later DSP-side retry would use them."""

from __future__ import annotations

import threading
from unittest.mock import MagicMock

import pytest
from flask import Flask

from src.services import taskchain_executor as tce
from src.services.taskchain_executor import TaskchainExecutor


@pytest.fixture
def repo():
    r = MagicMock()
    previous = TaskchainExecutor._schedule_repo
    TaskchainExecutor.set_schedule_repo(r)
    yield r
    TaskchainExecutor.set_schedule_repo(previous)
    with tce._PENDING_STEP_PARAMS_LOCK:
        tce._PENDING_STEP_PARAMS.pop("TC1", None)
        tce._PENDING_STEP_PARAMS_TTL.pop("TC1", None)


def test_persisted_from_background_thread(repo):
    t = threading.Thread(target=TaskchainExecutor.store_pending_step_params,
                         args=("TC1", {"STEP": [{"key": "a", "value": "1"}]}, "SPACE"))
    t.start()
    t.join()

    repo.set_pending_step_params.assert_called_once()
    assert repo.set_pending_step_params.call_args.args[:2] == ("TC1", "SPACE")


def test_request_context_repo_still_preferred(repo):
    app = Flask(__name__)
    ctx_repo = MagicMock()
    app.extensions["taskchain"] = {"schedule_repo": ctx_repo}

    with app.app_context():
        TaskchainExecutor.store_pending_step_params("TC1", {"STEP": []}, "SPACE")

    ctx_repo.set_pending_step_params.assert_called_once()
    repo.set_pending_step_params.assert_not_called()


def test_db_fallback_read_works_outside_request(repo):
    repo.get_pending_step_params.return_value = '{"STEP": [{"key": "a", "value": "1"}]}'
    with tce._PENDING_STEP_PARAMS_LOCK:
        tce._PENDING_STEP_PARAMS.pop("TC1", None)

    result = {}
    t = threading.Thread(target=lambda: result.update(
        params=TaskchainExecutor.consume_pending_step_params("TC1")))
    t.start()
    t.join()

    assert result["params"] == {"STEP": [{"key": "a", "value": "1"}]}
