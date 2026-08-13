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

# Download Camoufox + browser deps for the stealth tier. Kept non-fatal so an
# http-only deployment still builds if the browser fetch is unavailable.
RUN python -m scrapling install || scrapling install || true

COPY app.py .

EXPOSE 8080
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080}"]
