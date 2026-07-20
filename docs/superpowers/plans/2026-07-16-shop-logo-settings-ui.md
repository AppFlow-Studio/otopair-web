# Shop Logo Settings UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shop owners set/replace/remove their shop logo from `/settings` via a pick → crop → save flow; the saved logo shows in Settings and (already-shipped read path) on the customer app's map card.

**Architecture:** The Convex runtime truth lives in the **otopair-1** repo (`C:\Users\manso\Desktop\otopair-1`), which deploys to the shared dev deployment `dev:flippant-mink-750` — the same deployment otopair-web points at. The three logo mutations are already deployed. This plan (1) adds `logoUrl` to `getMyShops` in otopair-1 and pushes it, (2) ports the logo schema field + mutations into otopair-web's `convex/` for typed `api.shops.*` access (types only — otopair-web NEVER deploys), and (3) builds the Settings UI: a colocated `logo-uploader.tsx` with a react-easy-crop dialog.

**Tech Stack:** Next.js 16 app router (client components), Convex React (`useMutation`/`useQuery`), convex-test + vitest (edge-runtime env), react-easy-crop (new dep), Tailwind classes matching `app/(portal)/settings/page.tsx`.

**Spec:** `docs/superpowers/specs/2026-07-16-shop-logo-settings-ui-design.md`

---

## ⚠ Cross-repo rules (read first)

- **NEVER run `npx convex dev` or `npx convex deploy` from otopair-web.** Its `convex/` folder is a divergent partial copy; a push would clobber otopair-1-only functions on the shared deployment.
- The only deploy in this plan is a one-off push **from otopair-1** (Task 1).
- otopair-1's working tree may have unrelated changes — `git add` only the file this plan touches there.

## File structure

| File | Repo | Action | Responsibility |
|---|---|---|---|
| `convex/shops.ts` | otopair-1 | Modify (1 line) | `getMyShops` returns `logoUrl` (deployed) |
| `convex/schema.ts` | otopair-web | Modify | `shops.logo_storage_id` field + `by_logo_storage_id` index (type parity with live deployment) |
| `convex/shops.ts` | otopair-web | Modify | Port `resolveShopLogoUrl`, `requireShopOwner`, 3 logo mutations; align `getMyShops` |
| `tests/shop_logo.test.ts` | otopair-web | Create | convex-test coverage of the ported functions |
| `app/(portal)/settings/crop-image.ts` | otopair-web | Create | Pure canvas helper: crop area → square Blob |
| `app/(portal)/settings/logo-uploader.tsx` | otopair-web | Create | Avatar + owner controls + crop dialog + upload flow |
| `app/(portal)/settings/page.tsx` | otopair-web | Modify | Render `ShopLogoUploader` in the Shop Info header |

---

### Task 1: otopair-1 — `getMyShops` returns `logoUrl`, push, commit

**Files:**
- Modify: `C:\Users\manso\Desktop\otopair-1\convex\shops.ts:420` (inside `getMyShops`, line ~405)

The helper `resolveShopLogoUrl` already exists in that file (line 157) and is already used by `shops.list` (line 286). This change reuses it.

- [ ] **Step 1: Edit `getMyShops`**

In `C:\Users\manso\Desktop\otopair-1\convex\shops.ts`, inside `getMyShops` (starts line 405), replace:

```ts
        return shop ? { ...shop, memberRole: su.role } : null;
```

with:

```ts
        return shop
          ? { ...shop, memberRole: su.role, logoUrl: await resolveShopLogoUrl(ctx, shop) }
          : null;
```

(That exact old line appears once in otopair-1's `shops.ts` — it's unique to `getMyShops`.)

- [ ] **Step 2: Push to the shared dev deployment**

Run (PowerShell, from otopair-1):

```powershell
Set-Location C:\Users\manso\Desktop\otopair-1; npx convex dev --once
```

Expected output ends with something like `✔ Convex functions ready` (schema unchanged, so no schema-validation surprises). If it errors with an auth prompt, stop and ask the user — do not guess credentials.

- [ ] **Step 3: Commit (otopair-1, current branch, this file only)**

