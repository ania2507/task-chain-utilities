"""Unit tests for SchedulerService's SAP Job Scheduling service integration.

Covers the two concrete bugs found by inspection (timezone-naive `time_`
string, non-JSON-serializable traffic light payload) so they can't regress,
plus the skip-if-already-linked and prune-orphaned-schedule logic. The HANA
repository and the Job Scheduling service HTTP client are both faked/mocked -
no real DB or network access needed.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from src.services.scheduler_service import SchedulerService


class FakeRepo:
    """Minimal stand-in for ScheduleRepository - only the methods
    SchedulerService actually calls."""

    def __init__(self):
        self.entries = []
        self.schedules = []
        self.entry_job_scheduler_ids = {}
        self.schedule_job_scheduler_ids = {}

    def list_active_entries(self):
        return list(self.entries)

    def list_active_schedules(self):
        return list(self.schedules)

    def list_entries_with_job_scheduler_id(self):
        return [
            {"ID": eid, "JOBSCHEDULERSCHEDULEID": sid}
            for eid, sid in self.entry_job_scheduler_ids.items()
            if sid
        ]

    def list_schedules_with_job_scheduler_id(self):
        return [
            {"ID": sid_key, "JOBSCHEDULERSCHEDULEID": sid}
            for sid_key, sid in self.schedule_job_scheduler_ids.items()
            if sid
        ]

    def set_entry_job_scheduler_id(self, entry_id, job_scheduler_schedule_id):
        self.entry_job_scheduler_ids[entry_id] = job_scheduler_schedule_id

    def set_schedule_job_scheduler_id(self, schedule_id, job_scheduler_schedule_id):
        self.schedule_job_scheduler_ids[schedule_id] = job_scheduler_schedule_id

    def get_schedule_job_scheduler_id(self, schedule_id):
        return self.schedule_job_scheduler_ids.get(schedule_id)

    def delete_schedule(self, schedule_id):
        self.schedules = [s for s in self.schedules if s.get("ID") != schedule_id]
        self.schedule_job_scheduler_ids.pop(schedule_id, None)


def make_service(job_scheduler_client=None):
    repo = FakeRepo()
    svc = SchedulerService(
        repo=repo,
        job_scheduler_client=job_scheduler_client,
        callback_base_url="https://myapp.example.com",
    )
    return svc, repo


def tomorrow_parts():
    d = date.today() + timedelta(days=1)
    return d.isoformat(), "14:30"


class TestRegisterEntriesTimeFormat:
    """Regression test for bug 1: a bare strftime() string silently drops the
    UTC offset, so the service can't tell which timezone the time is in."""

    def test_time_sent_to_job_scheduler_includes_utc_offset(self):
        mock_client = MagicMock()
        mock_client.find_or_create_job.return_value = 42
        mock_client.create_schedule.return_value = "sched-1"
        svc, repo = make_service(mock_client)

        run_date, run_time = tomorrow_parts()
        repo.entries = [{
            "ID": "e1", "spaceId": "SP1", "taskchain": "TC1",
            "runDate": run_date, "runTime": run_time, "timezone": "Europe/Rome",
            "active": True, "parameters": None, "details": None,
            "jobSchedulerScheduleId": None,
        }]

        svc._register_entries()

        assert mock_client.create_schedule.call_count == 1
        kwargs = mock_client.create_schedule.call_args.kwargs
        time_value = kwargs["time_"]
        # Must be a real ISO-8601 string with a UTC offset (+HH:MM or Z),
        # not a bare "YYYY-MM-DD HH:MM:SS" with no timezone information.
        parsed = datetime.fromisoformat(time_value)
        assert parsed.tzinfo is not None, (
            f"time_={time_value!r} has no timezone offset - the service "
            "can't disambiguate which zone this wall-clock time is in"
        )

    def test_skips_entry_already_linked_to_external_schedule(self):
        mock_client = MagicMock()
        svc, repo = make_service(mock_client)

        run_date, run_time = tomorrow_parts()
        repo.entries = [{
            "ID": "e1", "spaceId": "SP1", "taskchain": "TC1",
            "runDate": run_date, "runTime": run_time, "timezone": "Europe/Rome",
            "active": True, "parameters": None, "details": None,
            "jobSchedulerScheduleId": "already-there",
        }]

        svc._register_entries()

        mock_client.create_schedule.assert_not_called()

    def test_past_due_entry_is_not_touched(self):
        mock_client = MagicMock()
        svc, repo = make_service(mock_client)

        yesterday = (date.today() - timedelta(days=1)).isoformat()
        repo.entries = [{
            "ID": "e1", "spaceId": "SP1", "taskchain": "TC1",
            "runDate": yesterday, "runTime": "00:00", "timezone": "Europe/Rome",
            "active": True, "parameters": None, "details": None,
            "jobSchedulerScheduleId": None,
        }]

        count, valid_ids = svc._register_entries()

        mock_client.create_schedule.assert_not_called()
        assert "entry::e1" in valid_ids  # still protected from pruning


