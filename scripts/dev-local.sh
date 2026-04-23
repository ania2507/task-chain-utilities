#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PY_SRV_DIR="$ROOT_DIR/py-srv"
PY_BIN="$PY_SRV_DIR/.venv/bin/python"

CAP_PORT="${CAP_PORT:-4004}"
PY_SRV_PORT="${PY_SRV_PORT:-8080}"

# Local defaults: run without XSUAA and without HANA.
export SKIP_AUTH="${SKIP_AUTH:-true}"
export USE_IN_MEMORY_REPO="${USE_IN_MEMORY_REPO:-true}"

if [[ ! -x "$PY_BIN" ]]; then
  echo "ERROR: Python venv not found at $PY_BIN" >&2
  echo "Create it with: cd $PY_SRV_DIR && python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt" >&2
  exit 1
fi

cleanup() {
  if [[ -n "${PY_SRV_PID:-}" ]] && kill -0 "$PY_SRV_PID" 2>/dev/null; then
    kill "$PY_SRV_PID" 2>/dev/null || true
    wait "$PY_SRV_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "Starting py-srv on port $PY_SRV_PORT (SKIP_AUTH=$SKIP_AUTH, USE_IN_MEMORY_REPO=$USE_IN_MEMORY_REPO)"
(
  cd "$PY_SRV_DIR"
  export PORT="$PY_SRV_PORT"
  exec "$PY_BIN" app.py
) &
PY_SRV_PID=$!

# Wait for py-srv to become available (best-effort)
for _ in {1..40}; do
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS "http://localhost:$PY_SRV_PORT/health" >/dev/null 2>&1; then
      break
    fi
  else
    # No curl: just sleep a bit.
    sleep 0.1
    break
  fi
  sleep 0.25
done

echo "Starting CAP/UI5 (cds watch) on port $CAP_PORT"

echo "URLs:"
echo "  - UI (via cds watch):  http://localhost:$CAP_PORT/webapp/index.html"
echo "  - OData:               http://localhost:$CAP_PORT/odata/v4/services/"
echo "  - Python docs:         http://localhost:$PY_SRV_PORT/docs"

echo "Press Ctrl+C to stop both."

cd "$ROOT_DIR"
# Keep CAP in the foreground so Ctrl+C behaves naturally.
exec npm run watch-webapp
