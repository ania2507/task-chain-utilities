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
from .routes.tasks import bp as tasks_bp
from .services import TaskchainExecutor, TaskchainRoutingService
from .services.job_executor import JobExecutor


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
            db_query_executor = repository
        else:
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
    ibp_host = os.environ.get("IBP_HOST", "").strip()
    ibp_user = os.environ.get("IBP_USER", "").strip()
    ibp_password = os.environ.get("IBP_PASSWORD", "").strip()
    if ibp_host and ibp_user and ibp_password:
        try:
            from .integrations.ibp import IBPJobClient

            verify = os.environ.get("IBP_VERIFY_SSL", "true").lower() != "false"
            client = IBPJobClient(ibp_host, ibp_user, ibp_password, verify_ssl=verify)
            executor.register_client(client)
            log.info("IBP integration registered (host=%s)", ibp_host)
        except Exception as e:
            log.warning("Failed to initialise IBP client: %s", e)
    else:
        log.info("IBP integration not configured (IBP_HOST/IBP_USER/IBP_PASSWORD missing)")

    # -- SAC --
    sac_host = os.environ.get("SAC_HOST", "").strip()
    sac_token_url = os.environ.get("SAC_TOKEN_URL", "").strip()
    sac_client_id = os.environ.get("SAC_CLIENT_ID", "").strip()
    sac_client_secret = os.environ.get("SAC_CLIENT_SECRET", "").strip()
    if sac_host and sac_token_url and sac_client_id and sac_client_secret:
        try:
            from .integrations.sac import SACJobClient
            from .integrations.sac.destination import DestinationClient

            verify = os.environ.get("SAC_VERIFY_SSL", "true").lower() != "false"

            # When SAC_DESTINATION_NAME is set, enable the BTP Destination
            # Service path for user-propagated tokens (SAML Bearer).
            # This is required for multi action execution.
            dest_client = DestinationClient.from_env()
            if dest_client:
                log.info("SAC Destination Service integration enabled (dest=%s)",
                         os.environ.get("SAC_DESTINATION_NAME"))
            else:
                log.info("SAC Destination Service not configured – using client_credentials only")

            client = SACJobClient(
                sac_host, sac_token_url, sac_client_id, sac_client_secret,
                destination_client=dest_client,
                verify_ssl=verify,
            )
            executor.register_client(client)
            log.info("SAC integration registered (host=%s)", sac_host)
        except Exception as e:
            log.warning("Failed to initialise SAC client: %s", e)
    else:
        log.info("SAC integration not configured (SAC_HOST/SAC_TOKEN_URL/SAC_CLIENT_ID/SAC_CLIENT_SECRET missing)")

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
    app.extensions["taskchain"] = {
        "repository": repository,
        "db_query_executor": db_query_executor,
        "engine": engine,
        "routing_service": routing_service,
        "taskchain_executor": taskchain_executor,
        "job_executor": job_executor,
    }

    app.register_blueprint(meta_bp)

    # Versioned API
    app.register_blueprint(rules_bp, url_prefix="/v1/rules")
    app.register_blueprint(tasks_bp, url_prefix="/v1/taskchains")
    app.register_blueprint(jobs_bp, url_prefix="/v1/jobs")
    app.register_blueprint(db_bp, url_prefix="/v1/db")
    app.register_blueprint(dsp_bp, url_prefix="/v1/dsp")

    return app
