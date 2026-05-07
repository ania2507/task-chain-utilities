"""Configuration helpers for Cloud Foundry / HANA / DSP HANA."""

from __future__ import annotations

import json
import logging
import os

from dotenv import load_dotenv


load_dotenv()
logger = logging.getLogger(__name__)


class Config:
    """Application configuration loaded from env vars / VCAP_SERVICES."""

    APP_PORT = int(os.environ.get("PORT", 8080))
    DEBUG = os.environ.get("DEBUG", "false").lower() == "true"
    LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

    HANA_SERVICE_INSTANCE_NAME = os.environ.get("HANA_SERVICE_INSTANCE_NAME", "task-chain-utilities-db")
    DSP_HANA_SERVICE_NAME = os.environ.get("DSP_HANA_SERVICE_NAME", "dsp-hana")
    DSP_SERVICE_NAME = os.environ.get("DSP_SERVICE_NAME", "dsp-credentials")

    HANA_HOST = os.environ.get("HANA_HOST", "localhost")
    HANA_PORT = int(os.environ.get("HANA_PORT", 443))
    HANA_USER = os.environ.get("HANA_USER", "")
    HANA_PASSWORD = os.environ.get("HANA_PASSWORD", "")
    HANA_ENCRYPT = os.environ.get("HANA_ENCRYPT", "true").lower() == "true"
    HANA_SCHEMA = os.environ.get("HANA_SCHEMA", "")

    DSP_HANA_HOST = os.environ.get("DSP_HANA_HOST", "")
    DSP_HANA_PORT = int(os.environ.get("DSP_HANA_PORT", 443))
    DSP_HANA_USER = os.environ.get("DSP_HANA_USER", "")
    DSP_HANA_PASSWORD = os.environ.get("DSP_HANA_PASSWORD", "")


    @classmethod
    def get_dsp_hana_credentials(cls) -> dict | None:
        vcap_services = os.environ.get("VCAP_SERVICES")
        if vcap_services:
            try:
                services = json.loads(vcap_services)
                if "user-provided" in services:
                    for instance in services["user-provided"]:
                        if instance.get("name") == cls.DSP_HANA_SERVICE_NAME:
                            creds = instance.get("credentials", {})
                            return {
                                "host": creds.get("host"),
                                "port": int(creds.get("port", 443)),
                                "user": creds.get("user"),
                                "password": creds.get("password"),
                                "encrypt": True,
                                "schema": None,
                            }
            except json.JSONDecodeError as e:
                logger.error("Failed to parse VCAP_SERVICES for DSP HANA: %s", e)

        if cls.DSP_HANA_HOST and cls.DSP_HANA_USER:
            return {
                "host": cls.DSP_HANA_HOST,
                "port": cls.DSP_HANA_PORT,
                "user": cls.DSP_HANA_USER,
                "password": cls.DSP_HANA_PASSWORD,
                "encrypt": True,
                "schema": None,
            }

        return None

    @classmethod
    def get_hana_credentials(cls) -> dict:
        vcap_services = os.environ.get("VCAP_SERVICES")
        if vcap_services:
            try:
                services = json.loads(vcap_services)
                candidates: list[dict] = []
                for service_type in ["hana", "hana-cloud", "hanatrial"]:
                    for instance in services.get(service_type, []) or []:
                        candidates.append(
                            {
                                "type": service_type,
                                "name": instance.get("name", ""),
                                "credentials": instance.get("credentials", {}) or {},
                            }
                        )

                if candidates:
                    if cls.HANA_SERVICE_INSTANCE_NAME:
                        for c in candidates:
                            if c["name"] == cls.HANA_SERVICE_INSTANCE_NAME:
                                hana_creds = c["credentials"]
                                logger.info(
                                    "Using HANA service instance '%s' (type=%s)", c["name"], c["type"]
                                )
                                return {
                                    "host": hana_creds.get("host", cls.HANA_HOST),
                                    "port": int(hana_creds.get("port", cls.HANA_PORT)),
                                    "user": hana_creds.get("user", cls.HANA_USER),
                                    "password": hana_creds.get("password", cls.HANA_PASSWORD),
                                    "encrypt": hana_creds.get("encrypt", cls.HANA_ENCRYPT),
                                    "schema": hana_creds.get("schema", cls.HANA_SCHEMA),
                                }

                    if len(candidates) == 1:
                        c = candidates[0]
                        hana_creds = c["credentials"]
                        logger.info(
                            "Using sole bound HANA service instance '%s' (type=%s)", c["name"], c["type"]
                        )
                        return {
                            "host": hana_creds.get("host", cls.HANA_HOST),
                            "port": int(hana_creds.get("port", cls.HANA_PORT)),
                            "user": hana_creds.get("user", cls.HANA_USER),
                            "password": hana_creds.get("password", cls.HANA_PASSWORD),
                            "encrypt": hana_creds.get("encrypt", cls.HANA_ENCRYPT),
                            "schema": hana_creds.get("schema", cls.HANA_SCHEMA),
                        }

                    names = ", ".join(
                        [f"{c['name']}[{c['type']}]" for c in candidates if c.get("name")]
                    )
                    raise RuntimeError(
                        "Multiple HANA services are bound to this app; cannot choose deterministically. "
                        f"Set HANA_SERVICE_INSTANCE_NAME to the HDI container service instance name. Found: {names}"
                    )
            except json.JSONDecodeError as e:
                logger.error("Failed to parse VCAP_SERVICES: %s", e)

        return {
            "host": cls.HANA_HOST,
            "port": cls.HANA_PORT,
            "user": cls.HANA_USER,
            "password": cls.HANA_PASSWORD,
            "encrypt": cls.HANA_ENCRYPT,
            "schema": cls.HANA_SCHEMA,
        }
