import json
from collections import defaultdict
from datetime import datetime

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt

with open("assets/data/download-stats.json") as f:
    stats = json.load(f)

by_date = defaultdict(lambda: {"free": 0, "paid": 0})
for row in stats.get("daily", []):
    tier = row.get("tier") if row.get("tier") == "paid" else "free"
    by_date[row["date"]][tier] += row.get("downloads", 0)

dates_sorted = sorted(by_date.keys())

if len(dates_sorted) < 2:
    # Not enough data yet -- draw a simple placeholder instead of failing.
    fig, ax = plt.subplots(figsize=(10, 5), dpi=150)
    ax.text(
        0.5,
        0.5,
        "Not enough data yet for a trend chart",
        ha="center",
        va="center",
        fontsize=14,
        color="#6b7280",
    )
    ax.axis("off")
    fig.savefig("assets/data/download-chart.png", facecolor="white", bbox_inches="tight")
else:
    xs = [datetime.strptime(d, "%Y-%m-%d") for d in dates_sorted]
    free = [by_date[d]["free"] for d in dates_sorted]
    paid = [by_date[d]["paid"] for d in dates_sorted]

    fig, ax = plt.subplots(figsize=(10, 5), dpi=150)
    ax.stackplot(xs, free, paid, colors=["#9aa0a6", "#1a2018"], labels=["Free", "Paid"])
    ax.set_title("pearOS Downloads — Last 30 Days", fontsize=15, fontweight="bold", color="#1a2018")
    ax.legend(loc="upper left", frameon=False)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
    ax.yaxis.set_major_locator(plt.MaxNLocator(integer=True))
    ax.set_facecolor("white")
    fig.autofmt_xdate()
    fig.savefig("assets/data/download-chart.png", facecolor="white", bbox_inches="tight")
