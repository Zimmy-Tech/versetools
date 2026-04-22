"""
fetch_weapon_images.py
======================
Pull hero images from starcitizen.tools into:
  app/public/weapon-images/{className}.{ext}        (--weapons, default)
  app/public/armor-images/{setName-slug}.{ext}      (--armor)
  app/public/attachment-images/{className}.{ext}    (--attachments)

Each mode writes its own manifest next to the images recording the resolved
wiki page + chosen image URL. Reruns skip entries already in the manifest
(with a matching on-disk file) unless --force is passed.

Usage:
  python3 fetch_weapon_images.py                  # weapons (default)
  python3 fetch_weapon_images.py --armor
  python3 fetch_weapon_images.py --attachments
  python3 fetch_weapon_images.py --all            # every mode
  python3 fetch_weapon_images.py --force          # rerun currently-cached items
  python3 fetch_weapon_images.py --only <id>      # fetch only these ids (repeatable)

When starcitizen.tools misses a page, add an override in the MANUAL_TITLES
dict for the relevant mode at the top of this file and rerun.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

_BASE       = Path(__file__).resolve().parent.parent
_FPS_JSON   = _BASE / "app" / "public" / "live" / "versedb_fps.json"
_ARMOR_JSON = _BASE / "app" / "public" / "live" / "versedb_fps_armor.json"
_PUBLIC     = _BASE / "app" / "public"

WIKI_BASE   = "https://starcitizen.tools"
MEDIA_HOST  = "media.starcitizen.tools"
USER_AGENT  = "VerseDB image fetcher (contact: bryanzimbardi@gmail.com)"

# ─── Per-mode title overrides ───────────────────────────────────────────────
# Extend these as we discover misses. Value is the wiki page title
# (underscores for spaces). Keep them here so they stay under source control.

WEAPON_TITLES: dict[str, str] = {
    "apar_special_ballistic_01": "Scourge_Railgun",
    "apar_special_ballistic_02": "Animus_Missile_Launcher",
    "behr_gren_frag_01":         "MK-4_Frag_Grenade",
    "none_special_ballistic_01": "Boomtube_Rocket_Launcher",
}

ARMOR_TITLES: dict[str, str] = {
    # setName → wiki page title
}

ATTACH_TITLES: dict[str, str] = {
    # className → wiki page title
}


STRIP_WEAPON_SUFFIXES = [
    " Sniper Rifle", " Assault Rifle", " Energy Assault Rifle",
    " Energy LMG", " Energy SMG", " Laser Pistol", " Laser Shotgun",
    " Laser Sniper Rifle", " Frag Pistol", " Rocket Launcher",
    " Grenade Launcher", " Missile Launcher", " Frag Grenade",
    " Rifle", " Pistol", " Shotgun", " Sniper", " SMG", " LMG",
]

STRIP_ARMOR_SUFFIXES = [
    " Armor Set", " Armor", " Suit", " Armour",
]

STRIP_ATTACH_SUFFIXES = [
    " Flash Hider", " Suppressor", " Compensator", " Stabilizer",
    " Laser Sight", " Vertical Grip", " Flashlight",
]


# ─── HTTP ───────────────────────────────────────────────────────────────────

def _fetch(url: str, timeout: int = 20, tries: int = 1, sleep_between: float = 1.0) -> bytes | None:
    """Fail-fast fetch — starcitizen.tools' origin is slow for uncached pages,
    so we don't waste minutes retrying. Missed items stay in `missing[]` and
    a follow-up rerun picks them up once Cloudflare has cached the probe.
    """
    last_err = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                if r.status == 200:
                    return r.read()
                last_err = f"HTTP {r.status}"
        except Exception as e:
            last_err = str(e)
        if attempt < tries - 1:
            time.sleep(sleep_between * (attempt + 1))
    return None


def _normalize_title(display_name: str, strip_suffixes: list[str]) -> list[str]:
    out: list[str] = []
    def add(t: str):
        t = t.strip().replace(" ", "_")
        if t and t not in out:
            out.append(t)
    add(display_name)
    for suf in strip_suffixes:
        if display_name.lower().endswith(suf.lower()):
            add(display_name[: -len(suf)])
    first = display_name.split(" ")[0]
    if first:
        add(first)
    return out


def _resolve_title(display_name: str, manual: str | None, strip_suffixes: list[str]) -> tuple[str | None, bytes | None]:
    candidates = [manual] if manual else []
    candidates += _normalize_title(display_name, strip_suffixes)

    for title in candidates:
        if not title: continue
        url = f"{WIKI_BASE}/{urllib.parse.quote(title, safe='_-')}"
        data = _fetch(url)
        if not data: continue
        txt = data.decode("utf-8", "replace")
        if "mw-search-nonefound" in txt:
            continue
        if "may refer to" in txt.lower() and "disambiguation" in txt.lower():
            continue
        if len(txt) < 20000:
            continue
        return title, data
    return None, None


# ─── Image picking ──────────────────────────────────────────────────────────

_IMG_RE = re.compile(r'https?://[^"\s]+?\.(?:png|jpg|jpeg|webp)', re.I)

PREFERRED_KEYWORDS = [
    "flat_on_white", "flat-on-white", "flat_white",
    "isometric", "flat_", "render", "white_background",
]


def _pick_best_image_url(html: bytes, display_name: str) -> str | None:
    txt = html.decode("utf-8", "replace")
    og = re.search(r'<meta\s+property="og:image"\s+content="([^"]+)"', txt, re.I)
    if og:
        url = og.group(1)
        if MEDIA_HOST in url:
            return _upgrade(url)
    candidates: list[str] = []
    for u in _IMG_RE.findall(txt):
        if MEDIA_HOST in u:
            candidates.append(u)
    if not candidates:
        return None
    for kw in PREFERRED_KEYWORDS:
        for u in candidates:
            if kw in u.lower():
                return _upgrade(u)
    tok = display_name.split(" ")[0].lower()
    for u in candidates:
        if tok in u.lower():
            return _upgrade(u)
    return _upgrade(candidates[0])


def _upgrade(url: str) -> str:
    m = re.match(
        r'(https?://media\.starcitizen\.tools/thumb/[^/]+/[^/]+/[^/]+?/)(\d+)px-(.+)$',
        url,
    )
    if m:
        return f"{m.group(1)}800px-{m.group(3)}"
    return url


def _ext_for_url(url: str) -> str:
    u = url.lower()
    if u.endswith(".webp"): return "webp"
    if u.endswith(".png"):  return "png"
    if u.endswith(".jpg") or u.endswith(".jpeg"): return "jpg"
    return "webp"


def _slug(name: str) -> str:
    """Slug-ify a display/set name for filesystem use."""
    s = name.lower().strip()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s


# ─── Manifest ───────────────────────────────────────────────────────────────

def _load_manifest(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            pass
    return {"schema": 1, "entries": {}, "missing": []}


def _save_manifest(path: Path, m: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(m, indent=2))


# ─── Core fetch loop ────────────────────────────────────────────────────────

def _run_mode(
    mode_name: str,
    out_dir: Path,
    targets: list[dict],   # each: {id, name}
    manual: dict[str, str],
    strip_suffixes: list[str],
    *,
    force: bool,
    only: list[str] | None,
):
    if only:
        keep = set(only)
        targets = [t for t in targets if t["id"] in keep]
    print(f"── {mode_name}: {len(targets)} targets → {out_dir.relative_to(_BASE)}")
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / f"{mode_name}-images.manifest.json"
    manifest = _load_manifest(manifest_path)
    entries: dict = manifest.get("entries", {})
    missing: list[str] = []
    n_fetch = n_cached = n_fail = 0

    for i, t in enumerate(targets, 1):
        tid  = t["id"]
        name = t["name"] or tid
        slug = t.get("slug") or tid
        print(f"[{i}/{len(targets)}] {tid:<42} {name}")

        cached = entries.get(tid)
        on_disk = [f for f in out_dir.glob(f"{slug}.*") if f.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")]
        # Treat a file on disk as authoritative even if the manifest entry was
        # lost (e.g. the previous run was killed before the final save). We
        # backfill a minimal manifest entry so future probes stay skipped.
        if not force and on_disk:
            if not cached:
                entries[tid] = {
                    "wikiTitle": None,
                    "imageUrl":  None,
                    "imagePath": f"{out_dir.name}/{on_disk[0].name}",
                    "bytes":     on_disk[0].stat().st_size,
                    "fetchedAt": datetime.fromtimestamp(on_disk[0].stat().st_mtime, tz=timezone.utc).isoformat(timespec="seconds"),
                    "source":    "disk-backfill",
                }
            n_cached += 1
            continue

        title, page = _resolve_title(name, manual.get(tid), strip_suffixes)
        if not page:
            print(f"    ✗ no wiki page resolved")
            missing.append(tid)
            n_fail += 1
            continue

        img_url = _pick_best_image_url(page, name)
        if not img_url:
            print(f"    ✗ no image on page '{title}'")
            missing.append(tid)
            n_fail += 1
            continue

        img = _fetch(img_url, timeout=60)
        if not img:
            print(f"    ✗ download failed: {img_url}")
            missing.append(tid)
            n_fail += 1
            continue

        ext = _ext_for_url(img_url)
        for f in on_disk:
            if f.suffix.lower().lstrip(".") != ext:
                try: f.unlink()
                except OSError: pass

        out_path = out_dir / f"{slug}.{ext}"
        out_path.write_bytes(img)

        entries[tid] = {
            "wikiTitle": title,
            "imageUrl":  img_url,
            "imagePath": f"{out_dir.name}/{slug}.{ext}",
            "bytes":     len(img),
            "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        n_fetch += 1
        print(f"    ✓ {title} → {ext.upper()} {len(img):,}B")

        # Flush manifest every 10 successful fetches so a Ctrl-C or timeout
        # doesn't lose the resume state.
        if n_fetch % 10 == 0:
            manifest["entries"] = entries
            _save_manifest(manifest_path, manifest)

    manifest["entries"] = entries
    manifest["missing"] = sorted(set(missing) - set(entries.keys()))
    manifest["lastRun"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    _save_manifest(manifest_path, manifest)

    print(f"   → Fetched: {n_fetch}  Cached: {n_cached}  Failed: {n_fail}")
    if manifest["missing"]:
        shown = ", ".join(manifest["missing"][:6])
        more  = f" (+{len(manifest['missing']) - 6} more)" if len(manifest["missing"]) > 6 else ""
        print(f"   → still missing: {shown}{more}")
        print(f"   → add overrides at top of this script then rerun.")


# ─── Mode entrypoints ───────────────────────────────────────────────────────

def _weapons_targets() -> list[dict]:
    d = json.loads(_FPS_JSON.read_text())
    return [{"id": w["className"], "name": w["name"], "slug": w["className"]} for w in d["weapons"]]


def _attachments_targets() -> list[dict]:
    d = json.loads(_FPS_JSON.read_text())
    # Strip the trailing size digit ("Emod Stabilizer1" → "Emod Stabilizer")
    # that leaked into the display name.
    def clean(n: str) -> str:
        return re.sub(r"\d+$", "", n).strip()
    return [
        {"id": a["className"], "name": clean(a["name"]), "slug": a["className"]}
        for a in d.get("attachments", [])
    ]


def _armor_targets() -> list[dict]:
    """One target per unique setName — several classNames share a set."""
    d = json.loads(_ARMOR_JSON.read_text())
    seen: dict[str, dict] = {}
    for a in d["armor"]:
        sn = a.get("setName")
        if not sn or sn in seen: continue
        seen[sn] = {"id": sn, "name": sn, "slug": _slug(sn)}
    return list(seen.values())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--weapons", action="store_true", help="Fetch weapons (default if no other mode flag).")
    ap.add_argument("--armor", action="store_true", help="Fetch armor sets.")
    ap.add_argument("--attachments", action="store_true", help="Fetch weapon attachments.")
    ap.add_argument("--all", action="store_true", help="Run all modes in sequence.")
    ap.add_argument("--force", action="store_true", help="Refetch even if manifest says cached.")
    ap.add_argument("--only", action="append", help="Restrict to these ids (repeatable).")
    args = ap.parse_args()

    if args.all:
        args.weapons = args.armor = args.attachments = True
    if not (args.weapons or args.armor or args.attachments):
        args.weapons = True

    if args.weapons:
        _run_mode(
            "weapon", _PUBLIC / "weapon-images", _weapons_targets(),
            WEAPON_TITLES, STRIP_WEAPON_SUFFIXES,
            force=args.force, only=args.only,
        )
    if args.armor:
        _run_mode(
            "armor", _PUBLIC / "armor-images", _armor_targets(),
            ARMOR_TITLES, STRIP_ARMOR_SUFFIXES,
            force=args.force, only=args.only,
        )
    if args.attachments:
        _run_mode(
            "attachment", _PUBLIC / "attachment-images", _attachments_targets(),
            ATTACH_TITLES, STRIP_ATTACH_SUFFIXES,
            force=args.force, only=args.only,
        )


if __name__ == "__main__":
    main()
