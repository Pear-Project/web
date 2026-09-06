import os
import sys

MIRROR_URL = "https://pearos-mirror.pages.dev/"
SITE_URL = "https://pearos.xyz/"

status = sys.argv[1]  # "up" or "down", decided by the shell check before this runs

if status == "down":
    msg = (
        "*pearOS SITE DOWN*\n\n"
        f"{SITE_URL} is not responding (checked from GitHub Actions).\n\n"
        "This does not affect in-progress downloads on iso.pearos.xyz -- only new "
        "visits to the main site.\n\n"
        f"Cloudflare Pages mirror (same content, always kept in sync): {MIRROR_URL}\n\n"
        "To fail over: point pearos.xyz's DNS at the mirror instead of GitHub Pages "
        "until GitHub Pages recovers."
    )
else:
    msg = f"*pearOS site recovered*\n\n{SITE_URL} is responding normally again."

print(msg)
with open(os.environ["GITHUB_ENV"], "a") as f:
    f.write("ALERT_MESSAGE<<EOF\n" + msg + "\nEOF\n")
