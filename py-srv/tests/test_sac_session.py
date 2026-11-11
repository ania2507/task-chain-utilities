"""Unit tests for the SAC client's caller-identity handling.

Regression tests for the nightly 403s on multi action launches: a JWT set by
the "Load Parameters" probe thread used to stick on the shared SAC session
forever and win over the JWT of the actual caller (e.g. the DSP API task),
and every caller shared one HTTP session / SAC token / CSRF token.
No network access: the Destination Service client is faked.
"""

from __future__ import annotations

import threading
from unittest.mock import MagicMock

import pytest
from flask import Flask

from src.integrations.sac.client import SACJobClient, _SACSession


class FakeDestination:
    """Returns a distinct SAC token per caller JWT and counts exchanges."""

    def __init__(self):
        self.calls = []

    def get_sac_token(self, user_jwt):
        self.calls.append(user_jwt)
        return {"access_token": f"sac-token-for-{user_jwt}", "expires_in": 3600}


@pytest.fixture
def app():
    return Flask(__name__)


def make_session(dest=None):
    return _SACSession(
        "https://sac.example.com", "https://uaa.example.com/oauth/token", "cid", "secret",
        destination_client=dest or FakeDestination(),
    )


def bearer(jwt):
    return {"Authorization": f"Bearer {jwt}"}


class TestCallerJwtPrecedence:
    def test_request_jwt_wins_over_thread_override(self, app):
        sac = make_session()
        sac.set_user_jwt("probe-user-jwt")
        with app.test_request_context(headers=bearer("dsp-caller-jwt")):
            assert sac.current_user_jwt() == "dsp-caller-jwt"

    def test_override_used_only_without_request_token(self):
        sac = make_session()
        sac.set_user_jwt("probe-user-jwt")
        assert sac.current_user_jwt() == "probe-user-jwt"

    def test_override_is_thread_local(self):
        sac = make_session()
        seen = {}

        def probe_thread():
            sac.set_user_jwt("probe-user-jwt")
            seen["inside"] = sac.current_user_jwt()

        t = threading.Thread(target=probe_thread)
        t.start()
        t.join()

        assert seen["inside"] == "probe-user-jwt"
        assert sac.current_user_jwt() is None

    def test_probe_clears_its_jwt_when_done(self):
        client = SACJobClient(
            "https://sac.example.com", "https://uaa.example.com/oauth/token", "cid", "secret",
            destination_client=FakeDestination(),
        )
        client._probe_multiaction_parameters = MagicMock(side_effect=RuntimeError("boom"))
        client._probe_running.add("t.X:1")

        client._run_probe_background("t.X:1", "probe-user-jwt")

        assert client._sac.current_user_jwt() is None
        assert "t.X:1" not in client._probe_running


class TestPerUserSessions:
    def test_each_caller_gets_its_own_session_and_token(self, app):
        dest = FakeDestination()
        sac = make_session(dest)

        with app.test_request_context(headers=bearer("user-a")):
            us_a, _ = sac._user_session()
            token_a = sac._ensure_access_token()
        with app.test_request_context(headers=bearer("user-b")):
            us_b, _ = sac._user_session()
            token_b = sac._ensure_access_token()

        assert us_a is not us_b
        assert us_a.session is not us_b.session
        assert token_a == "sac-token-for-user-a"
        assert token_b == "sac-token-for-user-b"

    def test_token_cached_per_caller_and_not_swapped_back_and_forth(self, app):
        dest = FakeDestination()
        sac = make_session(dest)

        for jwt in ("user-a", "user-b", "user-a", "user-b"):
            with app.test_request_context(headers=bearer(jwt)):
                sac._ensure_access_token()

        # One exchange per caller - switching users no longer throws away the
        # other user's token (and with it its SAC session).
        assert dest.calls == ["user-a", "user-b"]

    def test_csrf_token_not_shared_between_callers(self, app):
        sac = make_session()
        with app.test_request_context(headers=bearer("user-a")):
            us_a, _ = sac._user_session()
            us_a.csrf_token = "csrf-of-a"
        with app.test_request_context(headers=bearer("user-b")):
            us_b, _ = sac._user_session()

        assert us_b.csrf_token is None

    def test_destination_mode_without_any_jwt_still_fails_clearly(self):
        sac = make_session()
        with pytest.raises(RuntimeError, match="authenticated user context"):
            sac._ensure_access_token()


class TestCsrfFetchRetry:
    """SAC sometimes answers the CSRF request without a token (it didn't accept
    the session cookies). Only that request is retried, once, on clean cookies."""

    def _resp(self, token):
        r = MagicMock()
        r.status_code = 200
        r.headers = {"x-csrf-token": token} if token else {"content-type": "text/html"}
        r.raise_for_status.return_value = None
        return r

    def _user_session(self, app, responses):
        sac = make_session()
        with app.test_request_context(headers=bearer("dsp-caller-jwt")):
            us, _ = sac._user_session()
        us.session = MagicMock()
        us.session.get.side_effect = responses
        return sac, us

    def test_retries_once_on_clean_cookies(self, app):
        sac, us = self._user_session(app, [self._resp(None), self._resp("tok-2")])

        assert sac._fetch_csrf(us) == "tok-2"
        assert us.session.get.call_count == 2
        us.session.cookies.clear.assert_called_once()

    def test_gives_up_after_second_attempt(self, app):
        sac, us = self._user_session(app, [self._resp(None), self._resp(None)])

        with pytest.raises(RuntimeError, match="failed to obtain CSRF token"):
            sac._fetch_csrf(us)
        assert us.session.get.call_count == 2


