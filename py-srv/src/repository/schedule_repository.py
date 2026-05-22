"""Schedule repository - reads/writes CalendarEntry / Schedule / ScheduleRun /
TrafficLightStatus on the HDI container.

Tables (generated from CDS namespace `conditional.app.schedules`):
  - CONDITIONAL_APP_SCHEDULES_CALENDARENTRY
  - CONDITIONAL_APP_SCHEDULES_SCHEDULE
  - CONDITIONAL_APP_SCHEDULES_SCHEDULERUN
  - CONDITIONAL_APP_SCHEDULES_TRAFFICLIGHTSTATUS
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from src.config import Config

logger = logging.getLogger(__name__)


SCHEDULE_ENTRY_TBL = "CONDITIONAL_APP_SCHEDULES_SCHEDULEENTRY"
SCHEDULE_TBL       = "CONDITIONAL_APP_SCHEDULES_SCHEDULE"
RUN_TBL            = "CONDITIONAL_APP_SCHEDULES_SCHEDULERUN"
TRAFFIC_LIGHT_TBL  = "CONDITIONAL_APP_SCHEDULES_TRAFFICLIGHTSTATUS"


class ScheduleRepository:
    """Thin HANA repository for ScheduleEntry / ScheduleRun.

    Falls back to a no-op in-memory store if hdbcli or credentials are missing,
    so local `cds watch` without HANA still works.
    """

    def __init__(self, credentials: dict | None = None):
        self._credentials = credentials
        self._mem_entries: List[Dict[str, Any]] = []
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
    def insert_run(
        self,
        schedule_entry_id: str,
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
                "scheduleEntry_ID": schedule_entry_id,
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
            f"(ID, SCHEDULEENTRY_ID, TRIGGEREDAT, FINISHEDAT, STATUS, TARGETTYPE, REMOTEID, ERRORMESSAGE) "
            f"VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        conn = self._conn()
        try:
            cur = conn.cursor()
            cur.execute(sql, (run_id, schedule_entry_id, triggered_at, finished_at,
                              status, target_type, remote_id, error_message))
            conn.commit()
            cur.close()
        finally:
            conn.close()
        return run_id

    # ------------------------------------------------------------------
    # ScheduleEntry - one-shot future runs persisted in HDI
    # ------------------------------------------------------------------
    def list_active_entries(self) -> List[Dict[str, Any]]:
        """Return all active ScheduleEntry rows whose runDate is today or later."""
        if self._use_mem:
            return []
        sql = (
            f"SELECT ID, SPACEID, TASKCHAIN, RUNDATE, RUNTIME, TIMEZONE, ACTIVE, PARAMETERS "
            f"FROM {SCHEDULE_ENTRY_TBL} "
            f"WHERE ACTIVE = TRUE AND RUNDATE >= CURRENT_DATE"
        )
        conn = self._conn()
        try:
            cur = conn.cursor()
            cur.execute(sql)
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
            cur.close()
            return [_row_to_entry(r) for r in rows]
        except Exception as e:
            logger.warning("list_active_entries failed: %s", e)
            return []
        finally:
            try:
                conn.close()
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Schedule - cron-based traffic lights schedules
    # ------------------------------------------------------------------
    def list_active_schedules(self) -> List[Dict[str, Any]]:
        """Return all active Schedule rows (Traffic Lights type)."""
        if self._use_mem:
            return list(getattr(self, "_mem_schedules", []))
        sql = (
            f"SELECT ID, NAME, DESCRIPTION, TARGETTYPE, SPACEID, TASKCHAIN, "
            f"JOBTEMPLATE, PARAMETERS, CRONEXPRESSION, TIMEZONE, ISACTIVE, "
            f"NEXTRUNAT, LASTRUNSTATUS "
            f"FROM {SCHEDULE_TBL} "
            f"WHERE ISACTIVE = TRUE"
        )
        conn = self._conn()
        try:
            cur = conn.cursor()
            cur.execute(sql)
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
            cur.close()
            return [_row_to_schedule(r) for r in rows]
        except Exception as e:
            logger.warning("list_active_schedules failed: %s", e)
            return []
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def update_schedule_run_status(self, schedule_id: str, status: str, next_run_at: Optional[str]) -> None:
        """Update lastRunStatus and nextRunAt on a Schedule row after a cron tick."""
        if self._use_mem:
            return
        sql = (
            f"UPDATE {SCHEDULE_TBL} "
            f"SET LASTRUNSTATUS = ?, NEXTRUNAT = ? "
            f"WHERE ID = ?"
        )
        conn = self._conn()
        try:
            cur = conn.cursor()
            cur.execute(sql, (status, next_run_at, schedule_id))
            conn.commit()
            cur.close()
        except Exception as e:
            logger.warning("update_schedule_run_status failed: %s", e)
        finally:
            try:
                conn.close()
            except Exception:
                pass

    # ------------------------------------------------------------------
    # TrafficLightStatus - semaphore table written by external systems
    # ------------------------------------------------------------------
    def get_traffic_light(self, space_id: str, taskchain: str) -> Optional[Dict[str, Any]]:
        """Return the TrafficLightStatus row for (spaceId, taskchain), or None."""
        if self._use_mem:
            mem = getattr(self, "_mem_traffic", {})
            return mem.get(f"{space_id}::{taskchain}")
        sql = (
            f"SELECT SPACEID, TASKCHAIN, STATUS, UPDATEDAT, NOTE "
            f"FROM {TRAFFIC_LIGHT_TBL} "
            f"WHERE SPACEID = ? AND TASKCHAIN = ?"
        )
        conn = self._conn()
        try:
            cur = conn.cursor()
            cur.execute(sql, (space_id, taskchain))
            row = cur.fetchone()
            cur.close()
            if not row:
                return None
            cols = ["SPACEID", "TASKCHAIN", "STATUS", "UPDATEDAT", "NOTE"]
            return _row_to_traffic_light(dict(zip(cols, row)))
        except Exception as e:
            logger.warning("get_traffic_light failed: %s", e)
            return None
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def set_traffic_light_status(self, space_id: str, taskchain: str, status: str, note: Optional[str] = None) -> None:
        """Upsert the status for (spaceId, taskchain) in TrafficLightStatus."""
        now = datetime.now(timezone.utc).isoformat()
        if self._use_mem:
            if not hasattr(self, "_mem_traffic"):
                self._mem_traffic: Dict[str, Any] = {}
            self._mem_traffic[f"{space_id}::{taskchain}"] = {
                "spaceId": space_id, "taskchain": taskchain,
                "status": status, "updatedAt": now, "note": note,
            }
            return
        # HANA UPSERT (MERGE INTO)
        sql = (
            f"MERGE INTO {TRAFFIC_LIGHT_TBL} AS tgt "
            f"USING (SELECT ? AS SPACEID, ? AS TASKCHAIN FROM DUMMY) AS src "
            f"ON tgt.SPACEID = src.SPACEID AND tgt.TASKCHAIN = src.TASKCHAIN "
            f"WHEN MATCHED THEN UPDATE SET STATUS = ?, UPDATEDAT = ?, NOTE = ? "
            f"WHEN NOT MATCHED THEN INSERT (SPACEID, TASKCHAIN, STATUS, UPDATEDAT, NOTE) "
            f"VALUES (?, ?, ?, ?, ?)"
        )
        conn = self._conn()
        try:
            cur = conn.cursor()
            cur.execute(sql, (space_id, taskchain, status, now, note,
                              space_id, taskchain, status, now, note))
            conn.commit()
            cur.close()
        except Exception as e:
            logger.warning("set_traffic_light_status failed: %s", e)
        finally:
            try:
                conn.close()
            except Exception:
                pass


def _row_to_entry(row: Dict[str, Any]) -> Dict[str, Any]:
    rd = row.get("RUNDATE")
    rt = row.get("RUNTIME") or ""
    return {
        "ID": row.get("ID"),
        "spaceId": row.get("SPACEID"),
        "taskchain": row.get("TASKCHAIN"),
        "runDate": rd.isoformat() if hasattr(rd, "isoformat") else (str(rd) if rd else None),
        "runTime": rt,
        "timezone": row.get("TIMEZONE") or "Europe/Rome",
        "active": bool(row.get("ACTIVE")),
        "parameters": row.get("PARAMETERS"),
    }


def _row_to_schedule(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "ID": row.get("ID"),
        "name": row.get("NAME"),
        "description": row.get("DESCRIPTION"),
        "targetType": row.get("TARGETTYPE") or "DSP",
        "spaceId": row.get("SPACEID"),
        "taskchain": row.get("TASKCHAIN"),
        "jobTemplate": row.get("JOBTEMPLATE"),
        "parameters": row.get("PARAMETERS"),
        "cronExpression": row.get("CRONEXPRESSION"),
        "timezone": row.get("TIMEZONE") or "Europe/Rome",
        "isActive": bool(row.get("ISACTIVE")),
        "nextRunAt": row.get("NEXTRUNAT"),
        "lastRunStatus": row.get("LASTRUNSTATUS"),
    }


def _row_to_traffic_light(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "spaceId": row.get("SPACEID"),
        "taskchain": row.get("TASKCHAIN"),
        "status": row.get("STATUS"),
        "updatedAt": row.get("UPDATEDAT"),
        "note": row.get("NOTE"),
    }