```powershell
Set-Location C:\Users\manso\Desktop\otopair-1; git add convex/shops.ts; git commit -m "feat: getMyShops resolves logoUrl for dashboard settings"
```

Note: add ONLY `convex/shops.ts`. Do not `git add -A` — the tree may hold unrelated work.

---

### Task 2: otopair-web — failing tests for the ported logo functions

**Files:**
- Create: `C:\Users\manso\Desktop\otopair-web\tests\shop_logo.test.ts`

Uses the existing harness `tests/helpers.ts` (`makeT()` builds a convexTest instance over `convex/schema.ts`; `identityFor(subject)` builds a `withIdentity` arg). convex-test implements in-memory `ctx.storage`, so `ctx.storage.store(new Blob(...))` seeds real storage ids.

- [ ] **Step 1: Write the test file**

```ts
import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { identityFor, makeT } from "./helpers";

type T = ReturnType<typeof makeT>;

/** Seed a user + shop + owner-role membership; returns ids and the Clerk subject. */
async function seedShopWithOwner(t: T, tag: string) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const ownerClerkId = `clerk_logo_owner_${tag}_${now}`;
    const ownerId = await ctx.db.insert("users", {
      clerkUserId: ownerClerkId,
      email: `${tag}-owner@test.local`,
      first_name: "Owner",
      role: "shop_owner",
      createdAt: now,
    });
    const shopId = await ctx.db.insert("shops", {
      name: `Logo Shop ${tag}`,
      owner_user_id: ownerId,
      is_active: true,
    });
    await ctx.db.insert("shop_users", {
      user_id: ownerId,
      shop_id: shopId,
      role: "owner",
      is_active: true,
    });
    return { ownerClerkId, ownerId, shopId };
  });
}

/** Store fake image bytes in convex-test's in-memory storage; returns a real storageId. */
async function storeFakeImage(t: T) {
  return await t.run(async (ctx) =>
    ctx.storage.store(new Blob(["fake-png-bytes"], { type: "image/png" })),
  );
}

describe("shop logo mutations (ported from otopair-1)", () => {
  test("owner can set, see (via getMyShops logoUrl), and clear the logo", async () => {
    const t = makeT();
    const { ownerClerkId, shopId } = await seedShopWithOwner(t, "a");
    const asOwner = t.withIdentity(identityFor(ownerClerkId));

    // Before any upload, getMyShops resolves logoUrl to null.
    const before = await asOwner.query(api.shops.getMyShops, {});
    expect(before).toHaveLength(1);
    expect(before[0]!.logoUrl).toBeNull();

    const storageId = await storeFakeImage(t);
    await asOwner.mutation(api.shops.setShopLogo, { shopId, storageId });

    const after = await asOwner.query(api.shops.getMyShops, {});
    expect(typeof after[0]!.logoUrl).toBe("string");
    expect(after[0]!.logoUrl).toBeTruthy();

    await asOwner.mutation(api.shops.clearShopLogo, { shopId });
    const cleared = await asOwner.query(api.shops.getMyShops, {});
    expect(cleared[0]!.logoUrl).toBeNull();
  });

  test("a signed-in user with no membership cannot set or clear the logo", async () => {
    const t = makeT();
    const { shopId } = await seedShopWithOwner(t, "b");
    const randoClerkId = `clerk_logo_rando_${Date.now()}`;
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        clerkUserId: randoClerkId,
        email: "rando@test.local",
        first_name: "Rando",
        role: "user",
        createdAt: Date.now(),
      });
    });
    const asRando = t.withIdentity(identityFor(randoClerkId));
    const storageId = await storeFakeImage(t);

    await expect(
      asRando.mutation(api.shops.setShopLogo, { shopId, storageId }),
    ).rejects.toThrow("Not authorized");
    await expect(
      asRando.mutation(api.shops.clearShopLogo, { shopId }),
    ).rejects.toThrow("Not authorized");
    await expect(
      asRando.mutation(api.shops.generateShopLogoUploadUrl, { shopId }),
    ).rejects.toThrow("Not authorized");
  });

  test("a storageId already used by another shop is rejected", async () => {
    const t = makeT();
    const shopA = await seedShopWithOwner(t, "c1");
    const shopB = await seedShopWithOwner(t, "c2");
    const storageId = await storeFakeImage(t);

    const asOwnerA = t.withIdentity(identityFor(shopA.ownerClerkId));
    await asOwnerA.mutation(api.shops.setShopLogo, { shopId: shopA.shopId, storageId });

    const asOwnerB = t.withIdentity(identityFor(shopB.ownerClerkId));
    await expect(
      asOwnerB.mutation(api.shops.setShopLogo, { shopId: shopB.shopId, storageId }),
    ).rejects.toThrow("already in use by another shop");

    // Re-setting the SAME shop's own storageId stays idempotent (no self-conflict).
    await asOwnerA.mutation(api.shops.setShopLogo, { shopId: shopA.shopId, storageId });
  });

  test("owner gets an upload URL", async () => {
    const t = makeT();
    const { ownerClerkId, shopId } = await seedShopWithOwner(t, "d");
    const asOwner = t.withIdentity(identityFor(ownerClerkId));
    const url = await asOwner.mutation(api.shops.generateShopLogoUploadUrl, { shopId });
    expect(typeof url).toBe("string");
    expect(url.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the tests — expect failure (functions not ported yet)**

```powershell
npx vitest run tests/shop_logo.test.ts
```

Expected: all 4 tests FAIL with convex-test errors like `Could not find public function for 'shops:setShopLogo'` (vitest transpiles without typechecking, so the missing `api.shops.*` members fail at runtime, not compile time).

---

### Task 3: otopair-web — schema field + index

**Files:**
- Modify: `C:\Users\manso\Desktop\otopair-web\convex\schema.ts:1815` and `:1853-1856`

- [ ] **Step 1: Add the field**

In the `shops` table (`defineTable` at line 1798), replace this unique 3-line run (`logo:` alone also appears in the car-makes table near line 49 — this anchor disambiguates):

```ts
    description: v.optional(v.string()),
    logo: v.optional(v.string()),
    stripe_connect_account_id: v.optional(v.string()),
