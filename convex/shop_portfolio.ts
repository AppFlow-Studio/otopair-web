/**
 * shop_portfolio.ts - Shop portfolio / gallery images
 *
 * Two image sources coexist per row (exactly one set):
 *  - content_id  → legacy cdn_assets reference (seed data)
 *  - storage_id  → owner-uploaded file in Convex storage (settings gallery)
 *
 * Reads resolve both to a plain URL; writes (owner-gated) only ever create
 * storage-backed rows.
 */

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireShopOwner } from "./shops";

export const MAX_PORTFOLIO_IMAGES = 12;
const MAX_CAPTION_LENGTH = 200;

async function resolveRowUrl(ctx: any, row: any): Promise<string | null> {
  if (row.storage_id) return await ctx.storage.getUrl(row.storage_id);
  if (row.content_id) {
    const asset = (await ctx.db.get(row.content_id as Id<"cdn_assets">)) as {
      url?: string;
    } | null;
    return asset?.url ?? null;
  }
  return null;
}

function sortRows<T extends { display_order?: number; _creationTime: number }>(rows: T[]): T[] {
  return rows.sort(
    (a, b) =>
      (a.display_order ?? 0) - (b.display_order ?? 0) || a._creationTime - b._creationTime,
  );
}

async function getOwnedRow(ctx: any, shopId: Id<"shops">, portfolioId: Id<"shop_portfolio">) {
  const row = await ctx.db.get(portfolioId);
  if (!row || String(row.shop_id) !== String(shopId)) {
    throw new Error("Portfolio image not found for this shop.");
  }
  return row;
}

/**
 * List portfolio items for a shop with resolved URLs. Public — this is
 * customer-facing gallery content (same posture as the legacy version);
 * legacy captions come from cdn_assets, uploaded rows carry their own.
 */
export const listByShopId = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    const items = await ctx.db
      .query("shop_portfolio")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .collect();

    const withUrls = await Promise.all(
      sortRows(items).map(async (item) => {
        let caption = item.caption ?? null;
        if (!caption && item.content_id) {
          const asset = (await ctx.db.get(item.content_id as Id<"cdn_assets">)) as {
            caption?: string;
          } | null;
          caption = asset?.caption ?? null;
        }
        return {
          _id: item._id,
          shop_id: item.shop_id,
          content_id: item.content_id,
          display_order: item.display_order,
          url: await resolveRowUrl(ctx, item),
          caption,
          // Only storage-backed rows are editable from the dashboard.
          isUploaded: item.storage_id != null,
        };
      }),
    );

    return withUrls.filter((x) => x.url != null);
  },
});

/**
 * Generate a short-lived upload URL for a portfolio image. Same
 * mutation-not-action pattern as shops.generateShopLogoUploadUrl. The cap is
 * checked here too so the picker can fail before bytes are uploaded, but the
 * authoritative check is in addImage.
 */
export const generateUploadUrl = mutation({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    await requireShopOwner(ctx, args.shopId);
    const existing = await ctx.db
      .query("shop_portfolio")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .collect();
    if (existing.length >= MAX_PORTFOLIO_IMAGES) {
      throw new Error(`Portfolio is full — max ${MAX_PORTFOLIO_IMAGES} images.`);
    }
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Attach a newly-uploaded file as a portfolio image (appended last).
 *
 * Security mirrors shops.setShopLogo: reject a storageId already referenced
 * by any other portfolio row or by any shop's logo, so a leaked file id can't
 * be adopted cross-shop (and a later remove can't strand someone else's
 * reference). Replaced/removed files are never hard-deleted here — same
 * orphan-and-reap-later tradeoff documented on setShopLogo.
 */
export const addImage = mutation({
  args: {
    shopId: v.id("shops"),
    storageId: v.id("_storage"),
    caption: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireShopOwner(ctx, args.shopId);

    const [portfolioConflict, logoConflict] = await Promise.all([
      ctx.db
        .query("shop_portfolio")
        .withIndex("by_storage_id", (q) => q.eq("storage_id", args.storageId))
        .first(),
      ctx.db
        .query("shops")
        .withIndex("by_logo_storage_id", (q) => q.eq("logo_storage_id", args.storageId))
        .first(),
    ]);
    if (portfolioConflict || logoConflict) {
      throw new Error("That image is already in use.");
    }

    const existing = await ctx.db
      .query("shop_portfolio")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .collect();
    if (existing.length >= MAX_PORTFOLIO_IMAGES) {
      throw new Error(`Portfolio is full — max ${MAX_PORTFOLIO_IMAGES} images.`);
    }

    const caption = args.caption?.trim().slice(0, MAX_CAPTION_LENGTH);
    const nextOrder = existing.reduce((max, row) => Math.max(max, row.display_order ?? 0), 0) + 1;

    return await ctx.db.insert("shop_portfolio", {
      shop_id: args.shopId,
      storage_id: args.storageId,
      caption: caption || undefined,
      display_order: nextOrder,
      created_at: Date.now(),
    });
  },
});

/**
 * Remove a portfolio image (the row only — the stored file is left as an
 * orphan for the same reasons documented on shops.clearShopLogo).
 */
export const removeImage = mutation({
  args: { shopId: v.id("shops"), portfolioId: v.id("shop_portfolio") },
  handler: async (ctx, args) => {
    await requireShopOwner(ctx, args.shopId);
    await getOwnedRow(ctx, args.shopId, args.portfolioId);
    await ctx.db.delete(args.portfolioId);
    return args.portfolioId;
  },
});

/** Set (or clear, with an empty string) an image's caption. */
export const setCaption = mutation({
  args: {
    shopId: v.id("shops"),
    portfolioId: v.id("shop_portfolio"),
    caption: v.string(),
  },
  handler: async (ctx, args) => {
    await requireShopOwner(ctx, args.shopId);
    await getOwnedRow(ctx, args.shopId, args.portfolioId);
    const caption = args.caption.trim().slice(0, MAX_CAPTION_LENGTH);
    await ctx.db.patch(args.portfolioId, { caption: caption || undefined });
    return args.portfolioId;
  },
});

/**
 * Persist a new display order. Takes the full ordered id list as the client
 * sees it; each id is verified to belong to the shop. Rows not included
 * (e.g. added concurrently elsewhere) keep their old display_order rather
 * than failing the whole reorder.
 */
export const reorder = mutation({
  args: { shopId: v.id("shops"), orderedIds: v.array(v.id("shop_portfolio")) },
  handler: async (ctx, args) => {
    await requireShopOwner(ctx, args.shopId);
    if (new Set(args.orderedIds.map(String)).size !== args.orderedIds.length) {
      throw new Error("Duplicate ids in reorder request.");
    }
    for (const [index, portfolioId] of args.orderedIds.entries()) {
      await getOwnedRow(ctx, args.shopId, portfolioId);
      await ctx.db.patch(portfolioId, { display_order: index + 1 });
    }
    return args.shopId;
  },
});
