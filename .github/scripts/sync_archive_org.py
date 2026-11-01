#!/usr/bin/env python3
"""Builds assets/data/old-versions.json: every public item uploaded by the
pearOS archive.org account, newest first, each with a direct download link.

The same list is shown on every distro page ("Old Versions"), unsorted by
distro on purpose. Items are read via archive.org's public search API, so no
keys are needed for this part.
"""
import datetime
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

UPLOADER = "alxb421@gmail.com"
OUT_PATH = "assets/data/old-versions.json"
# Items that must not show up in the table (the bulk mirror holds ~20 files in
# one item, and this list only links the largest file of each item).
EXCLUDE = {"pearos-archive-mirror"}
USER_AGENT = "pearos-web-sync/1.0 (+https://pearos.xyz)"
SKIP_SUFFIXES = (".xml", ".sqlite", ".gz_meta", "_meta.xml", "_files.xml", "_meta.sqlite")


def get_json(url, attempts=5):
    # archive.org answers 502/503 now and then; back off and retry.
    for i in range(attempts):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.load(resp)
        except (urllib.error.URLError, TimeoutError) as e:
            if i == attempts - 1:
                raise
            wait = 5 * 2 ** i
            print(f"[ WARN ]: {e} on {url} -- retrying in {wait}s")
            time.sleep(wait)


def human_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1000 or unit == "GB":
            return f"{n:.1f} {unit}" if unit in ("GB", "MB") else f"{int(n)} {unit}"
        n /= 1000


def main_file(files):
    """Largest original (non-derivative) file, ignoring archive.org's own
    metadata files."""
    cands = [
        f for f in files
        if f.get("source") == "original"
        and not f["name"].endswith(SKIP_SUFFIXES)
        and not f["name"].startswith("__ia_")
        and f.get("size")
    ]
    return max(cands, key=lambda f: int(f["size"]), default=None)


def main():
    q = urllib.parse.urlencode({
        "q": f'uploader:"{UPLOADER}"',
        "fl[]": ["identifier", "title", "publicdate"],
        "sort[]": "publicdate desc",
        "rows": 500,
        "output": "json",
    }, doseq=True)
    docs = get_json(f"https://archive.org/advancedsearch.php?{q}")["response"]["docs"]
    if not docs:
        # An empty answer is far more likely an API hiccup than the account
        # genuinely having nothing -- don't wipe the published list.
        print("[ WARN ]: archive.org returned no items, keeping existing file.")
        return 0

    rows = []
    for d in docs:
        ident = d["identifier"]
        if ident in EXCLUDE or ident.startswith("zz-archive-test-"):
            continue
        try:
            files = get_json(f"https://archive.org/metadata/{urllib.parse.quote(ident)}").get("files", [])
        except Exception as e:
            print(f"[ WARN ]: metadata failed for {ident}: {e}")
            files = []
        f = main_file(files)
        row = {
            "identifier": ident,
            "name": d.get("title") or ident,
            "date": d["publicdate"][:10],
            "page": f"https://archive.org/details/{ident}",
        }
        if f:
            row["size"] = human_size(int(f["size"]))
            row["download"] = f"https://archive.org/download/{ident}/{urllib.parse.quote(f['name'])}"
        if "download" not in row:
            print(f"[ INFO ]: {ident} has no downloadable file, skipping.")
            continue
        rows.append(row)

    new = json.dumps(rows, indent=2) + "\n"
    try:
        old = open(OUT_PATH).read()
    except FileNotFoundError:
        old = ""
    if new != old:
        with open(OUT_PATH, "w") as fh:
            fh.write(new)
        print(f"[ INFO ]: {OUT_PATH} updated ({len(rows)} items).")
    else:
        print("[ INFO ]: No changes needed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