```

with:

```ts
    description: v.optional(v.string()),
    logo: v.optional(v.string()),
    logo_storage_id: v.optional(v.id("_storage")),
    stripe_connect_account_id: v.optional(v.string()),
```

- [ ] **Step 2: Add the index**

Replace:

```ts
    .index("by_slug", ["slug"])
    .index("by_owner_user_id", ["owner_user_id"])
    .index("by_stripe_connect_account_id", ["stripe_connect_account_id"]),
```

with:

```ts
    .index("by_slug", ["slug"])
    .index("by_owner_user_id", ["owner_user_id"])
    .index("by_stripe_connect_account_id", ["stripe_connect_account_id"])
    .index("by_logo_storage_id", ["logo_storage_id"]),
```

(This exact 3-index run is unique to the shops table.)

- [ ] **Step 3: Commit**

```powershell
git add convex/schema.ts; git commit -m "feat: port shops.logo_storage_id field + index from otopair-1"
```

---

### Task 4: otopair-web — port the helpers + three mutations, align `getMyShops`

**Files:**
- Modify: `C:\Users\manso\Desktop\otopair-web\convex\shops.ts` (three edits: helper block after `resolveMechanicPhotoUrl` ~line 155, `getMyShops` line ~378, and append mutations at end of file)
- Test: `tests/shop_logo.test.ts` (from Task 2)

`OWNER_ROLES` already exists at `convex/shops.ts:19`; the `users.by_clerkUserId` and `shop_users.by_user_and_shop` indexes already exist in this repo's schema. Code below is verbatim from otopair-1 `convex/shops.ts:157-191` and `:613-689`.

- [ ] **Step 1: Insert the two helpers after `resolveMechanicPhotoUrl`**

`resolveMechanicPhotoUrl` starts at line 140 and its closing `}` is directly above `async function getBlockingBookingsForMechanic` (line 157). Insert between them:

```ts
async function resolveShopLogoUrl(ctx: any, shop: any): Promise<string | null> {
  if (!shop?.logo_storage_id) return null;
  return await ctx.storage.getUrl(shop.logo_storage_id);
}

