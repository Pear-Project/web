#!/usr/bin/env python3
"""Sync assets/data/bsd-versions.json from the `iso-latest` release of pearOS-bsd/iso.

For each architecture (amd64, arm64) it looks for pearOS-UltraC0re-<arch>-<version>.iso.xz in the
release. Found: version, size and the SHA-256 of the .iso.xz itself (GitHub's asset digest: the file
people download, not the .iso inside it). Missing: the row is shown as "Unavailable".
The Worker (cloudflare/pearos-dl) serves any UltraC0re file name from that same release, so nothing
else has to change when a new version ships.
"""
import json, os, re, sys, urllib.request

REPO = "pearOS-bsd/iso"
TAG = "iso-latest"
DATA = "assets/data/bsd-versions.json"
ARCHES = ("amd64", "arm64")
DEFAULT_STATUS = "Developer Preview"


def fetch_release():
    req = urllib.request.Request(f"https://api.github.com/repos/{REPO}/releases/tags/{TAG}",
                                 headers={"Accept": "application/vnd.github+json", "User-Agent": "pearos-web-sync"})
    tok = os.environ.get("GITHUB_TOKEN")
    if tok:
        req.add_header("Authorization", f"Bearer {tok}")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def human_size(b):
    return f"{b / 1e9:.1f} GB" if b >= 1e9 else f"{round(b / 1e6)} MB"


def main():
    try:
        rel = fetch_release()
    except Exception as e:  # keep the current data rather than blanking the page
        print(f"[ WARN ]: could not read {REPO}@{TAG}: {e}; bsd-versions.json left as is")
        return 0

    try:
        old = {row["name"].rsplit("(", 1)[-1].rstrip(")").lower(): row for row in json.load(open(DATA))}
    except Exception:
        old = {}

    found = {}
    for a in rel.get("assets", []):
        m = re.fullmatch(r"pearOS-UltraC0re-(amd64|arm64)-([0-9][0-9.]*)\.iso\.xz", a["name"])
        if not m:
            continue
        digest = a.get("digest") or ""
        if not digest.startswith("sha256:"):
            print(f"[ WARN ]: {a['name']} has no sha256 digest yet; skipped")
            continue
        found[m.group(1)] = {"version": m.group(2), "size": a["size"], "sha": digest.split(":", 1)[1], "file": a["name"]}

    if not found:
        print(f"[ WARN ]: no UltraC0re image in {REPO}@{TAG}; bsd-versions.json left as is")
        return 0

    # Version to label an unavailable architecture with: the newest one available.
    latest = max((f["version"] for f in found.values()), key=lambda v: [int(x) for x in v.split(".") if x.isdigit()])
    rows = []
    for arch in ARCHES:
        label = arch.upper()
        f = found.get(arch)
        if f:
            prev = old.get(arch, {})
            status = prev.get("status") if prev.get("status") not in (None, "Unavailable") else DEFAULT_STATUS
            rows.append({"name": f"UltraC0re {f['version']} ({label})", "status": status, "size": human_size(f["size"]),
                         "sha256": f["sha"], "download": f"https://iso.pearos.xyz/iso/{f['file']}"})
        else:
            rows.append({"name": f"UltraC0re {latest} ({label})", "status": "Unavailable", "size": "—"})

    text = json.dumps(rows, indent=2, ensure_ascii=False) + "\n"
    if os.path.exists(DATA) and json.load(open(DATA)) == rows:
        print("bsd-versions.json unchanged")
        return 0
    open(DATA, "w").write(text)
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
