// =============================================================================
// Shops portal · Offerings Matrix — /shops/offerings (Shops spec §4.6).
// 23 services (grouped by category) × shops grid; toggle = ceremony
// (shops.write). Right rail: coverage gaps (offered by ≤1 shop). Network
// price-band mini-bars DESCOPED (needs a quote-engine run per cell) — noted.
// =============================================================================
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireDirector, logAudit } from "./directorGate";

// --- Authored return types (see dataOverview.ts header) -----------------------

export type MatrixService = {
  service_id: string;
  name: string;
  category: string;
  offered_by: string[]; // shop_ids
};
export type OfferingsResult = {
  shops: { id: string; name: string }[];
  services: MatrixService[];
  coverage_gaps: { service: string; offered_by: number }[];
};

export const matrix = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<OfferingsResult> => {
    await requireDirector(ctx, token);
    const shops = await ctx.db.query("shops").collect(); // 9 rows
    const services = await ctx.db.query("services").collect(); // 23 rows
    const categories = await ctx.db.query("service_categories").collect(); // 4 rows
    const catName = new Map(categories.map((c) => [String(c._id), c.name]));

    const offeredByService = new Map<string, Set<string>>();
    for (const s of shops) {
      const rows = await ctx.db
        .query("shop_services")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", s._id))
        .take(60);
      for (const r of rows) {
        if (r.is_offered === false) continue;
        const key = String(r.service_id);
        const set = offeredByService.get(key) ?? new Set<string>();
        set.add(String(s._id));
        offeredByService.set(key, set);
      }
    }

    const matrixServices: MatrixService[] = services
      .map((svc) => ({
        service_id: String(svc._id),
        name: svc.name,
        category: svc.service_category_id
          ? (catName.get(String(svc.service_category_id)) ?? "Uncategorized")
          : "Uncategorized",
        offered_by: [...(offeredByService.get(String(svc._id)) ?? [])],
      }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

    return {
      shops: shops.map((s) => ({ id: String(s._id), name: s.name })),
      services: matrixServices,
      coverage_gaps: matrixServices
        .filter((s) => s.offered_by.length <= 1)
        .map((s) => ({ service: s.name, offered_by: s.offered_by.length })),
    };
  },
});

export const toggleOffering = mutation({
  args: {
    token: v.string(),
    reason: v.string(),
    shopId: v.id("shops"),
    serviceId: v.id("services"),
    offered: v.boolean(),
  },
  handler: async (ctx, { token, reason, shopId, serviceId, offered }): Promise<{ ok: true }> => {
    const actor = await requireDirector(ctx, token, "shops.write");
    if (reason.trim().length < 4) throw new Error("A reason is required.");
    const shop = await ctx.db.get(shopId);
    const service = await ctx.db.get(serviceId);
    if (!shop || !service) throw new Error("Shop or service no longer exists.");
    const existing = await ctx.db
      .query("shop_services")
      .withIndex("by_shop_and_service", (q) => q.eq("shop_id", shopId).eq("service_id", serviceId))
      .first();
    if (existing) {
      if ((existing.is_offered !== false) === offered)
        throw new Error(`${service.name} is already ${offered ? "offered" : "not offered"} there.`);
      await ctx.db.patch(existing._id, { is_offered: offered });
    } else {
      if (!offered) throw new Error("Nothing to turn off — no offering row exists.");
      await ctx.db.insert("shop_services", { shop_id: shopId, service_id: serviceId, is_offered: true });
    }
    await logAudit(ctx, actor, {
      entity_type: "shop_service",
      entity_id: `${String(shopId)}:${String(serviceId)}`,
      action: offered ? "offering_enabled" : "offering_disabled",
      detail: `${shop.name} · ${service.name} → ${offered ? "offered" : "off"} — ${reason.trim()}`,
    });
    return { ok: true };
  },
});
