"""Rename the strength key in your data files once, before opening them in Hapbeat Studio 1.0 (intensity -> clip_gain).

Run this BEFORE opening the data in the new Studio. A Kit with the old key reads as clip_gain 1,
and Studio's next save then overwrites the Kit manifest and the cue table with those 1s.
Close Studio and Unity first, and commit or back up the folders before --write.
A file reported SKIP is not converted: its old keys stay, and they read as clip_gain 1 until you
rename them by hand.
Unreal: after converting the Kit, open each Event Map and press Refresh Clip Gains (an Event Map
saved before DEC-103 reads its cache as unresolved and plays without the material strength).

The products read only the new names, so data written by Studio 0.8 or older has to be converted once. This script does that for:
Studio's work folder (kits-meta.json, clips-meta.json), Kit folders (*-manifest.json),
game / video projects (cue tables, inventory.json) and Unity Event Map assets.

    python rename-intensity-to-clip-gain.py <folder or file> [...]          # dry run: list only
    python rename-intensity-to-clip-gain.py <folder or file> [...] --write  # rewrite in place

What is renamed (nothing else is touched; other meanings of "intensity" stay):
- Kit manifest: events.*.parameters.intensity / stream_events.*.parameters.intensity -> clip_gain
- cue table: clips.*.intensity / sounds.*.intensity -> clip_gain
- cue inventory: events[].intensity -> clip_gain
- Studio kits-meta.json: [kit].events[].intensity -> clipGain
- Studio clips-meta.json: [clip].libraryIntensity -> libraryClipGain
- Studio's EventDefinition (Pack builder) lists are not files and are not covered.
- Unity *.asset: `_cachedManifestIntensity:` -> `_cachedManifestClipGain:` (a cache)

A JSON file is rewritten by replacing only the key text, so its formatting stays. If that
would also hit an "intensity" key with another meaning, the file is reported and skipped.
"""
from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from pathlib import Path

SKIP_DIRS = {".git", "node_modules", "Library", "Temp", "obj", "Logs", "Intermediate", "Binaries", "DerivedDataCache"}


def _rename(d: dict, old: str, new: str) -> bool:
    if not isinstance(d, dict) or old not in d:
        return False
    if new in d:
        raise ValueError(f"has both {old!r} and {new!r}")
    d[new] = d.pop(old)
    return True


def convert(name: str, doc):
    """Return (kind, renamed copy, count, old key, new key) or None when the file is none of the known kinds."""
    out = copy.deepcopy(doc)
    n = 0
    if name == "kits-meta.json" and isinstance(out, list):
        for kit in out:
            for ev in (kit.get("events") or []) if isinstance(kit, dict) else []:
                n += _rename(ev, "intensity", "clipGain")
        return ("Studio kits-meta", out, n, "intensity", "clipGain")
    if name == "clips-meta.json" and isinstance(out, list):
        for clip in out:
            n += _rename(clip, "libraryIntensity", "libraryClipGain")
        return ("Studio clips-meta", out, n, "libraryIntensity", "libraryClipGain")
    if not isinstance(out, dict):
        return None
    if isinstance(out.get("clips"), dict) and isinstance(out.get("cues"), dict):
        for bucket in ("clips", "sounds"):
            for entry in (out.get(bucket) or {}).values():
                n += _rename(entry, "intensity", "clip_gain")
        return ("cue table", out, n, "intensity", "clip_gain")
    if "engine" in out and isinstance(out.get("events"), list):
        for ev in out["events"]:
            n += _rename(ev, "intensity", "clip_gain")
        return ("cue inventory", out, n, "intensity", "clip_gain")
    if isinstance(out.get("events"), dict) and ("schema_version" in out or "name" in out):
        for bucket in ("events", "stream_events"):
            for entry in (out.get(bucket) or {}).values():
                if isinstance(entry, dict):
                    n += _rename(entry.get("parameters"), "intensity", "clip_gain")
        return ("Kit manifest", out, n, "intensity", "clip_gain")
    return None


def handle_json(path: Path, write: bool) -> str | None:
    raw = path.read_bytes()
    bom = raw.startswith(b"\xef\xbb\xbf")
    text = raw.decode("utf-8-sig")
    try:
        doc = json.loads(text)
    except ValueError:
        return None
    try:
        res = convert(path.name, doc)
    except ValueError as e:
        return f"SKIP {path}: {e} - not converted; delete the old key by hand (the products read only the new one)"
    if not res or res[2] == 0:
        return None
    kind, renamed, n, old, new = res
    new_text = re.sub(rf'"{old}"(\s*):', rf'"{new}"\1:', text)
    if json.loads(new_text) != renamed:
        return f"SKIP {path}: {kind}, {n} key(s) - another \"{old}\" key in the file has a different meaning - this file stays at clip_gain 1 until you rename it by hand"
    if write:
        path.write_bytes((b"\xef\xbb\xbf" if bom else b"") + new_text.encode("utf-8"))
    return f"{'WROTE' if write else 'would rename'} {path}: {kind}, {n} key(s) {old} -> {new}"


def handle_asset(path: Path, write: bool) -> str | None:
    text = path.read_bytes().decode("utf-8", errors="surrogateescape")
    n = len(re.findall(r"^(\s*)_cachedManifestIntensity:", text, flags=re.M))
    if not n:
        return None
    if write:
        new = re.sub(r"^(\s*)_cachedManifestIntensity:", r"\1_cachedManifestClipGain:", text, flags=re.M)
        path.write_bytes(new.encode("utf-8", errors="surrogateescape"))
    return f"{'WROTE' if write else 'would rename'} {path}: Unity Event Map, {n} key(s) _cachedManifestIntensity -> _cachedManifestClipGain"


def walk(root: Path):
    if root.is_file():
        yield root
        return
    for p in sorted(root.rglob("*")):
        if p.is_file() and not (SKIP_DIRS & set(p.relative_to(root).parts[:-1])):
            yield p


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", type=Path)
    ap.add_argument("--write", action="store_true", help="rewrite the files (default: list only)")
    args = ap.parse_args(argv)
    lines = []
    for root in args.paths:
        for p in walk(root):
            if p.suffix.lower() == ".json":
                line = handle_json(p, args.write)
            elif p.suffix.lower() == ".asset":
                line = handle_asset(p, args.write)
            else:
                line = None
            if line:
                lines.append(line)
    sys.stdout.reconfigure(encoding="utf-8")
    print("\n".join(lines) if lines else "nothing to rename")
    if not args.write and any(line.startswith("would") for line in lines):
        print("(dry run - add --write to rewrite)")
    print("Run this before opening the data in the new Studio (an unconverted Kit reads as clip_gain 1 and the"
          " next save overwrites the Kit and the cue table). Close Studio and Unity first; commit or back up before"
          " --write. Unreal: after converting the Kit, press Refresh Clip Gains in each Event Map.")
    return 1 if any(line.startswith("SKIP") for line in lines) else 0


if __name__ == "__main__":
    sys.exit(main())
