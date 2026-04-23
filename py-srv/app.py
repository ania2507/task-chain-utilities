"""Flask entry point for the Taskchain Routing Microservice.

Routes are grouped in blueprints under `src/routes`.
"""

from __future__ import annotations

import logging
import os
import sys

from src.app_factory import create_app
from src.config import Config


# Allow local thirdparty extensions (optional).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "thirdparty"))


logging.basicConfig(
    level=getattr(logging, Config.LOG_LEVEL),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)


app = create_app()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