class TestRegisterTrafficLightPayload:
    """Regression test for bug 2: the raw repo row can carry datetime objects
    (nextRunAt/lastRunAt) that requests/json can't serialize."""

    def test_payload_is_json_serializable_even_with_datetime_fields(self):
        mock_client = MagicMock()
        mock_client.find_or_create_job.return_value = 99
        mock_client.create_schedule.return_value = "tl-sched-1"
        svc, repo = make_service(mock_client)

        repo.schedules = [{
            "ID": "s1", "name": "TL 1", "spaceId": "SP1", "taskchain": "TC1",
            "parameters": json.dumps({"checkInterval": 15}),
            "isActive": True,
            # These are the fields that were raw datetime objects coming
            # straight off the HANA cursor in the real repository.
            "nextRunAt": datetime.now(timezone.utc),
            "lastRunAt": datetime.now(timezone.utc),
            "lastRunStatus": "triggered",
            "jobSchedulerScheduleId": None,
        }]

        svc._register_traffic_light_schedules()

        assert mock_client.create_schedule.call_count == 1
        data = mock_client.create_schedule.call_args.kwargs["data"]
        json.dumps(data)  # must not raise TypeError

    def test_check_interval_below_5_minutes_is_clamped(self):
        mock_client = MagicMock()
        mock_client.find_or_create_job.return_value = 99
        mock_client.create_schedule.return_value = "tl-sched-1"
        svc, repo = make_service(mock_client)

        repo.schedules = [{
            "ID": "s1", "spaceId": "SP1", "taskchain": "TC1",
            "parameters": json.dumps({"checkInterval": 2}),
            "isActive": True, "nextRunAt": None, "lastRunAt": None,
            "jobSchedulerScheduleId": None,
        }]

        svc._register_traffic_light_schedules()

        kwargs = mock_client.create_schedule.call_args.kwargs
        assert kwargs["repeat_interval"] == "5 minutes"

    def test_skips_schedule_already_linked_to_external_schedule(self):
        mock_client = MagicMock()
        svc, repo = make_service(mock_client)

        repo.schedules = [{
            "ID": "s1", "spaceId": "SP1", "taskchain": "TC1",
            "parameters": "{}", "isActive": True,
            "nextRunAt": None, "lastRunAt": None,
            "jobSchedulerScheduleId": "already-there",
        }]

        svc._register_traffic_light_schedules()

        mock_client.create_schedule.assert_not_called()


class TestFallbackWithoutJobScheduler:
    def test_uses_apscheduler_when_no_client_configured(self):
        svc, repo = make_service(job_scheduler_client=None)
        run_date, run_time = tomorrow_parts()
        repo.entries = [{
            "ID": "e1", "spaceId": "SP1", "taskchain": "TC1",
            "runDate": run_date, "runTime": run_time, "timezone": "Europe/Rome",
            "active": True, "parameters": None, "details": None,
            "jobSchedulerScheduleId": None,
        }]

        count, valid_ids = svc._register_entries()

        assert count == 1
        assert svc._scheduler.get_job("entry::e1") is not None
        svc.shutdown()


class TestPruneOrphanedExternalSchedules:
    def test_deletes_external_schedule_for_deactivated_entry(self):
        mock_client = MagicMock()
        mock_client.find_or_create_job.return_value = 42
        svc, repo = make_service(mock_client)

        # Row no longer active -> not in list_active_entries(), but the
        # external schedule link from before is still recorded.
        repo.entry_job_scheduler_ids["e1"] = "stale-sched-1"

        svc._prune_orphaned_job_scheduler_entries(valid_entry_ids=set())

        mock_client.delete_schedule.assert_called_once_with(42, "stale-sched-1")
        assert repo.entry_job_scheduler_ids["e1"] is None

    def test_leaves_still_valid_entry_alone(self):
        mock_client = MagicMock()
        mock_client.find_or_create_job.return_value = 42
        svc, repo = make_service(mock_client)

        repo.entry_job_scheduler_ids["e1"] = "sched-1"

        svc._prune_orphaned_job_scheduler_entries(valid_entry_ids={"entry::e1"})

        mock_client.delete_schedule.assert_not_called()
        assert repo.entry_job_scheduler_ids["e1"] == "sched-1"


class TestAfterRunPolicyExternalCleanup:
    """Regression test: _apply_after_run_policy() deletes the Schedule row
    directly from py-srv (not through the CAP layer), so srv/schedules.js's
    before/after DELETE hooks never fire for it - without an explicit cleanup
    call here, a traffic light with auto-reset disabled would leave its
    external schedule orphaned, ticking forever after the row is gone."""

    def test_deletes_external_schedule_when_auto_reset_disabled(self):
        mock_client = MagicMock()
        mock_client.find_or_create_job.return_value = 99
        svc, repo = make_service(mock_client)

        repo.schedule_job_scheduler_ids["s1"] = "tl-sched-1"

        svc._apply_after_run_policy("s1", "SP1", "TC1", auto_reset=False, reset_state="GREEN")

        mock_client.delete_schedule.assert_called_once_with(99, "tl-sched-1")
        assert repo.get_schedule_job_scheduler_id("s1") is None

    def test_does_not_touch_external_schedule_when_auto_reset_enabled(self):
        mock_client = MagicMock()
        svc, repo = make_service(mock_client)

        repo.schedule_job_scheduler_ids["s1"] = "tl-sched-1"

        svc._apply_after_run_policy("s1", "SP1", "TC1", auto_reset=True, reset_state="GREEN")

        mock_client.delete_schedule.assert_not_called()
        assert repo.get_schedule_job_scheduler_id("s1") == "tl-sched-1"

    def test_no_op_when_row_was_never_linked_externally(self):
        mock_client = MagicMock()
        svc, repo = make_service(mock_client)

        svc._apply_after_run_policy("s1", "SP1", "TC1", auto_reset=False, reset_state="GREEN")

        mock_client.delete_schedule.assert_not_called()
