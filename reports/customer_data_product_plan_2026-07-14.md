# Customer-Facing Data Product — Plan
**Date:** 2026-07-14 · **Status:** Planning document (no code in this doc's scope)
**Grounded in:** everything shipped on `feat/3-portals` through Jul 14 — the full Data portal (P0–P2), external Data API v0 (`/v0/maintenance`, `/v0/labor`, `/v0/vehicle`, `/v0/vehicle-image`), the public `/car-data` teaser, and `lib/dataLayers.ts` (the one sellability gate).

---

## 1. Thesis

Otopair holds a vehicle-data asset that gets more valuable with every booking (spec: "two companies at once"). The internal portal made it **governable**; the `/v0` API made it **sellable to developers**. This plan covers the third audience: **individual car owners and shoppers** who want their exact car's data as a product — no API key, no developer skills.

The shape already exists in production primitives. Nothing below invents new data assembly: every surface renders the **exact `/v0/vehicle` + `/v0/vehicle-image` response shapes** through the same `dataLayers` gate. The product work is packaging, auth, and payment — not data engineering.

## 2. The three tiers

| Tier | Who | Gets | Auth | Status |
|---|---|---|---|---|
| **T0 — Anonymous teaser** | anyone, SEO traffic | identity + render + ~5 headline specs + locked counts | none | **SHIPPED** (`/car-data`, `dataPublic.teaserLookup`) |
| **T1 — Full report** | signed-in owner/shopper | everything `/v0/vehicle` serves for ONE config/VIN, rendered as a product page (specs w/ provenance badges, intervals, parts + price bands, empirical labor, VIN history for their own VIN) | Clerk account (+ purchase or free-with-account, §6 Q1) | to build |
| **T2 — API self-serve** | developers/SMBs | `/v0/*` with their own key, scopes, rate tier | api_keys (self-serve minting + billing) | API shipped; self-serve signup + billing to build |

## 3. Route map

```
/car-data                     T0 teaser (SHIPPED)
/car-data/report/[config_key] T1 full report page (gated: Clerk + entitlement)
/car-data/report/vin/[vin]    T1 VIN-flavored report (adds history when entitled)
/account/reports              the wallet: reports this user has unlocked
/car-data/api                 T2 self-serve API signup (docs → key mint → billing)
```

- T1 pages are `(marketing)`-branded (Lora/#eceae6) but Clerk-gated at the component level (middleware stays UX-only, per house doctrine — the entitlement check lives in the Convex query).
- The teaser's "Get the full report" CTA goes from `mailto:` → the T1 purchase flow when it exists.

## 4. Data contract (fixed — do not fork)

- **T1 report query** = a gated sibling of `dataApi.assembleVehicle`: same helpers, same gate, plus an entitlement check (`report_entitlements` table: user_id × config_key/vin, granted_at, source: purchase|promo|account). Response shape is byte-compatible with `/v0/vehicle` — one renderer serves the report page AND doubles as living API docs.
- **Media** = `vehicle_configs.image_url` / `/v0/vehicle-image` semantics; `media_source` flips to self-hosted when the licensed VD image folder lands (shape unchanged — already designed in).
- **Gate invariants (non-negotiable):** B (licensed Vehicle Databases, non-NHTSA) and X never render on any customer surface; every served value carries its layer badge; excluded fields are listed with the blocking layer (the gate is a feature). RepairPal/MOTOR book-times never leave — labor shown is empirical-only, exactly like `/v0/labor`.

## 5. Build sequence (when green-lit)

1. `report_entitlements` table + `dataReport.assembleReport` (gated sibling of assembleVehicle) + `/account/reports` wallet query. (~1 wave)
2. T1 report page: fork the api-sandbox `VehicleView`/`SpecsBlock` rendering (it already renders the full shape with the gate visible) restyled to marketing brand. (~1 wave)
3. Stripe product + checkout for report purchase (existing Stripe plumbing in `app/api/stripe`); entitlement granted in the webhook. (~1 wave)
4. T2 self-serve: public key-minting flow (rate-limited tier), Stripe metered billing off `api_usage` (the "future billing meter" the schema comment already names). (~1–2 waves)
5. SEO: pre-render teaser pages for top configs (`/car-data/[year]/[make]/[model]` static paths from the catalog), sitemap.ts + robots.ts (none exist today).

## 6. Open product questions (decide before step 3)

1. **Is T1 paid, free-with-account, or one-free-then-paid?** Pricing anchor: report competitors charge $20–40/VIN for *history*; our differentiator is maintenance truth, not accident history. A $9–15 per-config report or $XX/yr garage subscription both fit the wallet model.
2. **Does a booking grant the report free?** (Strong loop: book → your car's data unlocks → data keeps you in the app.) Recommended: yes — entitlement source "booking".
3. **Rate limiting for T0:** none exists on anonymous Convex queries (known, accepted for teaser). Revisit only if abuse shows up in logs.
4. **VIN history privacy on T1:** `/v0/vehicle` history is already PII-free (dates/statuses/shop names only) — decide whether a non-owner can buy a report on someone else's VIN with history included, or history stays owner-only (recommended: owner-only via vehicle_owners check).
5. **Licensing checkpoints:** VD image folder contract (media), MOTOR sandbox status (already excluded from all sellable surfaces), the standing legal-review gate from Data spec §12 — T1 launch should ride the same contract-review milestone as external API GA.

## 7. What was deliberately NOT proposed

- No new data assembly or new gate logic — one gate (`dataLayers`), one assembly family (`dataApi`), everywhere.
- No CMS/marketing-site rebuild — T1 rides the existing `(marketing)` group.
- No anonymous full-data endpoint — T0 stays a teaser by design (user decision Jul 14).
