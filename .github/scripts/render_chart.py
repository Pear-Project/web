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
FREE_COLOR = "#5c6b64"
PAID_COLOR = "#cbef63"
GRID = "#efefe930"

with open("assets/data/download-stats.json") as f:
    stats = json.load(f)

by_date = defaultdict(lambda: {"free": 0, "paid": 0})
for row in stats.get("daily", []):
    tier = row.get("tier") if row.get("tier") == "paid" else "free"
    by_date[row["date"]][tier] += row.get("downloads", 0)

dates_sorted = sorted(by_date.keys())

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
    free = [by_date[d]["free"] for d in dates_sorted]
    paid = [by_date[d]["paid"] for d in dates_sorted]

    ax.stackplot(
        xs,
        free,
        paid,
        colors=[FREE_COLOR, PAID_COLOR],
        alpha=0.85,
        labels=["Free", "Paid"],
    )
    ax.set_title("pearOS Downloads — Last 30 Days", fontsize=16, fontweight="semibold", color=FG, pad=16)

    legend = ax.legend(loc="upper left", frameon=False, labelcolor=FG, fontsize=11)

    for spine in ax.spines.values():
        spine.set_visible(False)

    ax.grid(axis="y", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)

    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
    ax.yaxis.set_major_locator(plt.MaxNLocator(integer=True, nbins=6))
    ax.tick_params(axis="both", colors=MUTED, labelsize=10, length=0)

    fig.autofmt_xdate(rotation=0, ha="center")

fig.savefig("assets/data/download-chart.png", facecolor=BG, bbox_inches="tight", dpi=150)
