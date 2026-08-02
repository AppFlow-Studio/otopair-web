/**
 * TEMPORARY demo seeder — populates a realistic parsed Service History
 * receipt so we can view the populated Cars → Service History UI without
 * running the real upload/Reducto pipeline. DELETE this file after the demo.
 *
 *   npx convex run _seedDemo:listOwners
 *   npx convex run _seedDemo:seedForVin '{"vin":"<VIN>"}'
 *   npx convex run _seedDemo:cleanup '{"vin":"<VIN>"}'
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

const SEED_FILENAME = "SEED_DEMO_receipt.pdf";

export const listOwners = internalQuery({
  args: {},
  handler: async (ctx) => {
    const owners = await ctx.db.query("vehicle_owners").collect();
    const out = [];
    for (const o of owners) {
      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", o.vin))
        .unique();
      const meta = (vehicle as any)?.metadata ?? {};
      out.push({
        ownerId: o._id,
        userId: o.user_id,
        vin: o.vin,
        status: o.status,
        make: meta.make ?? null,
        model: meta.model ?? null,
        year: (vehicle as any)?.year ?? null,
      });
    }
    return out;
  },
});

export const insertSeeded = internalMutation({
  args: {
    ownerId: v.id("vehicle_owners"),
    userId: v.id("users"),
    vin: v.string(),
    storageId: v.id("_storage"),
    now: v.number(),
  },
  handler: async (ctx, { ownerId, userId, vin, storageId, now }) => {
    const docId = await ctx.db.insert("vehicle_documents", {
      user_id: userId,
      vehicle_owner_id: ownerId,
      vin,
      storage_id: storageId,
      mime_type: "application/pdf",
      original_filename: SEED_FILENAME,
      size_bytes: 48213,
      uploaded_at: now,
      source: "user_upload",
      parse_status: "parsed",
      parsed_at: now,
    });

    const payload = {
      service_date: new Date(now - 12 * 24 * 60 * 60 * 1000).toISOString(),
      shop: {
        name: "Precision Auto Works",
        street: "1820 W 35th St",
        city: "Austin",
        state: "TX",
        zip: "78703",
        phone: "(512) 555-0142",
        labor_rate_hourly: 135,
      },
      vehicle: { odometer: 41250 },
      customer_concern: "Routine maintenance — oil + brake inspection",
      line_items: [
        {
          kind: "service",
          description: "Full synthetic oil change",
          line_total_cents: 8995,
        },
        {
          kind: "part",
          description: "Mobil 1 5W-30 (6 qt)",
          line_total_cents: 4794,
        },
        {
          kind: "service",
          description: "Front brake pad replacement",
          line_total_cents: 18500,
        },
        {
          kind: "part",
          description: "Ceramic brake pads (front)",
          line_total_cents: 8900,
        },
        {
          kind: "service",
          description: "Multi-point inspection",
          line_total_cents: 0,
        },
      ],
      labor_subtotal_cents: 27495,
      parts_subtotal_cents: 13694,
      total_cents: 44189,
    };

    await ctx.db.insert("vehicle_document_extractions", {
      document_id: docId,
      schema_version: 1,
      payload,
      overall_confidence: 0.96,
      review_state: "auto_accepted",
      created_at: now,
    });

    return { docId };
  },
});

export const seedForVin = internalAction({
  args: { vin: v.string(), now: v.number() },
  handler: async (ctx, { vin, now }) => {
    const owners = await ctx.runQuery(internal._seedDemo.listOwners, {});
    const owner = owners.find((o) => o.vin === vin);
    if (!owner) throw new Error(`No vehicle_owner for vin ${vin}`);

    // Minimal blob just to satisfy the required storage_id FK — the row
    // renders from the extraction payload, not this file.
    const storageId = await ctx.storage.store(
      new Blob(["%PDF-1.4 seed demo receipt"], { type: "application/pdf" }),
    );

    return await ctx.runMutation(internal._seedDemo.insertSeeded, {
      ownerId: owner.ownerId,
      userId: owner.userId,
      vin: owner.vin,
      storageId,
      now,
    });
  },
});

export const setStatus = internalMutation({
  args: { vin: v.string(), status: v.string() },
  handler: async (ctx, { vin, status }) => {
    const docs = await ctx.db
      .query("vehicle_documents")
      .withIndex("by_vin", (q) => q.eq("vin", vin))
      .collect();
    for (const d of docs) {
      if (d.original_filename !== SEED_FILENAME) continue;
      await ctx.db.patch(d._id, { parse_status: status as any });
    }
    return { updated: docs.length };
  },
});

export const cleanup = internalMutation({
  args: { vin: v.string() },
  handler: async (ctx, { vin }) => {
    const docs = await ctx.db
      .query("vehicle_documents")
      .withIndex("by_vin", (q) => q.eq("vin", vin))
      .collect();
    let removed = 0;
    for (const d of docs) {
      if (d.original_filename !== SEED_FILENAME) continue;
      const ex = await ctx.db
        .query("vehicle_document_extractions")
        .withIndex("by_document", (q) => q.eq("document_id", d._id))
        .collect();
      for (const e of ex) await ctx.db.delete(e._id);
      await ctx.storage.delete(d.storage_id).catch(() => {});
      await ctx.db.delete(d._id);
      removed += 1;
    }
    return { removed };
  },
});
