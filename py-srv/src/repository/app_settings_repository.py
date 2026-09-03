"""App settings repository - reads the generic key/value config table on the
HDI container (table generated from CDS namespace `conditional.app.settings`,
entity `AppSetting`: CONDITIONAL_APP_SETTINGS_APPSETTING).

Read-only: rows are written directly against HANA (e.g. via HANA Cockpit/
DBeaver), not through this app.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

from src.config import Config

from ._hana_connect import connect_with_retry

logger = logging.getLogger(__name__)

APP_SETTING_TBL = "CONDITIONAL_APP_SETTINGS_APPSETTING"


class AppSettingsRepository:
    """Thin HANA repository for the AppSetting key/value table.

    Falls back to returning None for every lookup if hdbcli or credentials
    are missing, so local `cds watch` without HANA still works - callers are
    expected to have a sensible fallback (env var, hardcoded default) for
    that case.
    """

    def __init__(self, credentials: dict | None = None):
        self._credentials = credentials
        self._use_mem = False

        if os.environ.get("USE_IN_MEMORY_REPO", "false").lower() == "true":
            self._use_mem = True
            return

        if not self._credentials:
            try:
                self._credentials = Config.get_hana_credentials()
                if not self._credentials or self._credentials.get("host") in (None, "", "localhost"):
                    self._use_mem = True
            except Exception as e:
                logger.warning("AppSettingsRepository: HANA credentials unavailable (%s) - disabled", e)
                self._use_mem = True

        if not self._use_mem:
            try:
                from hdbcli import dbapi  # noqa: F401
            except Exception as e:
                logger.warning("AppSettingsRepository: hdbcli not installed (%s) - disabled", e)
                self._use_mem = True

    def _conn(self):
        from hdbcli import dbapi  # type: ignore
        c = self._credentials
        params = {
            "address": c["host"],
            "port": int(c["port"]),
            "user": c["user"],
            "password": c["password"],
            "encrypt": c.get("encrypt", True),
        }
        if c.get("schema"):
            params["currentschema"] = c["schema"]
        return connect_with_retry(lambda: dbapi.connect(**params))

    def get(self, name: str) -> Optional[str]:
        """Return the `value` column for the row with this setting name, or
        None if not found (or the table/HANA isn't reachable)."""
        if self._use_mem:
            return None
        conn = self._conn()
        try:
            cur = conn.cursor()
            cur.execute(f"SELECT VALUE FROM {APP_SETTING_TBL} WHERE NAME = ?", (name,))
            row = cur.fetchone()
            cur.close()
            return row[0] if row else None
        except Exception as e:
            logger.warning("AppSettingsRepository.get(%s) failed: %s", name, e)
            return None
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def list_all(self) -> List[Dict[str, Any]]:
        """Return every row as a plain dict, JSON-ready."""
        if self._use_mem:
            return []
        conn = self._conn()
        try:
            cur = conn.cursor()
            cur.execute(f"SELECT NAME, VALUE, DESCRIPTION FROM {APP_SETTING_TBL} ORDER BY NAME")
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
            cur.close()
            return [
                {"name": r["NAME"], "value": r["VALUE"], "description": r["DESCRIPTION"]}
                for r in rows
            ]
        except Exception as e:
            logger.warning("AppSettingsRepository.list_all() failed: %s", e)
            return []
        finally:
            try:
                conn.close()
            except Exception:
                pass
