import json
import os
from collections import defaultdict

# Matches pearos-dl's own CURRENCY_CONFIG (cloudflare/pearos-dl/src/index.js)
# and the /stats/ page's CURRENCY_SYMBOLS -- just the display symbol, since
# /revenue already reports amounts in each charge's own currency.
CURRENCY_SYMBOLS = {"usd": "$", "eur": "€", "gbp": "£", "inr": "₹", "brl": "R$"}


def format_money(amount_cents, currency):
    symbol = CURRENCY_SYMBOLS.get(currency, f"{currency.upper()} ")
    return f"{symbol}{amount_cents / 100:,.2f}"


# Approximate, manually-maintained EUR rates -- matches stats/index.html's
# EUR_RATES and pearos-dl's own CURRENCY_CONFIG approach for non-parity
# currencies. Not a live FX rate; only used for the one combined total line.
EUR_RATES = {"usd": 0.92, "eur": 1, "gbp": 1.16, "inr": 0.011, "brl": 0.17}


def sum_in_eur_cents(bucket):
    total = 0
    for cur, v in (bucket or {}).items():
        rate = EUR_RATES.get(cur)
        if rate is None:
            continue
        total += (v.get("amount_cents", 0) or 0) * rate
    return total


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
total_paid = 0
total_free = 0
for row in stats.get("by_file", []):
    name = edition_name(row["file"])
    if not name:
        continue
    n = int(row.get("downloads", 0))
    tier = "paid" if row.get("tier") == "paid" else "free"
    by_edition[name][tier] += n
    if tier == "paid":
        total_paid += n
    else:
        total_free += n

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

conversion_total = total_paid + total_free
if conversion_total:
    pct = total_paid / conversion_total * 100
    lines.append(f"Paid conversion: *{pct:.2f}%* ({total_paid} paid of {conversion_total})")

friend_all_time = stats.get("friend_all_time", 0)
friend_last_24h = stats.get("friend_last_24h", 0)
if friend_all_time:
    lines.append(f"Friends & family link: *{friend_all_time}* all-time (*{friend_last_24h}* in last 24h)")

donations = stats.get("donations") or {}
all_time_rev = donations.get("all_time") or {}
last_30d_rev = donations.get("last_30d") or {}
if all_time_rev:
    lines.append("")
    lines.append("*Donations revenue:*")
    for cur in sorted(all_time_rev.keys(), key=lambda c: all_time_rev[c].get("amount_cents", 0), reverse=True):
        at = all_time_rev.get(cur, {"amount_cents": 0, "count": 0})
        d30 = last_30d_rev.get(cur, {"amount_cents": 0, "count": 0})
        lines.append(
            f"{cur.upper()}: *{format_money(at['amount_cents'], cur)}* all-time "
            f"({format_money(d30['amount_cents'], cur)} last 30d, {at['count']} donations)"
        )

ad_revenue = stats.get("ad_revenue") or {}
ad_all_time = ad_revenue.get("all_time") or {}
ad_30d = ad_revenue.get("last_30d") or {}
if ad_all_time:
    lines.append("")
    lines.append("*Ad revenue (Ezoic):*")
    ad_at_usd = ad_all_time.get("usd", {"amount_cents": 0})["amount_cents"]
    ad_30d_usd = ad_30d.get("usd", {"amount_cents": 0})["amount_cents"]
    lines.append(f"USD: *{format_money(ad_at_usd, 'usd')}* all-time ({format_money(ad_30d_usd, 'usd')} last 30d)")

if all_time_rev or ad_all_time:
    total_eur_cents = sum_in_eur_cents(all_time_rev) + sum_in_eur_cents(ad_all_time)
    lines.append(f"*Total revenue (EUR, approx.):* {format_money(total_eur_cents, 'eur')}")

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
    for r in referrers[:3]:
        label = "Direct" if r["referrer"] == "direct" else r["referrer"]
        lines.append(f"{label}: *{r['downloads']}*")
    other_ref_total = sum(r["downloads"] for r in referrers[3:])
    if other_ref_total:
        lines.append(f"Other: *{other_ref_total}*")

by_hour = stats.get("by_hour", [])
if by_hour:
    peak = max(by_hour, key=lambda h: h["downloads"])
    lines.append("")
    lines.append(f"*Peak hour (UTC):* {peak['hour']:02d}:00 — {peak['downloads']} downloads")

lines.append("")
lines.append(f"_Updated: {stats.get('generated_at', '?')}_")

message = "\n".join(lines)

# Whatser's API hard-rejects anything over 1000 characters (confirmed: a
# real run silently "succeeded" in CI while the API actually returned a
# validation error, because the curl call didn't check the response body).
# Trimming a couple of list sections keeps this under that in practice, but
# truncate as a last resort instead of risking another silently-dropped
# report if the data grows further.
MAX_LEN = 1000
if len(message) > MAX_LEN:
    suffix = "\n… (truncated)"
    message = message[: MAX_LEN - len(suffix)] + suffix

print(message)
