import json
from collections import defaultdict
from datetime import datetime

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt

# Matches the site's own dark-mode CSS tokens (assets/css/*.css, .dark {...})
# so the chart sent over WhatsApp looks like it belongs to pearOS, not a
# generic default matplotlib plot.
BG = "#002b28"
FG = "#efefe9"
MUTED = "#acb0a2"
GRID = "#efefe930"

# Matches pearos-dl's own CURRENCY_CONFIG (cloudflare/pearos-dl/src/index.js)
# -- just the display symbol, since /revenue reports amounts in each charge's
# own currency rather than converting anything.
CURRENCY_SYMBOLS = {"usd": "$", "eur": "€", "gbp": "£", "inr": "₹", "brl": "R$"}


def format_money(amount_cents, currency):
    symbol = CURRENCY_SYMBOLS.get(currency, f"{currency.upper()} ")
    return f"{symbol}{amount_cents / 100:,.2f}"


with open("assets/data/download-stats.json") as f:
    stats = json.load(f)

# Four fixed series, matching /stats/'s own CHART_SERIES exactly (same
# colors too) -- each edition/tier plotted as its own line, not stacked, so
# a tiny paid count is never buried under a much bigger free count sharing
# one band. Previously this stacked all editions' Free+Paid into one area,
# which didn't match what the site itself shows.
SERIES = [
    {"id": "nicecore_free", "match": "nicec0re", "tier": "free", "label": "NiceC0re — Free", "color": "#5c6b64"},
    {"id": "nicecore_paid", "match": "nicec0re", "tier": "paid", "label": "NiceC0re — Paid", "color": "#cbef63"},
    {"id": "debian_free", "match": "goldwing", "tier": "free", "label": "Debian — Free", "color": "#3b82f6"},
    {"id": "debian_paid", "match": "goldwing", "tier": "paid", "label": "Debian — Paid", "color": "#f59e0b"},
]

by_date_series = defaultdict(lambda: defaultdict(int))
for row in stats.get("daily", []):
    file_lower = (row.get("file") or "").lower()
    tier = "paid" if row.get("tier") == "paid" else "free"
    for series in SERIES:
        if series["match"] in file_lower and series["tier"] == tier:
            by_date_series[row["date"]][series["id"]] += row.get("downloads", 0)
            break

dates_sorted = sorted(by_date_series.keys())

# Revenue is a rolling-window snapshot from Stripe (not a daily series like
# downloads are), so it's shown as a subtitle line rather than plotted -- a
# second axis for ~5 currencies with wildly different magnitudes (a few cents
# of INR next to tens of USD) would be more confusing than useful.
donations = stats.get("donations") or {}
all_time_rev = donations.get("all_time") or {}
last_30d_rev = donations.get("last_30d") or {}
ad_revenue = stats.get("ad_revenue") or {}
ad_all_time = ad_revenue.get("all_time") or {}
ad_30d = ad_revenue.get("last_30d") or {}

subtitle_parts = []
if all_time_rev:
    currencies = sorted(all_time_rev.keys(), key=lambda c: all_time_rev[c].get("amount_cents", 0), reverse=True)
    donation_parts = [
        f"{format_money(all_time_rev[c]['amount_cents'], c)} all-time "
        f"({format_money(last_30d_rev.get(c, {'amount_cents': 0})['amount_cents'], c)} last 30d)"
        for c in currencies
    ]
    subtitle_parts.append("Donations: " + "  ·  ".join(donation_parts))
if ad_all_time:
    ad_at_usd = ad_all_time.get("usd", {"amount_cents": 0})["amount_cents"]
    ad_30d_usd = ad_30d.get("usd", {"amount_cents": 0})["amount_cents"]
    subtitle_parts.append(f"Ads: {format_money(ad_at_usd, 'usd')} all-time ({format_money(ad_30d_usd, 'usd')} last 30d)")

donations_subtitle = None
if subtitle_parts:
    # matplotlib's mathtext parser treats a bare "$" as a math-mode delimiter
    # (mangling the text into garbled italics/minus-signs) unless it's escaped.
    donations_subtitle = "   |   ".join(subtitle_parts).replace("$", r"\$")

fig, ax = plt.subplots(figsize=(10, 5), dpi=150)
fig.patch.set_facecolor(BG)
ax.set_facecolor(BG)

if len(dates_sorted) < 2:
    # Not enough data yet -- draw a simple placeholder instead of failing.
    ax.text(
        0.5,
        0.5,
        "Not enough data yet for a trend chart",
        ha="center",
        va="center",
        fontsize=14,
        color=MUTED,
    )
    ax.axis("off")
else:
    xs = [datetime.strptime(d, "%Y-%m-%d") for d in dates_sorted]

    for series in SERIES:
        ys = [by_date_series[d].get(series["id"], 0) for d in dates_sorted]
        ax.plot(xs, ys, color=series["color"], linewidth=2, label=series["label"])
    # Two separate axes-anchored texts (not fig.suptitle, which interacts
    # unpredictably with bbox_inches="tight" -- it can end up rendered below
    # an axes-level title instead of above it). The subtitle sits just above
    # the axes edge; the title's extra pad keeps it further up, above that.
    ax.set_title(
        "pearOS Downloads — Last 30 Days",
        fontsize=16,
        fontweight="semibold",
        color=FG,
        pad=28 if donations_subtitle else 16,
    )
    if donations_subtitle:
        ax.text(0.5, 1.03, donations_subtitle, transform=ax.transAxes, ha="center", va="bottom", fontsize=10.5, color=MUTED)

    # Anchored outside the axes (to the right) rather than "upper left"
    # inside the plot -- with 4 lines instead of 2 stacked bands, an inline
    # legend box collided with the NiceC0re line and the y-axis labels.
    # bbox_inches="tight" at save time expands the canvas to fit it.
    legend = ax.legend(loc="upper left", bbox_to_anchor=(1.02, 1), borderaxespad=0, frameon=False, labelcolor=FG, fontsize=11)

    for spine in ax.spines.values():
        spine.set_visible(False)

    ax.grid(axis="y", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)

    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
    ax.yaxis.set_major_locator(plt.MaxNLocator(integer=True, nbins=6))
    ax.tick_params(axis="both", colors=MUTED, labelsize=10, length=0)

    fig.autofmt_xdate(rotation=0, ha="center")

fig.savefig("assets/data/download-chart.png", facecolor=BG, bbox_inches="tight", dpi=150)
