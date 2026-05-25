import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

type VerificationField = {
  field_name: string;
  our_value: unknown;
  corrected_value: unknown;
  status: "confirmed" | "corrected" | "unknown";
};

async function mapRow(ctx: any, row: any) {
  const [config, mechanic] = await Promise.all([
    ctx.db.get(row.vehicle_config_id),
    ctx.db.get(row.mechanic_id),
  ]);
  const [make, model] = await Promise.all([
    config?.make_id ? ctx.db.get(config.make_id) : null,
    config?.model_id ? ctx.db.get(config.model_id) : null,
  ]);

  const fields: VerificationField[] = Array.isArray(row.verifications) ? row.verifications : [];

  return {
    _id: row._id,
    configId: row.vehicle_config_id,
    configKey: config?.config_key ?? "—",
    vehicle: [config?.year, make?.name, model?.name, config?.trim_name]
      .filter(Boolean).join(" "),
    mechanicId: row.mechanic_id,
    mechanicName: mechanic
      ? `${mechanic.first_name} ${mechanic.last_name}`.trim()
      : "Unknown mechanic",
    overallAccuracy: row.overall_accuracy ?? null,
    partsUsedCorrect: row.parts_used_correct ?? null,
    actualLaborHours: row.actual_labor_hours ?? null,
    jobId: row.job_id ?? null,
    serviceId: row.service_id ?? null,
    fields,
    confirmedCount: fields.filter(f => f.status === "confirmed").length,
    correctedCount: fields.filter(f => f.status === "corrected").length,
    unknownCount:   fields.filter(f => f.status === "unknown").length,
    submittedAt: row.created_at ?? null,
    verifiedAt:  row.verified_at ?? null,
    verificationCount: config?.verification_count ?? 0,
    enrichmentStatus: config?.enrichment_status ?? null,
    status: row.status ?? "pending",
  };
}

export const listPending = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("mechanic_verifications")
      .withIndex("by_status", q => q.eq("status", "pending"))
      .order("desc")
      .collect();
    return Promise.all(rows.map(r => mapRow(ctx, r)));
  },
});

/**
 * listAll — returns every mechanic verification. Optional status filter:
 *   undefined or "all" → every row
 *   "pending" | "accepted" | "rejected" → that status only
 */
export const listAll = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, { status }) => {
    let rows;
    if (!status || status === "all") {
      rows = await ctx.db.query("mechanic_verifications").order("desc").collect();
    } else {
      rows = await ctx.db
        .query("mechanic_verifications")
        .withIndex("by_status", q => q.eq("status", status))
        .order("desc")
        .collect();
    }
    return Promise.all(rows.map(r => mapRow(ctx, r)));
  },
});

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return "(empty)";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

export const acceptVerification = mutation({
  args: {
    id: v.id("mechanic_verifications"),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, actorName, actorId }) => {
    const row = await ctx.db.get(id);
    if (!row || row.status !== "pending") return;

    const config = await ctx.db.get(row.vehicle_config_id);
    if (!config) return;

    const now = Date.now();
    const entityId = String(row.vehicle_config_id);
    const fields: VerificationField[] = Array.isArray(row.verifications) ? row.verifications : [];

    const corrections: { name: string; from: unknown; to: unknown }[] = [];
    const confirmations: { name: string; value: unknown }[] = [];

    for (const field of fields) {
      if (field.status === "corrected") {
        // Retire previous latest evidence for this field
        const old = await ctx.db
          .query("enrichment_evidence")
          .withIndex("by_entity_field", q =>
            q.eq("entity_type", "vehicle_config")
             .eq("entity_id", entityId)
             .eq("field_name", field.field_name)
          )
          .collect();
        for (const e of old) {
          if (e.is_latest) await ctx.db.patch(e._id, { is_latest: false });
        }
        await ctx.db.insert("enrichment_evidence", {
          entity_type: "vehicle_config",
          entity_id: entityId,
          field_name: field.field_name,
          observed_value: field.corrected_value,
          source_type: "mechanic",
          confidence: 0.99,
          is_latest: true,
          observed_at: now,
          created_at: now,
        });
        corrections.push({ name: field.field_name, from: field.our_value, to: field.corrected_value });
      } else if (field.status === "confirmed") {
        await ctx.db.insert("enrichment_evidence", {
          entity_type: "vehicle_config",
          entity_id: entityId,
          field_name: field.field_name,
          observed_value: field.our_value,
          source_type: "mechanic",
          confidence: 0.98,
          is_latest: true,
          observed_at: now,
          created_at: now,
        });
        confirmations.push({ name: field.field_name, value: field.our_value });
      }
    }

    const newCount = (config.verification_count ?? 0) + 1;
    await ctx.db.patch(row.vehicle_config_id, {
      verification_count: newCount,
      last_verified_at: now,
      ...(newCount >= 3 ? { enrichment_status: "verified" } : {}),
    });

    await ctx.db.patch(id, { status: "accepted", verified_at: now });

    // One audit entry per field — corrections show from → to, confirmations show the value
    for (const c of corrections) {
      await ctx.db.insert("audit_log", {
        entity_type: "vehicle_config",
        entity_id: entityId,
        action: "field_edit",
        actor: actorName,
        actor_id: actorId,
        detail: `Corrected ${c.name}: ${fmtVal(c.from)} → ${fmtVal(c.to)}`,
        created_at: now,
      });
    }
    for (const c of confirmations) {
      await ctx.db.insert("audit_log", {
        entity_type: "vehicle_config",
        entity_id: entityId,
        action: "field_edit",
        actor: actorName,
        actor_id: actorId,
        detail: `Confirmed ${c.name} = ${fmtVal(c.value)}`,
        created_at: now,
      });
    }
    // Summary header entry
    await ctx.db.insert("audit_log", {
      entity_type: "vehicle_config",
      entity_id: entityId,
      action: "field_edit",
      actor: actorName,
      actor_id: actorId,
      detail: `Mechanic verification accepted — ${corrections.length} corrections, ${confirmations.length} confirmed`,
      created_at: now,
    });
  },
});

export const rejectVerification = mutation({
  args: {
    id: v.id("mechanic_verifications"),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, actorName, actorId }) => {
    const row = await ctx.db.get(id);
    if (!row || row.status !== "pending") return;

    const now = Date.now();
    await ctx.db.patch(id, { status: "rejected", verified_at: now });

    await ctx.db.insert("audit_log", {
      entity_type: "vehicle_config",
      entity_id: String(row.vehicle_config_id),
      action: "field_edit",
      actor: actorName,
      actor_id: actorId,
      detail: "Mechanic verification rejected",
      created_at: now,
    });
  },
});
