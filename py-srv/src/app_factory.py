"""Flask application factory.

Keeps the entrypoint small and groups routes via Blueprints.
Also wires up repositories/services with safe local fallbacks.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, Tuple

from flask import Flask

from .config import Config
from .engine import RuleEngine
from .repository import DspHanaQueryExecutor, HanaRuleRepository, InMemoryRuleRepository
from .routes.db import bp as db_bp
from .routes.dsp import bp as dsp_bp
from .routes.jobs import bp as jobs_bp
from .routes.meta import bp as meta_bp
from .routes.rules import bp as rules_bp
from .routes.scheduler import bp as scheduler_bp
from .routes.tasks import bp as tasks_bp
from .services import TaskchainExecutor, TaskchainRoutingService
from .services.job_executor import JobExecutor
from .services.scheduler_service import SchedulerService
from .repository.schedule_repository import ScheduleRepository


def _init_components() -> Tuple[Any, Any, RuleEngine, TaskchainRoutingService, TaskchainExecutor]:
    """Initialize repositories/services with safe local fallbacks."""

    use_in_memory = os.environ.get("USE_IN_MEMORY_REPO", "false").lower() == "true"

    if use_in_memory:
        logging.getLogger(__name__).warning("Using InMemoryRuleRepository (USE_IN_MEMORY_REPO=true)")
        repository = InMemoryRuleRepository()
        db_query_executor = repository
    else:
        try:
            repository = HanaRuleRepository()
        except Exception as e:
            logging.getLogger(__name__).warning(
                "Falling back to InMemoryRuleRepository (HANA init failed): %s", e
            )
            repository = InMemoryRuleRepository()

        dsp_executor = DspHanaQueryExecutor()
        if Config.get_dsp_hana_credentials():
            logging.getLogger(__name__).info("Using DSP HANA for cross-schema db_query()")
            db_query_executor = dsp_executor
        else:
            logging.getLogger(__name__).info("DSP HANA not configured, using HDI container for db_query()")
            db_query_executor = repository

    engine = RuleEngine(db_query_func=getattr(db_query_executor, "query", None))
    routing_service = TaskchainRoutingService(repository, engine)
    taskchain_executor = TaskchainExecutor()
    return repository, db_query_executor, engine, routing_service, taskchain_executor


def _init_job_executor() -> JobExecutor:
    """Create a JobExecutor and register configured integration clients.

    Reads credentials from environment variables.  Missing credentials
    simply mean the corresponding integration is unavailable (not an error).
    """
    log = logging.getLogger(__name__)
    executor = JobExecutor()

    # -- IBP --
    try:
        from .integrations.ibp import IBPJobClient
        from .integrations.ibp.destination import IBPDestinationClient

        verify = os.environ.get("IBP_VERIFY_SSL", "true").lower() != "false"
        ibp_dest_name = os.environ.get("IBP_DESTINATION_NAME", "").strip()

        if ibp_dest_name:
            dest_client = IBPDestinationClient.from_env()
            if not dest_client:
                log.warning(
                    "IBP_DESTINATION_NAME is set (%s) but Destination Service credentials are missing",
                    ibp_dest_name,
                )
            else:
                conn = dest_client.get_connection()
                client = IBPJobClient(
                    host=conn["host"],
                    user=conn.get("user"),
                    password=conn.get("password"),
                    bearer_token=conn.get("access_token"),
                    verify_ssl=verify,
                )
                executor.register_client(client)
                log.info("IBP integration registered via Destination (dest=%s)", ibp_dest_name)
        else:
            ibp_host = os.environ.get("IBP_HOST", "").strip()
            ibp_user = os.environ.get("IBP_USER", "").strip()
            ibp_password = os.environ.get("IBP_PASSWORD", "").strip()
            if ibp_host and ibp_user and ibp_password:
                client = IBPJobClient(ibp_host, ibp_user, ibp_password, verify_ssl=verify)
                executor.register_client(client)
                log.info("IBP integration registered (legacy env mode, host=%s)", ibp_host)
            else:
                log.info(
                    "IBP integration not configured "
                    "(set IBP_DESTINATION_NAME or IBP_HOST/IBP_USER/IBP_PASSWORD)"
                )
    except Exception as e:
        log.warning("Failed to initialise IBP client: %s", e)

    # -- SAC --
    sac_host = os.environ.get("SAC_HOST", "").strip()
    sac_token_url = os.environ.get("SAC_TOKEN_URL", "").strip()
    sac_client_id = os.environ.get("SAC_CLIENT_ID", "").strip()
    sac_client_secret = os.environ.get("SAC_CLIENT_SECRET", "").strip()
    try:
        from .integrations.sac import SACJobClient
        from .integrations.sac.destination import DestinationClient

        verify = os.environ.get("SAC_VERIFY_SSL", "true").lower() != "false"

        # Prefer BTP Destination bootstrap when available. This supports
        # OAuth2SAMLBearerAssertion/SystemUser setups without legacy SAC_* vars.
        dest_client = DestinationClient.from_env()
        if dest_client:
            conn = dest_client.get_connection()
            client = SACJobClient(
                conn["host"], sac_token_url, sac_client_id, sac_client_secret,
                destination_client=dest_client,
                verify_ssl=verify,
            )
            executor.register_client(client)
            log.info(
                "SAC integration registered via Destination (dest=%s, host=%s)",
                os.environ.get("SAC_DESTINATION_NAME"),
                conn["host"],
            )
        elif sac_host and sac_token_url and sac_client_id and sac_client_secret:
            client = SACJobClient(
                sac_host, sac_token_url, sac_client_id, sac_client_secret,
                verify_ssl=verify,
            )
            executor.register_client(client)
            log.info("SAC integration registered (legacy env mode, host=%s)", sac_host)
        else:
            log.info(
                "SAC integration not configured "
                "(set SAC_DESTINATION_NAME or SAC_HOST/SAC_TOKEN_URL/SAC_CLIENT_ID/SAC_CLIENT_SECRET)"
            )
    except Exception as e:
        log.warning("Failed to initialise SAC client: %s", e)

    return executor


def create_app() -> Flask:
    app = Flask(__name__)

    logging.getLogger().setLevel(getattr(logging, Config.LOG_LEVEL, logging.INFO))

    # CORS for local CAP watch / UI5 dev.
    try:
        from flask_cors import CORS

        CORS(app, origins=["http://localhost:4004", "http://127.0.0.1:4004"])
    except Exception:
        # flask-cors is optional at runtime.
        pass

    repository, db_query_executor, engine, routing_service, taskchain_executor = _init_components()
    job_executor = _init_job_executor()

    # Scheduler service (APScheduler).  Safe to instantiate even if DB/APS unavailable;
    # `sync()` will simply load zero jobs.
    try:
        schedule_repo = ScheduleRepository()
        scheduler_service = SchedulerService(
            repo=schedule_repo,
            taskchain_executor=taskchain_executor,
            job_executor=job_executor,
            db_query_executor=db_query_executor,
        )
        try:
            scheduler_service.sync()
        except Exception:
            logging.getLogger(__name__).exception("Initial scheduler sync failed")
    except Exception as e:
        logging.getLogger(__name__).warning("SchedulerService init failed: %s", e)
        scheduler_service = None

    app.extensions["taskchain"] = {
        "repository": repository,
        "db_query_executor": db_query_executor,
        "engine": engine,
        "routing_service": routing_service,
        "taskchain_executor": taskchain_executor,
        "job_executor": job_executor,
        "scheduler_service": scheduler_service,
    }

    app.register_blueprint(meta_bp)

    # Versioned API
    app.register_blueprint(rules_bp, url_prefix="/v1/rules")
    app.register_blueprint(tasks_bp, url_prefix="/v1/taskchains")
    app.register_blueprint(jobs_bp, url_prefix="/v1/jobs")
    app.register_blueprint(db_bp, url_prefix="/v1/db")
    app.register_blueprint(dsp_bp, url_prefix="/v1/dsp")
    app.register_blueprint(scheduler_bp, url_prefix="/v1/scheduler")

    return app
