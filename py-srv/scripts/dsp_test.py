"""End-to-end DSP connectivity test for the deployed py-srv app.

Validates that, from inside the running CF container:
  1. The destination `External_Trigger_DSP` is resolved via the Destination
     Service (no UPS, no static credentials).
  2. The DSP catalog API responds and lists spaces.
  3. A specific asset (3VR_IFP_DEPL_METADATA_01) is discoverable.
  4. Rows can be read via the relational consumption endpoint.

Usage (from a developer machine, against the deployed app):

    cf enable-ssh task-chain-utilities-py-srv && cf restart task-chain-utilities-py-srv
    cf ssh task-chain-utilities-py-srv -c "cat > /tmp/dsp_test.py" < py-srv/scripts/dsp_test.py
    cf ssh task-chain-utilities-py-srv -c '\
        LD_LIBRARY_PATH=/home/vcap/deps/1/python/lib \
        PYTHONPATH=/home/vcap/deps/1/python/lib/python3.13/site-packages:/home/vcap/app \
        /home/vcap/deps/1/python/bin/python3 /tmp/dsp_test.py'

Override the asset/space via env vars if needed:
    DSP_TEST_SPACE=ORCHESTRATION  DSP_TEST_ASSET=3VR_IFP_DEPL_METADATA_01
"""

from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, "/home/vcap/app")

from src.integrations.dsp.destination import DSPDestinationClient  # noqa: E402


SPACE = os.environ.get("DSP_TEST_SPACE", "ORCHESTRATION")
ASSET = os.environ.get("DSP_TEST_ASSET", "3VR_IFP_DEPL_METADATA_01")


def banner(title: str) -> None:
    print()
    print("=" * 60)
    print(title)
    print("=" * 60)


def http_get(host: str, token: str, path: str) -> dict:
    req = urllib.request.Request(
        host + path,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def main() -> int:
    banner("STEP 1: Resolve destination External_Trigger_DSP")
    client = DSPDestinationClient.from_env()
    if client is None:
        print("❌ DSPDestinationClient.from_env() returned None — VCAP_SERVICES missing?")
        return 1
    conn = client.get_connection()
    host = conn["host"]
    token = conn.get("access_token") or ""
    print(f"host         = {host}")
    print(f"auth         = {conn.get('authentication')}")
    print(f"token (len)  = {len(token)} chars")
    if not token:
        print("❌ No access_token returned from Destination Service")
        return 1

    banner("STEP 2: GET /api/v1/dwc/catalog/spaces")
    spaces = http_get(host, token, "/api/v1/dwc/catalog/spaces?$top=200")
    items = spaces.get("value", [])
    print(f"total spaces = {len(items)}")
    has_space = any((s.get("name") or s.get("id")) == SPACE for s in items)
    print(f"{SPACE} present = {has_space}")

    banner(f"STEP 3: catalog filter for {ASSET}")
    flt = urllib.parse.quote(f"name eq '{ASSET}'")
    res = http_get(host, token, f"/api/v1/dwc/catalog/assets?$filter={flt}")
    matches = res.get("value", [])
    print(f"matches = {len(matches)}")
    for m in matches:
        space_name = m.get("spaceName") or m.get("assetSpaceName")
        print(f"  - name={m.get('name')}  label={m.get('label')}  space={space_name}")

    banner("STEP 4: Read rows from consumption/relational")
    path = (
        f"/api/v1/dwc/consumption/relational/{SPACE}/{ASSET}/_{ASSET}"
        "?$top=3&$count=true"
    )
    rows_res = http_get(host, token, path)
    print(f"@odata.count = {rows_res.get('@odata.count')}")
    for i, row in enumerate(rows_res.get("value", []), 1):
        keys = list(row.keys())[:6]
        print(f"  row {i}: keys={keys}")

    banner("ALL STEPS OK ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