// Explicit-shopId shop-owner gate — mirrors convex/mechanics.ts's
// `requireShopOwner` (same shop_users membership check + owner_user_id
// fallback). Duplicated rather than imported, matching this file's
// existing convention of local copies of small ctx-helpers (see
// `resolveMechanicPhotoUrl` above, also duplicated from mechanics.ts).
// Needed here (vs. this file's own `getPrimaryShopForUser` pattern)
// because the dashboard-facing logo mutations take an explicit
// `shopId` arg rather than acting on "my primary shop".
async function requireShopOwner(ctx: any, shopId: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");

  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
    .unique();
  if (!user) throw new Error("User not found");

  const membership = await ctx.db
    .query("shop_users")
    .withIndex("by_user_and_shop", (q: any) => q.eq("user_id", user._id).eq("shop_id", shopId))
    .filter((q: any) => q.eq(q.field("is_active"), true))
    .first();

  const shop = await ctx.db.get(shopId);
  const isOwner = OWNER_ROLES.has(membership?.role) || String(shop?.owner_user_id ?? "") === String(user._id);
  if (!isOwner) throw new Error("Not authorized");

  return { user, shop };
}
```

- [ ] **Step 2: Align `getMyShops` (same one-line change as Task 1)**

In `getMyShops` (line ~363), replace:

```ts
        return shop ? { ...shop, memberRole: su.role } : null;
```

with:

```ts
        return shop
          ? { ...shop, memberRole: su.role, logoUrl: await resolveShopLogoUrl(ctx, shop) }
          : null;
```

- [ ] **Step 3: Append the three mutations at the very end of the file**

```ts
/**
 * Generate a short-lived upload URL for a shop's logo/official image.
 * Called by the (separate) mechanic dashboard before POSTing the image
 * bytes directly to Convex storage. Mutation (not action) because
 * `ctx.storage.generateUploadUrl()` is available on mutation ctx in
 * this Convex version — see the same pattern in users.ts / bookings.ts
 * / vehicleDocuments.ts — which lets us reuse the ctx.db-based
 * `requireShopOwner` auth directly instead of an action+runQuery hop.
 */
