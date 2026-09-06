#!/usr/bin/env python3
"""Flip pearos.xyz's apex DNS to the Cloudflare Pages mirror when GitHub
Pages is down, and revert once it recovers. Stateless: always re-derives
what to do from the DNS records' *current* content, the same way the
`pearos-failover` Cloudflare Worker does -- the two run independently
(this one inside a GitHub Actions job, the other entirely on Cloudflare) and
never conflict, since whichever notices first just makes the other's next
pass a no-op.
"""
import json
import os
import sys
import urllib.request

ZONE_ID = os.environ["CF_ZONE_ID"]
CF_API_TOKEN = os.environ["CF_API_TOKEN"]
RECORD_NAME = "pearos.xyz"
MIRROR_TARGET = "pearos-mirror.pages.dev"

# Static, documented GitHub Pages IPs for pearos.xyz's normal (non-failover) state.
GH_PAGES_IPS = ["185.199.108.153", "185.199.109.153", "185.199.110.153", "185.199.111.153"]
GH_PAGES_IPS_V6 = [
    "2606:50c0:8000::153",
    "2606:50c0:8001::153",
    "2606:50c0:8002::153",
    "2606:50c0:8003::153",
]

# Always resolves through GitHub's own infra -- GitHub Pages redirects this
# to the custom domain (pearos.xyz) when a CNAME file is present, so a 3xx
# here (not a connection failure or 5xx) proves the GH Pages origin itself
# is alive, independent of whatever pearos.xyz's DNS currently points at.
GH_PAGES_HEALTH_URL = "https://pear-project.github.io/web/"


def cf_api(path, method="GET", body=None):
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {CF_API_TOKEN}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req) as resp:
        data = json.load(resp)
    if not data.get("success"):
        raise RuntimeError(f"Cloudflare API error on {path}: {data.get('errors')}")
    return data


def is_gh_pages_healthy():
    req = urllib.request.Request(GH_PAGES_HEALTH_URL, method="GET")
    try:
        opener = urllib.request.build_opener(NoRedirect)
        resp = opener.open(req, timeout=15)
        return 200 <= resp.status < 500
    except urllib.error.HTTPError as e:
        return 200 <= e.code < 500
    except Exception:
        return False


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def get_apex_records():
    data = cf_api(f"/zones/{ZONE_ID}/dns_records?name={RECORD_NAME}")
    # The apex also carries MX (mail) and TXT (SPF, google/zoho verification)
    # records -- those must never be touched. Only ever act on the records
    # that actually route web traffic (A/AAAA normally, or our own failover
    # CNAME).
    return [r for r in data["result"] if r["type"] in ("A", "AAAA", "CNAME")]


def delete_records(records):
    for r in records:
        cf_api(f"/zones/{ZONE_ID}/dns_records/{r['id']}", method="DELETE")


def fail_over(records):
    print("GitHub Pages is down -- failing over to Cloudflare Pages mirror")
    delete_records(records)
    cf_api(
        f"/zones/{ZONE_ID}/dns_records",
        method="POST",
        body={"type": "CNAME", "name": RECORD_NAME, "content": MIRROR_TARGET, "proxied": True, "ttl": 1},
    )


def restore_github_pages(records):
    print("GitHub Pages has recovered -- restoring its DNS records")
    delete_records(records)
    for ip in GH_PAGES_IPS:
        cf_api(
            f"/zones/{ZONE_ID}/dns_records",
            method="POST",
            body={"type": "A", "name": RECORD_NAME, "content": ip, "proxied": True, "ttl": 1},
        )
    for ip in GH_PAGES_IPS_V6:
        cf_api(
            f"/zones/{ZONE_ID}/dns_records",
            method="POST",
            body={"type": "AAAA", "name": RECORD_NAME, "content": ip, "proxied": True, "ttl": 1},
        )


def main():
    healthy = is_gh_pages_healthy()
    records = get_apex_records()
    failed_over = any(r["type"] == "CNAME" for r in records)

    if not healthy and not failed_over:
        fail_over(records)
    elif healthy and failed_over:
        restore_github_pages(records)
    else:
        print(f"No action needed (healthy={healthy}, failed_over={failed_over})")


if __name__ == "__main__":
    main()
