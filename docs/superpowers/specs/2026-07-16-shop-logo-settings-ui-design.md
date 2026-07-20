# Shop Logo Upload — Settings UI + Convex Port

**Date:** 2026-07-16
**Repo:** otopair-web (dashboard), with one small change in otopair-1 (app repo)
**Branch:** `waleed-fix`
**Goal:** Let a shop owner set their shop's logo from the dashboard Settings page (`/settings`), with a pick → crop → save flow. The logo then appears on the customer app's map shop card automatically (that read path already ships in otopair-1).

Companion to otopair-1's `docs/superpowers/specs/2026-07-12-shop-images-design.md`, which built the backend + app read path and left the dashboard UI as a blueprint (§6 there). This spec is that dashboard piece.

---

## 0. Decisions locked

| Decision | Choice |
|---|---|
| Runtime backend | The three mutations (`generateShopLogoUploadUrl`, `setShopLogo`, `clearShopLogo`) are **already deployed** to the shared dev deployment `dev:flippant-mink-750` from otopair-1. No new write functions. |
| Current-logo display | Add `logoUrl` resolution to **`getMyShops`** in otopair-1 (the deploying repo) and push. Claude edits + pushes (one-off `npx convex dev --once` from otopair-1). |
| otopair-web convex/ | **Typed port**: copy the schema field + index, the three mutations, and their helpers into this repo's `convex/` so `api.shops.*` is typed here. Types only — **never deploy from otopair-web**. |
| Upload UX | Save immediately: pick → crop dialog → Save uploads + applies. No page-level save button. |
| Crop | Manual crop required (user decision): fixed square aspect, round mask, drag + zoom. Library: **react-easy-crop** (new dependency). |
| Output | Cropped region rendered to canvas at `min(512, cropWidthPx)` square. PNG for `image/png`/`image/webp` sources (preserves transparency), JPEG q0.9 for `image/jpeg`. Well under the 2 MB contract cap. |
| Who sees controls | Members whose `memberRole` ∈ `OWNER_ROLES` (`owner`, `shop_owner`, `admin`). Others see the avatar read-only. Server enforces regardless. |

---

## 1. Context (why this shape)

- Both repos point at the **same** Convex deployment: `dev:flippant-mink-750` (`.env.local` in each). otopair-1 is the canonical convex codebase and the only repo that deploys. otopair-web's `convex/` is a divergent partial copy used for local types; the repo's existing workaround for deployment-only functions is `makeFunctionReference` string refs (e.g. `app/(portal)/team/page.tsx:119`). We use the typed port instead (user direction), which also shrinks the schema drift.
- `getMyShops` (both copies currently identical) returns raw shop docs — no `logoUrl`. A storage id can only become a servable URL server-side (`ctx.storage.getUrl`), so Settings cannot display the saved logo without the otopair-1 query change. `shops.list` does resolve `logoUrl` but is the customer browse query (bookable-shops gate) — wrong tool for "my shop".
- The Settings page (`app/(portal)/settings/page.tsx`) reads `api.shops.getMyShops`, takes `shops[0]`, and renders the Shop Info card header (name + `/slug` + Active badge) at lines ~148–162. Sibling feature components are colocated: `hours-editor.tsx`, `services-editor.tsx`, `labor-rate-card.tsx`.

## 2. Change in otopair-1 (deployed)

In `convex/shops.ts` `getMyShops` (line ~405), resolve the logo per shop, reusing the existing `resolveShopLogoUrl` helper (already used by `shops.list` at line ~286):

```ts
return shop ? { ...shop, memberRole: su.role, logoUrl: await resolveShopLogoUrl(ctx, shop) } : null;
```

Push once from otopair-1: `npx convex dev --once`. Additive — no other client is affected.

## 3. Port into otopair-web (types only)

