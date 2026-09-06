#!/usr/bin/env python3
"""Fetch release_notes.md (where it exists) for each pearOS build and turn
it into structured JSON the /changelog/ page renders as one section per
build.

The NiceC0re file is hand-written and a bit messy (mixed # / ## heading
levels for release dates, raw <img>/<br> HTML mixed into markdown, and a
non-changelog tail -- install instructions, roadmap, notes -- appended
after the actual release history). Only the changelog portion is kept:
everything from the first release entry up to (not including) the
"# How do I install?" section.

Builds without a release_notes.md yet (Debian/Goldwing, BSD, aarch64) are
written as `null` -- the page shows "Coming soon" for those, and this
script picks them up automatically the day one gets added, no code change
needed.
"""
import json
import re
import urllib.error
import urllib.request

import markdown

BUILDS = {
    "nicecore": "https://raw.githubusercontent.com/pearos-archlinux/iso/main/release_notes.md",
    "debian": "https://raw.githubusercontent.com/Pear-Project/iso/main/release_notes.md",
    "bsd": None,
    "aarch64": None,
}
OUTPUT_PATH = "assets/data/changelog.json"

# Matches a release heading: 1-2 '#'s, then a line containing a
# day-month-year date (the actual thing that varies release to release --
# "RELEASE 3", "Information" casing, etc. -- so anchor on the date instead).
HEADING_RE = re.compile(
    r"^#{1,2}\s+(.*\d{1,2}\s+\w+\s+20\d{2}.*)$", re.MULTILINE
)
STOP_MARKER = "# How do I install?"


def fetch(url):
    if url is None:
        return None
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            return resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def extract_entries(text):
    if STOP_MARKER in text:
        text = text.split(STOP_MARKER)[0]

    matches = list(HEADING_RE.finditer(text))
    entries = []
    for i, m in enumerate(matches):
        title = m.group(1).strip().rstrip("#").strip()
        # The file's own "`Last update: ...`" banner line also contains a
        # date and matches the heading pattern, but it's not a release entry.
        if title.lower().lstrip("`").startswith("last update"):
            continue
        body_start = m.end()
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body_md = text[body_start:body_end].strip()
        if not body_md:
            continue
        html = markdown.markdown(body_md, extensions=["extra"])
        entries.append({"title": title, "html": html})
    return entries


def main():
    result = {}
    for build, url in BUILDS.items():
        text = fetch(url)
        result[build] = extract_entries(text) if text else None
        count = len(result[build]) if result[build] else 0
        print(f"{build}: {count} entries" if text else f"{build}: no release_notes.md yet")

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
