/**
 * shopLicenses.ts — Shop compliance documents (licenses & certificates).
 *
 * A shop uploads proof it can legally offer certain services — today just the
 * NY DMV inspection station license that State Inspection / Emissions Test
 * require. Storage-backed rows (like shop_portfolio) with a review workflow the
 * director panel drives.
 *
 * Owner-gated (this file): shop owners upload / replace / remove / list their
 * own documents. Director-gated review lives in shopsDirectory.ts.
 */

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireShopOwner } from "./shops";

// Known compliance-document types. The client catalog (lib/license-catalog.ts)
// is the source of truth for labels/grouping; this list is informational only.
// `addLicense` accepts ANY license_type string (custom "other" documents store
// their human label directly), so this is not a validation gate.
export const LICENSE_TYPES = [
  "dmv_inspection_station",
  "business_license",
  "dealer_license",
  "garage_liability_insurance",
  "ase_certification",
  "oem_certification",
  "epa_609",
] as const;
export type LicenseType = (typeof LICENSE_TYPES)[number];

const MAX_LICENSES_PER_SHOP = 25;

/** Reject a storageId already referenced by a license, a portfolio image, or a
 *  shop logo, so a leaked file id can't be adopted cross-record. */
async function assertStorageIdUnused(ctx: any, storageId: Id<"_storage">) {
  const [licenseConflict, portfolioConflict, logoConflict] = await Promise.all([
    ctx.db
      .query("shop_licenses")
      .withIndex("by_storage_id", (q: any) => q.eq("storage_id", storageId))
      .first(),
    ctx.db
      .query("shop_portfolio")
      .withIndex("by_storage_id", (q: any) => q.eq("storage_id", storageId))
      .first(),
    ctx.db
      .query("shops")
      .withIndex("by_logo_storage_id", (q: any) => q.eq("logo_storage_id", storageId))
      .first(),
  ]);
  if (licenseConflict || portfolioConflict || logoConflict) {
    throw new Error("That file is already in use.");
  }
}

/**
 * Short-lived upload URL for a compliance document. Mutation (not action),
 * mirroring shop_portfolio.generateUploadUrl. Owner-gated.
 */
export const generateUploadUrl = mutation({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    await requireShopOwner(ctx, args.shopId);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Attach a newly-uploaded file as a compliance document. Uploading a document
 * of a type the shop already has SUPERSEDES the old one (the prior row is
 * deleted; the stored file is orphaned — same reap-later tradeoff as
 * shop_portfolio.removeImage). New documents always start pending_review.
 */
export const addLicense = mutation({
  args: {
    shopId: v.id("shops"),
    storageId: v.id("_storage"),
    licenseType: v.string(),
    originalFilename: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    licenseNumber: v.optional(v.string()),
    issuer: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireShopOwner(ctx, args.shopId);
    await assertStorageIdUnused(ctx, args.storageId);

    const existing = await ctx.db
      .query("shop_licenses")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .collect();
    if (existing.length >= MAX_LICENSES_PER_SHOP) {
      throw new Error(`Too many documents — max ${MAX_LICENSES_PER_SHOP}.`);
    }

    // Single active document per type: drop the previous one of this type.
    for (const row of existing) {
      if (row.license_type === args.licenseType) {
        await ctx.db.delete(row._id);
      }
    }

    return await ctx.db.insert("shop_licenses", {
      shop_id: args.shopId,
      license_type: args.licenseType,
      storage_id: args.storageId,
      original_filename: args.originalFilename,
      mime_type: args.mimeType,
      license_number: args.licenseNumber?.trim() || undefined,
      issuer: args.issuer?.trim() || undefined,
      expires_at: args.expiresAt,
      review_status: "pending_review",
      uploaded_by: user._id,
      created_at: Date.now(),
    });
  },
});

/** Remove a compliance document (row only; the stored file is left orphaned). */
export const removeLicense = mutation({
  args: { shopId: v.id("shops"), licenseId: v.id("shop_licenses") },
  handler: async (ctx, args) => {
    await requireShopOwner(ctx, args.shopId);
    const row = await ctx.db.get(args.licenseId);
    if (!row || String(row.shop_id) !== String(args.shopId)) {
      throw new Error("Document not found for this shop.");
    }
    await ctx.db.delete(args.licenseId);
    return args.licenseId;
  },
});

/**
 * List a shop's compliance documents with resolved file URLs. Owner-gated —
 * these are private, unlike the public portfolio gallery. Used by both the
 * onboarding step and the Settings section.
 */
export const listForShop = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    await requireShopOwner(ctx, args.shopId);
    const rows = await ctx.db
      .query("shop_licenses")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .collect();

    return await Promise.all(
      rows
        .sort((a, b) => b.created_at - a.created_at)
        .map(async (row) => ({
          _id: row._id,
          licenseType: row.license_type,
          url: row.storage_id ? await ctx.storage.getUrl(row.storage_id) : null,
          originalFilename: row.original_filename ?? null,
          mimeType: row.mime_type ?? null,
          licenseNumber: row.license_number ?? null,
          issuer: row.issuer ?? null,
          expiresAt: row.expires_at ?? null,
          reviewStatus: row.review_status,
          reviewNote: row.review_note ?? null,
          reviewedAt: row.reviewed_at ?? null,
          createdAt: row.created_at,
        })),
    );
  },
});