- `convex/schema.ts` shops table (line ~1798): add `logo_storage_id: v.optional(v.id("_storage"))` after `logo`, and `.index("by_logo_storage_id", ["logo_storage_id"])` alongside the existing indexes. (Also protects any future push from failing validation, since live rows already carry this field.)
- `convex/shops.ts`: port verbatim from otopair-1 —
  - `resolveShopLogoUrl` + `requireShopOwner` local helpers (defined near the top of otopair-1's shops.ts — the latter at :170; `OWNER_ROLES` already exists here at line 19),
  - the three mutations (otopair-1 shops.ts:622–689) with their security comments intact,
  - the same `getMyShops` `logoUrl` line as §2, keeping both copies aligned.
- Generated types (`convex/_generated/api.d.ts`) map module exports statically — no codegen run or push required. **Do not run `npx convex dev`/`deploy` from otopair-web** (pre-existing hazard: the folders are still divergent elsewhere; a push would clobber otopair-1-only functions).

## 4. Settings UI (otopair-web)

New colocated client component: `app/(portal)/settings/logo-uploader.tsx`, rendered inside the Shop Info card header row (left of the name/slug block):

```
[ 64px round avatar ]  Test Shop                    [Active]
  Upload logo · Remove   /test-shop
```

- **Avatar:** 64px circle. `shop.logoUrl` set → `<img>` (object-cover); else gray placeholder with a lucide `Store`/`ImageIcon`. (Plain `<img>`, not `next/image` — the Convex storage host isn't in `images.remotePatterns` and these URLs are deployment-served.)
- **Controls** (only when `shop.memberRole` ∈ OWNER_ROLES): a text button "Upload logo" (or "Change" when a logo exists) and "Remove" when a logo exists. Hidden `<input type="file" accept="image/png,image/jpeg,image/webp">`.
- **Validation on pick:** type ∈ {png, jpeg, webp}; source file ≤ 10 MB (decode guard). Failure → inline message under the controls (same message-string convention as `timezoneMessage`), no dialog.
- **Crop dialog:** hand-rolled fixed-inset overlay (repo has no dialog primitive; follow the existing overlay style used by e.g. `post-job-survey-dialog.tsx`). Contents: react-easy-crop (`aspect={1}`, `cropShape="round"`, drag + zoom slider), Cancel / Save buttons. Browsers apply EXIF orientation on decode.
- **Save flow** (the contract from otopair-1's spec §6, verbatim):
  1. Draw `croppedAreaPixels` to a canvas sized `min(512, cropWidthPx)` square; `toBlob` (PNG/JPEG per §0).
  2. `const uploadUrl = await generateShopLogoUploadUrl({ shopId })` (useMutation on `api.shops.generateShopLogoUploadUrl`)
  3. `POST uploadUrl` with `Content-Type: blob.type`, body = blob → `{ storageId }`
  4. `await api.shops.setShopLogo({ shopId, storageId })`
  5. Close dialog. Avatar updates reactively via `getMyShops`.
- **Remove:** `api.shops.clearShopLogo({ shopId })`, no confirm (trivially re-uploadable), inline "Removing…" state.
- **Busy states:** spinner + disabled controls while uploading (Loader2, matching the page's save buttons).

## 5. Error handling

- Bad type / oversize source → inline message, dialog never opens.
- Steps 2–4 failure → error message **inside the dialog**, dialog stays open, Save re-enabled. Surface server messages verbatim — notably "That image is already in use by another shop." (cross-tenant guard).
- Remove failure → inline message under controls.
- Revoke object URLs on dialog close/unmount. Never call `ctx.storage.delete` client-side or server-side (orphans are the accepted tradeoff; reaper deferred — otopair-1 spec §9).

## 6. Verification

1. Typecheck: `npx tsc --noEmit` in otopair-web (baseline-relative); otopair-1 touched file compiles (its convex push typechecks it).
2. Live, in the dev server (`localhost:3000/settings`, signed in as Test Shop's owner):
   - Upload → crop → Save → avatar shows the crop.
   - **Reload the page** → logo still shows (proves the deployed `getMyShops` change, not local state).
   - Remove → placeholder returns; re-upload works (replacement path, old file orphaned by design).
   - Non-owner member (if available): controls hidden.
3. Customer-app read path needs zero work (`shops.list` already resolves `logoUrl`; proven with Waleed Service Center's existing PNG). Spot-check only if convenient.

## 7. Out of scope (deferred in otopair-1 spec §9, unchanged)

- Orphaned-file reaper; shop detail-page hero; server-side image validation/resizing; multi-image portfolio; re-crop of an existing logo (we store only the cropped output — "Change" starts from a fresh file pick).

## 8. New dependency

`react-easy-crop` (MIT, ~8 KB gz, zero deps) in otopair-web only.
