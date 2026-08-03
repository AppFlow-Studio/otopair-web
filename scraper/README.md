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
- Response: `{ url, status, mode, html?, markdown? }`

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
npx convex env set PARTS_SCRAPLING on
```
`convex/vehicleEnrichment/scrapling.ts` is the client; `fetchUrlWithHtml` in
`firecrawl.ts` tries Scrapling first when enabled and falls back to Firecrawl on
any miss. To route only specific domains through Scrapling (recommended — e.g.
TLS-blocking sites), gate the call in `firecrawl.ts` on the URL host.

> Note: Scrapling's fetcher API has shifted across releases; `app.py` reads the
> response defensively, but if you pin a very new/old `scrapling` the
> `Fetcher.get` / `StealthyFetcher.fetch` call sites may need a tweak.
