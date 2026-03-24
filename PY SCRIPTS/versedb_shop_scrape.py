"""
versedb_shop_scrape.py
======================
Fetches ship and item shop prices from the UEX Corp API and merges them
into an existing versedb_data.json.

Run independently of versedb_extract.py on a weekly/monthly cycle.

Usage:
    python3 versedb_shop_scrape.py
"""

import json
import sys
import urllib.request
from pathlib import Path

DATA_FILE = Path(__file__).parent / "versedb_data.json"
APP_FILE = Path(__file__).parent / "../../versedb-app/public/versedb_data.json"

UEX_VEHICLE_URL = "https://api.uexcorp.space/2.0/vehicles_purchases_prices_all"
UEX_ITEM_URL = "https://api.uexcorp.space/2.0/items_prices_all"

# UEX uses planet names for some locations; remap to city names
SHOP_RENAMES = {
    "New Deal Crusader": "New Deal Orison",
}


def fetch_json(url):
    try:
        req = urllib.request.Request(url, headers={
            "Accept": "application/json",
            "User-Agent": "VerseDB-Extractor/1.0",
        })
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        print(f"  ERROR: UEX API fetch failed ({url}): {e}")
        return None


def main():
    print("=" * 60)
    print("VerseDB Shop Scrape — UEX Corp Price Update")
    print("=" * 60)

    # Load existing data
    if not DATA_FILE.exists():
        print(f"\nERROR: {DATA_FILE} not found. Run versedb_extract.py first.")
        sys.exit(1)

    with open(DATA_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    ships = data["ships"]
    items = data["items"]

    # --- Ship prices ---
    print("\n[1/2] Fetching ship prices from UEX…")
    vdata = fetch_json(UEX_VEHICLE_URL)
    if vdata and vdata.get("status") == "ok":
        uex_ships = {}
        for entry in vdata["data"]:
            name = entry.get("vehicle_name", "").strip()
            if not name or not entry.get("price_buy"):
                continue
            shop = entry.get("terminal_name", "")
            shop = SHOP_RENAMES.get(shop, shop)
            uex_ships.setdefault(name.lower(), []).append({
                "price": entry["price_buy"],
                "shop": shop,
            })

        matched = 0
        for ship in ships:
            ship.pop("shopPrices", None)  # clear old prices
            ship_name = ship.get("name", "").strip()
            entries = uex_ships.get(ship_name.lower())
            if not entries:
                short = ship_name.split(" ", 1)[-1] if " " in ship_name else ship_name
                entries = uex_ships.get(short.lower())
            if entries:
                ship["shopPrices"] = entries
                matched += 1
        print(f"  Ship prices matched: {matched}/{len(ships)}")
    else:
        print("  WARNING: Could not fetch ship prices — keeping existing data")

    # --- Item prices ---
    print("\n[2/2] Fetching item prices from UEX…")
    idata = fetch_json(UEX_ITEM_URL)
    if idata and idata.get("status") == "ok":
        uex_items = {}
        for entry in idata["data"]:
            name = entry.get("item_name", "").strip()
            if not name or not entry.get("price_buy"):
                continue
            shop = entry.get("terminal_name", "")
            shop = SHOP_RENAMES.get(shop, shop)
            uex_items.setdefault(name.lower(), []).append({
                "price": entry["price_buy"],
                "shop": shop,
            })

        matched = 0
        for item in items:
            item.pop("shopPrices", None)  # clear old prices
            item_name = item.get("name", "").strip()
            entries = uex_items.get(item_name.lower())
            if not entries:
                sub = item.get("subType", "")
                if sub:
                    entries = uex_items.get(f"{item_name} {sub}".lower())
            if entries:
                item["shopPrices"] = entries
                matched += 1
        print(f"  Item prices matched: {matched}/{len(items)}")
    else:
        print("  WARNING: Could not fetch item prices — keeping existing data")

    # Write updated data
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    size_mb = DATA_FILE.stat().st_size / 1_048_576
    print(f"\n{'=' * 60}")
    print(f"Done!  {DATA_FILE}  ({size_mb:.1f} MB)")

    # Copy to app if the app directory exists
    if APP_FILE.parent.exists():
        import shutil
        shutil.copy2(DATA_FILE, APP_FILE)
        print(f"Copied to {APP_FILE}")
    else:
        print(f"App directory not found at {APP_FILE.parent} — skipping copy")


if __name__ == "__main__":
    main()
