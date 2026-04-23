"""Async task runner logic (thread-based simulation)."""

from __future__ import annotations

import time

from .task_store import get_task, set_task_result, set_task_status


def fake_async_task(task_id: str, duration: int = 5) -> None:
    """Simulate an async task that takes some time to complete."""
    if get_task(task_id) is None:
        return

    set_task_status(task_id, "processing")
    time.sleep(duration)

    if get_task(task_id) is None:
        return

    set_task_status(task_id, "completed")
    set_task_result(task_id, {"message": "Task completed successfully", "data": "fake_result_data"})
