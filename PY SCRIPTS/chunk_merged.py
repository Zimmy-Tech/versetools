#!/usr/bin/env python3
"""
Split versedb_merged.json into per-stream chunks for the admin diff/import.

The diff-review UI struggles when a single upload contains thousands of
proposed changes. This script slices the payload into smaller files —
one per stream, further sub-chunked at `--chunk-size` (default 500)
entities — so the admin can review and apply each piece individually.

Each chunk carries:
  - meta:        copied verbatim (so the version label moves)
  - missionRefs: copied into the FIRST mission chunk only
  - partial:     true (suppresses Pass 2 deletes — see api/server.js)
  - exactly one stream's data, sliced to <= chunk_size entities

Streams without entries in the source payload are skipped.

Usage:
  python3 "PY SCRIPTS/chunk_merged.py" --target ptu
  python3 "PY SCRIPTS/chunk_merged.py" --target live --chunk-size 250
  python3 "PY SCRIPTS/chunk_merged.py" --in app/public/ptu/versedb_merged.json --out chunks/

Output: <out_dir>/versedb_merged_<stream>_<NNN>.json
"""

import argparse
import json
from pathlib import Path

# Streams to chunk. Order = upload order recommendation (small streams
# first so the user gets quick wins, ships before items for FK reasons,
# missions last because they're typically the noisiest).
STREAMS = [
    "ships",
    "items",
    "fpsItems",
    "fpsGear",
    "fpsArmor",
    "missions",
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=["live", "ptu"], default="ptu")
    parser.add_argument("--chunk-size", type=int, default=500)
    parser.add_argument("--in", dest="in_path", default=None,
                        help="Override input path (defaults to app/public/<target>/versedb_merged.json)")
    parser.add_argument("--out", dest="out_dir", default=None,
                        help="Override output dir (defaults to app/public/<target>/chunks/)")
    args = parser.parse_args()

    repo = Path(__file__).resolve().parent.parent
    in_path = Path(args.in_path) if args.in_path else (
        repo / "app" / "public" / args.target / "versedb_merged.json"
    )
    out_dir = Path(args.out_dir) if args.out_dir else (
        repo / "app" / "public" / args.target / "chunks"
    )

    if not in_path.exists():
        raise SystemExit(f"input not found: {in_path}")

    with open(in_path) as f:
        merged = json.load(f)

    out_dir.mkdir(parents=True, exist_ok=True)
    # Wipe stale chunks so previous-run leftovers don't get uploaded
    for old in out_dir.glob("versedb_merged_*.json"):
        old.unlink()

    meta = merged.get("meta", {})
    mission_refs = merged.get("missionRefs")

    print(f"chunking {in_path}")
    print(f"  target:     {args.target}")
    print(f"  chunk size: {args.chunk_size}")
    print(f"  out dir:    {out_dir}")
    print()

    total_chunks = 0
    for stream in STREAMS:
        entries = merged.get(stream) or []
        if not entries:
            continue

        n = len(entries)
        chunks = [(i, entries[i:i + args.chunk_size]) for i in range(0, n, args.chunk_size)]
        print(f"  {stream:12} {n:5} entries -> {len(chunks)} chunks")

        for chunk_idx, (start, slice_) in enumerate(chunks, start=1):
            payload = {
                "meta": meta,
                "partial": True,
                stream: slice_,
            }
            # missionRefs only ride along on the FIRST mission chunk —
            # they're a wholesale-overwrite blob, no need to re-send per
            # chunk and we don't want N audit-log entries for the same
            # blob.
            if stream == "missions" and chunk_idx == 1 and mission_refs:
                payload["missionRefs"] = mission_refs

            out_name = f"versedb_merged_{stream}_{chunk_idx:03d}.json"
            with open(out_dir / out_name, "w") as f:
                json.dump(payload, f, indent=2, sort_keys=True)
            total_chunks += 1

    print()
    print(f"wrote {total_chunks} chunks under {out_dir}")
    print()
    print("Upload order (recommended): ships → items → fps* → missions.")
    print("Each chunk carries `partial: true` so the diff preview won't")
    print("propose deletes for entities outside the chunk.")


if __name__ == "__main__":
    main()