class TestSacStatusPollTolerance:
    """A failed status read must not fail the DSP step while the multi action
    is still running in SAC - only a real SAC failure, or reads failing for
    longer than the grace period, may."""

    @pytest.fixture
    def client_and_executor(self):
        from src.routes import jobs as jobs_routes

        app = Flask(__name__)
        app.testing = True  # bypasses XSUAA validation in flask_access_validation
        app.register_blueprint(jobs_routes.bp, url_prefix="/v1/jobs")
        executor = MagicMock()
        app.extensions["taskchain"] = {"job_executor": executor}
        jobs_routes._poll_error_since.clear()
        yield app.test_client(), executor, jobs_routes
        jobs_routes._poll_error_since.clear()

    def test_transient_error_reported_as_still_running(self, client_and_executor):
        client, executor, _ = client_and_executor
        executor.get_status.side_effect = RuntimeError("SAC timeout")

        resp = client.get("/v1/jobs/sac__abc")

        assert resp.status_code == 202
        assert resp.get_json()["status"] == "UNKNOWN"

    def test_fails_once_errors_outlast_grace_period(self, client_and_executor):
        client, executor, jobs_routes = client_and_executor
        executor.get_status.side_effect = RuntimeError("SAC timeout")
        jobs_routes._poll_error_since["sac__abc"] = (
            __import__("time").time() - jobs_routes._POLL_ERROR_GRACE_SECONDS - 1
        )

        assert client.get("/v1/jobs/sac__abc").status_code == 500

    def test_success_resets_the_error_streak(self, client_and_executor):
        client, executor, jobs_routes = client_and_executor
        executor.get_status.side_effect = RuntimeError("SAC timeout")
        client.get("/v1/jobs/sac__abc")
        assert "sac__abc" in jobs_routes._poll_error_since

        executor.get_status.side_effect = None
        executor.get_status.return_value = {"status": "RUNNING"}
        assert client.get("/v1/jobs/sac__abc").status_code == 202
        assert "sac__abc" not in jobs_routes._poll_error_since

    def test_real_sac_failure_still_fails_immediately(self, client_and_executor):
        client, executor, _ = client_and_executor
        executor.get_status.return_value = {"status": "FAILED"}

        assert client.get("/v1/jobs/sac__abc").status_code == 500

    def test_ibp_transient_error_reported_as_still_running(self, client_and_executor):
        client, executor, _ = client_and_executor
        executor.get_status.side_effect = RuntimeError("IBP timeout")

        resp = client.get("/v1/jobs/ibp__abc")

        assert resp.status_code == 202
        assert resp.get_json()["status"] == "UNKNOWN"

    def test_ibp_fails_once_errors_outlast_grace_period(self, client_and_executor):
        client, executor, jobs_routes = client_and_executor
        executor.get_status.side_effect = RuntimeError("IBP timeout")
        jobs_routes._poll_error_since["ibp__abc"] = (
            __import__("time").time() - jobs_routes._POLL_ERROR_GRACE_SECONDS - 1
        )

        assert client.get("/v1/jobs/ibp__abc").status_code == 500

    def test_real_ibp_failure_still_fails_immediately(self, client_and_executor):
        client, executor, _ = client_and_executor
        executor.get_status.return_value = {"status": "FAILED", "steps": []}

        assert client.get("/v1/jobs/ibp__abc").status_code == 500

    def test_other_integrations_unchanged(self, client_and_executor):
        client, executor, _ = client_and_executor
        executor.get_status.side_effect = RuntimeError("timeout")

        assert client.get("/v1/jobs/dsp__abc").status_code == 500


class TestProbeNeedsExplicitConfirmation:
    """Discovering parameters by launching the multi action (a real SAC
    execution) must only happen when the caller explicitly allows it."""

    def _client(self, monkeypatch):
        client = SACJobClient(
            "https://sac.example.com", "https://uaa.example.com/oauth/token", "cid", "secret",
            destination_client=FakeDestination(),
        )
        # Every side-effect-free read finds nothing (SAC answers 404).
        monkeypatch.setattr(client._sac, "get", MagicMock(side_effect=RuntimeError("404 Client Error: Not Found")))
        client._probe_cache.clear()
        client._probe_running.clear()
        return client

    def test_no_probe_without_explicit_permission(self, app, monkeypatch):
        client = self._client(monkeypatch)
        started = MagicMock()
        monkeypatch.setattr("src.integrations.sac.client.threading.Thread", started)

        with app.test_request_context(headers=bearer("user-a")):
            result = client.get_multiaction_definition("t.X:1")

        assert result == {"parameters": [], "probeRequired": True}
        started.assert_not_called()
        assert "t.X:1" not in client._probe_running

    def test_probe_started_when_explicitly_allowed(self, app, monkeypatch):
        client = self._client(monkeypatch)
        started = MagicMock()
        monkeypatch.setattr("src.integrations.sac.client.threading.Thread", started)

        with app.test_request_context(headers=bearer("user-a")):
            result = client.get_multiaction_definition("t.X:1", allow_probe=True)

        assert result == {"probing": True}
        started.assert_called_once()
        client._probe_running.discard("t.X:1")
