"""
Otopair self-hosted Scrapling scraper.

A tiny FastAPI wrapper around Scrapling that the Convex enrichment pipeline can
call as a cheaper alternative / browser-fallback to Firecrawl. It exposes
POST /scrape, which returns the page HTML and (optionally) markdown, and
POST /fetch, which is a raw-BYTE passthrough (see below).

Two fetch tiers:
  - "http"    curl_cffi TLS impersonation (free, fast, no browser)
  - "stealth" Camoufox headless browser (handles TLS-blocking / JS sites)
  - "auto"    try http first, escalate to stealth if it looks blocked/short

WHY /fetch EXISTS (Aug 13 2026)
------------------------------
/scrape HTML-parses whatever it retrieves and hands back text, which destroys a
PDF. That was fine until the manual pipeline turned out to be blocked at the
NETWORK layer rather than the source layer: four owner's-manual URLs that Convex
logged as `dealereprocess:http_403` (2019 Sierra, 2021 CX-30, 2020 Grand
Cherokee, 2022 Palisade) all return 206 + application/pdf from a workstation,
and probing from inside Convex with three header variants returned Cloudflare
403 HTML every time. It is an IP-range block on Convex's egress, not a dead CDN
and not a request-shape problem — so 11 of the 12 makes with a deterministic
manual path were unreachable while we logged the wall and moved on.

This service already runs somewhere else with a different egress IP, so it is
the proxy. /fetch streams the upstream bytes back UNPARSED, with the upstream
status and content headers preserved, so the caller's existing probe/download
code works against it unchanged.

Run locally:
    python3 -m venv ~/.venvs/scrapling && source ~/.venvs/scrapling/bin/activate
    pip install -r requirements.txt
    scrapling install          # downloads Camoufox for the stealth tier
    uvicorn app:app --reload --port 8080

Auth: if SCRAPLING_TOKEN is set, callers must send `Authorization: Bearer <token>`.
"""

from __future__ import annotations

import os
import re
from typing import Optional

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
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

# Hard ceiling on a /fetch body, whatever the caller asks for. The Convex action
# runtime dies at 64 MB and its manual path already refuses anything over 20 MB,
# so buffering more here could only ever produce a response the caller must throw
# away — and this service scales to zero on a small machine.
FETCH_MAX_BYTES = 24 * 1024 * 1024
FETCH_DEFAULT_TIMEOUT_MS = 60_000

# Anti-bot interstitials are the case the stealth tier exists for, and a length
# floor alone does not catch them: a Cloudflare challenge is typically 2-5 KB of
# real HTML and often answers 200, so it cleared both guards and got returned as
# a successful scrape. Keep these patterns narrow — vendor internals and exact
# title strings, never prose a real page might contain — because a false positive
# escalates a page we already had to the slow browser tier for nothing.
BLOCK_SIGNATURES = [
    re.compile(p, re.I)
    for p in (
        r"_cf_chl_opt",
        r"challenge-platform",
        r"\bcf-chl-",
        r"<title>\s*Just a moment",
        r"Checking your browser before accessing",
        r"Attention Required!\s*\|\s*Cloudflare",
        r"DDoS protection by\s*Cloudflare",
        r"_Incapsula_Resource",
        r"PerimeterX|px-captcha",
        r"Enable JavaScript and cookies to continue",
    )
]


