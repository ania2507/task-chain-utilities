"""Schedule repository - reads/writes Schedule + ScheduleRun on the HDI container.

Tables (generated from CDS namespace `conditional.app.schedules`):
  - CONDITIONAL_APP_SCHEDULES_SCHEDULE
  - CONDITIONAL_APP_SCHEDULES_SCHEDULERUN
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List, Optional

from src.config import Config

logger = logging.getLogger(__name__)


SCHEDULE_TBL = "CONDITIONAL_APP_SCHEDULES_SCHEDULE"
RUN_TBL = "CONDITIONAL_APP_SCHEDULES_SCHEDULERUN"


class ScheduleRepository:
    """Thin HANA repository for Schedule / ScheduleRun.

    Falls back to a no-op in-memory store if hdbcli or credentials are missing,
    so local `cds watch` without HANA still works.
    """

    def __init__(self, credentials: dict | None = None):
        self._credentials = credentials
        self._mem_schedules: Dict[str, Dict[str, Any]] = {}
        self._mem_runs: List[Dict[str, Any]] = []
        self._use_mem = False

        import os
        if os.environ.get("USE_IN_MEMORY_REPO", "false").lower() == "true":
            logger.info("ScheduleRepository: USE_IN_MEMORY_REPO=true - using in-memory store")
            self._use_mem = True
            return

        if not self._credentials:
            try:
                self._credentials = Config.get_hana_credentials()
                # Defensive: reject obvious unbound defaults
                if not self._credentials or self._credentials.get("host") in (None, "", "localhost"):
                    logger.warning("ScheduleRepository: no real HANA binding - using in-memory")
                    self._use_mem = True
            except Exception as e:
                logger.warning("ScheduleRepository: HANA credentials unavailable (%s) - using in-memory", e)
                self._use_mem = True

        if not self._use_mem:
            try:
                from hdbcli import dbapi  # noqa: F401
            except Exception as e:
                logger.warning("ScheduleRepository: hdbcli not installed (%s) - using in-memory", e)
                self._use_mem = True

    # ------------------------------------------------------------------
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
        return dbapi.connect(**params)

    # ------------------------------------------------------------------
    def list_active(self) -> List[Dict[str, Any]]:
        if self._use_mem:
            return [s for s in self._mem_schedules.values() if s.get("isActive")]
        sql = (
            f"SELECT ID, NAME, TARGETTYPE, SPACEID, TASKCHAIN, JOBTEMPLATE, "
            f"PARAMETERS, CRONEXPRESSION, TIMEZONE, ISACTIVE "
            f"FROM {SCHEDULE_TBL} WHERE ISACTIVE = TRUE"
        )
        conn = self._conn()
        try:
            cur = conn.cursor()
            cur.execute(sql)
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
            cur.close()
            return [_row_to_schedule(r) for r in rows]
        finally:
            conn.close()

    def get(self, schedule_id: str) -> Optional[Dict[str, Any]]:
        if self._use_mem:
            return self._mem_schedules.get(schedule_id)
        sql = (
            f"SELECT ID, NAME, TARGETTYPE, SPACEID, TASKCHAIN, JOBTEMPLATE, "
            f"PARAMETERS, CRONEXPRESSION, TIMEZONE, ISACTIVE "
            f"FROM {SCHEDULE_TBL} WHERE ID = ?"
        )
        conn = self._conn()
        try:
            cur = conn.cursor()
            cur.execute(sql, (schedule_id,))
            row = cur.fetchone()
            if not row:
                return None
            cols = [d[0] for d in cur.description]
            cur.close()
            return _row_to_schedule(dict(zip(cols, row)))
        finally:
            conn.close()

    def update_run_state(
        self,
        schedule_id: str,
        last_run_at: Optional[str],
        last_run_status: Optional[str],
        next_run_at: Optional[str],
    ) -> None:
        if self._use_mem:
            s = self._mem_schedules.get(schedule_id)
            if s:
                s["lastRunAt"] = last_run_at
                s["lastRunStatus"] = last_run_status
                s["nextRunAt"] = next_run_at
            return
        sql = (
            f"UPDATE {SCHEDULE_TBL} "
            f"SET LASTRUNAT = ?, LASTRUNSTATUS = ?, NEXTRUNAT = ? "
            f"WHERE ID = ?"
        )
        conn = self._conn()
        try:
            cur = conn.cursor()
            cur.execute(sql, (last_run_at, last_run_status, next_run_at, schedule_id))
            conn.commit()
            cur.close()
        finally:
            conn.close()

    def insert_run(
        self,
        schedule_id: str,
        triggered_at: str,
        finished_at: Optional[str],
        status: str,
        target_type: str,
        remote_id: Optional[str],
        error_message: Optional[str],
    ) -> str:
        run_id = str(uuid.uuid4())
        if self._use_mem:
            self._mem_runs.append({
                "ID": run_id,
                "schedule_ID": schedule_id,
                "triggeredAt": triggered_at,
                "finishedAt": finished_at,
                "status": status,
                "targetType": target_type,
                "remoteId": remote_id,
                "errorMessage": error_message,
            })
            return run_id
        sql = (
            f"INSERT INTO {RUN_TBL} "
            f"(ID, schedule_ID, TRIGGEREDAT, FINISHEDAT, STATUS, TARGETTYPE, REMOTEID, ERRORMESSAGE) "
            f"VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        conn = self._conn()
        try:
            cur = conn.cursor()
            cur.execute(sql, (run_id, schedule_id, triggered_at, finished_at,
                              status, target_type, remote_id, error_message))
            conn.commit()
            cur.close()
        finally:
            conn.close()
        return run_id


def _row_to_schedule(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "ID": row.get("ID"),
        "name": row.get("NAME"),
        "targetType": row.get("TARGETTYPE"),
        "spaceId": row.get("SPACEID"),
        "taskchain": row.get("TASKCHAIN"),
        "jobTemplate": row.get("JOBTEMPLATE"),
        "parameters": row.get("PARAMETERS"),
        "cronExpression": row.get("CRONEXPRESSION"),
        "timezone": row.get("TIMEZONE") or "Europe/Rome",
        "isActive": bool(row.get("ISACTIVE")),
    }
