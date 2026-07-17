// =============================================================================
// Data portal · Pricing Engine (tiers & multipliers) — /data/pricing-engine
// (Data spec §9.3). INTERNAL — GATED:
//   - every function (reads included) requires the `data.write` capability,
//     which restricts the page to super_admin + data_admin — exactly the
//     spec's population ("Super Admin + Yassin's Data Admin only");
//   - every page view writes an audit row (recordGateEntry), behind a TOTP
//     re-auth interstitial (director_auth.reverifyTotp);
//   - every edit is a CO-SIGNED ceremony: a second director (data.write,
//     different user) enters their email + live TOTP code; the action
//     verifies both before the internal apply mutation runs. Snapshots via
//     lib/fallbackSnapshots keep every change restorable.
// Ported from the un-gated legacy directorPricing.ts (left untouched for the
// old panel); reads here are bounded (no full vehicles/makes collects).
// =============================================================================
import { v } from "convex/values";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { requireDirector, logAudit, roleHasCapability, type DirectorRole } from "./directorGate";
import { verifyTotp } from "./director_auth";
import { VEHICLE_TIERS, tierValidator, type VehicleTier } from "./lib/vehicleTiers";
import {
  buildEntityLabel,
  diffChanges,
  recordFallbackSnapshot,
} from "./lib/fallbackSnapshots";
import type { Id } from "./_generated/dataModel";

// --- Authored return types (see dataOverview.ts header) -----------------------

export const recordGateEntry = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<{ ok: true }> => {
    const actor = await requireDirector(ctx, token, "data.write");
    await logAudit(ctx, actor, {
      entity_type: "pricing_engine",
      entity_id: "gate",
      action: "page_viewed",
      detail: `role=${actor.role} — internal pricing system access (spec §9.3: every view logged)`,
    });
    return { ok: true };
  },
});

export type TierOverviewRow = {
  id: string;
  code: string;
  name: string;
  anchor_vehicle_label: string;
  description: string | null;
  is_active: boolean;
  config_count: number;
  config_count_capped: boolean;
  assignment_count: number;
  assignment_count_capped: boolean;
};
export type OverviewResult = { tiers: TierOverviewRow[]; v2_tier_codes: string[] };

export const overview = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<OverviewResult> => {
    await requireDirector(ctx, token, "data.write");
    const tiers = await ctx.db.query("pricing_tiers").withIndex("by_display_order").collect();
    const rows: TierOverviewRow[] = [];
    for (const t of tiers) {
      const assignments = await ctx.db
        .query("pricing_vehicle_assignments")
        .withIndex("by_tier", (q) => q.eq("tier_id", t._id))
        .take(1001);
      // v2 7-tier config counts key off the tier CODE prefix (T2 covers T2a/b/c).
      let configCount = 0;
      let capped = false;
      for (const code of VEHICLE_TIERS) {
        if (!code.startsWith(t.code)) continue;
        const configs = await ctx.db
          .query("vehicle_configs")
          .withIndex("by_pricing_tier", (q) => q.eq("pricing_tier", code))
          .take(2001);
        configCount += configs.length;
        if (configs.length === 2001) capped = true;
      }
      rows.push({
        id: String(t._id),
        code: t.code,
        name: t.name,
        anchor_vehicle_label: t.anchor_vehicle_label,
        description: t.description ?? null,
        is_active: t.is_active,
        config_count: configCount,
        config_count_capped: capped,
        assignment_count: Math.min(assignments.length, 1000),
        assignment_count_capped: assignments.length === 1001,
      });
    }
    return { tiers: rows, v2_tier_codes: [...VEHICLE_TIERS] };
  },
});

export type MatrixCellV1 = {
  id: string;
  tier_id: string;
  category_id: string;
  multiplier: number;
  is_locked: boolean;
  notes: string | null;
};
export type MatrixCellV2 = {
  id: string;
  category_id: string;
  tier: string;
  multiplier: number;
  source: string | null;
};
export type MatricesResult = {
  v1: {
    tiers: { id: string; code: string; name: string }[];
    categories: { id: string; code: string; name: string }[];
    cells: MatrixCellV1[];
  };
  parts: { categories: { id: string; code: string; name: string }[]; cells: MatrixCellV2[] };
  labor: { categories: { id: string; code: string; name: string }[]; cells: MatrixCellV2[] };
};

