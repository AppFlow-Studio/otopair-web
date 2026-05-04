# Vehicle Enrichment Pipeline

## What This Space Is For
The 3-tier AI enrichment pipeline that converts bare vehicle identity (VIN → year, make, model, trim, engine) into fully populated maintenance specs, OEM parts, service intervals, labor times, and pricing.

## Architecture

| Tier | Method | Cost | Latency | Confidence |
|---|---|---|---|---|
| 1 | Anthropic Claude Haiku batch + FireCrawl scraping | ~$0.50-0.60/vehicle | 7-13 min | Medium-High |
| 2 | Site-scoped FireCrawl searches + regex + consensus | ~30 credits | 2-5 min | Medium |
| 3 | Mechanic verification post-job | $0 | Instant | Highest |

## Key Concepts
- **Config key:** `{year}_{make}_{model}_{trim}_{engineCode}` — normalized, used for cache lookups.
- **Evidence tracking:** Every value has source URL + domain + confidence score.
- **Cache-first:** Check `vehicle_configs` table before any API calls.
- **Batch processing:** Claude Message Batches API for bulk enrichment.

## Key Files
- `v3pipeline.ts` — Main entry: `enrichVehicleBatchV3`
- `prompts/` — Claude prompt templates
- `scrapers/` — FireCrawl scraper configs
- `validation/` — Data validation rules

## Process
1. **Check cache** — Does vehicle_configs row exist? If yes, skip.
2. **Tier 1** — Batch Claude Haiku + FireCrawl. Poll for results.
3. **Validate** — Check data completeness, confidence thresholds.
4. **Store** — Write to normalized tables (engines, transmissions, vehicle_configs, oem_parts, service_intervals).
5. **Evidence** — Record source URL + confidence for every value in enrichment_evidence table.
6. **Tier 2 (if needed)** — Targeted site scraping for missing data.
7. **Tier 3 (ongoing)** — Mechanic feedback updates confidence scores.

## What NOT To Do
- Don't modify without reading docs/ENRICHMENT_PIPELINE_COMPLETE.md (67KB full spec).
- Don't skip evidence tracking — every data point needs provenance.
- Don't hardcode API keys — use environment variables.
- Don't test against production Convex — use `npx convex dev` for local.

## Active Skills
- `/pipeline-auditor` — Validates enrichment data integrity and evidence chains.
