// =============================================================================
// Data portal · Provenance & Incidents — /data/provenance (Data spec §10.4).
// Moat lines (Layer D+E rising vs X shrinking — daily snapshots from the
// evidence sweep, data.moat.day.*) · Layer-B exposure table (same deriveLayer
// the API gate uses, so the number reconciles with gate exclusions by
// construction) · data_incidents cards with declare/resolve ceremonies.
// Repo-taxonomy note: the spec's "D = mechanic-verified" maps to repo layer E
// (human-verified); repo D = empirical. "Ours" = D + E, annotated in UI.
// =============================================================================
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireDirector, logAudit } from "./directorGate";
import { carInfoFor } from "./dataOverview";

// --- Authored return types (see dataOverview.ts header) -----------------------

export type MoatPoint = {
  date: string;
  by_layer: { A: number; B: number; C: number; D: number; E: number; X: number };
};

export const moatSeries = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<MoatPoint[]> => {
    await requireDirector(ctx, token);
    // Prefix range over the by_key index — dated keys sort lexicographically.
    const rows = await ctx.db
      .query("portal_stats")
      .withIndex("by_key", (q) =>
        q.gte("key", "data.moat.day.").lt("key", "data.moat.day.￿"),
      )
      .take(400);
    return rows
      .map((r) => ({
        date: r.key.slice("data.moat.day.".length),
        by_layer: ((r.meta as { by_layer?: MoatPoint["by_layer"] } | null)?.by_layer ?? {
          A: 0,
          B: 0,
          C: 0,
          D: r.value,
          E: 0,
          X: 0,
        }) as MoatPoint["by_layer"],
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  },
});

export type IncidentRow = {
  id: string;
  number: number;
  title: string;
  severity: "sev1" | "sev2" | "sev3";
  status: "open" | "monitoring" | "resolved";
  summary: string;
  root_cause: string | null;
  scope_note: string | null;
  affected_entity_type: string | null;
  affected_count: number | null;
  declared_by: string;
  declared_at: number;
  resolved_by: string | null;
  resolved_at: number | null;
  resolution_note: string | null;
};

export const listIncidents = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<IncidentRow[]> => {
    await requireDirector(ctx, token);
    const statuses = ["open", "monitoring", "resolved"] as const;
    const out: IncidentRow[] = [];
    for (const status of statuses) {
      const rows = await ctx.db
        .query("data_incidents")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(100);
      for (const r of rows) {
        out.push({
          id: String(r._id),
          number: r.number,
          title: r.title,
          severity: r.severity,
          status: r.status,
          summary: r.summary,
          root_cause: r.root_cause ?? null,
          scope_note: r.scope_note ?? null,
          affected_entity_type: r.affected_entity_type ?? null,
          affected_count: r.affected_count ?? null,
          declared_by: r.declared_by,
          declared_at: r.declared_at,
          resolved_by: r.resolved_by ?? null,
          resolved_at: r.resolved_at ?? null,
          resolution_note: r.resolution_note ?? null,
        });
      }
    }
    // open first, then monitoring, then resolved; newest number first within.
    const rank = { open: 0, monitoring: 1, resolved: 2 } as const;
    return out.sort((a, b) => rank[a.status] - rank[b.status] || b.number - a.number);
  },
});

const slugify = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

export const declareIncident = mutation({
  args: {
    token: v.string(),
    reason: v.string(),
    title: v.string(),
    severity: v.union(v.literal("sev1"), v.literal("sev2"), v.literal("sev3")),
    summary: v.string(),
    root_cause: v.optional(v.string()),
    scope_note: v.optional(v.string()),
    affected_entity_type: v.optional(v.string()),
    affected_count: v.optional(v.number()),
    source_context: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: true; number: number }> => {
    const actor = await requireDirector(ctx, args.token, "data.write");
    if (args.reason.trim().length < 4) throw new Error("A reason is required.");
    if (!args.title.trim()) throw new Error("Title is required.");
    if (!args.summary.trim()) throw new Error("Summary is required.");
    const newest = await ctx.db.query("data_incidents").withIndex("by_number").order("desc").first();
    const number = (newest?.number ?? 0) + 1;
    let slug = slugify(args.title);
    const slugTaken = await ctx.db
      .query("data_incidents")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (slugTaken) slug = `${slug}-${number}`;
    const id = await ctx.db.insert("data_incidents", {
      number,
      slug,
      title: args.title.trim(),
      severity: args.severity,
      status: "open",
      summary: args.summary.trim(),
      root_cause: args.root_cause?.trim() || undefined,
      scope_note: args.scope_note?.trim() || undefined,
      affected_entity_type: args.affected_entity_type,
      affected_count: args.affected_count,
      source_context: args.source_context,
      declared_by: actor.name,
      declared_by_id: actor.userId,
      declared_at: Date.now(),
      created_at: Date.now(),
    });
    await logAudit(ctx, actor, {
      entity_type: "data_incident",
      entity_id: String(id),
      action: "incident_declared",
      detail: `#${number} ${args.title.trim()} (${args.severity}) — ${args.reason.trim()}`,
    });
    return { ok: true, number };
  },
});