export const multiplierMatrices = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<MatricesResult> => {
    await requireDirector(ctx, token, "data.write");
    const [tiers, v1Cats, v1Cells, pCats, pCells, lCats, lCells] = await Promise.all([
      ctx.db.query("pricing_tiers").withIndex("by_display_order").collect(),
      ctx.db.query("pricing_service_categories").collect(),
      ctx.db.query("pricing_multipliers").collect(),
      ctx.db.query("pricing_parts_categories").collect(),
      ctx.db.query("pricing_parts_multipliers").collect(),
      ctx.db.query("pricing_labor_categories").collect(),
      ctx.db.query("pricing_labor_multipliers").collect(),
    ]);
    const byOrder = <T extends { display_order?: number }>(rows: T[]) =>
      rows.slice().sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
    return {
      v1: {
        tiers: tiers.map((t) => ({ id: String(t._id), code: t.code, name: t.name })),
        categories: byOrder(v1Cats).map((c) => ({ id: String(c._id), code: c.code, name: c.name })),
        cells: v1Cells.map((m) => ({
          id: String(m._id),
          tier_id: String(m.tier_id),
          category_id: String(m.pricing_category_id),
          multiplier: m.multiplier,
          is_locked: m.is_locked,
          notes: m.notes ?? null,
        })),
      },
      parts: {
        categories: byOrder(pCats).map((c) => ({ id: String(c._id), code: c.code, name: c.name })),
        cells: pCells.map((m) => ({
          id: String(m._id),
          category_id: String(m.parts_category_id),
          tier: m.tier,
          multiplier: m.multiplier,
          source: m.source ?? null,
        })),
      },
      labor: {
        categories: byOrder(lCats).map((c) => ({ id: String(c._id), code: c.code, name: c.name })),
        cells: lCells.map((m) => ({
          id: String(m._id),
          category_id: String(m.labor_category_id),
          tier: m.tier,
          multiplier: m.multiplier,
          source: m.source ?? null,
        })),
      },
    };
  },
});

export type BaselineRow = {
  id: string;
  service_name: string;
  service_slug: string | null;
  base_price_low_cents: number;
  base_price_high_cents: number;
  is_real_data: boolean;
  data_source: string | null;
  notes: string | null;
};
export type GoldenRecordResult = {
  baselines: BaselineRow[];
  completeness_pct: number; // fraction of services with a real-data baseline
  services_total: number;
};

export const camryGoldenRecord = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<GoldenRecordResult> => {
    await requireDirector(ctx, token, "data.write");
    const services = await ctx.db.query("services").collect();
    const rows: BaselineRow[] = [];
    let real = 0;
    for (const s of services) {
      const b = await ctx.db
        .query("pricing_baselines")
        .withIndex("by_service", (q) => q.eq("service_id", s._id))
        .first();
      if (!b) continue;
      if (b.is_real_data) real++;
      rows.push({
        id: String(b._id),
        service_name: s.name,
        service_slug: s.slug ?? null,
        base_price_low_cents: b.base_price_low_cents,
        base_price_high_cents: b.base_price_high_cents,
        is_real_data: b.is_real_data,
        data_source: b.data_source ?? null,
        notes: b.notes ?? null,
      });
    }
    rows.sort((a, b) => a.service_name.localeCompare(b.service_name));
    return {
      baselines: rows,
      completeness_pct:
        services.length > 0 ? Math.round((real / services.length) * 100) : 0,
      services_total: services.length,
    };
  },
});

export type AssignmentRow = {
  id: string;
  config_key: string;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  pricing_tier: string | null;
  tier_source: string | null;
};

