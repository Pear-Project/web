#!/usr/bin/env python3
"""Syncs the NiceC0re entry in nicecore-versions.json against the current
sha.txt in pearos-archlinux/iso, and manages the 15-day retirement window
for the previous month's ISO.

sha.txt already contains the exact filename that was just built, so the
download URL and sha256 are always derived from it directly -- no more
guessing/hardcoding a filename pattern that breaks when the month rolls
over.

The row's name always includes the version straight from the filename
(e.g. "NiceC0re 26.09"). When the filename changes (new month), the
previous entry is kept around as its own row (e.g. "NiceC0re 26.08") with
a `retire_at` timestamp 15 days out, so the old ISO stays downloadable
during the transition. Any row whose `retire_at` has passed gets its R2
object deleted and is dropped from the table.
"""
import datetime
import json
import os
import re
import sys
import urllib.request

SHA_TXT_URL = "https://raw.githubusercontent.com/pearos-archlinux/iso/main/sha.txt"
VERSIONS_PATH = "assets/data/nicecore-versions.json"
RETIRE_AFTER_DAYS = 15
R2_BUCKET = "pearos-cdn"
CF_API_BASE = "https://api.cloudflare.com/client/v4"


USER_AGENT = "pearOS-sync-script"


def fetch_text(url):
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req) as resp:
        return resp.read().decode().strip()


def fetch_content_length(url):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req) as resp:
        length = resp.headers.get("Content-Length")
    if not length:
        raise RuntimeError(f"No Content-Length from {url}")
    return int(length)


def format_size(num_bytes):
    return f"{num_bytes / 1_000_000_000:.1f} GB"


def extract_version(filename):
    m = re.search(r"(\d{4}\.\d{2})", filename)
    return m.group(1) if m else filename


def short_version(full_version):
    # "2026.08" -> "26.08" (drop the century, matches how the site refers
    # to releases elsewhere)
    m = re.match(r"^\d{2}(\d{2}\.\d{2})$", full_version)
    return m.group(1) if m else full_version


def delete_r2_object(key, account_id, api_token):
    url = f"{CF_API_BASE}/accounts/{account_id}/r2/buckets/{R2_BUCKET}/objects/{key}"
    req = urllib.request.Request(
        url,
        method="DELETE",
        headers={"Authorization": f"Bearer {api_token}", "User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status in (200, 204)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return True  # already gone
        print(f"[ ERR ]: R2 delete failed for {key}: {e.code} {e.read().decode()}")
        return False


def r2_key_from_download_url(download_url):
    # https://iso.pearos.xyz/iso/<file>.iso -> iso/<file>.iso
    return re.sub(r"^https?://[^/]+/", "", download_url)


def main():
    sha_txt = fetch_text(SHA_TXT_URL)
    first_line = sha_txt.splitlines()[0]
    parts = first_line.split(None, 1)
    if len(parts) != 2:
        print(f"[ ERR ]: Could not parse sha.txt line: {first_line!r}")
        sys.exit(1)
    new_sha, new_path = parts
    new_filename = os.path.basename(new_path)
    new_download = f"https://iso.pearos.xyz/iso/{new_filename}"

    with open(VERSIONS_PATH) as f:
        versions = json.load(f)

    # The main entry is whichever row has no retire_at -- retired rows always
    # carry one, so this holds even as `name` itself changes every month.
    main_idx = next((i for i, v in enumerate(versions) if "retire_at" not in v), None)
    if main_idx is None:
        print('[ ERR ]: No active NiceC0re entry found in nicecore-versions.json')
        sys.exit(1)
    main_entry = versions[main_idx]

    old_filename = os.path.basename(main_entry.get("download", ""))
    new_name = f"NiceC0re {short_version(extract_version(new_filename))}"
    changed = False

    if old_filename and old_filename != new_filename:
        retire_at = (
            datetime.datetime.now(datetime.timezone.utc)
            + datetime.timedelta(days=RETIRE_AFTER_DAYS)
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
        retired_entry = {
            "name": main_entry.get("name", "NiceC0re"),
            "status": main_entry.get("status", "Available"),
            "size": main_entry.get("size"),
            "sha256": main_entry.get("sha256"),
            "download": main_entry.get("download"),
            "retire_at": retire_at,
        }
        versions.insert(main_idx + 1, retired_entry)
        main_idx = versions.index(main_entry)
        changed = True
        print(f"[ INFO ]: New ISO detected ({old_filename} -> {new_filename}); "
              f"retiring old one at {retire_at}")

    new_size_bytes = fetch_content_length(new_download)
    new_size = format_size(new_size_bytes)

    if (main_entry.get("sha256") != new_sha or main_entry.get("size") != new_size
            or main_entry.get("download") != new_download or main_entry.get("name") != new_name):
        main_entry["name"] = new_name
        main_entry["sha256"] = new_sha
        main_entry["size"] = new_size
        main_entry["download"] = new_download
        changed = True

    # Retire any entry whose window has passed.
    account_id = os.environ.get("CF_ACCOUNT_ID")
    api_token = os.environ.get("CF_R2_TOKEN")
    now = datetime.datetime.now(datetime.timezone.utc)
    kept = []
    for v in versions:
        retire_at = v.get("retire_at")
        if not retire_at:
            kept.append(v)
            continue
        retire_dt = datetime.datetime.strptime(retire_at, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=datetime.timezone.utc
        )
        if now < retire_dt:
            kept.append(v)
            continue
        if not account_id or not api_token:
            print(f"[ WARN ]: {v['name']} is past retire_at but CF_ACCOUNT_ID/CF_R2_TOKEN "
                  f"are not set -- leaving it in place.")
            kept.append(v)
            continue
        key = r2_key_from_download_url(v["download"])
        if delete_r2_object(key, account_id, api_token):
            print(f"[ INFO ]: Deleted retired ISO from R2 and table: {v['name']} ({key})")
            changed = True
        else:
            kept.append(v)  # retry next run
    versions = kept

    if changed:
        with open(VERSIONS_PATH, "w") as f:
            json.dump(versions, f, indent=2)
            f.write("\n")
        print("[ INFO ]: nicecore-versions.json updated.")
    else:
        print("[ INFO ]: No changes needed.")


if __name__ == "__main__":
    main()