export const setIncidentStatus = mutation({
  args: {
    token: v.string(),
    reason: v.string(),
    id: v.id("data_incidents"),
    status: v.union(v.literal("open"), v.literal("monitoring"), v.literal("resolved")),
    resolution_note: v.optional(v.string()),
  },
  handler: async (ctx, { token, reason, id, status, resolution_note }): Promise<{ ok: true }> => {
    const actor = await requireDirector(ctx, token, "data.write");
    if (reason.trim().length < 4) throw new Error("A reason is required.");
    const row = await ctx.db.get(id);
    if (!row) throw new Error("That incident no longer exists.");
    if (row.status === status) throw new Error(`Incident is already ${status}.`);
    if (status === "resolved" && !(resolution_note ?? "").trim())
      throw new Error("A resolution note is required to resolve.");
    await ctx.db.patch(id, {
      status,
      resolved_by: status === "resolved" ? actor.name : undefined,
      resolved_at: status === "resolved" ? Date.now() : undefined,
      resolution_note: status === "resolved" ? resolution_note!.trim() : row.resolution_note,
    });
    await logAudit(ctx, actor, {
      entity_type: "data_incident",
      entity_id: String(id),
      action: `incident_${status}`,
      detail: `#${row.number} ${row.title}: ${row.status} → ${status} — ${reason.trim()}`,
    });
    return { ok: true };
  },
});

// ─── affected-config membership ─────────────────────────────────────────────
// data_incidents.affected_count/affected_entity_type is a bare number+type
// pair (Incident #1's "38 vehicle_config" was never itemized). The rows below
// give a declared incident an actual, workable list of vehicle_configs, each
// independently trackable to "corrected" — with an audited who/when/why on
// every add and every correction.

/** A VIN (17 chars, exact match) or a vehicle_configs.config_key. Tries VIN
 *  first since it's the identifier directors have on hand from an audit
 *  report; falls back to config_key for configs with no vehicle row yet. */
async function resolveConfigIdentifier(
  ctx: QueryCtx,
  raw: string,
): Promise<Id<"vehicle_configs"> | null> {
  const id = raw.trim();
  if (!id) return null;
  if (id.length === 17) {
    const veh = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", id.toUpperCase()))
      .first();
    if (veh?.vehicle_config_id) return veh.vehicle_config_id;
  }
  const cfg = await ctx.db
    .query("vehicle_configs")
    .withIndex("by_config_key", (q) => q.eq("config_key", id))
    .first();
  return cfg?._id ?? null;
}

