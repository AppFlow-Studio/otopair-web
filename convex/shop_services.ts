import { query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { formatServiceDisplayName } from "../utils/serviceDisplayName";
import {
  findServicesNotOffered,
  offeringState,
  serviceNotOfferedMessage,
  type BlockedService,
} from "./lib/shopServiceOffering";

/**
 * Every (shop, service) pair a customer can book — the mobile app builds each
 * shop's `serviceIds` from this. Only offered rows come back (bug #404): the
 * app already skipped `is_offered: false`, and the same predicate as the
 * booking guard (lib/shopServiceOffering.ts) also drops retired or deleted
 * services and collapses duplicate rows to one per pair, so the list can't
 * show a service the booking would refuse.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const shopServices = await ctx.db.query("shop_services").collect();
    const rowsByPair = new Map<string, typeof shopServices>();
    for (const row of shopServices) {
      const key = `${String(row.shop_id)}:${String(row.service_id)}`;
      const rows = rowsByPair.get(key);
      if (rows) rows.push(row);
      else rowsByPair.set(key, [row]);
    }
    const offered = await Promise.all(
      Array.from(rowsByPair.values()).map(async (rows) => {
        const shopService = rows.find((row) => row.is_offered === true);
        if (!shopService) return null;
        const service = await ctx.db.get(shopService.service_id);
        if (offeringState(service, rows) !== "offered") return null;
        const shop = await ctx.db.get(shopService.shop_id);
        return { ...shopService, service, shop };
      }),
    );
    return offered.filter((row): row is NonNullable<typeof row> => row !== null);
  },
});

/**
 * Live Review & Pay gate for the customer app (bug #404): can this shop book
 * every service in the cart right now? Same predicate as the commit-time guard
 * in bookings.createBatch, so `ok: false` here is exactly a booking the server
 * would refuse with SERVICE_NOT_OFFERED — and it updates the moment the shop
 * saves Settings → Services. Pass `source_recommendation_id` + `vin` when the
 * booking started from the shop's own recommendation (exempt, like the guard).
 *
 * Ids are plain strings so a stale or malformed id from a cached cart reads as
 * "missing" instead of throwing the whole screen. No auth, like `list`.
 */
export const validateCheckoutServices = query({
  args: {
    shop_id: v.string(),
    service_ids: v.array(v.string()),
    source_recommendation_id: v.optional(v.string()),
    vin: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const shopId = ctx.db.normalizeId("shops", args.shop_id);
    const shop = shopId ? await ctx.db.get(shopId) : null;

    const blocked: BlockedService[] = [];
    const known: Id<"services">[] = [];
    const seen = new Set<string>();
    for (const raw of args.service_ids) {
      if (seen.has(raw)) continue;
      seen.add(raw);
      const serviceId = ctx.db.normalizeId("services", raw);
      if (serviceId) known.push(serviceId);
      else blocked.push({ serviceId: raw, name: "", reason: "missing" });
    }

    if (!shopId || !shop) {
      // No such shop: nothing in the cart is bookable there.
      for (const serviceId of known) {
        const service = await ctx.db.get(serviceId);
        blocked.push({
          serviceId: String(serviceId),
          name: formatServiceDisplayName(service?.name ?? ""),
          reason: service ? "not_offered" : "missing",
        });
      }
    } else {
      const recommendationId = args.source_recommendation_id
        ? ctx.db.normalizeId("job_recommendations", args.source_recommendation_id)
        : null;
      blocked.push(
        ...(await findServicesNotOffered(ctx, shopId, known, {
          sourceRecommendationId: recommendationId,
          vin: args.vin ?? null,
        })),
      );
    }

    const ok = blocked.length === 0;
    return {
      ok,
      blocked,
      // The sentence the booking would fail with, ready for a banner.
      message: ok
        ? null
        : serviceNotOfferedMessage(
            shop?.name,
            blocked.map((b) => b.name),
          ),
    };
  },
});

export const getById = query({
  args: { id: v.id("shop_services") },
  handler: async (ctx, args) => {
    const shopService = await ctx.db.get(args.id);
    if (!shopService) {
      return null;
    }
    const service = await ctx.db.get(shopService.service_id);
    const shop = await ctx.db.get(shopService.shop_id);
    return { ...shopService, service, shop };
  },
});

export const getByShopId = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("shop_services")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .filter((q) => q.eq(q.field("is_offered"), true))
      .collect();
  },
});

export const getByServiceId = query({
  args: { serviceId: v.id("services") },
  handler: async (ctx, args) => {
    const shopServices = await ctx.db
      .query("shop_services")
      .filter((q) => q.and(q.eq(q.field("service_id"), args.serviceId), q.eq(q.field("is_offered"), true)))
      .collect();
    return await Promise.all(
      shopServices.map(async (ss) => {
        const shop = await ctx.db.get(ss.shop_id);
        return { ...ss, shop };
      }),
    );
  },
});
