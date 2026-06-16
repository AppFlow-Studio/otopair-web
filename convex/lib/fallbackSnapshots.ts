/**
 * fallbackSnapshots — append-only history capture for fallback-spec edits.
 *
 * Every director edit that changes a baseline, parts/labor multiplier, or a
 * service's default labor hours writes a snapshot of the PRIOR row state
 * before the patch lands. The snapshot stores the full row as JSON so
 * "Restore this version" can replay exactly. Diff summary is computed once
 * here so the history modal doesn't have to re-derive it.
 *
 * Keep this module thin and isomorphic — no `mutation()` / `query()` wrappers
 * so the helper can be invoked from any director mutation in directorPricing.
 */

import type { Doc, Id } from "../_generated/dataModel";

export type FallbackEntityType =
  | "baseline"
  | "parts_multiplier"
  | "labor_multiplier"
  | "service_labor_hours";

type FallbackRow =
  | Doc<"pricing_baselines">
  | Doc<"pricing_parts_multipliers">
  | Doc<"pricing_labor_multipliers">
  | Doc<"services">;

type ChangedField = { key: string; from: unknown; to: unknown };

/**
 * Convert a list of {field, from, to} changes into a one-line human summary.
 * Numbers in cents are formatted as currency; booleans become Yes/No.
 */
export function summarizeChanges(
  entity_type: FallbackEntityType,
  changes: ChangedField[],
): string {
  if (changes.length === 0) return "(no changes)";
  return changes
    .map((c) => {
      const k = c.key;
      const isCents = k.endsWith("_cents");
      const fmt = (v: unknown) => {
        if (v == null || v === "") return "—";
        if (typeof v === "boolean") return v ? "Yes" : "No";
        if (typeof v === "number") {
          if (isCents) return `$${(v / 100).toFixed(2)}`;
          return String(v);
        }
        return String(v);
      };
      const label = k.replace(/_cents$/, "");
      return `${label}: ${fmt(c.from)} → ${fmt(c.to)}`;
    })
    .join(", ");
}

/**
 * Diff helper: returns an array of changed fields between `prev` and `next`.
 * Treats null/undefined/"" as equivalent (matches the noop semantics in
 * directorPricing.buildPatch).
 */
export function diffChanges(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): ChangedField[] {
  const noop = (a: unknown, b: unknown) => {
    const ae = a == null || a === "";
    const be = b == null || b === "";
    if (ae && be) return true;
    return a === b;
  };
  const out: ChangedField[] = [];
  for (const k of Object.keys(next)) {
    if (noop(prev[k], next[k])) continue;
    out.push({ key: k, from: prev[k], to: next[k] });
  }
  return out;
}

/**
 * Build a human label for the snapshot row. The history modal renders this
 * as the entity heading so directors can scan the cross-entity feed without
 * hydrating related rows.
 */
export function buildEntityLabel(
  entity_type: FallbackEntityType,
  row: FallbackRow,
  hints: { service_name?: string | null; category_code?: string | null } = {},
): string {
  switch (entity_type) {
    case "baseline":
      return hints.service_name ?? "Baseline";
    case "parts_multiplier": {
      const tier = (row as Doc<"pricing_parts_multipliers">).tier;
      return `${hints.category_code ?? "parts"} · ${tier}`;
    }
    case "labor_multiplier": {
      const tier = (row as Doc<"pricing_labor_multipliers">).tier;
      return `${hints.category_code ?? "labor"} · ${tier}`;
    }
    case "service_labor_hours":
      return hints.service_name ?? "Service labor hours";
  }
}

/**
 * Strip Convex system fields and serialize a row for the payload column.
 * Strings (Ids and primitives) are preserved; nested objects pass through.
 */
export function serializeRow(row: FallbackRow): string {
  const clone: Record<string, unknown> = { ...(row as any) };
  delete clone._id;
  delete clone._creationTime;
  return JSON.stringify(clone);
}

/**
 * Write a snapshot row. Call BEFORE patching the target so the captured
 * payload reflects the prior state. Safe to call from any mutation context.
 */
export async function recordFallbackSnapshot(
  ctx: { db: any },
  args: {
    entity_type: FallbackEntityType;
    entity_id: string;
    entity_label: string;
    prior_row: FallbackRow;
    changes: ChangedField[];
    is_restore?: boolean;
    actor_name: string;
    actor_id?: Id<"director_users">;
  },
): Promise<Id<"pricing_fallback_snapshots">> {
  return await ctx.db.insert("pricing_fallback_snapshots", {
    entity_type: args.entity_type,
    entity_id: args.entity_id,
    entity_label: args.entity_label,
    payload: serializeRow(args.prior_row),
    changes_summary: summarizeChanges(args.entity_type, args.changes),
    is_restore: args.is_restore,
    actor_name: args.actor_name,
    actor_id: args.actor_id,
    created_at: Date.now(),
  });
}