export const addAffectedConfigs = mutation({
  args: {
    token: v.string(),
    reason: v.string(),
    incidentId: v.id("data_incidents"),
    // One VIN or config_key per entry — the UI splits a pasted list on
    // newlines/commas before calling this.
    identifiers: v.array(v.string()),
  },
  handler: async (ctx, { token, reason, incidentId, identifiers }): Promise<{
    added: number; alreadyPresent: number; notFound: string[];
  }> => {
    const actor = await requireDirector(ctx, token, "data.write");
    if (reason.trim().length < 4) throw new Error("A reason is required.");
    const incident = await ctx.db.get(incidentId);
    if (!incident) throw new Error("That incident no longer exists.");

    let added = 0;
    let alreadyPresent = 0;
    const notFound: string[] = [];
    const now = Date.now();
    for (const raw of identifiers) {
      if (!raw.trim()) continue;
      const configId = await resolveConfigIdentifier(ctx, raw);
      if (!configId) { notFound.push(raw.trim()); continue; }
      const existing = await ctx.db
        .query("data_incident_configs")
        .withIndex("by_incident_config", (q) => q.eq("incident_id", incidentId).eq("vehicle_config_id", configId))
        .first();
      if (existing) { alreadyPresent++; continue; }
      await ctx.db.insert("data_incident_configs", {
        incident_id: incidentId,
        vehicle_config_id: configId,
        status: "open",
        added_by: actor.name,
        added_by_id: actor.userId,
        added_at: now,
      });
      added++;
    }

    if (added > 0) {
      const total = await ctx.db
        .query("data_incident_configs")
        .withIndex("by_incident", (q) => q.eq("incident_id", incidentId))
        .collect();
      await ctx.db.patch(incidentId, {
        affected_count: total.length,
        affected_entity_type: incident.affected_entity_type ?? "vehicle_config",
      });
    }

    await logAudit(ctx, actor, {
      entity_type: "data_incident",
      entity_id: String(incidentId),
      action: "configs_added",
      detail: `#${incident.number} ${incident.title}: +${added} vehicle(s)` +
        `${alreadyPresent ? `, ${alreadyPresent} already present` : ""}` +
        `${notFound.length ? `, ${notFound.length} not found (${notFound.slice(0, 5).join(", ")}${notFound.length > 5 ? "…" : ""})` : ""}` +
        ` — ${reason.trim()}`,
    });
    return { added, alreadyPresent, notFound };
  },
});

export type AffectedConfigRow = {
  id: string;
  configId: string;
  status: "open" | "corrected";
  addedBy: string;
  addedAt: number;
  correctedBy: string | null;
  correctedAt: number | null;
  correctionNote: string | null;
  configKey: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  engineLabel: string | null;
  vin: string | null;
};

export const listAffectedConfigs = query({
  args: { token: v.string(), incidentId: v.id("data_incidents") },
  handler: async (ctx, { token, incidentId }): Promise<AffectedConfigRow[]> => {
    await requireDirector(ctx, token);
    const rows = await ctx.db
      .query("data_incident_configs")
      .withIndex("by_incident", (q) => q.eq("incident_id", incidentId))
      .collect();
    const out: AffectedConfigRow[] = await Promise.all(
      rows.map(async (r) => {
        const car = await carInfoFor(ctx, "vehicle_config", String(r.vehicle_config_id));
        return {
          id: String(r._id),
          configId: String(r.vehicle_config_id),
          status: r.status,
          addedBy: r.added_by,
          addedAt: r.added_at,
          correctedBy: r.corrected_by ?? null,
          correctedAt: r.corrected_at ?? null,
          correctionNote: r.correction_note ?? null,
          configKey: car.configKey,
          year: car.year,
          make: car.make,
          model: car.model,
          trim: car.trim,
          engineLabel: car.engineLabel,
          vin: car.vin,
        };
      }),
    );
    // Open first (the actual worklist), oldest-added first within each; corrected last.
    return out.sort((a, b) =>
      (a.status === b.status ? a.addedAt - b.addedAt : a.status === "open" ? -1 : 1));
  },
});

export const setConfigCorrectionStatus = mutation({
  args: {
    token: v.string(),
    reason: v.string(),
    id: v.id("data_incident_configs"),
    status: v.union(v.literal("open"), v.literal("corrected")),
  },
  handler: async (ctx, { token, reason, id, status }): Promise<{ ok: true }> => {
    const actor = await requireDirector(ctx, token, "data.write");
    if (reason.trim().length < 4) throw new Error("A reason is required.");
    const row = await ctx.db.get(id);
    if (!row) throw new Error("That vehicle is no longer on this incident.");
    if (row.status === status) throw new Error(`Already ${status}.`);
    await ctx.db.patch(id, {
      status,
      corrected_by: status === "corrected" ? actor.name : row.corrected_by,
      corrected_by_id: status === "corrected" ? actor.userId : row.corrected_by_id,
      corrected_at: status === "corrected" ? Date.now() : row.corrected_at,
      correction_note: status === "corrected" ? reason.trim() : row.correction_note,
    });
    await logAudit(ctx, actor, {
      entity_type: "data_incident_config",
      entity_id: String(id),
      action: status === "corrected" ? "marked_corrected" : "reopened",
      detail: `vehicle_config ${row.vehicle_config_id}: ${row.status} → ${status} — ${reason.trim()}`,
    });
    return { ok: true };
  },
});
