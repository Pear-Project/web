#!/usr/bin/env python3
"""Builds assets/data/old-versions.json: every public item uploaded by the
pearOS archive.org account, newest first, each with a direct download link.

The same list is shown on every distro page ("Old Versions"), unsorted by
distro on purpose. Items are read via archive.org's public search API, so no
keys are needed for this part.
"""
import datetime
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

UPLOADER = "alxb421@gmail.com"
OUT_PATH = "assets/data/old-versions.json"
STATS_PATH = "assets/data/old-versions-stats.json"
# Bulk mirror items: one row per file instead of one per item, dated from the
# files' original upload date in the source item (the mirror's own mtimes are
# just the day we copied them).
MIRRORS = {"pearos-archive-mirror": "pearos"}
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


def file_rows_candidates(files):
    return [
        f for f in files
        if f.get("source") == "original"
        and not f["name"].endswith(SKIP_SUFFIXES)
        and not f["name"].startswith("__ia_")
        and f.get("size")
        and not f["name"].lower().endswith((".png", ".jpg", ".torrent"))
    ]


def mirror_rows(ident, source_ident, files, fallback_date):
    try:
        src = get_json(f"https://archive.org/metadata/{urllib.parse.quote(source_ident)}").get("files", [])
    except Exception as e:
        print(f"[ WARN ]: source metadata failed for {source_ident}: {e}")
        src = []
    src_mtime = {f["name"]: f.get("mtime") for f in src}
    out = []
    for f in file_rows_candidates(files):
        mt = src_mtime.get(f["name"])
        date = (datetime.datetime.fromtimestamp(int(mt), datetime.timezone.utc).strftime("%Y-%m-%d")
                if mt else fallback_date)
        out.append({
            "identifier": ident,
            "name": re.sub(r"\.(7z|iso|zip|tar\.\w+)$", "", f["name"]),
            "date": date,
            "page": f"https://archive.org/details/{ident}",
            "size": human_size(int(f["size"])),
            "download": f"https://archive.org/download/{ident}/{urllib.parse.quote(f['name'])}",
        })
    return out


def source_downloads(ident):
    q = urllib.parse.urlencode({"q": f"identifier:{ident}", "fl[]": ["downloads"], "output": "json"}, doseq=True)
    try:
        docs = get_json(f"https://archive.org/advancedsearch.php?{q}")["response"]["docs"]
        return int(docs[0].get("downloads") or 0) if docs else 0
    except Exception as e:
        print(f"[ WARN ]: could not read downloads of {ident}: {e}")
        return 0


def write_if_changed(path, text):
    try:
        if open(path).read() == text:
            return
    except FileNotFoundError:
        pass
    with open(path, "w") as fh:
        fh.write(text)
    print(f"[ INFO ]: {path} updated.")


def main():
    q = urllib.parse.urlencode({
        "q": f'uploader:"{UPLOADER}"',
        "fl[]": ["identifier", "title", "publicdate", "downloads"],
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
    stats = []
    for d in docs:
        ident = d["identifier"]
        if ident.startswith("zz-archive-test-"):
            continue
        try:
            files = get_json(f"https://archive.org/metadata/{urllib.parse.quote(ident)}").get("files", [])
        except Exception as e:
            print(f"[ WARN ]: metadata failed for {ident}: {e}")
            files = []
        if ident in MIRRORS:
            # archive.org only counts downloads per item, not per file: show
            # the mirror as one line, adding the original item's count (that
            # is where these files were actually downloaded from).
            n = int(d.get("downloads") or 0) + source_downloads(MIRRORS[ident])
            mrows = mirror_rows(ident, MIRRORS[ident], files, d["publicdate"][:10])
            stats.append({"name": f"pearOS archive ({len(mrows)} files)", "date": d["publicdate"][:10],
                          "downloads": n, "page": f"https://archive.org/details/{MIRRORS[ident]}"})
            rows.extend(mrows)
            continue
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
            # still counts towards the download totals
            stats.append({"name": row["name"], "date": row["date"],
                          "downloads": int(d.get("downloads") or 0), "page": row["page"]})
            continue
        rows.append(row)
        stats.append({"name": row["name"], "date": row["date"],
                      "downloads": int(d.get("downloads") or 0), "page": row["page"]})

    rows.sort(key=lambda r: r["date"], reverse=True)
    stats.sort(key=lambda r: r["downloads"], reverse=True)
    write_if_changed(STATS_PATH, json.dumps(
        {"total": sum(r["downloads"] for r in stats), "items": stats}, indent=2) + "\n")
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
