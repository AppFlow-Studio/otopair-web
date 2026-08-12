# Otopair Scrapling scraper

A tiny FastAPI service wrapping [Scrapling](https://github.com/D4Vinci/Scrapling)
so the Convex enrichment pipeline can use a **self-hosted, free** scraper (curl_cffi
TLS impersonation) with a **browser fallback** (Camoufox) — as an alternative to
Firecrawl credits and for sites that reject impersonated TLS (e.g. `hondapartsdeal.com`).

It is **opt-in**: the pipeline only calls it when `PARTS_SCRAPLING=on` and
`SCRAPLING_URL` is set. Until then, nothing changes and Firecrawl stays the default.

## API

`POST /scrape`
```jsonc
{ "url": "https://…", "mode": "auto", "timeout_ms": 45000, "formats": ["markdown","html"] }
```
- `mode`: `http` (fast, no browser) · `stealth` (Camoufox browser) · `auto` (http, escalate to stealth if blocked/short)
- Response: `{ url, status, mode, html?, markdown?, final_url?, blocked }`
- `status` is the **upstream** status, carried inside a 200 envelope — a `403`
  here means the target refused us, not that the service failed.
- `blocked` is the challenge-page verdict. `auto` escalates to the browser tier
  on it, and callers treat it as a miss.

> **`auto` escalation counts challenge pages, not just short ones.** A Cloudflare
> interstitial is 2–5 KB of real HTML and frequently answers `200`, so a
> status+length check alone passed it straight through as a successful scrape.

`GET /health` → `{ "ok": true }`

Auth: set `SCRAPLING_TOKEN` and callers must send `Authorization: Bearer <token>`.

## Run locally

```bash
cd scraper
python3 -m venv ~/.venvs/scrapling && source ~/.venvs/scrapling/bin/activate
pip install -r requirements.txt
scrapling install                       # downloads Camoufox for the stealth tier
export SCRAPLING_TOKEN=$(openssl rand -hex 24)   # optional
uvicorn app:app --reload --port 8080

# smoke test
curl -s localhost:8080/scrape -H "Authorization: Bearer $SCRAPLING_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","mode":"http"}' | head
```

## Docker

```bash
docker build -t otopair-scraper scraper
docker run -p 8080:8080 -e SCRAPLING_TOKEN=secret otopair-scraper
```
The image runs `scrapling install` at build time for the browser tier. Give it
**≥1GB RAM** if you use `stealth`/`auto`; `http`-only works in far less.

## Deploy (pick a browser-capable host — NOT Vercel/serverless)

**Fly.io** (config in `fly.toml`, scales to zero):
```bash
cd scraper
fly launch --no-deploy --copy-config
fly secrets set SCRAPLING_TOKEN=$(openssl rand -hex 24)
fly deploy
# URL: https://<app>.fly.dev
```

**Railway / Render**: point at this folder, use the `Dockerfile`, expose port
`8080`, set `SCRAPLING_TOKEN`. Health check `/health`.

**Google Cloud Run**:
```bash
gcloud run deploy otopair-scraper --source scraper \
  --port 8080 --memory 1Gi --allow-unauthenticated \
  --set-env-vars SCRAPLING_TOKEN=secret
```

## Wire it into the pipeline

Point Convex at the deployed service and flip the flag (values are read at call
time — no redeploy needed):
```bash
npx convex env set SCRAPLING_URL   https://<your-scraper-host>
npx convex env set SCRAPLING_TOKEN <same token as the service>

# Two INDEPENDENT consumers — enable them one at a time, not together.
npx convex env set PARTS_SCRAPLING          on   # price path (firecrawl.ts)
npx convex env set PARTS_SCRAPLING_ADAPTERS on   # source adapters (sourceAdapters/http.ts)
```

`convex/vehicleEnrichment/scrapling.ts` is the client. There are three consumers:

| Consumer | Flag | Notes |
|---|---|---|
| `firecrawl.ts` `fetchUrlWithHtml` / `fetchUrl` | `PARTS_SCRAPLING` | falls back to Firecrawl on any miss |
| `sourceAdapters/http.ts` `adapterFetch` | `PARTS_SCRAPLING_ADAPTERS` | falls back to a direct fetch on any miss |
| `claimGathering.ts` amsoil headless rescue | `PARTS_SCRAPLING` | `mode: "stealth"`, one page |

The flags are separate on purpose: the adapters parse HTML structurally and are
far more sensitive to a different rendering than the price path is, so they roll
out — and roll back — independently.

**Adapter eligibility.** `adapterFetch` only offers a request to Scrapling when
it is a plain HTML GET. Requests carrying `Cookie` / `Authorization` / `Origin` /
`Referer` / `X-Requested-With` / `Content-Type`, and anything with
`expects: "json"`, stay on the direct tier — `/scrape` takes no header
passthrough and HTML-parses what it fetches, so routing them would silently
change the request or mangle the body. Currently routed: `myCarUserManual`,
`amsoil` (vehicle page), `rockauto`, `tricoWipers`. Still direct: `brembo`
(cookie session), `summitCentric` (needs the post-redirect URL — unblock with
`final_url` once redeployed), `wixFilters` / `sylvaniaBulbs` / `amsoil` API
(JSON), `tricoWipers` options (POST).

To route only specific domains through Scrapling, gate on the URL host at the
call site.

> The `blocked` / `final_url` response fields and challenge-aware `auto`
> escalation need a **redeploy** of this service to take effect. The Convex side
> re-sniffs the body itself and treats a missing field as `false`, so an older
> deploy is safe — it just falls back instead of escalating.

> Note: Scrapling's fetcher API has shifted across releases; `app.py` reads the
> response defensively, but if you pin a very new/old `scrapling` the
> `Fetcher.get` / `StealthyFetcher.fetch` call sites may need a tweak.
