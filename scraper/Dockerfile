# Otopair Scrapling scraper — FastAPI + Scrapling (curl_cffi + Camoufox).
#
# The "http" tier needs no browser. The "stealth" tier drives Camoufox (a
# headless Firefox fork) which `scrapling install` downloads at build time; the
# apt packages below are its shared-library dependencies. Give the container
# >=1GB RAM for the browser tier.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080

# Camoufox / headless-Firefox runtime libraries.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget \
      libgtk-3-0 libx11-xcb1 libasound2 libdbus-glib-1-2 libxt6 \
      libxrandr2 libxcomposite1 libxdamage1 libxfixes3 libxcb1 \
      libpango-1.0-0 libcairo2 libgbm1 fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

# ── Browser for the stealth tier ────────────────────────────────────────────
#
# THIS STEP IS FATAL ON PURPOSE. It used to end in `|| true`, on the reasoning
# that an http-only deployment should still build if the browser download was
# unavailable. What that actually produced was an image whose stealth tier
# could never work, deployed and serving, reporting healthy — `/health` only
# ever checked the process was up. Every stealth call 502'd, and every `auto`
# call silently swallowed the escalation failure and returned the anti-bot wall
# it was escalating to get past (see /scrape). Live Aug 2026:
#
#   BrowserType.launch_persistent_context: Executable doesn't exist at
#   /root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome
#
# A build that cannot produce a working stealth tier must fail here, loudly,
# rather than ship a service that lies about being able to fetch.
#
# NOTE the browser is PATCHRIGHT CHROMIUM. `StealthyFetcher` in the installed
# Scrapling drives Patchright — a stealth-patched Playwright fork — which keeps
# its OWN chromium build under the same ms-playwright cache path. Installing
# plain Playwright's chromium is NOT sufficient and fails at runtime with:
#
#   Executable doesn't exist at .../ms-playwright/chromium-1228/...
#   Please run the following command to download new browsers:
#       patchright install
#
# (Nor is `scrapling install`, and the hand-listed Firefox libraries above were
# never what any of this wanted.) `--with-deps` pulls the browser's own OS
# packages, so those do not need maintaining by hand either.
RUN python -m patchright install --with-deps chromium

# Camoufox/browserforge assets, when this Scrapling build wants them. Non-fatal
# because the Playwright install above is the one the stealth tier depends on;
# this is belt-and-braces for versions that reach for Camoufox instead.
RUN python -m scrapling install || scrapling install || true

# Prove the browser can actually LAUNCH at build time, THROUGH PATCHRIGHT.
#
# Downloading a binary and being able to start it are different things
# (missing shared libraries surface only on launch), and this check is what
# stops a dead stealth tier reaching production.
#
# It must import `patchright`, not `playwright`. The first version of this
# check imported playwright, passed, and shipped an image whose runtime still
# 502'd — a verification that exercises a different library than production is
# not a verification. Same failure it was added to prevent, one layer up.
RUN python -c "\
from patchright.sync_api import sync_playwright; \
p = sync_playwright().start(); \
b = p.chromium.launch(headless=True); \
b.close(); p.stop(); \
print('[build] patchright chromium launch OK')"

COPY app.py .

EXPOSE 8080
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080}"]
