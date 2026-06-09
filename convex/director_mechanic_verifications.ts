import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  applyForwardPatch,
  coerceFieldValue,
  fmtVal,
  newPatchBuckets,
  routeFieldToPatchBucket,
  type ReviewDecision,
} from "./lib/mechanic_verifications";

type VerificationField = {
  field_name: string;
  our_value: unknown;
  corrected_value: unknown;
  status: "confirmed" | "corrected" | "unknown";
  notes?: string;
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

  const fields: VerificationField[] = Array.isArray(row.verifications)
    ? row.verifications
    : [];

  return {
    _id: row._id,
    configId: row.vehicle_config_id,
    configKey: config?.config_key ?? "—",
    vehicle: [config?.year, make?.name, model?.name, config?.trim_name]
      .filter(Boolean)
      .join(" "),
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
    confirmedCount: fields.filter((f) => f.status === "confirmed").length,
    correctedCount: fields.filter((f) => f.status === "corrected").length,
    unknownCount: fields.filter((f) => f.status === "unknown").length,
    submittedAt: row.created_at ?? null,
    verifiedAt: row.verified_at ?? null,
    verificationCount: config?.verification_count ?? 0,
    enrichmentStatus: config?.enrichment_status ?? null,
    status: row.status ?? "pending",
    reviewDecisions: Array.isArray(row.review_decisions)
      ? row.review_decisions
      : [],
  };
}

export const listPending = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("mechanic_verifications")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .order("desc")
      .collect();
    return Promise.all(rows.map((r) => mapRow(ctx, r)));
  },
});

/**
 * listAll — returns every mechanic verification. Optional status filter:
 *   undefined or "all" → every row
 *   "pending" | "accepted" | "rejected" | "undone" → that status only
 */
export const listAll = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, { status }) => {
    let rows;
    if (!status || status === "all") {
      rows = await ctx.db
        .query("mechanic_verifications")
        .order("desc")
        .collect();
    } else {
      rows = await ctx.db
        .query("mechanic_verifications")
        .withIndex("by_status", (q) => q.eq("status", status))
        .order("desc")
        .collect();
    }
    return Promise.all(rows.map((r) => mapRow(ctx, r)));
  },
});

// ─── Core accept implementation ────────────────────────────────────────────
//
// Both acceptVerification (full all-`accept`) and acceptVerificationPartial
// call this. It does the actual work: per-decision evidence ledger + data
// table write-through (via the shared routing in convex/lib/
// mechanic_verifications.ts), counter increment, status flip, and audit
// entries. Persists `review_decisions` so undoMechanicVerification.undoById
// can faithfully reverse each decision (accept/skip/override).

type AcceptOutcome =
  | { ok: true; applied: number; overridden: number; skipped: number }
  | { ok: false; reason: string };

