# Shop Photo Gallery → Mobile (otopair-1) Handoff

**Date:** 2026-07-23 · **From:** otopair-web `waleed-fix` · **Deployment:** `dev:flippant-mink-750` (already live)
**Audience:** otopair-1 (`Waleed-Dev`) — `ShopPortfolioSection` owner

## TL;DR

Shop owners can now upload real gallery photos from the web dashboard (Settings → Photo Gallery: up to 12 images, captions, drag-order). These flow through the **same query the app already calls** — `api.shop_portfolio.listByShopId` — so the existing Portfolio tab starts showing real photos with **zero required code changes**. What you *should* change: delete the Unsplash placeholder fallback (it now misrepresents shops that chose not to upload), render the captions you're already receiving, and sync two Convex files for correct types. **Do not run `npx convex dev` from otopair-1 until you've synced** (details below — it would delete the new functions from the shared deployment).

## Data flow

```mermaid
flowchart LR
  subgraph web [otopair-web dashboard]
    A[Settings → Photo Gallery card\nportfolio-manager.tsx]
  end
  subgraph convex [Convex dev:flippant-mink-750]
    B[(shop_portfolio\nstorage_id | content_id\ncaption, display_order)]
    C[(cdn_assets\nlegacy seed URLs)]
    D[(_storage\nowner uploads)]
    Q[shop_portfolio.listByShopId\npublic query]
  end
  subgraph app [otopair-1]
    E[useShopPortfolioFromConvex]
    F[ShopPortfolioSection\nPortfolio tab on\nbooking/shop/id + booking/mechanic/id]
  end
  A -- generateUploadUrl / addImage /\nsetCaption / reorder / removeImage --> B
  B -- content_id --> C
  B -- storage_id --> D
  B --> Q
  Q -- reactive subscription --> E --> F
```

## What changed server-side (already deployed)

`shop_portfolio` rows now come in two flavors, resolved transparently by the query:

| Row kind | Source field | URL comes from | Caption comes from |
|---|---|---|---|
| Legacy (seed) | `content_id` | `cdn_assets.url` | `cdn_assets.caption` (row `caption` wins if set) |
| **Owner upload (new)** | `storage_id` | `ctx.storage.getUrl()` | row `caption` |

New owner-gated mutations exist (`generateUploadUrl`, `addImage`, `removeImage`, `setCaption`, `reorder`) but are **dashboard-only** — the driver app never calls them.

## The contract (unchanged name, enriched rows)

`api.shop_portfolio.listByShopId({ shopId: Id<"shops"> })` → array, **already sorted** by `display_order` (tie-break `_creationTime`), null-URL rows filtered server-side:

```ts
{
  _id: Id<"shop_portfolio">;
  shop_id: Id<"shops">;
  content_id?: string;          // legacy rows only
  display_order?: number;       // don't re-sort client-side; server order is canonical
  url: string;                  // plain https URL (convex.cloud storage or CDN) — no auth headers needed
  caption: string | null;       // ≤200 chars, owner-editable
  isUploaded: boolean;          // NEW — true = owner-uploaded (storage-backed)
}
```

Guarantees: max **12** rows per shop (server-enforced), reactive (dashboard edits push live into an open app screen), owner uploads are original files up to **10 MB** PNG/JPEG/WebP — no server-side resizing exists, so keep tiles on `resizeMode="cover"` and consider `expo-image` with a `recyclingKey` if memory becomes a concern on photo-heavy shops.

## Required: repo sync (types only — runtime already works)

The deployment runs the new code; otopair-1's local `convex/` copy is stale (its `listByShopId` predates `storage_id`/`isUploaded`). Copy from otopair-web:

1. `convex/shop_portfolio.ts` — whole file.
2. `convex/schema.ts` — the `shop_portfolio` table block (adds `storage_id`, `caption`, `created_at`, optional `content_id`, index `by_storage_id`).
3. `convex/shops.ts` — `requireShopOwner` is now `export`ed, and `setShopLogo`'s conflict check also scans `shop_portfolio.by_storage_id` (logo↔portfolio file-adoption guard, both directions).

Then `npx convex codegen` (NOT `dev`).

> ⚠️ **Deploy direction warning (important):** as of 2026-07-23 the shared deployment's source of truth is **otopair-web** (its `convex/` is a strict superset — 427 vs 369 modules; the two `devOnly/` scripts were ported web-side so nothing is mobile-only anymore). Running `npx convex dev` from otopair-1 **before syncing** would delete `shop_portfolio`'s new functions, `landing`, and ~60 other modules from `flippant-mink-750`. Sync first, or coordinate with Waleed.

## Recommended UI changes in `ShopPortfolioSection.tsx`

1. **Delete the `DEFAULT_IMAGES` Unsplash fallback.** It was a reasonable placeholder when no shop could have photos; now it shows strangers' garages as *this shop's* work — worse than empty. The existing "No portfolio images available" empty state is currently unreachable (`portfolio.length > 0 ? … : DEFAULT_IMAGES` guarantees ≥3 images); removing the fallback makes it live. Consider hiding the tab entirely at 0 photos — your call.
2. **Render captions.** `useShopPortfolioFromConvex` already maps `caption` and the component throws it away (`portfolio.map((p) => p.url)`). Owners write things like "2015 WRX big turbo build" — show it as a one-line label under/over the tile.
3. **Key by `p.id`**, not array index (reorders from the dashboard arrive live; index keys will cross-fade the wrong tiles).
4. The `// TODO: Open full-screen image viewer` is worth doing now that photos are real — captions make a nice lightbox title.
5. `display_order` in the hook's `PortfolioItem` is typed `number` but is optional on legacy rows — either type it `number | undefined` or drop the field; the array is pre-sorted anyway.

## QA recipe (dev data available right now)

- **Chelala Service Center** (`slug: chelala-service-center`) has 3 real owner-uploaded photos on dev.
- Manage them at `localhost:3000` (otopair-web dev server) → sign in `shopowner+clerk_test@gmail.com` (email-code method, dev OTP `424242`) → Settings → Photo Gallery.
- Reactivity check: keep the app's Portfolio tab open while reordering/captioning in the dashboard — the tab should update without refresh.

## Contacts / provenance

Web-side implementation: `convex/shop_portfolio.ts`, `app/(portal)/settings/portfolio-manager.tsx` on `waleed-fix` (2026-07-23, E2E-verified via `.agent/pw` harness, 0 console errors). Questions → Waleed.
