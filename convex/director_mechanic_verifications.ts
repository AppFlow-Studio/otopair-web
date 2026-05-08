import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

type VerificationField = {
  field_name: string;
  our_value: unknown;
  corrected_value: unknown;
  status: "confirmed" | "corrected" | "unknown";
};

export const listPending = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("mechanic_verifications")
      .withIndex("by_status", q => q.eq("status", "pending"))
      .order("desc")
      .collect();

    return Promise.all(rows.map(async row => {
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
        verificationCount: config?.verification_count ?? 0,
        enrichmentStatus: config?.enrichment_status ?? null,
      };
    }));
  },
});

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
      }
    }

    const newCount = (config.verification_count ?? 0) + 1;
    await ctx.db.patch(row.vehicle_config_id, {
      verification_count: newCount,
      last_verified_at: now,
      ...(newCount >= 3 ? { enrichment_status: "verified" } : {}),
    });

    await ctx.db.patch(id, { status: "accepted", verified_at: now });

    await ctx.db.insert("audit_log", {
      entity_type: "vehicle_config",
      entity_id: entityId,
      action: "field_edit",
      actor: actorName,
      actor_id: actorId,
      detail: `Mechanic verification accepted — ${fields.filter(f => f.status === "corrected").length} corrections, ${fields.filter(f => f.status === "confirmed").length} confirmed`,
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
