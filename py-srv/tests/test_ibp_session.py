"""Unit tests for the IBP OData session's CSRF token handling.

IBP may answer the CSRF request without a token (it didn't accept the session
cookies). Only that request is retried, once, on clean cookies - never the
job launch itself. No network access: the HTTP session is mocked.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from src.integrations.ibp.client import _ODataSession


def _resp(token):
    r = MagicMock()
    r.status_code = 200
    r.headers = {"x-csrf-token": token} if token else {"content-type": "text/html"}
    r.raise_for_status.return_value = None
    return r


def make_session(responses):
    s = _ODataSession("https://ibp.example.com", bearer_token="tok")
    s._session = MagicMock()
    s._session.get.side_effect = responses
    return s


def test_retries_once_on_clean_cookies():
    s = make_session([_resp(None), _resp("csrf-2")])

    assert s._fetch_csrf() == "csrf-2"
    assert s._session.get.call_count == 2
    s._session.cookies.clear.assert_called_once()


def test_first_token_used_without_retry():
    s = make_session([_resp("csrf-1")])

    assert s._fetch_csrf() == "csrf-1"
    assert s._session.get.call_count == 1
    s._session.cookies.clear.assert_not_called()


def test_gives_up_after_second_attempt():
    s = make_session([_resp(None), _resp(None)])

    with pytest.raises(RuntimeError, match="failed to obtain CSRF token"):
        s._fetch_csrf()
    assert s._session.get.call_count == 2


def test_launch_post_is_not_repeated_when_csrf_fails():
    s = make_session([_resp(None), _resp(None)])

    with pytest.raises(RuntimeError):
        s.post("JobSchedule", params={"x": "1"})
    s._session.post.assert_not_called()


def test_status_read_uses_short_timeout():
    from src.integrations.ibp import client as ibp_client
    from src.integrations.base import IntegrationType, JobReference

    c = ibp_client.IBPJobClient("https://ibp.example.com", bearer_token="tok")
    resp = MagicMock()
    resp.json.return_value = {"d": {"JobStatus": "R", "JobStepSet": {"results": []}}}
    c._odata.get = MagicMock(return_value=resp)

    try:
        c.get_job_status(JobReference(integration_type=IntegrationType.IBP, remote_id="JOB1:RUN1"))
    except Exception:
        pass  # only the read's timeout matters here

    assert c._odata.get.call_args.kwargs["timeout"] == ibp_client._STATUS_READ_TIMEOUT_SECONDS
    assert ibp_client._STATUS_READ_TIMEOUT_SECONDS < 60
