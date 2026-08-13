// ⌘K cross-entity search (shell spec §3A). Deliberately narrow per risk R11:
// exact-ish lookups over existing indexes only — users by email prefix
// (by_email index range scan), shops by name substring (9-row table), and
// direct ID lookup for bookings/users/shops when the query parses as an ID.
// No search indexes, no fuzzy matching in P0.
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";

const MAX_PER_GROUP = 8;

// Authored return type — load-bearing (see convex/backfillTires.ts
// _listCandidates): without it TS must infer the handler while resolving the
// whole ApiFromModules barrel, which exhausts the checker's instantiation
// budget and silently degrades api.* types to `any` in consumer files.
export type PortalSearchHit = { id: string; label: string; sub: string };
export type PortalSearchResult = {
  users: PortalSearchHit[];
  shops: PortalSearchHit[];
  bookings: PortalSearchHit[];
};

export const search = query({
  args: { token: v.string(), q: v.string() },
  handler: async (ctx, { token, q }): Promise<PortalSearchResult> => {
    await requireDirector(ctx, token);
    const needle = q.trim();
    const results: PortalSearchResult = { users: [], shops: [], bookings: [] };
    if (needle.length < 2) return results;
    const lower = needle.toLowerCase();

    // Direct ID lookup — IDs are pasted from other pages or Slack constantly.
    const maybeBooking = ctx.db.normalizeId("bookings", needle);
    if (maybeBooking) {
      const b = await ctx.db.get(maybeBooking);
      if (b) {
        results.bookings.push({
          id: String(b._id),
          label: `Booking · ${b.status}`,
          sub: (b as { scheduled_date?: string }).scheduled_date ?? "",
        });
      }
    }
    const maybeUser = ctx.db.normalizeId("users", needle);
    if (maybeUser) {
      const u = await ctx.db.get(maybeUser);
      if (u) {
        results.users.push({
          id: String(u._id),
          label: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || "User",
          sub: u.email ?? "",
        });
      }
    }
    const maybeShop = ctx.db.normalizeId("shops", needle);
    if (maybeShop) {
      const s = await ctx.db.get(maybeShop);
      if (s) results.shops.push({ id: String(s._id), label: s.name, sub: s.city ?? "" });
    }

    // Users by email prefix — index range scan, never a table scan.
    if (results.users.length < MAX_PER_GROUP) {
      const matches = await ctx.db
        .query("users")
        .withIndex("by_email", (idx) => idx.gte("email", lower).lt("email", lower + "￿"))
        .take(MAX_PER_GROUP);
      for (const u of matches) {
        if (results.users.some((r) => r.id === String(u._id))) continue;
        results.users.push({
          id: String(u._id),
          label: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || "User",
          sub: u.email ?? "",
        });
      }
    }

    // Shops by name substring — the table is single-digit rows (9 measured);
    // revisit with a search index if the network ever grows past ~200.
    const shops = await ctx.db.query("shops").collect();
    for (const s of shops) {
      if (results.shops.length >= MAX_PER_GROUP) break;
      if (results.shops.some((r) => r.id === String(s._id))) continue;
      if (s.name.toLowerCase().includes(lower)) {
        results.shops.push({ id: String(s._id), label: s.name, sub: s.city ?? "" });
      }
    }

    return results;
  },
});