def _looks_blocked(html: str) -> bool:
    """True when the body is an anti-bot challenge rather than the page."""
    head = html[:4000]
    return any(rx.search(head) for rx in BLOCK_SIGNATURES)


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
    # Post-redirect URL when the library exposes it. Adapters that decide what a
    # page IS from where they landed (a model page bouncing to a category index)
    # need this; without it they have to stay on the direct tier.
    final_url: Optional[str] = None
    # True when the returned body tripped the challenge detector. The caller
    # treats it as a miss — surfaced rather than hidden so a wall shows up as a
    # wall in logs instead of as thin extraction downstream.
    blocked: bool = False


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
def health(deep: bool = False):
    """Liveness, and optionally whether the STEALTH TIER actually works.

    The shallow answer is process liveness and nothing more. That is what Fly's
    check calls, and on its own it is what let a container with no browser
    binary sit in production reporting `{"ok": true}` while every stealth call
    502'd and every `auto` call silently returned the anti-bot wall it was
    escalating to get past.

    `?deep=1` launches the browser. It is deliberately NOT the Fly check —
    starting Chromium on every interval would dominate the memory budget of a
    1-shared-CPU machine — but it is what a deploy should be verified with, and
    what to hit first when the stealth tier looks broken:

        curl "$SCRAPLING_URL/health?deep=1"

    `browser: "ok"` means a page can actually be opened. Anything else names
    the failure instead of hiding it.
    """
    if not deep:
        return {"ok": True}
    try:
        # patchright, NOT playwright — StealthyFetcher drives Patchright and it
        # keeps a separate chromium build. A deep check against the wrong
        # library reports healthy while the stealth tier is dead.
        from patchright.sync_api import sync_playwright

        pw = sync_playwright().start()
        try:
            browser = pw.chromium.launch(headless=True)
            browser.close()
        finally:
            pw.stop()
        return {"ok": True, "browser": "ok"}
    except Exception as e:  # noqa: BLE001 - the message IS the diagnostic
        return {"ok": False, "browser": "unavailable", "error": str(e)[:400]}


