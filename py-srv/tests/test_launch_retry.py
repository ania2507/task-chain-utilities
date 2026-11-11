"""Unit tests for retrying automatic DSP launches that DSP certainly did not
process (503/502, connection failures), and for reporting the final outcome to
SAP Job Scheduling service. DSP and the service are mocked - no network."""

from __future__ import annotations

import socket
import urllib.error
from unittest.mock import MagicMock

import pytest
import requests
from flask import Flask

from src.services import scheduler_service as ss
from src.services.scheduler_service import SchedulerService, _is_retryable_launch_error


def http_error(code):
    return urllib.error.HTTPError("https://dsp.example.com", code, "err", hdrs=None, fp=None)


class Repo:
    def __init__(self):
        self.runs = []

    def insert_run(self, **kw):
        self.runs.append(kw)


ENTRY = {
    "ID": "11111111-1111-1111-1111-111111111111", "targetType": "DSP",
    "spaceId": "SPACE1", "taskchain": "TC1", "parameters": None, "details": "CC04",
}
QUEUE_KEY = "SPACE1::TC1"


@pytest.fixture
def svc():
    tc_exec = MagicMock()
    service = SchedulerService(repo=Repo(), taskchain_executor=tc_exec)
    service._scheduler.shutdown(wait=False)
    service._scheduler = MagicMock()  # capture jobs instead of running them
    return service


def scheduled_retry(service):
    """kwargs of the last retry job scheduled."""
    calls = [c for c in service._scheduler.add_job.call_args_list
             if str(c.kwargs.get("id", "")).startswith("retry::")]
    return calls[-1].kwargs if calls else None


class TestRetryableErrors:
    @pytest.mark.parametrize("exc", [
        http_error(503), http_error(502),
        urllib.error.URLError(ConnectionRefusedError("refused")),
        requests.exceptions.ConnectTimeout("connect timeout"),
    ])
    def test_retryable(self, exc):
        assert _is_retryable_launch_error(exc)

    @pytest.mark.parametrize("exc", [
        http_error(504), http_error(500), http_error(400),
        urllib.error.URLError(socket.timeout("timed out")),
        requests.exceptions.ReadTimeout("read timeout"),
        RuntimeError("Task chain 'TC1' is already running"),
    ])
    def test_not_retryable(self, exc):
        assert not _is_retryable_launch_error(exc)

    def test_wrapped_cause_is_inspected(self):
        try:
            try:
                raise http_error(503)
            except Exception as inner:
                raise RuntimeError("launch failed") from inner
        except RuntimeError as outer:
            assert _is_retryable_launch_error(outer)


class TestLaunchRetries:
    def test_503_is_retried_and_slot_kept(self, svc):
        svc._tc_exec.execute_async_dsp.side_effect = http_error(503)

        result = svc._fire(ENTRY["ID"], manual=False, entry=dict(ENTRY))

        assert result["status"] == "retrying"
        assert QUEUE_KEY in svc._running_taskchains  # later fires still queue behind it
        job = scheduled_retry(svc)
        assert job["kwargs"]["attempt"] == 2
        assert svc._repo.runs[-1]["status"] == "retrying"

    def test_queued_fire_waits_during_retries(self, svc):
        svc._tc_exec.execute_async_dsp.side_effect = http_error(503)
        svc._fire(ENTRY["ID"], manual=False, entry=dict(ENTRY))

        second = svc._fire("22222222-2222-2222-2222-222222222222", manual=False, entry=dict(ENTRY))

        assert second["status"] == "queued"

    def test_retry_success_reports_and_watches(self, svc):
        svc._tc_exec.execute_async_dsp.side_effect = [http_error(503), "SPACE1__123"]
        done = MagicMock()
        svc._fire(ENTRY["ID"], manual=False, entry=dict(ENTRY), on_retry_done=done)

        svc._retry_launch(**scheduled_retry(svc)["kwargs"])

        final = done.call_args.args[0]
        assert final["status"] == "success"
        assert len(final["attempts"]) == 2
        assert QUEUE_KEY in svc._running_taskchains  # held until the DSP run finishes
        assert any(str(c.kwargs.get("id", "")).startswith("tcwatch::")
                   for c in svc._scheduler.add_job.call_args_list)

    def test_gives_up_after_last_retry(self, svc):
        svc._tc_exec.execute_async_dsp.side_effect = http_error(503)
        done = MagicMock()
        svc._fire(ENTRY["ID"], manual=False, entry=dict(ENTRY), on_retry_done=done)

        for _ in ss._LAUNCH_RETRY_OFFSETS_SECONDS:
            svc._retry_launch(**scheduled_retry(svc)["kwargs"])

        final = done.call_args.args[0]
        assert final["status"] == "error"
        assert len(final["attempts"]) == 1 + len(ss._LAUNCH_RETRY_OFFSETS_SECONDS)
        assert QUEUE_KEY not in svc._running_taskchains  # slot freed
        assert svc._repo.runs[-1]["status"] == "error"
        assert svc._tc_exec.execute_async_dsp.call_count == 1 + len(ss._LAUNCH_RETRY_OFFSETS_SECONDS)

    def test_non_retryable_error_fails_immediately(self, svc):
        svc._tc_exec.execute_async_dsp.side_effect = http_error(504)

        result = svc._fire(ENTRY["ID"], manual=False, entry=dict(ENTRY))

        assert result["status"] == "error"
        assert scheduled_retry(svc) is None
        assert QUEUE_KEY not in svc._running_taskchains

    def test_manual_fire_is_not_retried(self, svc):
        svc._tc_exec.execute_async_dsp.side_effect = http_error(503)

        result = svc._fire(ENTRY["ID"], manual=True, entry=dict(ENTRY))

        assert result["status"] == "error"
        assert scheduled_retry(svc) is None