export const generateShopLogoUploadUrl = mutation({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    await requireShopOwner(ctx, args.shopId);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Point a shop at a newly-uploaded logo file.
 *
 * We deliberately do NOT hard-delete the previously-stored file here. A
 * client-supplied storageId can't be proven to belong to this shop, and
 * `ctx.storage.delete` is a global hard-delete with no refcount — deleting
 * a "previous" id an attacker planted could destroy another feature's file
 * (e.g. a user's profile photo). Orphaned replaced logos are an accepted,
 * low-severity tradeoff, reclaimable later by a background job that deletes
 * only `_storage` ids not referenced by any live `logo_storage_id` (and
 * cross-checked against other `_storage`-referencing tables). A
 * `{shopId, storageId}` pending-upload record at generateShopLogoUploadUrl
 * time would enable safe synchronous reclamation — deferred.
 */
export const setShopLogo = mutation({
  args: { shopId: v.id("shops"), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    await requireShopOwner(ctx, args.shopId);

    // Security: reject a storageId already used as another shop's logo. Without
    // this, an owner of any shop could adopt a victim's file id (leaked via
    // shops.list). This guarantees a shop's logo_storage_id is only ever a
    // file uniquely uploaded for that shop.
    const conflict = await ctx.db
      .query("shops")
      .withIndex("by_logo_storage_id", (q) => q.eq("logo_storage_id", args.storageId))
      .filter((q) => q.neq(q.field("_id"), args.shopId))
      .first();
    if (conflict) {
      throw new Error("That image is already in use by another shop.");
    }

    await ctx.db.patch(args.shopId, { logo_storage_id: args.storageId });

    return args.shopId;
  },
});

/**
 * Remove a shop's logo — unsets the field so the card falls back to the
 * placeholder.
 *
 * As with setShopLogo, we deliberately do NOT hard-delete the stored file:
 * a client-supplied storageId can't be proven to belong to this shop and
 * `ctx.storage.delete` is a global hard-delete with no refcount, so deleting
 * it could destroy another feature's file. Orphaned files are an accepted,
 * low-severity tradeoff, reclaimable later by a background job that deletes
 * only `_storage` ids not referenced by any live `logo_storage_id` (and
 * cross-checked against other `_storage`-referencing tables).
 */
export const clearShopLogo = mutation({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    await requireShopOwner(ctx, args.shopId);

    await ctx.db.patch(args.shopId, { logo_storage_id: undefined });

    return args.shopId;
  },
});
```

- [ ] **Step 4: Run the tests — expect pass**

```powershell
npx vitest run tests/shop_logo.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```powershell
git add convex/shops.ts tests/shop_logo.test.ts; git commit -m "feat: port shop logo mutations + getMyShops logoUrl from otopair-1"
```

---

### Task 5: Install react-easy-crop

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install**

```powershell
npm install react-easy-crop
```

Expected: adds `react-easy-crop` (v5.x) to dependencies; no peer warnings for React 19.

- [ ] **Step 2: Commit**

```powershell
git add package.json package-lock.json; git commit -m "chore: add react-easy-crop for shop logo cropping"
```

---

### Task 6: Canvas crop helper

**Files:**
- Create: `C:\Users\manso\Desktop\otopair-web\app\(portal)\settings\crop-image.ts`

No unit test — the vitest env is edge-runtime (no canvas/DOM); this is exercised live in Task 9.

- [ ] **Step 1: Write the helper**

```ts
// Renders the user's chosen crop of a source image to a square Blob for
// upload. Kept separate from the uploader component so the canvas math is
// isolated from React state.

export type CropAreaPixels = { x: number; y: number; width: number; height: number };

// The map card renders 56px and the settings avatar 64px — 512px output is
// plenty while keeping files far below the 2 MB contract cap.
const OUTPUT_MAX_PX = 512;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not read that image file."));
    image.src = src; // object URL — same-origin, no crossOrigin needed
  });
}

export async function cropAreaToBlob(
  sourceUrl: string,
  area: CropAreaPixels,
  sourceType: string,
): Promise<Blob> {
  const image = await loadImage(sourceUrl);
  // Modern browsers apply EXIF orientation when decoding, so `area` (from
  // react-easy-crop, measured on the displayed image) maps 1:1 onto
  // drawImage source coordinates.
  const size = Math.max(1, Math.round(Math.min(OUTPUT_MAX_PX, area.width)));
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable in this browser.");
  ctx.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, size, size);

  // JPEG for opaque photos (small files); PNG for formats that may carry
  // transparency (png/webp sources) so logos keep their alpha channel.
  const outputType = sourceType === "image/jpeg" ? "image/jpeg" : "image/png";
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, outputType, 0.9),
  );
  if (!blob) throw new Error("Could not process the cropped image.");
  return blob;
}
```

- [ ] **Step 2: Commit**

```powershell
git add "app/(portal)/settings/crop-image.ts"; git commit -m "feat: canvas crop-to-blob helper for shop logo upload"
```

---

### Task 7: Logo uploader component

**Files:**
- Create: `C:\Users\manso\Desktop\otopair-web\app\(portal)\settings\logo-uploader.tsx`

Layout: a vertical stack — 64px round avatar, then owner-only "Upload/Change logo" + "Remove" text buttons, then an inline message. The crop dialog is a fixed-inset overlay (this repo has no dialog primitive; this follows the existing hand-rolled overlay convention, e.g. `components/post-job-survey-dialog.tsx`). react-easy-crop needs no CSS import.

- [ ] **Step 1: Write the component**

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import Cropper from "react-easy-crop";
import type { Area } from "react-easy-crop";
import { ImageIcon, Loader2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cropAreaToBlob } from "./crop-image";

// Mirrors convex/shops.ts OWNER_ROLES — UI gating only; the mutations
// enforce ownership server-side regardless.
const OWNER_ROLES = new Set(["owner", "shop_owner", "admin"]);
const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

export default function ShopLogoUploader({
  shopId,
  logoUrl,
  memberRole,
}: {
  shopId: Id<"shops">;
  logoUrl: string | null;
  memberRole?: string;
}) {
  const generateUploadUrl = useMutation(api.shops.generateShopLogoUploadUrl);
  const setShopLogo = useMutation(api.shops.setShopLogo);
  const clearShopLogo = useMutation(api.shops.clearShopLogo);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [sourceType, setSourceType] = useState("image/png");
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [areaPixels, setAreaPixels] = useState<Area | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [message, setMessage] = useState("");

  const canEdit = OWNER_ROLES.has(memberRole ?? "");

  // Revoke the temporary object URL when it's replaced or on unmount.
  useEffect(() => {
    return () => {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    };
  }, [sourceUrl]);

  function handlePickFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setMessage("");
    if (!ACCEPTED_TYPES.has(file.type)) {
      setMessage("Please choose a PNG, JPEG, or WebP image.");
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      setMessage("Image is too large — max 10 MB.");
      return;
    }
    setSourceType(file.type);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setAreaPixels(null);
    setDialogError("");
    setSourceUrl(URL.createObjectURL(file));
  }

  const onCropComplete = useCallback((_area: Area, croppedAreaPixels: Area) => {
    setAreaPixels(croppedAreaPixels);
  }, []);

  function closeDialog() {
    if (isSaving) return;
    setSourceUrl(null); // the effect above revokes the object URL
    setDialogError("");
  }

  async function handleSave() {
    if (!sourceUrl || !areaPixels) return;
    setIsSaving(true);
    setDialogError("");
    try {
      const blob = await cropAreaToBlob(sourceUrl, areaPixels, sourceType);
      const uploadUrl = await generateUploadUrl({ shopId });
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": blob.type },
        body: blob,
      });
      if (!response.ok) throw new Error(`Upload failed (${response.status}).`);
      const { storageId } = await response.json();
      await setShopLogo({ shopId, storageId });
      setSourceUrl(null);
      setMessage("Logo updated.");
    } catch (error: unknown) {
      setDialogError(error instanceof Error ? error.message : "Could not save the logo.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRemove() {
    setIsRemoving(true);
    setMessage("");
    try {
      await clearShopLogo({ shopId });
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "Could not remove the logo.");
    } finally {
      setIsRemoving(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-full border border-gray-200 bg-gray-100">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- Convex storage
          // URLs aren't in next.config images.remotePatterns; plain <img> by design.
          <img src={logoUrl} alt="Shop logo" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <ImageIcon className="h-6 w-6 text-gray-400" />
          </div>
        )}
        {(isSaving || isRemoving) && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70">
            <Loader2 className="h-5 w-5 animate-spin text-gray-500" />
          </div>
        )}
      </div>

      {canEdit && (
        <div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isSaving || isRemoving}
              className="text-sm font-medium text-blue-600 hover:underline disabled:opacity-60"
            >
              {logoUrl ? "Change logo" : "Upload logo"}
            </button>
            {logoUrl && (
              <button
                type="button"
                onClick={() => void handleRemove()}
                disabled={isSaving || isRemoving}
                className="text-sm font-medium text-red-600 hover:underline disabled:opacity-60"
              >
                Remove
              </button>
            )}
          </div>
          {message && <p className="mt-1 max-w-[200px] text-xs text-gray-600">{message}</p>}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={handlePickFile}
          />
        </div>
      )}

      {sourceUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6">
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-900">
              Crop logo
            </h3>
            <div className="relative h-72 w-full overflow-hidden rounded-lg bg-gray-900">
              <Cropper
                image={sourceUrl}
                crop={crop}
                zoom={zoom}
                aspect={1}
                cropShape="round"
                showGrid={false}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={onCropComplete}
              />
            </div>
            <div className="mt-4 flex items-center gap-3">
              <span className="text-xs text-gray-500">Zoom</span>
              <input
                type="range"
                min={1}
                max={3}
                step={0.05}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                disabled={isSaving}
                className="w-full"
              />
            </div>
            {dialogError && <p className="mt-3 text-sm text-red-600">{dialogError}</p>}
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={closeDialog}
                disabled={isSaving}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={isSaving || !areaPixels}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
              >
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Save logo
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```powershell
git add "app/(portal)/settings/logo-uploader.tsx"; git commit -m "feat: shop logo uploader with crop dialog"
```

---

### Task 8: Render the uploader in the Shop Info card

**Files:**
- Modify: `C:\Users\manso\Desktop\otopair-web\app\(portal)\settings\page.tsx:18` (imports) and `:148-162` (header row)

- [ ] **Step 1: Add the import**

After the existing sibling imports (line ~18-21, `import HoursEditor from "./hours-editor";` block), add:

```tsx
import ShopLogoUploader from "./logo-uploader";
```

- [ ] **Step 2: Wrap the header row**

Replace (lines ~148-162):

```tsx
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-xl font-bold text-gray-900 mb-1">{shop.name}</h3>
                  <p className="text-gray-500 text-sm">/{shop.slug}</p>
                </div>
```

with:

```tsx
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <ShopLogoUploader
                    shopId={shop._id}
                    logoUrl={(shop as any).logoUrl ?? null}
                    memberRole={(shop as any).memberRole}
                  />
                  <div>
                    <h3 className="text-xl font-bold text-gray-900 mb-1">{shop.name}</h3>
                    <p className="text-gray-500 text-sm">/{shop.slug}</p>
                  </div>
                </div>
```

(The `(shop as any)` casts match the page's existing convention, e.g. `(shop as any).timezone` at line 48. The Active badge `<span>` after this block is untouched — the outer `justify-between` keeps it right-aligned.)

- [ ] **Step 3: Commit**

```powershell
git add "app/(portal)/settings/page.tsx"; git commit -m "feat: shop logo upload in Settings shop info card"
```

---

### Task 9: Typecheck + live verification

- [ ] **Step 1: Typecheck**

```powershell
npx tsc --noEmit
```

Expected: no NEW errors mentioning `logo-uploader.tsx`, `crop-image.ts`, `settings/page.tsx`, `convex/shops.ts`, or `convex/schema.ts`. (If the repo has pre-existing baseline errors elsewhere, ignore those — only our files must be clean.)

- [ ] **Step 2: Run the full new-test file once more**

```powershell
npx vitest run tests/shop_logo.test.ts
```

Expected: 4 passed. (Do NOT run the whole suite — the booking/scheduling tests are a known-flaky, off-limits subsystem.)

- [ ] **Step 3: Live verification (dev server on localhost:3000, signed in as Test Shop's owner)**

The dev server is already running via the Browser pane (`preview_start` name `otopair-web`). Sign-in state lives in the user's browser; if the Browser pane session isn't authenticated, hand the user this checklist instead of clicking through Clerk sign-in:

1. `/settings` → Shop Info card shows a gray circle placeholder left of "Test Shop" with "Upload logo".
2. Upload logo → pick a PNG → crop dialog opens → drag/zoom → Save logo → dialog closes, avatar shows the cropped image.
3. **Reload the page** → the logo still shows (proves the deployed `getMyShops` logoUrl change end-to-end).
4. Change logo → pick a different image → save → avatar swaps (replacement path; old file orphaned by design).
5. Remove → placeholder returns.
6. Console (`read_console_messages`) and server logs (`preview_logs`) show no new errors during the flow.
7. (If a non-owner member account is available) `/settings` as that member → avatar visible, no Upload/Remove controls.

- [ ] **Step 4: Fix anything found, re-verify, commit fixes**

```powershell
git add <changed files>; git commit -m "fix: shop logo upload polish from live verification"
```

(Skip if nothing needed fixing.)

---

## Out of scope (per spec §7)

Orphaned-file reaper; shop detail-page hero; server-side image validation/resizing; multi-image portfolio; re-crop of an existing logo ("Change" always starts from a fresh file pick).
