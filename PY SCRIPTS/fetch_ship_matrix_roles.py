#!/usr/bin/env python3
"""
Pulls ship role / career data from the star-citizen.wiki public API
(https://api.star-citizen.wiki/api/v3/vehicles) and writes a compact
className → { role, career, shipMatrixName } map.

Isolated from the main extraction pipeline on purpose — this is ONLY
read by the Ship Explorer page, not by the loadout, compare, mining,
or any other feature that relies on versedb_data.json. We don't want
a third-party data source polluting our core model.

Output:
    app/public/live/ship_matrix_roles.json

Usage:
    python3 "PY SCRIPTS/fetch_ship_matrix_roles.py"
"""

import json
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

API_BASE = "https://api.star-citizen.wiki/api/v3/vehicles"
PAGE_SIZE = 75  # API default 15, cap unknown, 75 works fine
OUT = Path(__file__).resolve().parent.parent / "app" / "public" / "live" / "ship_matrix_roles.json"

HEADERS = {
    "Accept": "application/json",
    "User-Agent": "versedb-ship-role-fetcher/1.0 (+github.com/Zimmy-tech/versetools)",
}


def fetch(page: int) -> dict:
    url = f"{API_BASE}?page%5Bsize%5D={PAGE_SIZE}&page%5Bnumber%5D={page}"
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    out_map: dict[str, dict] = {}
    page = 1
    last_page = 1
    total = 0

    while page <= last_page:
        try:
            payload = fetch(page)
        except urllib.error.URLError as e:
            print(f"[!] page {page} failed: {e}", file=sys.stderr)
            return 2

        meta = payload.get("meta", {})
        last_page = int(meta.get("last_page") or 1)
        total = int(meta.get("total") or 0)

        for v in payload.get("data", []):
            cls = (v.get("class_name") or "").strip()
            if not cls:
                continue
            entry: dict[str, object] = {}
            # Role is the good one — "Light Fighter", "Medium Fighter",
            # "Interceptor", "Stealth Bomber", "Interdiction", etc.
            if v.get("role"):
                entry["role"] = v["role"]
            if v.get("career"):
                entry["career"] = v["career"]
            if v.get("shipmatrix_name"):
                entry["shipMatrixName"] = v["shipmatrix_name"]
            if not entry:
                continue
            # Key case-insensitively so lookups from our lowercase
            # className fields in the loadout match.
            out_map[cls.lower()] = entry

        print(f"[{page}/{last_page}] +{len(payload.get('data', []))} → map={len(out_map)}")
        page += 1
        # Polite pacing — community API, no point hammering.
        time.sleep(0.15)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as f:
        json.dump({
            "source": "api.star-citizen.wiki/api/v3/vehicles",
            "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "total_vehicles_in_api": total,
            "map": out_map,
        }, f, indent=2)

    print(f"\nwrote {OUT} — {len(out_map)} class_name entries from {total} vehicles")
    return 0


if __name__ == "__main__":
    sys.exit(main())
