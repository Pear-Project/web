import json
import os
from collections import defaultdict


def edition_name(file):
    f = file.lower()
    if "nicec0re" in f:
        return "NiceC0re (Arch)"
    if "goldwing" in f:
        return "Debian (Goldwing)"
    if "bsd" in f:
        return "BSD"
    if "aarch64" in f or "raspberry" in f:
        return "aarch64"
    return None


with open("assets/data/download-stats.json") as f:
    stats = json.load(f)

by_edition = defaultdict(lambda: {"free": 0, "paid": 0})
for row in stats.get("by_file", []):
    name = edition_name(row["file"])
    if not name:
        continue
    tier = "paid" if row.get("tier") == "paid" else "free"
    by_edition[name][tier] += int(row.get("downloads", 0))

lines = []
lines.append("*pearOS — Daily Report*")
lines.append("")
lines.append("*Site status:*")
sites = [
    ("pearos.xyz", os.environ.get("S1", "?")),
    ("eqane.com", os.environ.get("S2", "?")),
    ("itpgog-valcea.com", os.environ.get("S3", "?")),
    ("alex.pearos.xyz", os.environ.get("S4", "?")),
    ("pear-software.com", os.environ.get("S5", "?")),
    ("crm.pear-software.com", os.environ.get("S6", "?")),
]
for name, status in sites:
    lines.append(f"{name}: *{status}*")

lines.append("")
lines.append("*Downloads:*")
lines.append(f"Total (all-time): *{stats.get('total_all_time', 0)}*")
lines.append(f"Last 30 days: *{stats.get('last_30d', 0)}*")
lines.append(f"Last 24 hours: *{stats.get('last_24h', 0)}*")

friend_all_time = stats.get("friend_all_time", 0)
friend_last_24h = stats.get("friend_last_24h", 0)
if friend_all_time:
    lines.append(f"Friends & family link: *{friend_all_time}* all-time (*{friend_last_24h}* in last 24h)")

if by_edition:
    lines.append("")
    lines.append("*By edition:*")
    for name in sorted(by_edition.keys()):
        d = by_edition[name]
        total = d["free"] + d["paid"]
        lines.append(f"_{name}_: *{total}* (free: {d['free']}, paid: {d['paid']})")

countries = [c for c in stats.get("by_country", []) if c.get("country")]
if countries:
    lines.append("")
    lines.append("*Top countries:*")
    for c in countries[:3]:
        lines.append(f"{c['country']}: *{c['downloads']}*")
    other_total = sum(c["downloads"] for c in countries[3:])
    if other_total:
        lines.append(f"Other: *{other_total}*")

referrers = [r for r in stats.get("by_referrer", []) if r.get("referrer")]
if referrers:
    lines.append("")
    lines.append("*Traffic sources:*")
    for r in referrers[:8]:
        label = "Direct" if r["referrer"] == "direct" else r["referrer"]
        lines.append(f"{label}: *{r['downloads']}*")

by_hour = stats.get("by_hour", [])
if by_hour:
    peak = max(by_hour, key=lambda h: h["downloads"])
    lines.append("")
    lines.append(f"*Peak hour (UTC):* {peak['hour']:02d}:00 — {peak['downloads']} downloads")

lines.append("")
lines.append(f"_Updated: {stats.get('generated_at', '?')}_")

print("\n".join(lines))
