"""In-memory task storage shared across the application.

This module centralizes the task dictionary so it can be imported from the
application entrypoint and tests without circular imports.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Dict, Optional


_tasks_lock = threading.Lock()

# In-memory storage for async tasks.
# Shape: {task_id: {status: str, result: dict|None, created_at: float}}
tasks: Dict[str, Dict[str, Any]] = {}


def create_task(task_id: str) -> None:
    with _tasks_lock:
        tasks[task_id] = {"status": "pending", "result": None, "created_at": time.time()}


def get_task(task_id: str) -> Optional[Dict[str, Any]]:
    with _tasks_lock:
        return tasks.get(task_id)


def set_task_status(task_id: str, status: str) -> None:
    with _tasks_lock:
        if task_id in tasks:
            tasks[task_id]["status"] = status


def set_task_result(task_id: str, result: Dict[str, Any]) -> None:
    with _tasks_lock:
        if task_id in tasks:
            tasks[task_id]["result"] = result
