/**
 * undoMechanicVerification — reverses a previously-accepted mechanic verification.
 *
 * What it does:
 *   1. Walks the verification's review_decisions / verifications fields
 *   2. For each accepted field, restores the previous value (our_value) to the
 *      appropriate data table (engines / transmissions / chassis_specs /
 *      trim_specs / vehicle_configs)
 *   3. Flips enrichment_evidence: marks the mechanic-source latest as
 *      is_latest:false, restores the most recent retired non-mechanic evidence
 *      back to is_latest:true (if any exists)
 *   4. Decrements verification_count on the vehicle_config (and unverifies if
 *      it drops below 3)
 *   5. Marks the verification row status:"undone" (terminal, distinct from
 *      rejected / pending) so the audit trail of accept-then-undo is preserved
 *   6. Writes one audit_log entry per field with the from → to values + summary
 *
 * Run from Convex dashboard: Functions → undoMechanicVerification → undoById
 * or undoLatest (which finds the most recent accepted verification).
 *
 * Routing + coercion live in convex/lib/mechanic_verifications.ts so this and
 * the accept side can't drift.
 */

import {
  mutation,
  action,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import {
  applyRevertPatch,
  coerceFieldValue,
  fmtVal,
  newPatchBuckets,
  routeFieldToPatchBucket,
} from "./lib/mechanic_verifications";

type RevertDecision = {
  field_name: string;
  action: "accept" | "skip" | "override";
  override_value?: unknown;
};

type UndoFieldRecord = { name: string; from: unknown; to: unknown };

type UndoResult =
  | { ok: false; reason: string }
  | { ok: true; undoneFields: number };

async function performUndo(
  ctx: any,
  id: any,
  actorName: string,
  actorId: any,
): Promise<UndoResult> {
  const row = await ctx.db.get(id);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "accepted") {
    return { ok: false, reason: `not_accepted (status=${row.status})` };
  }

  const config = await ctx.db.get(row.vehicle_config_id);
  if (!config) return { ok: false, reason: "config_not_found" };

  const now = Date.now();
  const entityId = String(row.vehicle_config_id);
  const fields: any[] = Array.isArray(row.verifications)
    ? row.verifications
    : [];
  const reviewDecisions: any[] = Array.isArray((row as any).review_decisions)
    ? (row as any).review_decisions
    : [];

  const buckets = newPatchBuckets();
  const undoneFields: UndoFieldRecord[] = [];

  // Prefer the new partial-accept format. Fall back to "every non-unknown
  // field was accepted" for legacy rows that pre-date review_decisions.
  const decisions: RevertDecision[] = reviewDecisions.length > 0
    ? reviewDecisions
    : fields
        .filter((f: any) => f.status !== "unknown")
        .map((f: any) => ({ field_name: f.field_name, action: "accept" }));

  for (const decision of decisions) {
    if (decision.action === "skip") continue;
    const field = fields.find((f: any) => f.field_name === decision.field_name);
    if (!field) continue;

    const appliedValue =
      decision.action === "override"
        ? decision.override_value
        : field.status === "confirmed"
          ? field.our_value
          : field.corrected_value;

    // null our_value → undefined, which Convex `db.replace` interprets as
    // "delete this key" so the column reverts to schema-missing (the pre-
    // mechanic state). Schema validators reject `null` for optional fields.
    const rawRestored = field.our_value === null ? undefined : field.our_value;
    let restoredValue: unknown;
    try {
      restoredValue = coerceFieldValue(decision.field_name, rawRestored);
    } catch {
      // Couldn't coerce — fall through with the raw value; applyRevertPatch
      // will still try, and Convex will surface the validator error if it
      // really can't be written. Better than silently skipping a revert.
      restoredValue = rawRestored;
    }

    undoneFields.push({
      name: decision.field_name,
      from: appliedValue,
      to: field.our_value,
    });

    // Retire mechanic-source latest evidence; re-promote the most recent
    // non-mechanic retired evidence to is_latest:true (if any).
    const all = await ctx.db
      .query("enrichment_evidence")
      .withIndex("by_entity_field", (q: any) =>
        q
          .eq("entity_type", "vehicle_config")
          .eq("entity_id", entityId)
          .eq("field_name", decision.field_name),
      )
      .collect();
    for (const e of all) {
      if (e.is_latest && e.source_type === "mechanic") {
        await ctx.db.patch(e._id, { is_latest: false });
      }
    }
    const previous = all
      .filter((e: any) => !e.is_latest && e.source_type !== "mechanic")
      .sort(
        (a: any, b: any) => (b.observed_at ?? 0) - (a.observed_at ?? 0),
      )[0];
    if (previous) await ctx.db.patch(previous._id, { is_latest: true });

    routeFieldToPatchBucket(decision.field_name, restoredValue, buckets);
  }

  await applyRevertPatch(ctx, config, buckets);

  // Decrement verification_count + maybe re-downgrade enrichment_status.
  const newCount = Math.max(0, (config.verification_count ?? 1) - 1);
  const patch: Record<string, unknown> = { verification_count: newCount };
  if (newCount < 3 && config.enrichment_status === "verified") {
    patch.enrichment_status = "enriched";
  }
  await ctx.db.patch(row.vehicle_config_id, patch as any);

  // Mark as "undone" — a terminal state distinct from rejected/pending.
  await ctx.db.patch(id, {
    status: "undone",
    verified_at: now,
    reviewer_id: actorId,
  } as any);

  for (const u of undoneFields) {
    await ctx.db.insert("audit_log", {
      entity_type: "vehicle_config",
      entity_id: entityId,
      action: "field_edit",
      actor: actorName,
      actor_id: actorId,
      detail: `Undo: ${u.name}  ${fmtVal(u.from)} → ${fmtVal(u.to)}`,
      created_at: now,
    });
  }
  await ctx.db.insert("audit_log", {
    entity_type: "vehicle_config",
    entity_id: entityId,
    action: "field_edit",
    actor: actorName,
    actor_id: actorId,
    detail: `Mechanic verification reverted — ${undoneFields.length} fields restored`,
    created_at: now,
  });

  return { ok: true, undoneFields: undoneFields.length };
}

