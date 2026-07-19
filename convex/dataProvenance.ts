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
import { requireDirector, logAudit } from "./directorGate";

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