export const assignmentsForTier = query({
  args: { token: v.string(), tier: tierValidator, search: v.optional(v.string()) },
  handler: async (ctx, { token, tier, search }): Promise<{ rows: AssignmentRow[]; truncated: boolean }> => {
    await requireDirector(ctx, token, "data.write");
    const configs = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_pricing_tier", (q) => q.eq("pricing_tier", tier))
      .take(500);
    const makeName = new Map<string, string>();
    const modelName = new Map<string, string>();
    const needle = (search ?? "").trim().toLowerCase();
    const rows: AssignmentRow[] = [];
    for (const c of configs) {
      const mid = String(c.make_id);
      if (!makeName.has(mid)) {
        const m = await ctx.db.get(c.make_id);
        makeName.set(mid, m ? ((m as { name?: string }).name ?? "—") : "—");
      }
      const moid = String(c.model_id);
      if (!modelName.has(moid)) {
        const m = await ctx.db.get(c.model_id);
        modelName.set(moid, m ? ((m as { name?: string }).name ?? "—") : "—");
      }
      const row: AssignmentRow = {
        id: String(c._id),
        config_key: c.config_key,
        year: c.year,
        make: makeName.get(mid)!,
        model: modelName.get(moid)!,
        trim: c.trim_name ?? null,
        pricing_tier: c.pricing_tier ?? null,
        tier_source: (c as { pricing_tier_source?: string }).pricing_tier_source ?? null,
      };
      if (needle) {
        const hay = `${row.year} ${row.make} ${row.model} ${row.trim ?? ""} ${row.config_key}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      rows.push(row);
    }
    return { rows, truncated: configs.length === 500 };
  },
});

export type HistoryRow = {
  id: string;
  entity_type: string;
  entity_label: string;
  changes_summary: string;
  is_restore: boolean;
  actor_name: string;
  created_at: number;
};

export const editHistory = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<HistoryRow[]> => {
    await requireDirector(ctx, token, "data.write");
    const rows = await ctx.db
      .query("pricing_fallback_snapshots")
      .withIndex("by_created_at")
      .order("desc")
      .take(50);
    return rows.map((r) => ({
      id: String(r._id),
      entity_type: r.entity_type,
      entity_label: r.entity_label,
      changes_summary: r.changes_summary,
      is_restore: r.is_restore ?? false,
      actor_name: r.actor_name,
      created_at: r.created_at,
    }));
  },
});

// --- Blast radius (ceremony preview: "affects N configs' fallback") ----------

const editKindValidator = v.union(
  v.literal("v1_multiplier"),
  v.literal("parts_multiplier"),
  v.literal("labor_multiplier"),
  v.literal("baseline"),
);

export const blastRadius = query({
  args: { token: v.string(), kind: editKindValidator, id: v.string() },
  handler: async (
    ctx,
    { token, kind, id },
  ): Promise<{ affected_configs: number; capped: boolean; note: string }> => {
    await requireDirector(ctx, token, "data.write");
    const countTier = async (tier: VehicleTier) => {
      const rows = await ctx.db
        .query("vehicle_configs")
        .withIndex("by_pricing_tier", (q) => q.eq("pricing_tier", tier))
        .take(2001);
      return rows.length;
    };
    if (kind === "parts_multiplier" || kind === "labor_multiplier") {
      const row =
        kind === "parts_multiplier"
          ? await ctx.db.get(id as Id<"pricing_parts_multipliers">)
          : await ctx.db.get(id as Id<"pricing_labor_multipliers">);
      if (!row) return { affected_configs: 0, capped: false, note: "cell no longer exists" };
      const n = await countTier(row.tier as VehicleTier);
      return {
        affected_configs: Math.min(n, 2000),
        capped: n === 2001,
        note: `configs on tier ${row.tier} whose fallback uses this cell`,
      };
    }
    if (kind === "v1_multiplier") {
      const row = await ctx.db.get(id as Id<"pricing_multipliers">);
      if (!row) return { affected_configs: 0, capped: false, note: "cell no longer exists" };
      const assignments = await ctx.db
        .query("pricing_vehicle_assignments")
        .withIndex("by_tier", (q) => q.eq("tier_id", row.tier_id))
        .take(1001);
      return {
        affected_configs: Math.min(assignments.length, 1000),
        capped: assignments.length === 1001,
        note: "assignments on this v1 tier",
      };
    }
    // baseline: every tiered config derives its fallback from the Camry anchor.
    let total = 0;
    let capped = false;
    for (const tier of VEHICLE_TIERS) {
      const n = await countTier(tier);
      total += Math.min(n, 2000);
      if (n === 2001) capped = true;
    }
    return {
      affected_configs: total,
      capped,
      note: "all tiered configs — baselines anchor every tier's fallback",
    };
  },
});

// --- Co-signed writes ----------------------------------------------------------
// Simplest honest co-sign (no primitive existed repo-wide): the edit is an
// ACTION that verifies the primary session (data.write) AND a second
// director's email + live TOTP code (also data.write, different user) before
// running the internal apply mutation. Both names land in the snapshot +
// audit row.

const editPayloadValidator = v.union(
  v.object({
    kind: v.literal("v1_multiplier"),
    id: v.id("pricing_multipliers"),
    multiplier: v.number(),
  }),
  v.object({
    kind: v.literal("parts_multiplier"),
    id: v.id("pricing_parts_multipliers"),
    multiplier: v.number(),
  }),
  v.object({
    kind: v.literal("labor_multiplier"),
    id: v.id("pricing_labor_multipliers"),
    multiplier: v.number(),
  }),
  v.object({
    kind: v.literal("baseline"),
    id: v.id("pricing_baselines"),
    base_price_low_cents: v.number(),
    base_price_high_cents: v.number(),
  }),
);

export const applyCosigned = action({
  args: {
    token: v.string(),
    reason: v.string(),
    cosign_email: v.string(),
    cosign_code: v.string(),
    edit: editPayloadValidator,
  },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    if (args.reason.trim().length < 4) throw new Error("A reason is required.");
    // Primary signer
    const primary = await ctx.runQuery(api.director_auth.validateSession, {
      token: args.token,
    });
    if (!primary) throw new Error("unauthorized: invalid or expired director session");
    if (!roleHasCapability(primary.role as DirectorRole, "data.write"))
      throw new Error(`forbidden: role '${primary.role}' lacks capability 'data.write'`);
    // Co-signer
    const cosigner = await ctx.runQuery(internal.director_auth._getUserByEmail, {
      email: args.cosign_email.trim().toLowerCase(),
    });
    if (!cosigner) throw new Error("Co-signer email not found among director users.");
    if (String(cosigner._id) === String(primary.userId))
      throw new Error("Co-signer must be a DIFFERENT director than the primary.");
    if (!roleHasCapability(cosigner.role as DirectorRole, "data.write"))
      throw new Error(`Co-signer role '${cosigner.role}' lacks capability 'data.write'.`);
    if (!(await verifyTotp(cosigner.totp_secret, args.cosign_code.trim())))
      throw new Error("Co-signer TOTP code is invalid or expired.");

    await ctx.runMutation(internal.dataPricingEngine._applyEdit, {
      edit: args.edit,
      reason: args.reason.trim(),
      actorName: primary.name,
      actorId: primary.userId,
      cosignerName: cosigner.name,
    });
    return { ok: true };
  },
});

export const _applyEdit = internalMutation({
  args: {
    edit: editPayloadValidator,
    reason: v.string(),
    actorName: v.string(),
    actorId: v.id("director_users"),
    cosignerName: v.string(),
  },
  handler: async (ctx, { edit, reason, actorName, actorId, cosignerName }): Promise<{ ok: true }> => {
    const now = Date.now();
    const signed = `co-signed by ${cosignerName} — ${reason}`;
    const actor = { name: actorName, userId: actorId };

    if (edit.kind === "v1_multiplier") {
      const cur = await ctx.db.get(edit.id);
      if (!cur) throw new Error("That multiplier cell no longer exists.");
      if (cur.is_locked) throw new Error("Cell is locked (validated by bookings) — unlock first.");
      if (cur.multiplier === edit.multiplier) throw new Error("Multiplier unchanged.");
      await ctx.db.patch(edit.id, { multiplier: edit.multiplier, updated_at: now });
      await logAudit(ctx, actor, {
        entity_type: "pricing_multiplier_v1",
        entity_id: String(edit.id),
        action: "field_edit",
        detail: `multiplier: ${cur.multiplier} → ${edit.multiplier} · ${signed}`,
      });
      return { ok: true };
    }

    if (edit.kind === "parts_multiplier" || edit.kind === "labor_multiplier") {
      const isParts = edit.kind === "parts_multiplier";
      const cur = isParts
        ? await ctx.db.get(edit.id as Id<"pricing_parts_multipliers">)
        : await ctx.db.get(edit.id as Id<"pricing_labor_multipliers">);
      if (!cur) throw new Error("That multiplier cell no longer exists.");
      if (cur.multiplier === edit.multiplier) throw new Error("Multiplier unchanged.");
      const cat = isParts
        ? await ctx.db.get((cur as { parts_category_id: Id<"pricing_parts_categories"> }).parts_category_id)
        : await ctx.db.get((cur as { labor_category_id: Id<"pricing_labor_categories"> }).labor_category_id);
      const entityType = isParts ? ("parts_multiplier" as const) : ("labor_multiplier" as const);
      await recordFallbackSnapshot(ctx, {
        entity_type: entityType,
        entity_id: String(edit.id),
        entity_label: buildEntityLabel(entityType, cur, {
          category_code: (cat as { code?: string } | null)?.code ?? null,
        }),
        prior_row: cur,
        changes: diffChanges(cur as never, { multiplier: edit.multiplier }),
        actor_name: `${actorName} (co-signed by ${cosignerName})`,
        actor_id: actorId,
      });
      await ctx.db.patch(edit.id as Id<"pricing_parts_multipliers">, {
        multiplier: edit.multiplier,
        source: "director_override",
        updated_at: now,
      });
      await logAudit(ctx, actor, {
        entity_type: isParts ? "pricing_multiplier_v2_parts" : "pricing_multiplier_v2_labor",
        entity_id: String(edit.id),
        action: "field_edit",
        detail: `(${(cur as { tier: string }).tier}) multiplier: ${cur.multiplier} → ${edit.multiplier} · ${signed}`,
      });
      return { ok: true };
    }

    // baseline
    const cur = await ctx.db.get(edit.id);
    if (!cur) throw new Error("That baseline no longer exists.");
    if (
      cur.base_price_low_cents === edit.base_price_low_cents &&
      cur.base_price_high_cents === edit.base_price_high_cents
    )
      throw new Error("Baseline unchanged.");
    if (edit.base_price_low_cents > edit.base_price_high_cents)
      throw new Error("Low must not exceed high.");
    const svc = await ctx.db.get(cur.service_id);
    await recordFallbackSnapshot(ctx, {
      entity_type: "baseline",
      entity_id: String(edit.id),
      entity_label: buildEntityLabel("baseline", cur, {
        service_name: (svc as { name?: string } | null)?.name ?? null,
      }),
      prior_row: cur,
      changes: diffChanges(cur as never, {
        base_price_low_cents: edit.base_price_low_cents,
        base_price_high_cents: edit.base_price_high_cents,
      }),
      actor_name: `${actorName} (co-signed by ${cosignerName})`,
      actor_id: actorId,
    });
    await ctx.db.patch(edit.id, {
      base_price_low_cents: edit.base_price_low_cents,
      base_price_high_cents: edit.base_price_high_cents,
      updated_at: now,
    });
    await logAudit(ctx, actor, {
      entity_type: "pricing_baseline",
      entity_id: String(edit.id),
      action: "field_edit",
      detail: `band: ${cur.base_price_low_cents}–${cur.base_price_high_cents}¢ → ${edit.base_price_low_cents}–${edit.base_price_high_cents}¢ · ${signed}`,
    });
    return { ok: true };
  },
});