export const undoById = mutation({
  args: {
    id: v.id("mechanic_verifications"),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, actorName, actorId }) =>
    performUndo(ctx, id, actorName, actorId),
});

/**
 * undoLatest — convenience action that finds the most recent accepted
 * verification and undoes it. Calls undoById internally.
 */
export const _findLatestAccepted = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("mechanic_verifications")
      .withIndex("by_status", (q) => q.eq("status", "accepted"))
      .order("desc")
      .take(1);
    return rows[0] ?? null;
  },
});

export const undoLatest = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<
    | { ok: false; reason: string }
    | { ok: true; undoneFields: number; verificationId: string }
  > => {
    const latest = await ctx.runQuery(
      internal.undoMechanicVerification._findLatestAccepted,
      {},
    );
    if (!latest) return { ok: false, reason: "No accepted verification found." };

    const result: {
      ok: boolean;
      reason?: string;
      undoneFields?: number;
    } = await ctx.runMutation(
      internal.undoMechanicVerification._undoInternal,
      { id: latest._id },
    );
    if (!result.ok) return { ok: false, reason: result.reason ?? "unknown" };
    return {
      ok: true,
      undoneFields: result.undoneFields ?? 0,
      verificationId: String(latest._id),
    };
  },
});

// Internal wrapper — same logic as undoById but uses a hard-coded actor since
// actions can't easily forward the calling director's session.
export const _undoInternal = internalMutation({
  args: { id: v.id("mechanic_verifications") },
  handler: async (ctx, { id }) =>
    performUndo(ctx, id, "System (undo)", undefined),
});