class TestJobSchedulerCallback:
    @pytest.fixture
    def client(self, svc):
        from src.routes import scheduler as sched_routes

        app = Flask(__name__)
        app.testing = True  # bypasses XSUAA validation
        app.register_blueprint(sched_routes.bp, url_prefix="/v1/scheduler")
        svc._job_scheduler = MagicMock()
        app.extensions["taskchain"] = {"scheduler_service": svc}
        return app.test_client()

    HEADERS = {"x-sap-job-id": "42", "x-sap-job-schedule-id": "sch-1", "x-sap-job-run-id": "run-1"}
    BODY = {"kind": "entry", "entry_id": ENTRY["ID"], "entry": ENTRY}

    def test_success_is_200(self, client, svc):
        svc._tc_exec.execute_async_dsp.return_value = "SPACE1__123"
        assert client.post("/v1/scheduler/jobscheduler-callback", json=self.BODY,
                           headers=self.HEADERS).status_code == 200

    def test_definitive_failure_is_500(self, client, svc):
        svc._tc_exec.execute_async_dsp.side_effect = http_error(504)
        assert client.post("/v1/scheduler/jobscheduler-callback", json=self.BODY,
                           headers=self.HEADERS).status_code == 500

    def test_retry_is_202_then_run_closed_with_outcome(self, client, svc):
        svc._tc_exec.execute_async_dsp.side_effect = [http_error(503), "SPACE1__123"]

        resp = client.post("/v1/scheduler/jobscheduler-callback", json=self.BODY, headers=self.HEADERS)
        assert resp.status_code == 202

        svc._retry_launch(**scheduled_retry(svc)["kwargs"])

        svc._job_scheduler.update_run_log.assert_called_once()
        call = svc._job_scheduler.update_run_log.call_args
        assert call.args[:3] == ("42", "sch-1", "run-1")
        assert call.kwargs["success"] is True
        assert "attempt 1" in call.kwargs["message"] and "attempt 2" in call.kwargs["message"]


class TestAdhocRunLinkedToEntry:
    def test_run_linked_to_given_entry(self, svc):
        svc._tc_exec.execute_async_dsp.return_value = "SPACE1__123"
        entry_id = "33333333-3333-3333-3333-333333333333"

        svc.run_adhoc("SPACE1", "TC1", None, "note", entry_id=entry_id)

        assert svc._repo.runs[-1]["schedule_entry_id"] == entry_id

    def test_run_without_entry_stays_unlinked(self, svc):
        svc._tc_exec.execute_async_dsp.return_value = "SPACE1__123"

        svc.run_adhoc("SPACE1", "TC1")

        assert svc._repo.runs[-1]["schedule_entry_id"] is None

    def test_route_rejects_non_uuid_entry_id(self, svc):
        from src.routes import scheduler as sched_routes

        app = Flask(__name__)
        app.testing = True
        app.register_blueprint(sched_routes.bp, url_prefix="/v1/scheduler")
        app.extensions["taskchain"] = {"scheduler_service": svc}

        resp = app.test_client().post("/v1/scheduler/run-now-adhoc", json={
            "spaceId": "SPACE1", "taskchain": "TC1", "entryId": "not-a-uuid"})

        assert resp.status_code == 400
        svc._tc_exec.execute_async_dsp.assert_not_called()