@app.post("/scrape", response_model=ScrapeResponse)
def scrape(req: ScrapeRequest, authorization: Optional[str] = Header(default=None)):
    _check_auth(authorization)
    timeout_s = max(5, req.timeout_ms // 1000)

    used = req.mode
    try:
        if req.mode == "stealth":
            page = _fetch_stealth(req.url, req.timeout_ms)
            status, html = _extract(page)
        else:
            page = _fetch_http(req.url, timeout_s)
            status, html = _extract(page)
            # "auto" escalates to the browser tier when the cheap fetch looks
            # blocked, empty, or bounced to a homepage. The challenge check is
            # the important one: a Cloudflare interstitial is long enough and
            # often 200, so the size/status guards alone let it straight through.
            if req.mode == "auto" and (
                status >= 400
                or len(html.strip()) < MIN_OK_CHARS
                or _looks_blocked(html)
            ):
                # The rescue rung must never destroy the page it is rescuing:
                # if the browser tier throws (Camoufox/browserforge failures
                # arrive as exceptions, not bad pages), keep the http-tier
                # result — the status/blocked fields already tell the caller
                # what it is, and a 502 here would discard a real answer.
                try:
                    page = _fetch_stealth(req.url, req.timeout_ms)
                    used = "stealth"
                    status, html = _extract(page)
                except Exception as e:
                    print(f"[scrape] stealth escalation failed for {req.url}: {e}")
                    used = "http"
    except Exception as e:  # never leak a stack trace to the caller
        raise HTTPException(status_code=502, detail=f"fetch failed: {e}")

    out = ScrapeResponse(
        url=req.url,
        status=status,
        mode=used,
        final_url=getattr(page, "url", None) or req.url,
        blocked=_looks_blocked(html),
    )
    if "html" in req.formats:
        out.html = html
    if "markdown" in req.formats:
        out.markdown = _md(html) if (html and _md) else None
    return out


# ── Raw-byte passthrough ─────────────────────────────────────────────────────


class FetchRequest(BaseModel):
    url: str
    timeout_ms: int = FETCH_DEFAULT_TIMEOUT_MS
    # Verbatim Range header, e.g. "bytes=0-2047". The manual pipeline PROBES with
    # a 2 KB range before committing to a 40 MB download, and that probe is the
    # single most common call here — passing the range through keeps it cheap
    # instead of pulling whole manuals to read a magic number.
    range: Optional[str] = None
    accept: str = "*/*"
    referer: Optional[str] = None
    # 0 = the service ceiling. Capped to FETCH_MAX_BYTES either way.
    max_bytes: int = 0


def _ascii_header(value: Optional[str]) -> Optional[str]:
    """Header values cross an ASCII-only boundary; drop anything that would
    raise on encode rather than failing the whole response for a stray byte."""
    if not value:
        return None
    cleaned = "".join(ch for ch in value if 32 <= ord(ch) < 127).strip()
    return cleaned[:200] or None


@app.post("/fetch")
def fetch(req: FetchRequest, authorization: Optional[str] = Header(default=None)):
    """Fetch a URL and return its bytes UNPARSED, for callers whose own egress is
    blocked (see the module docstring).

    Contract, and it is deliberately the same one /scrape follows: a non-2xx from
    the TARGET is not a failure of this service. It comes back as HTTP 200 with
    the real code in `X-Upstream-Status`, so the caller can tell "the CDN refused
    us" apart from "the proxy is down" — the distinction that cost us 11 makes
    when a 403 was recorded as a dead source. Only a transport failure here is a
    5xx.

    Upstream `Content-Type` and `Content-Range` are echoed under their own names
    so a caller that already reads them from a direct fetch needs no new code.
    """
    _check_auth(authorization)

    cap = FETCH_MAX_BYTES if req.max_bytes <= 0 else min(req.max_bytes, FETCH_MAX_BYTES)
    timeout_s = max(5, req.timeout_ms // 1000)

    headers = {"Accept": req.accept or "*/*"}
    if req.range:
        headers["Range"] = req.range
    if req.referer:
        headers["Referer"] = req.referer

    try:
        from curl_cffi import requests as cffi_requests

        # impersonate= is the entire point: it is the TLS/JA3 handshake, not the
        # User-Agent, that Cloudflare fingerprints. A spoofed UA over a Python
        # handshake is exactly what got refused from Convex.
        r = cffi_requests.get(
            req.url,
            headers=headers,
            impersonate="chrome",
            timeout=timeout_s,
            allow_redirects=True,
            stream=True,
        )
    except Exception as e:  # never leak a stack trace to the caller
        raise HTTPException(status_code=502, detail=f"fetch failed: {e}")

    truncated = False
    try:
        chunks: list[bytes] = []
        total = 0
        iter_content = getattr(r, "iter_content", None)
        if iter_content is None:
            # Older/newer curl_cffi without streaming — take the whole body and
            # trim. Correctness over memory; the cap still bounds what we return.
            body = r.content or b""
            if len(body) > cap:
                body, truncated = body[:cap], True
            chunks, total = [body], len(body)
        else:
            # STRICTLY greater, not >=. A ranged probe asks for exactly
            # max_bytes and gets exactly max_bytes; stopping at == would flag
            # every one of them as truncated, and the download path treats that
            # flag as "this is half a document" and throws the fetch away.
            # Truncated must mean "there was more and we stopped".
            for chunk in iter_content(chunk_size=256 * 1024):
                if not chunk:
                    continue
                chunks.append(chunk)
                total += len(chunk)
                if total > cap:
                    truncated = True
                    break
        body = b"".join(chunks)[:cap]
        if len(body) < total:
            truncated = True
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"read failed: {e}")
    finally:
        try:
            r.close()
        except Exception:
            pass

    upstream = getattr(r, "status_code", None) or getattr(r, "status", None) or 0
    try:
        upstream = int(upstream)
    except (TypeError, ValueError):
        upstream = 0

    up_headers = getattr(r, "headers", {}) or {}

    def up(name: str) -> Optional[str]:
        try:
            return _ascii_header(up_headers.get(name))
        except Exception:
            return None

    out_headers = {
        "X-Upstream-Status": str(upstream),
        "X-Upstream-Url": _ascii_header(getattr(r, "url", None) or req.url) or req.url,
        "X-Proxy-Truncated": "1" if truncated else "0",
    }
    for name, header in (
        ("content-range", "Content-Range"),
        ("content-length", "X-Upstream-Content-Length"),
        ("server", "X-Upstream-Server"),
    ):
        value = up(name)
        if value:
            out_headers[header] = value

    return Response(
        content=body,
        # A challenge page arrives as text/html; passing the real type through is
        # what lets the caller's PDF gate reject it for the right reason.
        media_type=up("content-type") or "application/octet-stream",
        headers=out_headers,
    )
