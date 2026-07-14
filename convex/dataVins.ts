// =============================================================================
// Data portal · VIN Explorer — /data/vins (Data spec §4B).
// List: every decoded vehicle with FK-link health ("missing links" = decode
// gaps). Detail: decode card (all FKs as chips), metadata JSON, passport
// link, ownership (dates only — user identity stays gated), recent booking
// chips. Re-decode reuses dataControlRoom.triggerReEnrich; nothing new here.
// =============================================================================
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";

// --- Authored return types (see dataOverview.ts header) -----------------------

export type VinListRow = {
  id: string;
  vin: string;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  engine_code: string | null;
  has_image: boolean;
  owners: number;
  missing_links: boolean;
};

export const listVehicles = query({
  args: {
    token: v.string(),
    paginationOpts: paginationOptsValidator,
    missingLinksOnly: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { token, paginationOpts, missingLinksOnly },
  ): Promise<{ page: VinListRow[]; isDone: boolean; continueCursor: string }> => {
    await requireDirector(ctx, token);
    const page = await ctx.db.query("vehicles").order("desc").paginate(paginationOpts);

    const trimCache = new Map<string, { name: string | null; model: string | null; make: string | null }>();
    const engineCache = new Map<string, string | null>();

    const rows: VinListRow[] = [];
    for (const veh of page.page) {
      let trim: string | null = null;
      let model: string | null = null;
      let make: string | null = null;
      if (veh.trim_id) {
        const tid = String(veh.trim_id);
        if (!trimCache.has(tid)) {
          const t = await ctx.db.get(veh.trim_id);
          let modelName: string | null = null;
          let makeName: string | null = null;
          const modelId = (t as { model_id?: import("./_generated/dataModel").Id<"models"> } | null)
            ?.model_id;
          if (modelId) {
            const m = await ctx.db.get(modelId);
            modelName = m ? ((m as { name?: string }).name ?? null) : null;
            const makeId = (m as { make_id?: import("./_generated/dataModel").Id<"makes"> } | null)
              ?.make_id;
            if (makeId) {
              const mk = await ctx.db.get(makeId);
              makeName = mk ? ((mk as { name?: string }).name ?? null) : null;
            }
          }
          trimCache.set(tid, {
            name: t ? ((t as { name?: string }).name ?? null) : null,
            model: modelName,
            make: makeName,
          });
        }
        const cached = trimCache.get(tid)!;
        trim = cached.name;
        model = cached.model;
        make = cached.make;
      }
      let engineCode: string | null = null;
      if (veh.engine_id) {
        const eid = String(veh.engine_id);
        if (!engineCache.has(eid)) {
          const e = await ctx.db.get(veh.engine_id);
          const eo = e as { engine_code?: string; name?: string } | null;
          engineCache.set(eid, eo?.engine_code ?? eo?.name ?? null);
        }
        engineCode = engineCache.get(eid) ?? null;
      }
      const owners = await ctx.db
        .query("vehicle_owners")
        .withIndex("by_vin", (q) => q.eq("vin", veh.vin))
        .take(5);
      const missing = veh.trim_id == null || veh.engine_id == null;
      if (missingLinksOnly && !missing) continue;
      rows.push({
        id: String(veh._id),
        vin: veh.vin,
        year: veh.year ?? null,
        make,
        model,
        trim,
        engine_code: engineCode,
        has_image: veh.image_url != null,
        owners: owners.length,
        missing_links: missing,
      });
    }
    return { page: rows, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

export type VinDetailResult = {
  id: string;
  vin: string;
  year: number | null;
  image_url: string | null;
  config: { id: string; config_key: string } | null;
  links: { kind: string; id: string | null; label: string | null }[];
  metadata_json: string | null;
  passport: { vin: string; last_shop_confirmed_at: number | null } | null;
  ownership: { added_at: number | null; removed_at: number | null; status: string }[];
  bookings: { id: string; status: string; scheduled_date: string | null; created_at: number }[];
  bookings_window_note: string;
  queue: { status: string; error: string | null; queued_at: number | null } | null;
} | null;

export const vinDetail = query({
  args: { token: v.string(), vin: v.string() },
  handler: async (ctx, { token, vin }): Promise<VinDetailResult> => {
    await requireDirector(ctx, token);
    const veh = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", vin.trim().toUpperCase()))
      .first();
    if (!veh) return null;

    // Decode card: every FK as a chip with its resolved label. A null id is
    // itself signal — it IS the decode gap the missing-links filter hunts.
    const links: { kind: string; id: string | null; label: string | null }[] = [];
    {
      const t = veh.trim_id ? await ctx.db.get(veh.trim_id) : null;
      links.push({
        kind: "trim",
        id: veh.trim_id ? String(veh.trim_id) : null,
        label: t ? ((t as { name?: string }).name ?? null) : null,
      });
      const e = veh.engine_id ? await ctx.db.get(veh.engine_id) : null;
      const eo = e as { engine_code?: string; name?: string } | null;
      links.push({
        kind: "engine",
        id: veh.engine_id ? String(veh.engine_id) : null,
        label: eo?.engine_code ?? eo?.name ?? null,
      });
      const tr = veh.transmission_id ? await ctx.db.get(veh.transmission_id) : null;
      const tro = tr as { transmission_type?: string; type?: string; name?: string } | null;
      links.push({
        kind: "transmission",
        id: veh.transmission_id ? String(veh.transmission_id) : null,
        label: tro?.transmission_type ?? tro?.type ?? tro?.name ?? null,
      });
      const ch = veh.chassis_id ? await ctx.db.get(veh.chassis_id) : null;
      const cho = ch as { code?: string; name?: string } | null;
      links.push({
        kind: "chassis",
        id: veh.chassis_id ? String(veh.chassis_id) : null,
        label: cho?.code ?? cho?.name ?? null,
      });
    }

    const config = veh.vehicle_config_id ? await ctx.db.get(veh.vehicle_config_id) : null;

    const passport = await ctx.db
      .query("vehicle_passports")
      .withIndex("by_vin", (q) => q.eq("vin", veh.vin))
      .first();

    const owners = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin", (q) => q.eq("vin", veh.vin))
      .take(10);

    // Bookings: no by_vin index exists — bounded workaround reads each
    // owner's recent bookings and filters to this VIN. Labeled as a window.
    const bookings: { id: string; status: string; scheduled_date: string | null; created_at: number }[] = [];
    for (const o of owners.slice(0, 5)) {
      const rows = await ctx.db
        .query("bookings")
        .withIndex("by_user_id", (q) => q.eq("user_id", o.user_id))
        .order("desc")
        .take(25);
      for (const b of rows) {
        if (b.vin === veh.vin) {
          bookings.push({
            id: String(b._id),
            status: b.status,
            scheduled_date: (b as { scheduled_date?: string }).scheduled_date ?? null,
            created_at: (b as { created_at?: number }).created_at ?? b._creationTime,
          });
        }
      }
    }
    bookings.sort((a, b) => b.created_at - a.created_at);

    const queueRow = await ctx.db
      .query("vin_queue")
      .withIndex("by_vin", (q) => q.eq("vin", veh.vin))
      .first();

    return {
      id: String(veh._id),
      vin: veh.vin,
      year: veh.year ?? null,
      image_url: veh.image_url ?? null,
      config: config ? { id: String(config._id), config_key: config.config_key } : null,
      links,
      metadata_json: veh.metadata != null ? JSON.stringify(veh.metadata, null, 2) : null,
      passport: passport
        ? {
            vin: passport.vin,
            last_shop_confirmed_at:
              (passport as { last_shop_confirmed_at?: number }).last_shop_confirmed_at ?? null,
          }
        : null,
      ownership: owners.map((o) => ({
        added_at: o.added_at ?? null,
        removed_at: o.removed_at ?? null,
        status: o.status,
      })),
      bookings: bookings.slice(0, 25),
      bookings_window_note:
        "recent bookings via each owner's last 25 (no by_vin index) — a window, not lifetime",
      queue: queueRow
        ? {
            status: queueRow.status,
            error: queueRow.error ?? null,
            queued_at: queueRow.queued_at ?? null,
          }
        : null,
    };
  },
});
