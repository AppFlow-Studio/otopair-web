// =============================================================================
// vehicleEnrichment/agentResearch.ts — Firecrawl /agent as a LAST-RESORT tier
// =============================================================================
//
// WHY THIS EXISTS, and why it is this small.
//
// The original plan (docs/enrichment-audit/2026-08-02-agent-endpoint-plan.md)
// proposed three uses. Round 19 measured them and killed two:
//
//   repair rung   DROPPED — the deterministic repair rung took roles covered
//                 from 3-8 to 10-25 without any agent at all.
//   corroboration DROPPED — improved on its own (0-12% -> 0-33%) as rockauto
//                 and wix_filters began participating.
//   rotor minimums KEPT — 0 of 12 axles in round 19, and 0 across ~30 vehicles
//                 over five rounds. `brembo` did not appear in adapters_seen
//                 for ANY round-19 vehicle. This is the tool filter's exact
//                 criterion: data we cannot get today.
//   never_found   KEPT — 11 residual misses across 5 vehicles, EIGHT of them on
//                 one vehicle (the Chevrolet Equinox), which is precisely why
//                 that config finished at 3 roles while the F-150 reached 13.
//
// Measured live 2026-08-02 against the real endpoint:
//   - `maxCredits: 300` FAILS ("Agent reached max credits") after ~256s;
//     1500 completes. The documented default of 2500 is far too loose to set
//     per-field, so every call here passes an explicit budget.
//   - latency ~226s. Far too slow to sit inline in the pipeline's 600s action
//     budget, so this is always SCHEDULED, never awaited by the run.
//   - `schema` is honoured, and `source_url` IS returned when the schema
//     requires it (the docs do not promise this — we force it).
//   - `creditsUsed` came back 0 on a completed task, so it cannot be trusted
//     for budget accounting; we bound spend with maxCredits per call instead.
//
// THE LAW THIS FILE OBEYS. Agent output is a CLAIM, never a write. The probe
// makes the reason concrete: asked for a 2019 F-150 rotor minimum it answered
// from r1concepts.com — an aftermarket rotor RETAILER, whose page may state
// its own product's dimensions rather than Ford's discard spec — and returned
// the identical generic label "MIN TH" for both axles. That is a plausible
// answer of unknown authority, which is the definition of a claim. It goes
// through the same rotor validation, the same reconciler, and the same
// verifier as every other source, and it can never overwrite a stronger one.

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Claim } from "./sourceAdapters/types";

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";
const SOURCE_DOMAIN = "firecrawl-agent";

/** Measured floor is between 300 (fails) and 1500 (completes). */
const DEFAULT_MAX_CREDITS = 1500;
/** ~226s observed; poll a little past that before giving up. */
const POLL_INTERVAL_MS = 15_000;
const MAX_POLLS = 28; // ~7 minutes
const SUBMIT_TIMEOUT_MS = 60_000;

/** Kill switch, checked at call time so a flip needs no deploy. */
export function isAgentEnabled(env: Record<string, string | undefined>): boolean {
  return env.ENRICHMENT_AGENT === "on";
}

