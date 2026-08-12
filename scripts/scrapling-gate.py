"""RevolutionParts catalog gate probe — Firecrawl (standard / stealth proxy) vs
Scrapling (fast-HTTP impersonation / stealth browser) on registry-generated
*.oempartsonline.com part pages.

UC2 decision gate of the Scrapling adoption plan: quantifies how often Firecrawl
standard is blocked (stealth credits burned), and whether self-hosted Scrapling
matches Firecrawl-stealth success within budget. Writes per-URL raw JSON to
reports/scrapling-gate/raw/ and a summary to reports/scrapling-gate/summary.json;
the human-readable verdict is authored separately in
reports/scrapling_vs_firecrawl_probe_2026-07-28.md.

Run (venv python — Scrapling lives there, not in the repo):
  %USERPROFILE%\\.venvs\\scrapling\\Scripts\\python.exe scripts/scrapling-gate.py
Options: --skip-firecrawl (no FIRECRAWL_API_KEY / zero credits), --limit N

Naming note: "olp" is reserved for the openlaborproject probe — this is "rp"
(RevolutionParts) / scrapling tooling.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from statistics import median

REPO = Path(__file__).resolve().parent.parent
RAW_DIR = REPO / "reports" / "scrapling-gate" / "raw"
SUMMARY_PATH = REPO / "reports" / "scrapling-gate" / "summary.json"

FIRECRAWL_BASE = "https://api.firecrawl.dev/v2"
REQUEST_GAP_S = 1.5  # politeness gap between every outbound request
FC_TIMEOUT_MS = 40_000
SCRAPLING_TIMEOUT_MS = 30_000

# Batch-validated vehicles on OLP-subdomain makes (year, make, subdomain, model_slug).
# Slugs follow sourceRegistry.ts modelTrimSlug ("Forester", "Touring" -> forester_touring;
# "F-150" -> f150). URL template mirrors oemPartsOnlineConfig.yearSpecificUrl.
VEHICLES = [
    (2019, "subaru", "subaru", "forester_touring"),
    (2021, "hyundai", "hyundai", "tucson_ultimate"),
    (2017, "nissan", "nissan", "rogue_sv"),
    (2006, "ford", "ford", "f150_lariat"),
    (2024, "chevrolet", "g", "equinox_premier"),
]
PART_SLUGS = ["oil_filter", "brake_pads", "cabin_air_filter", "spark_plug"]

# Content-quality markers mirroring the pipeline's deterministic parse:
# priceParser.ts reads .price-section-price / .product-sale-price (never -retail/-save);
# scraper.ts parses JSON-LD Product blocks; RP part pages carry a "This Part Fits" table.
RE_PRICE = re.compile(r"price-section-price|product-sale-price", re.I)
RE_JSONLD = re.compile(r'application/ld\+json|"@type"\s*:\s*"Product"', re.I)
RE_FITMENT = re.compile(r"this part fits|vehicle-fitment|\bfitment\b", re.I)
RE_CHALLENGE = re.compile(
    r"just a moment|cf-chl|challenge-platform|attention required|access denied"
    r"|verify you are a human|captcha|pardon our interruption", re.I)
RE_TITLE = re.compile(r"<title>([^<]*)</title>", re.I)
# Storefront homepage title: "Online Subaru Parts Superstore | OEM Parts Online".
# Unresolved category slugs 30x-chain to the homepage, which itself contains
# featured-product price markers — without this check, redirect rot would be
# misclassified as success (verified live Jul 28 2026 on the subaru subdomain).
RE_HOME_TITLE = re.compile(r"^Online .*Superstore", re.I)


def classify(status, html, title, final_url):
    body = html or ""
    if status == 404:
        return "not_found"
    if RE_CHALLENGE.search(body[:20000]):
        return "blocked"
    if status is not None and status >= 400:
        return "blocked"
    if title and RE_HOME_TITLE.match(title.strip()):
        return "redirected_home"
    if final_url and final_url.rstrip("/").count("/") <= 2:  # scheme://host only
        return "redirected_home"
    quality = bool(RE_PRICE.search(body) or RE_JSONLD.search(body))
    if quality:
        return "success"
    if len(body) < 1000:
        return "blocked_thin"
    return "partial"  # substantial body but none of the catalog markers


def leg_result(via, status, html, ms, err=None, extra=None, final_url=None):
    body = html or ""
    m = RE_TITLE.search(body)
    title = (m.group(1).strip() if m else None)
    r = {
        "via": via,
        "ok": err is None,
        "status": status,
        "ms": ms,
        "content_len": len(body),
        "title": title,
        "final_url": final_url,
        "class": "error" if err else classify(status, body, title, final_url),
        "has_price_class": bool(RE_PRICE.search(body)),
        "has_jsonld_product": bool(RE_JSONLD.search(body)),
        "has_fitment_marker": bool(RE_FITMENT.search(body)),
    }
    if err:
        r["error"] = str(err)[:300]
    if extra:
        r.update(extra)
    return r


def fc_scrape(url, api_key, stealth):
    body = {
        "url": url,
        "formats": ["markdown", "rawHtml"],
        "maxAge": 0,  # defeat Firecrawl-side cache so every leg is a live fetch
        "timeout": FC_TIMEOUT_MS - 5_000,
    }
    if stealth:
        body["proxy"] = "stealth"
    req = urllib.request.Request(
        f"{FIRECRAWL_BASE}/scrape",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        method="POST",
    )
    via = "firecrawl_stealth" if stealth else "firecrawl_std"
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=FC_TIMEOUT_MS / 1000) as resp:
            payload = json.loads(resp.read().decode())
        ms = int((time.monotonic() - t0) * 1000)
        d = payload.get("data") or payload
        html = d.get("rawHtml") or d.get("html") or ""
        meta = d.get("metadata") or {}
        return leg_result(via, meta.get("statusCode"), html, ms,
                          final_url=meta.get("url") or meta.get("sourceURL"),
                          extra={"markdown_len": len(d.get("markdown") or "")})
    except urllib.error.HTTPError as e:
        ms = int((time.monotonic() - t0) * 1000)
        # Firecrawl API-level failure (402 credits, 429 rate limit, 500) — not a target-site verdict
        return leg_result(via, None, "", ms, err=f"firecrawl_api_{e.code}: {e.reason}")
    except Exception as e:  # noqa: BLE001 — probe must never die mid-matrix
        ms = int((time.monotonic() - t0) * 1000)
        return leg_result(via, None, "", ms, err=e)


def page_html(page):
    for attr in ("html_content", "body"):
        val = getattr(page, attr, None)
        if val:
            return val.decode("utf-8", "replace") if isinstance(val, bytes) else str(val)
    return ""


def scr_http(url):
    from scrapling.fetchers import Fetcher
    t0 = time.monotonic()
    try:
        try:
            page = Fetcher.get(url, impersonate="chrome", stealthy_headers=True,
                               timeout=SCRAPLING_TIMEOUT_MS / 1000)
        except TypeError:  # arg names shift across 0.x — degrade to defaults
            page = Fetcher.get(url, timeout=SCRAPLING_TIMEOUT_MS / 1000)
        ms = int((time.monotonic() - t0) * 1000)
        return leg_result("scrapling_http", getattr(page, "status", None), page_html(page), ms,
                          final_url=getattr(page, "url", None))
    except Exception as e:  # noqa: BLE001
        ms = int((time.monotonic() - t0) * 1000)
        return leg_result("scrapling_http", None, "", ms, err=e)


def scr_stealth(url, solve_cloudflare=False):
    from scrapling.fetchers import StealthyFetcher
    t0 = time.monotonic()
    try:
        page = StealthyFetcher.fetch(url, headless=True, solve_cloudflare=solve_cloudflare,
                                     timeout=SCRAPLING_TIMEOUT_MS)
        ms = int((time.monotonic() - t0) * 1000)
        return leg_result("scrapling_stealth", getattr(page, "status", None), page_html(page), ms,
                          final_url=getattr(page, "url", None),
                          extra={"solve_cloudflare": solve_cloudflare})
    except Exception as e:  # noqa: BLE001
        ms = int((time.monotonic() - t0) * 1000)
        return leg_result("scrapling_stealth", None, "", ms,
                          err=e, extra={"solve_cloudflare": solve_cloudflare})


# Pass 2 (--new-scheme): the registry's category-URL scheme is dead on the
# OLP subdomains (all fetchers 30x-chain to the homepage — verified in pass 1),
# so the production-relevant comparison is on the WORKING scheme:
# /search?search_str=<OEM>  →  first /oem-parts/... detail link.
# One known-good OEM per gate make, from batch-10/11 ground truth.
NEW_SCHEME_SEEDS = [
    ("subaru", "15208AA21A"),    # Forester oil filter (current after supersession)
    ("hyundai", "26300-35505"),  # Tucson 2.4 oil filter
    ("nissan", "15208-65F0E"),   # Rogue QR25DE oil filter
    ("ford", "FL820S"),          # F-150 5.4 Motorcraft oil filter
    ("g", "12683541"),           # Equinox 1.5T spark plug (GT-verbatim)
]
RE_DETAIL_HREF = re.compile(r'href="(/oem-parts/[^"]+)"')


def run_legs(url, api_key, skip_fc):
    legs = []
    if not skip_fc:
        legs.append(fc_scrape(url, api_key, stealth=False))
        time.sleep(REQUEST_GAP_S)
        legs.append(fc_scrape(url, api_key, stealth=True))
        time.sleep(REQUEST_GAP_S)
    legs.append(scr_http(url))
    time.sleep(REQUEST_GAP_S)
    stealth_leg = scr_stealth(url)
    if stealth_leg["class"] in ("blocked", "blocked_thin", "error"):
        time.sleep(REQUEST_GAP_S)
        stealth_leg = scr_stealth(url, solve_cloudflare=True)
    legs.append(stealth_leg)
    time.sleep(REQUEST_GAP_S)
    return legs


def discover_detail_url(sub, oem):
    """Fetch the storefront search page (cheap tier) and pull the first detail link."""
    from scrapling.fetchers import Fetcher
    base = f"https://{sub}.oempartsonline.com"
    try:
        p = Fetcher.get(f"{base}/search?search_str={oem}", impersonate="chrome",
                        stealthy_headers=True, timeout=SCRAPLING_TIMEOUT_MS / 1000)
        m = RE_DETAIL_HREF.search(page_html(p))
        return f"{base}{m.group(1)}" if m else None
    except Exception:  # noqa: BLE001
        return None


def run_new_scheme(api_key, skip_fc):
    raw_dir = REPO / "reports" / "scrapling-gate" / "raw-newscheme"
    raw_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for i, (sub, oem) in enumerate(NEW_SCHEME_SEEDS, 1):
        search_url = f"https://{sub}.oempartsonline.com/search?search_str={oem}"
        search_legs = run_legs(search_url, api_key, skip_fc)
        detail_url = discover_detail_url(sub, oem)
        detail_legs = run_legs(detail_url, api_key, skip_fc) if detail_url else []
        row = {"sub": sub, "oem": oem, "search_url": search_url, "search_legs": search_legs,
               "detail_url": detail_url, "detail_legs": detail_legs}
        rows.append(row)
        (raw_dir / f"{i:02d}_{sub}_{oem}.json").write_text(json.dumps(row, indent=2), encoding="utf-8")
        detail_str = ", ".join(f"{l['via']}={l['class']}({l['ms']}ms)" for l in detail_legs) or "no detail link found"
        print(f"[{i}/{len(NEW_SCHEME_SEEDS)}] {sub} {oem}: search "
              + ", ".join(f"{l['via']}={l['class']}" for l in search_legs)
              + f" | detail: {detail_str}", flush=True)
    out = REPO / "reports" / "scrapling-gate" / "summary-newscheme.json"
    out.write_text(json.dumps({"finished": datetime.now(timezone.utc).isoformat(),
                               "rows": rows}, indent=2), encoding="utf-8")
    print(f"wrote {out}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-firecrawl", action="store_true")
    ap.add_argument("--new-scheme", action="store_true",
                    help="probe the working search->detail scheme instead of registry URLs")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    if args.new_scheme:
        api_key = os.environ.get("FIRECRAWL_API_KEY")
        if not api_key and not args.skip_firecrawl:
            sys.exit("FIRECRAWL_API_KEY not set — export it or pass --skip-firecrawl")
        run_new_scheme(api_key, args.skip_firecrawl)
        return

    api_key = os.environ.get("FIRECRAWL_API_KEY")
    if not api_key and not args.skip_firecrawl:
        sys.exit("FIRECRAWL_API_KEY not set — export it or pass --skip-firecrawl")

    urls = [
        (f"{y}-{make}-{model_slug}-{part}",
         f"https://{sub}.oempartsonline.com/oem-{y}-{make}-{model_slug}-{part}.html")
        for (y, make, sub, model_slug) in VEHICLES
        for part in PART_SLUGS
    ][: args.limit]

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    started = datetime.now(timezone.utc).isoformat()
    print(f"gate probe start {started} — {len(urls)} URLs, "
          f"legs: {'scr only' if args.skip_firecrawl else 'fc_std, fc_stealth, scr_http, scr_stealth'}")

    all_rows = []
    for i, (key, url) in enumerate(urls, 1):
        legs = run_legs(url, api_key, args.skip_firecrawl)
        row = {"key": key, "url": url, "legs": legs}
        all_rows.append(row)
        (RAW_DIR / f"{i:02d}_{key}.json").write_text(json.dumps(row, indent=2), encoding="utf-8")
        print(f"[{i}/{len(urls)}] {key}: " +
              ", ".join(f"{l['via']}={l['class']}({l['ms']}ms)" for l in legs), flush=True)

    vias = sorted({l["via"] for r in all_rows for l in r["legs"]})
    summary = {"started": started, "finished": datetime.now(timezone.utc).isoformat(),
               "n_urls": len(all_rows), "per_leg": {}}
    for via in vias:
        rows = [l for r in all_rows for l in r["legs"] if l["via"] == via]
        summary["per_leg"][via] = {
            "n": len(rows),
            "success": sum(1 for l in rows if l["class"] == "success"),
            "partial": sum(1 for l in rows if l["class"] == "partial"),
            "blocked": sum(1 for l in rows if l["class"] in ("blocked", "blocked_thin")),
            "redirected_home": sum(1 for l in rows if l["class"] == "redirected_home"),
            "not_found": sum(1 for l in rows if l["class"] == "not_found"),
            "error": sum(1 for l in rows if l["class"] == "error"),
            "median_ms": median(l["ms"] for l in rows) if rows else None,
            "p95_ms": sorted(l["ms"] for l in rows)[max(0, int(len(rows) * 0.95) - 1)] if rows else None,
            "jsonld_hits": sum(1 for l in rows if l["has_jsonld_product"]),
            "price_class_hits": sum(1 for l in rows if l["has_price_class"]),
        }
    SUMMARY_PATH.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print("\nsummary:")
    print(json.dumps(summary["per_leg"], indent=2))
    print(f"\nwrote {SUMMARY_PATH}")


if __name__ == "__main__":
    main()
