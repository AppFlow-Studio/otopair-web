"""
Otopair self-hosted Scrapling scraper.

A tiny FastAPI wrapper around Scrapling that the Convex enrichment pipeline can
call as a cheaper alternative / browser-fallback to Firecrawl. It exposes one
endpoint, POST /scrape, that returns the page HTML and (optionally) markdown.

Two fetch tiers:
  - "http"    curl_cffi TLS impersonation (free, fast, no browser)
  - "stealth" Camoufox headless browser (handles TLS-blocking / JS sites)
  - "auto"    try http first, escalate to stealth if it looks blocked/short

Run locally:
    python3 -m venv ~/.venvs/scrapling && source ~/.venvs/scrapling/bin/activate
    pip install -r requirements.txt
    scrapling install          # downloads Camoufox for the stealth tier
    uvicorn app:app --reload --port 8080

Auth: if SCRAPLING_TOKEN is set, callers must send `Authorization: Bearer <token>`.
"""

from __future__ import annotations

import os
from typing import Optional

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

try:
    from markdownify import markdownify as _md
except Exception:  # markdownify is optional — html still returned without it
    _md = None

app = FastAPI(title="Otopair Scrapling scraper", version="1.0.0")

AUTH_TOKEN = os.environ.get("SCRAPLING_TOKEN", "").strip()
# A page shorter than this (or that redirected home) is treated as a miss so
# "auto" mode escalates to the browser tier — mirrors the pipeline's guard.
MIN_OK_CHARS = 1000


class ScrapeRequest(BaseModel):
    url: str
    mode: str = "http"  # "http" | "stealth" | "auto"
    timeout_ms: int = 45_000
    formats: list[str] = ["markdown", "html"]


class ScrapeResponse(BaseModel):
    url: str
    status: int
    mode: str
    html: Optional[str] = None
    markdown: Optional[str] = None


def _check_auth(authorization: Optional[str]) -> None:
    if AUTH_TOKEN and authorization != f"Bearer {AUTH_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")


def _extract(page) -> tuple[int, str]:
    """Pull (status, html) from a Scrapling response across library versions."""
    html = (
        getattr(page, "html_content", None)
        or getattr(page, "body", None)
        or (str(page) if page is not None else "")
    )
    if isinstance(html, bytes):
        html = html.decode("utf-8", "ignore")
    status = getattr(page, "status", None) or getattr(page, "status_code", None) or 200
    try:
        status = int(status)
    except (TypeError, ValueError):
        status = 200
    return status, html or ""


def _fetch_http(url: str, timeout_s: int):
    from scrapling.fetchers import Fetcher

    return Fetcher.get(
        url,
        stealthy_headers=True,
        follow_redirects=True,
        timeout=timeout_s,
    )


def _fetch_stealth(url: str, timeout_ms: int):
    from scrapling.fetchers import StealthyFetcher

    return StealthyFetcher.fetch(
        url,
        headless=True,
        network_idle=True,
        timeout=timeout_ms,
    )


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/scrape", response_model=ScrapeResponse)
def scrape(req: ScrapeRequest, authorization: Optional[str] = Header(default=None)):
    _check_auth(authorization)
    timeout_s = max(5, req.timeout_ms // 1000)

    used = req.mode
    try:
        if req.mode == "stealth":
            page = _fetch_stealth(req.url, req.timeout_ms)
        else:
            page = _fetch_http(req.url, timeout_s)
            status, html = _extract(page)
            # "auto" escalates to the browser tier when the cheap fetch looks
            # blocked, empty, or bounced to a homepage.
            if req.mode == "auto" and (
                status >= 400 or len(html.strip()) < MIN_OK_CHARS
            ):
                page = _fetch_stealth(req.url, req.timeout_ms)
                used = "stealth"
    except Exception as e:  # never leak a stack trace to the caller
        raise HTTPException(status_code=502, detail=f"fetch failed: {e}")

    status, html = _extract(page)
    out = ScrapeResponse(url=req.url, status=status, mode=used)
    if "html" in req.formats:
        out.html = html
    if "markdown" in req.formats:
        out.markdown = _md(html) if (html and _md) else None
    return out
