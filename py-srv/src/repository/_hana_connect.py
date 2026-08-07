"""Shared retry helper for opening a fresh HANA connection.

Each repository still opens/closes its own hdbcli connection per operation -
no pooling here, that's a separate, riskier change (hdbcli connections aren't
safe to share across concurrently-executing threads without a real
checkout/release pool, which needs testing against a live HANA instance
before it's worth the risk). This only retries the connect() call itself,
with a short backoff, so a transient HANA blip doesn't surface as an
immediate 500 to the caller.
"""

from __future__ import annotations

import logging
import time
from typing import Callable, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")


def connect_with_retry(connect_fn: Callable[[], T], attempts: int = 3, base_delay_seconds: float = 0.5) -> T:
    last_exc: Exception | None = None
    for attempt in range(attempts):
        try:
            return connect_fn()
        except Exception as e:
            last_exc = e
            if attempt < attempts - 1:
                delay = base_delay_seconds * (attempt + 1)
                logger.warning(
                    "HANA connect attempt %d/%d failed (%s), retrying in %.1fs",
                    attempt + 1, attempts, e, delay,
                )
                time.sleep(delay)
    assert last_exc is not None
    raise last_exc
