"""Unit tests for JobSchedulerClient - all HTTP calls mocked, no real service needed."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from src.integrations.jobscheduler import JobSchedulerClient, JobSchedulerRateLimitError


def make_client() -> JobSchedulerClient:
    return JobSchedulerClient(
        service_url="https://jobscheduler-rest.example.com",
        uaa_url="https://example.authentication.sap.hana.ondemand.com",
        client_id="cid",
        client_secret="csec",
    )


def _resp(status_code=200, json_body=None, headers=None):
    r = MagicMock()
    r.status_code = status_code
    r.headers = headers or {}
    r.content = b"1" if json_body is not None else b""
    r.json.return_value = json_body if json_body is not None else {}

    def _raise():
        if status_code >= 400:
            raise Exception(f"HTTP {status_code}")

    r.raise_for_status.side_effect = _raise
    return r


class TestFromEnv:
    def test_parses_standard_plan_credentials(self, monkeypatch):
        vcap = {
            "jobscheduler": [
                {
                    "credentials": {
                        "url": "https://jobscheduler-rest.example.com",
                        "uaa": {
                            "url": "https://example.authentication.sap.hana.ondemand.com",
                            "clientid": "cid",
                            "clientsecret": "csec",
                        },
                    }
                }
            ]
        }
        monkeypatch.setenv("VCAP_SERVICES", json.dumps(vcap))
        client = JobSchedulerClient.from_env()
        assert client is not None
        assert client._service_url == "https://jobscheduler-rest.example.com"
        assert client._uaa_url == "https://example.authentication.sap.hana.ondemand.com"

    def test_none_when_not_bound(self, monkeypatch):
        monkeypatch.delenv("VCAP_SERVICES", raising=False)
        assert JobSchedulerClient.from_env() is None

    def test_none_when_credentials_incomplete(self, monkeypatch):
        # e.g. a lite-plan / x509 binding without clientsecret
        vcap = {"jobscheduler": [{"credentials": {"url": "https://x", "uaa": {"clientid": "cid"}}}]}
        monkeypatch.setenv("VCAP_SERVICES", json.dumps(vcap))
        assert JobSchedulerClient.from_env() is None


class TestTokenCaching:
    @patch("src.integrations.jobscheduler.client.requests.post")
    def test_fetches_and_caches_token(self, mock_post):
        mock_post.return_value = _resp(json_body={"access_token": "tok1", "expires_in": 3600})
        client = make_client()

        tok1 = client._ensure_token()
        tok2 = client._ensure_token()

        assert tok1 == "tok1"
        assert tok2 == "tok1"
        mock_post.assert_called_once()  # second call served from cache

    @patch("src.integrations.jobscheduler.client.requests.post")
    def test_refetches_after_expiry(self, mock_post, monkeypatch):
        mock_post.return_value = _resp(json_body={"access_token": "tok1", "expires_in": 3600})
        client = make_client()
        client._ensure_token()

        # Force the cached token to look expired.
        client._token_expiry = 0
        mock_post.return_value = _resp(json_body={"access_token": "tok2", "expires_in": 3600})
        tok2 = client._ensure_token()

        assert tok2 == "tok2"
        assert mock_post.call_count == 2


class TestFindOrCreateJob:
    @patch("src.integrations.jobscheduler.client.requests.request")
    @patch.object(JobSchedulerClient, "_ensure_token", return_value="tok")
    def test_reuses_existing_job_by_name(self, _tok, mock_req):
        mock_req.return_value = _resp(
            json_body={"total": 1, "results": [{"jobId": 42, "_id": 3, "name": "my-job"}]}
        )
        client = make_client()

        job_id = client.find_or_create_job("my-job", "desc", "https://app/callback")

        assert job_id == 42  # prefers jobId over _id
        # Only the lookup call was made - no POST to create.
        assert mock_req.call_count == 1
        assert mock_req.call_args.args[0] == "GET"

    @patch("src.integrations.jobscheduler.client.requests.request")
    @patch.object(JobSchedulerClient, "_ensure_token", return_value="tok")
    def test_creates_job_when_not_found(self, _tok, mock_req):
        mock_req.side_effect = [
            _resp(json_body={"total": 0, "results": []}),
            _resp(status_code=201, json_body={"jobId": 7, "name": "my-job"}),
        ]
        client = make_client()

        job_id = client.find_or_create_job("my-job", "desc", "https://app/callback")

        assert job_id == 7
        assert mock_req.call_count == 2
        assert mock_req.call_args_list[1].args[0] == "POST"

    @patch("src.integrations.jobscheduler.client.requests.request")
    @patch.object(JobSchedulerClient, "_ensure_token", return_value="tok")
    def test_second_call_is_served_from_cache(self, _tok, mock_req):
        mock_req.return_value = _resp(json_body={"total": 0, "results": []})
        client = make_client()
        client._job_id_cache["my-job"] = 99

        job_id = client.find_or_create_job("my-job", "desc", "https://app/callback")

        assert job_id == 99
        mock_req.assert_not_called()

    @patch("src.integrations.jobscheduler.client.requests.request")
    @patch.object(JobSchedulerClient, "_ensure_token", return_value="tok")
    def test_create_body_includes_required_schedules_array(self, _tok, mock_req):
        """Regression test: the live service rejects job creation with
        "Schedules must be an array" if this key is missing, even though we
        always add real schedules afterwards via create_schedule()."""
        mock_req.side_effect = [
            _resp(json_body={"total": 0, "results": []}),
            _resp(status_code=201, json_body={"jobId": 7, "name": "my-job"}),
        ]
        client = make_client()

        client.find_or_create_job("my-job", "desc", "https://app/callback")

        create_body = mock_req.call_args_list[1].kwargs["json"]
        assert create_body["schedules"] == []


class TestCreateSchedule:
    def test_rejects_zero_trigger_modes(self):
        client = make_client()
        with pytest.raises(ValueError):
            client.create_schedule(1, description="d", data={})

    def test_rejects_multiple_trigger_modes(self):
        client = make_client()
        with pytest.raises(ValueError):
            client.create_schedule(1, description="d", data={}, time_="now", cron="* * * * * * *")

    @patch("src.integrations.jobscheduler.client.requests.request")
    @patch.object(JobSchedulerClient, "_ensure_token", return_value="tok")
    def test_create_schedule_posts_expected_body(self, _tok, mock_req):
        mock_req.return_value = _resp(status_code=201, json_body={"scheduleId": "sched-1"})
        client = make_client()

        schedule_id = client.create_schedule(
            42, description="d", data={"foo": "bar"}, time_="2026-09-15T14:30:00+02:00"
        )

        assert schedule_id == "sched-1"
        method, url = mock_req.call_args.args
        assert method == "POST"
        assert url.endswith("/scheduler/jobs/42/schedules")
        body = mock_req.call_args.kwargs["json"]
        assert body["time"] == "2026-09-15T14:30:00+02:00"
        assert body["data"] == {"foo": "bar"}
        assert "cron" not in body


class TestDeleteSchedule:
    @patch("src.integrations.jobscheduler.client.requests.request")
    @patch.object(JobSchedulerClient, "_ensure_token", return_value="tok")
    def test_swallows_errors(self, _tok, mock_req):
        mock_req.side_effect = Exception("network down")
        client = make_client()

        client.delete_schedule(1, "sched-1")  # must not raise


class TestRateLimit:
    @patch("src.integrations.jobscheduler.client.requests.request")
    @patch.object(JobSchedulerClient, "_ensure_token", return_value="tok")
    def test_429_raises_rate_limit_error(self, _tok, mock_req):
        mock_req.return_value = _resp(status_code=429, headers={"retry-after": "7"})
        client = make_client()

        with pytest.raises(JobSchedulerRateLimitError) as exc_info:
            client.get_job_count()
        assert exc_info.value.retry_after == 7.0