export function agentMaxCredits(env: Record<string, string | undefined>): number {
  const raw = Number(env.ENRICHMENT_AGENT_MAX_CREDITS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_CREDITS;
}

/** Per-run ceiling on agent tasks — a runaway loop must not empty the plan. */
export function agentTaskBudget(env: Record<string, string | undefined>): number {
  const raw = Number(env.ENRICHMENT_AGENT_MAX_TASKS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 3;
}

// ─── Pure prompt builders (exported for tests) ───────────────────

export type AgentVehicle = {
  year: number;
  make: string;
  model: string;
  trim?: string | null;
  engineCode?: string | null;
  displacement?: string | null;
};

function vehicleLine(v: AgentVehicle): string {
  return [
    v.year, v.make, v.model, v.trim,
    v.displacement ? `${v.displacement}L` : null,
    v.engineCode ? `engine ${v.engineCode}` : null,
  ].filter(Boolean).join(" ");
}

/**
 * Rotor prompt. Every clause here mirrors a rule the pipeline already enforces
 * downstream, so a violating answer is discarded rather than acted on:
 * three-numbers-never-interchangeable, verbatim label required, never derive
 * one figure from another.
 */
export function buildRotorPrompt(v: AgentVehicle): string {
  return (
    `For a ${vehicleLine(v)}, find the brake rotor DISCARD MINIMUM thickness in ` +
    `millimetres for the FRONT and REAR axles.\n\n` +
    `The discard minimum is the REPLACE-AT figure, usually cast into the rotor ` +
    `hat, printed under labels like "Minimum Thickness", "Min. Thickness", ` +
    `"Discard Thickness", "Wear Limit" or "MIN TH".\n\n` +
    `It is NOT the new/nominal thickness (the first figure in a size string ` +
    `like "350x34mm" is the DIAMETER, the second is NOMINAL), and it is NOT the ` +
    `machine-to / refinish limit.\n\n` +
    `Rules:\n` +
    `- Copy the label you ACTUALLY READ, verbatim, into observed_label. Do not ` +
    `compose or infer one.\n` +
    `- Never derive a minimum by subtracting an allowance from a nominal figure.\n` +
    `- Prefer the manufacturer service specification or a rotor manufacturer's ` +
    `technical page over a retail listing.\n` +
    `- If you cannot find a LABELLED discard minimum for an axle, omit that ` +
    `axle entirely. An omission is a correct answer; an estimate is not.`
  );
}

export function rotorSchema(): Record<string, any> {
  const axle = {
    type: "object",
    properties: {
      axle: { type: "string", enum: ["front", "rear"] },
      min_mm: { type: "number" },
      observed_label: { type: "string" },
      source_url: { type: "string" },
    },
    // source_url required: the docs do not promise it, and a claim without
    // provenance cannot be audited, corroborated or refuted.
    required: ["axle", "min_mm", "observed_label", "source_url"],
    additionalProperties: false,
  };
  return {
    type: "object",
    properties: { axles: { type: "array", items: axle } },
    required: ["axles"],
    additionalProperties: false,
  };
}

/** Last-resort part sourcing, for a role the deterministic path could not fill. */
export function buildRolePrompt(v: AgentVehicle, roleKey: string, blocked: readonly string[]): string {
  const readable = roleKey.replace(/_/g, " ");
  return (
    `For a ${vehicleLine(v)}, find the GENUINE OEM part number for the ${readable}.\n\n` +
    `Rules:\n` +
    `- Return the manufacturer's own part number, not an aftermarket brand's.\n` +
    `- The listing must name THIS model AND cover THIS model year. A part for ` +
    `another model of the same make, or another generation of the same ` +
    `nameplate, is wrong.\n` +
    `- Copy the product listing title verbatim into observed_title, and return ` +
    `the page URL in source_url.\n` +
    (blocked.length > 0
      ? `- These numbers were already rejected for this vehicle — do NOT return ` +
        `any of them: ${blocked.slice(0, 20).join(", ")}\n`
      : "") +
    `- If you cannot find a part number tied to this exact vehicle, return ` +
    `nothing. A gap is a correct answer; a plausible guess is not.`
  );
}

export function roleSchema(): Record<string, any> {
  return {
    type: "object",
    properties: {
      oem_part_number: { type: "string" },
      observed_title: { type: "string" },
      source_url: { type: "string" },
    },
    required: ["oem_part_number", "observed_title", "source_url"],
    additionalProperties: false,
  };
}

// ─── Fetch layer — fail open to null on ANY error ────────────────

type AgentOutcome = { ok: true; data: any } | { ok: false; reason: string };

async function runAgentTask(
  prompt: string,
  schema: Record<string, any>,
  opts: { maxCredits: number; urls?: readonly string[] },
): Promise<AgentOutcome> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return { ok: false, reason: "no_api_key" };
  let id: string;
  try {
    const res = await fetch(`${FIRECRAWL_BASE}/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        prompt,
        schema,
        model: "spark-1-mini",
        maxCredits: opts.maxCredits,
        ...(opts.urls && opts.urls.length > 0
          ? { urls: [...opts.urls], strictConstrainToURLs: false }
          : {}),
      }),
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: `submit_http_${res.status}` };
    const body: any = await res.json();
    if (!body?.id) return { ok: false, reason: "submit_no_id" };
    id = body.id;
  } catch (e) {
    return { ok: false, reason: `submit_failed:${(e as Error).message?.slice(0, 60)}` };
  }

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const res = await fetch(`${FIRECRAWL_BASE}/agent/${id}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const body: any = await res.json();
      if (body?.status === "completed") return { ok: true, data: body.data ?? null };
      if (body?.status && body.status !== "processing") {
        // "Agent reached max credits" lands here — a budget stop, not a bug.
        return { ok: false, reason: `${body.status}:${String(body.error ?? "").slice(0, 80)}` };
      }
    } catch {
      // transient — keep polling
    }
  }
  return { ok: false, reason: "poll_timeout" };
}

// ─── Pure result → Claim conversion (exported for tests) ─────────

export function rotorClaimsFrom(data: any, observedAt: number): Claim[] {
  const out: Claim[] = [];
  for (const row of (data?.axles ?? []) as any[]) {
    if (!row || (row.axle !== "front" && row.axle !== "rear")) continue;
    const mm = typeof row.min_mm === "number" ? row.min_mm : null;
    const label = typeof row.observed_label === "string" ? row.observed_label.trim() : "";
    const url = typeof row.source_url === "string" ? row.source_url.trim() : "";
    // A minimum with no verbatim label or no provenance is discarded here
    // rather than downstream — the rotor law treats an unlabelled minimum as
    // unusable, so emitting one would only create noise in the ledger.
    if (mm == null || mm <= 0 || !label || !url) continue;
    // Physical sanity: passenger/light-truck rotors run roughly 6-40 mm.
    // Anything outside that is a misread unit or a diameter.
    if (mm < 5 || mm > 45) continue;
    out.push({
      field_key: row.axle === "front"
        ? "rotor_front_min_thickness_mm"
        : "rotor_rear_min_thickness_mm",
      value: String(mm),
      value_raw: String(mm),
      source_family: "web_search",
      source_domain: SOURCE_DOMAIN,
      source_url: url,
      method: "agent_research",
      observed_label: label,
      observed_at: observedAt,
    });
  }
  return out;
}

export function roleClaimFrom(
  data: any,
  fieldKey: string,
  blocked: ReadonlySet<string>,
  observedAt: number,
): Claim | null {
  const oem = typeof data?.oem_part_number === "string" ? data.oem_part_number.trim() : "";
  const title = typeof data?.observed_title === "string" ? data.observed_title.trim() : "";
  const url = typeof data?.source_url === "string" ? data.source_url.trim() : "";
  if (!oem || !url) return null;
  // The researcher was told not to return a rejected number; enforce it here
  // too, because a blocklisted number that dominates the open web is exactly
  // what a research agent re-finds.
  if (blocked.has(oem.toUpperCase().replace(/[^A-Z0-9]/g, ""))) return null;
  return {
    field_key: fieldKey,
    value: oem,
    value_raw: oem,
    source_family: "web_search",
    source_domain: SOURCE_DOMAIN,
    source_url: url,
    method: "agent_research",
    observed_label: title || undefined,
    observed_at: observedAt,
  };
}

// ─── Actions ─────────────────────────────────────────────────────

/**
 * RETIRED (Aug 2026). Rotor discard minimums are no longer researched: the
 * stored minimum is DERIVED as a 15% wear threshold off the sourced nominal
 * (rotorSpecResource.deriveRotorMinMm — operator policy, validated in
 * mechanic interviews). Five rounds of this rung found 0 published minimums
 * across ~30 vehicles, so retiring it costs nothing.
 *
 * The export survives as a no-op so any still-pending scheduled invocation
 * from an in-flight run lands harmlessly instead of crashing on a missing
 * function.
 */
export const researchRotorMinimums = internalAction({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    runId: v.optional(v.id("enrichment_runs")),
    year: v.float64(),
    make: v.string(),
    model: v.string(),
    trim: v.optional(v.union(v.string(), v.null())),
    engineCode: v.optional(v.union(v.string(), v.null())),
    displacement: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (_ctx, args): Promise<{ status: string; claims: number }> => {
    console.log(
      `[agent] rotor-minimum research is retired (15% wear derivation) — ` +
        `no-op for ${args.year} ${args.make} ${args.model}`,
    );
    return { status: "retired_derived_15pct", claims: 0 };
  },
});

/**
 * LAST-RESORT part sourcing for roles the deterministic path positively
 * exhausted (`resource_never_found`).
 *
 * Round 19 sized this precisely: 11 residual misses across 5 vehicles, EIGHT
 * of them on the Chevrolet Equinox — which is exactly why that config finished
 * at 3 roles while the F-150 reached 13. So the cost is concentrated on the
 * vehicles that need it, and near-zero on the ones that do not.
 *
 * `never_found` is the ONLY outcome that qualifies. The other misses mean
 * different things and must not trigger paid research:
 *   skipped_run_budget / skipped_lifetime_cap — untried, not unfindable
 *   rejected_other / rejected_refuted        — found and REJECTED, so a
 *                                              research pass would just
 *                                              re-find the rejected number
 *
 * Writes CLAIMS. A claim still has to survive the reconciler, the fitment
 * verifier and the interchange law before it can occupy a role, which is what
 * keeps a self-directed research agent from becoming a bypass around every
 * gate this pipeline has.
 */
export const researchMissingRoles = internalAction({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    runId: v.optional(v.id("enrichment_runs")),
    year: v.float64(),
    make: v.string(),
    model: v.string(),
    trim: v.optional(v.union(v.string(), v.null())),
    engineCode: v.optional(v.union(v.string(), v.null())),
    displacement: v.optional(v.union(v.string(), v.null())),
    /** roleKey + the V4 field key its number is stored under. */
    roles: v.array(v.object({ roleKey: v.string(), fieldKey: v.string() })),
    /** Normalized numbers already rejected for this config. */
    blockedOems: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<{ status: string; claims: number; attempted: number }> => {
    if (!isAgentEnabled(process.env)) return { status: "disabled", claims: 0, attempted: 0 };
    const budget = agentTaskBudget(process.env);
    if (budget <= 0 || args.roles.length === 0) {
      return { status: "no_budget_or_roles", claims: 0, attempted: 0 };
    }
    const vehicle: AgentVehicle = {
      year: args.year, make: args.make, model: args.model,
      trim: args.trim ?? null, engineCode: args.engineCode ?? null,
      displacement: args.displacement ?? null,
    };
    const blockedList = args.blockedOems ?? [];
    const blockedSet = new Set(blockedList.map((b) => b.toUpperCase().replace(/[^A-Z0-9]/g, "")));

    // Bounded by the per-run task budget: eight roles at ~226s each is half an
    // hour of wall clock and eight times the credits, so the tap is opened a
    // few roles at a time rather than all at once.
    const take = args.roles.slice(0, budget);
    const claims: Claim[] = [];
    let attempted = 0;

    for (const role of take) {
      attempted++;
      const outcome = await runAgentTask(
        buildRolePrompt(vehicle, role.roleKey, blockedList),
        roleSchema(),
        { maxCredits: agentMaxCredits(process.env) },
      );
      if (!outcome.ok) {
        console.warn(`[agent] role research failed (${role.roleKey}): ${outcome.reason}`);
        continue;
      }
      const claim = roleClaimFrom(outcome.data, role.fieldKey, blockedSet, Date.now());
      if (!claim) {
        console.log(`[agent] role research returned nothing usable for ${role.roleKey}`);
        continue;
      }
      claims.push(claim);
      console.log(
        `[agent] role research proposed ${role.roleKey}=${claim.value} ` +
          `("${claim.observed_label ?? ""}") from ${claim.source_url}`,
      );
    }

    if (claims.length > 0) {
      await ctx.runMutation(internal.vehicleEnrichment.claimGathering._writeClaims, {
        vehicleConfigId: args.vehicleConfigId,
        runId: args.runId,
        claims: claims.map((c) => ({
          field_key: c.field_key,
          value: c.value,
          value_raw: c.value_raw ?? c.value,
          source_family: c.source_family,
          source_domain: c.source_domain,
          source_url: c.source_url,
          method: c.method,
          adapter: "firecrawl_agent",
          observed_label: c.observed_label,
          observed_at: c.observed_at,
        })),
      });
    }
    return { status: "ok", claims: claims.length, attempted };
  },
});