async function performPartialAccept(
  ctx: any,
  id: any,
  decisions: ReviewDecision[],
  actorName: string,
  actorId: any,
): Promise<AcceptOutcome> {
  const row = await ctx.db.get(id);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "pending") {
    return { ok: false, reason: `not_pending (status=${row.status})` };
  }

  const config = await ctx.db.get(row.vehicle_config_id);
  if (!config) return { ok: false, reason: "config_not_found" };

  const now = Date.now();
  const entityId = String(row.vehicle_config_id);
  const fields: VerificationField[] = Array.isArray(row.verifications)
    ? row.verifications
    : [];
  const fieldByName = new Map(fields.map((f) => [f.field_name, f]));

  const buckets = newPatchBuckets();

  const appliedAudit: Array<{
    name: string;
    fromOurs: unknown;
    toApplied: unknown;
    confidence: number;
    kind: "confirmed" | "corrected" | "override";
  }> = [];
  const skippedAudit: Array<{ name: string; mechanicSuggested: unknown }> = [];

  for (const decision of decisions) {
    const field = fieldByName.get(decision.field_name);
    if (!field) continue;

    if (decision.action === "skip" || field.status === "unknown") {
      // Unknown fields can't be applied; if a decision claims to accept one
      // anyway, treat it as a skip and audit so the director can see it.
      skippedAudit.push({
        name: decision.field_name,
        mechanicSuggested:
          field.status === "corrected" ? field.corrected_value : field.our_value,
      });
      continue;
    }

    // Resolve the value the director chose to commit.
    const rawApplied =
      decision.action === "override"
        ? decision.override_value
        : field.status === "corrected"
          ? field.corrected_value
          : field.our_value;

    let coerced: unknown;
    try {
      coerced = coerceFieldValue(decision.field_name, rawApplied);
    } catch (err) {
      // Couldn't coerce to the destination column's type — downgrade to skip
      // rather than corrupting the data table. Record the reason so the
      // director can see why.
      skippedAudit.push({
        name: decision.field_name,
        mechanicSuggested: rawApplied,
      });
      await ctx.db.insert("audit_log", {
        entity_type: "vehicle_config",
        entity_id: entityId,
        action: "field_edit",
        actor: actorName,
        actor_id: actorId,
        detail: `Skipped ${decision.field_name} — value "${fmtVal(rawApplied)}" not coercible (${(err as Error).message})`,
        created_at: now,
      });
      continue;
    }

    // Evidence ledger: retire prior is_latest, insert new mechanic-source row.
    const prior = await ctx.db
      .query("enrichment_evidence")
      .withIndex("by_entity_field", (q: any) =>
        q
          .eq("entity_type", "vehicle_config")
          .eq("entity_id", entityId)
          .eq("field_name", decision.field_name),
      )
      .collect();
    for (const e of prior) {
      if (e.is_latest) await ctx.db.patch(e._id, { is_latest: false });
    }

    const confidence =
      decision.action === "override" || field.status === "corrected"
        ? 0.99
        : 0.98;

    await ctx.db.insert("enrichment_evidence", {
      entity_type: "vehicle_config",
      entity_id: entityId,
      field_name: decision.field_name,
      observed_value: coerced,
      source_type: "mechanic",
      confidence,
      is_latest: true,
      observed_at: now,
      created_at: now,
    });

    // Route into per-table patch buckets; we'll apply all at the end.
    routeFieldToPatchBucket(decision.field_name, coerced, buckets);

    appliedAudit.push({
      name: decision.field_name,
      fromOurs: field.our_value,
      toApplied: coerced,
      confidence,
      kind:
        decision.action === "override"
          ? "override"
          : (field.status as "confirmed" | "corrected"),
    });
  }

  // Write-through to the data tables. Symmetric with applyRevertPatch in undo.
  await applyForwardPatch(ctx, config, buckets);

  // Bump verification count, flip status to "verified" once we've had 3+.
  const newCount = (config.verification_count ?? 0) + 1;
  await ctx.db.patch(row.vehicle_config_id, {
    verification_count: newCount,
    last_verified_at: now,
    ...(newCount >= 3 ? { enrichment_status: "verified" } : {}),
  });

  // Persist the decisions on the row — undoMechanicVerification.undoById
  // depends on this exact shape to reverse partial accepts correctly. Without
  // it, undo falls back to "every non-unknown field was accepted" and will
  // try to revert fields the director actually skipped.
  await ctx.db.patch(id, {
    status: "accepted",
    verified_at: now,
    reviewer_id: actorId,
    review_decisions: decisions,
  });

  // Audit — one per applied/overridden/skipped field, then a summary.
  let overriddenCount = 0;
  for (const a of appliedAudit) {
    let detail: string;
    if (a.kind === "override") {
      overriddenCount++;
      detail = `Override ${a.name}: ${fmtVal(a.fromOurs)} → ${fmtVal(a.toApplied)}`;
    } else if (a.kind === "corrected") {
      detail = `Corrected ${a.name}: ${fmtVal(a.fromOurs)} → ${fmtVal(a.toApplied)}`;
    } else {
      detail = `Confirmed ${a.name} = ${fmtVal(a.toApplied)}`;
    }
    await ctx.db.insert("audit_log", {
      entity_type: "vehicle_config",
      entity_id: entityId,
      action: "field_edit",
      actor: actorName,
      actor_id: actorId,
      detail,
      created_at: now,
    });
  }
  for (const s of skippedAudit) {
    await ctx.db.insert("audit_log", {
      entity_type: "vehicle_config",
      entity_id: entityId,
      action: "field_edit",
      actor: actorName,
      actor_id: actorId,
      detail: `Skipped ${s.name} (mechanic suggested: ${fmtVal(s.mechanicSuggested)})`,
      created_at: now,
    });
  }

  const appliedCount = appliedAudit.length - overriddenCount;
  await ctx.db.insert("audit_log", {
    entity_type: "vehicle_config",
    entity_id: entityId,
    action: "field_edit",
    actor: actorName,
    actor_id: actorId,
    detail: `Mechanic verification accepted — ${appliedCount} applied, ${overriddenCount} overridden, ${skippedAudit.length} skipped`,
    created_at: now,
  });

  return {
    ok: true,
    applied: appliedCount,
    overridden: overriddenCount,
    skipped: skippedAudit.length,
  };
}

/**
 * acceptVerificationPartial — director's per-field decisions land here. Each
 * decision is one of accept / skip / override. The mutation:
 *   1. Writes evidence + data-table patch for every applied/overridden field
 *      (using the shared routing in convex/lib/mechanic_verifications.ts so
 *      undoMechanicVerification stays symmetric).
 *   2. Persists `review_decisions` on the row so undo can faithfully reverse
 *      each individual decision.
 *   3. Increments verification_count and flips enrichment_status → "verified"
 *      at 3+.
 *   4. Writes one audit entry per applied/overridden/skipped field + summary.
 */
export const acceptVerificationPartial = mutation({
  args: {
    id: v.id("mechanic_verifications"),
    decisions: v.array(
      v.object({
        field_name: v.string(),
        action: v.union(
          v.literal("accept"),
          v.literal("skip"),
          v.literal("override"),
        ),
        override_value: v.optional(v.any()),
      }),
    ),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, decisions, actorName, actorId }) => {
    return performPartialAccept(
      ctx,
      id,
      decisions as ReviewDecision[],
      actorName,
      actorId,
    );
  },
});

/**
 * acceptVerification — legacy all-or-nothing accept, preserved as a thin
 * shim over acceptVerificationPartial so existing UI callsites and dashboard
 * scripts keep working. Builds an all-`accept` decisions array from the
 * row's verifications (excluding unknown fields, which can't be applied).
 */
export const acceptVerification = mutation({
  args: {
    id: v.id("mechanic_verifications"),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, actorName, actorId }) => {
    const row = await ctx.db.get(id);
    if (!row || row.status !== "pending") return;
    const fields: VerificationField[] = Array.isArray(row.verifications)
      ? row.verifications
      : [];
    const decisions: ReviewDecision[] = fields
      .filter((f) => f.status !== "unknown")
      .map((f) => ({ field_name: f.field_name, action: "accept" as const }));
    return performPartialAccept(ctx, id, decisions, actorName, actorId);
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
    await ctx.db.patch(id, {
      status: "rejected",
      verified_at: now,
      reviewer_id: actorId,
    });

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
