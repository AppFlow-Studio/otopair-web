// =============================================================================
// claimGathering.ts — run the rival source adapters, persist their Claims, and
// reconcile them into consensus.
//
// This is the wiring that was missing: sourceAdapters/{registry,claimLedger}.ts
// and all six adapters were written, unit-tested and completely orphaned — no
// production code imported any of them, and there was no table to persist a
// Claim into. Corroboration therefore read 0% not because sources disagreed but
// because no second source was ever asked.
//
// WHAT THIS DOES NOT DO: it does not write vehicle fields. It gathers evidence
// and computes consensus; the callers decide what to do with it, under their own
// validation. Keeping the gatherer write-free is what lets it run in "observe"
// mode on a live fleet without any chance of a present-but-wrong write.
//
// FETCH TIER: adapters marked `needs_headless` in ADAPTER_FETCHABILITY are
// SKIPPED, not attempted. There is no headless browser reachable from a Convex
// action (verified repo-wide: Playwright here is the Next.js E2E harness and
// cannot run inside V8), so summit_centric and amsoil can only ever burn a
// 20s timeout cascade to return ok:false. Skipping them is not a limitation
// being hidden — `skipped_headless` is reported in the result so the cost of
// the missing tier stays visible.
// =============================================================================

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  ADAPTER_FETCHABILITY,
  PART_KEYED_ADAPTERS,
  SOURCE_ADAPTERS,
  byField,
} from "./sourceAdapters/registry";
import { reconcileClaims, resolveOperator, type ClaimConsensus } from "./sourceAdapters/claimLedger";
import { scraplingEnabled, scraplingFetchUrlWithHtml } from "./scrapling";
import { parseAmsoilVehiclePage } from "./sourceAdapters/amsoil";
import type { AdapterVehicle, Claim, SourceAdapter } from "./sourceAdapters/types";

/** Per-adapter wall-clock ceiling. Adapters already carry per-request
 *  AbortSignal timeouts, but Brembo's cascade is up to ~23 sequential requests,
 *  so the whole lookup needs its own bound or one slow catalogue can eat the
 *  calling action's budget. */
const ADAPTER_DEADLINE_MS = Number(process.env.CLAIM_ADAPTER_DEADLINE_MS ?? "45000");

/**
 * Wall-clock ceiling for the WHOLE fan-out, not just one adapter.
 *
 * Per-adapter bounds alone do not bound the call: five fetchable adapters at
 * 45s each is 225s, and this runs inside the finalize action that already
 * budgets PARTS_PRICE_PASS_DEADLINE_MS (360s) and is hard-killed by Convex at
 * 600s. Without this, a few slow catalogues could cost the run its finalize
 * writes — trading a nice-to-have evidence layer for the actual enrichment,
 * which is a terrible trade.
 *
 * On expiry the remaining adapters are recorded as skipped (never silently
 * dropped) and everything gathered so far is still persisted and reconciled.
 */
const GATHER_DEADLINE_MS = Number(process.env.CLAIM_GATHER_DEADLINE_MS ?? "120000");

/** Convex mutations are transactions; a few hundred claims in one call risks
 *  the write limit. Same slicing idiom the evidence writer uses. */
const CLAIM_WRITE_SLICE = 50;

/** `field_claims.source_family` is a plain string in the schema so adding a
 *  family is not a migration — which means a row could carry a family the
 *  ledger has no weight for, and `Math.max` over an undefined weight yields
 *  NaN, silently corrupting the winner ordering. Rows are filtered against
 *  this set on read-back; an unrecognized family is dropped, never scored. */
const KNOWN_FAMILIES: ReadonlySet<string> = new Set([
  "oem_catalog",
  "aftermarket_catalog",
  "aggregator",
  "owners_manual",
  "gov",
  "web_search",
  "human",
]);

export type AdapterRunRecord = {
  adapter: string;
  ok: boolean;
  claims: number;
  needs_headless?: boolean;
  error?: string;
};

export type GatherResult = {
  ran: string[];
  skipped_headless: string[];
  adapters: AdapterRunRecord[];
  claims_written: number;
  consensus: ClaimConsensus[];
};

/** Race an adapter against a deadline. A timeout is reported as a normal
 *  adapter failure — this function never throws and never rejects, mirroring
 *  the adapters' own fail-open contract. */
async function withDeadline(
  adapter: SourceAdapter,
  vehicle: AdapterVehicle,
  ms: number,
): Promise<{ ok: boolean; claims: Claim[]; needs_headless?: boolean; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<{ ok: false; claims: Claim[]; error: string }>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, claims: [], error: `adapter_deadline_${ms}ms` }),
        ms,
      );
    });
    const result = await Promise.race([adapter.lookup(vehicle), timeout]);
    return result;
  } catch (e) {
    return { ok: false, claims: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Persist a slice of claims. Idempotent per (config, field, domain, value):
 * a re-run that observes the same value from the same domain replaces the row
 * rather than stacking duplicates, because a duplicated row would inflate
 * nothing (the ledger counts families and operators, not rows) but would make
 * the audit trail lie about how many times a source was consulted.
 */
export const _writeClaims = internalMutation({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    runId: v.optional(v.id("enrichment_runs")),
    claims: v.array(
      v.object({
        field_key: v.string(),
        value: v.string(),
        value_raw: v.optional(v.string()),
        source_family: v.string(),
        source_domain: v.string(),
        source_operator: v.optional(v.string()),
        source_url: v.string(),
        method: v.string(),
        adapter: v.optional(v.string()),
        observed_label: v.optional(v.string()),
        observed_at: v.float64(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    let written = 0;
    for (const c of args.claims) {
      const existing = await ctx.db
        .query("field_claims")
        .withIndex("by_config_field", (q) =>
          q.eq("vehicle_config_id", args.vehicleConfigId).eq("field_key", c.field_key),
        )
        .collect();
      const dup = existing.find(
        (row) => row.source_domain === c.source_domain && row.value === c.value,
      );
      if (dup) {
        await ctx.db.patch(dup._id, { ...c, run_id: args.runId });
      } else {
        await ctx.db.insert("field_claims", {
          vehicle_config_id: args.vehicleConfigId,
          run_id: args.runId,
          ...c,
        });
      }
      written++;
    }
    return { written };
  },
});

/**
 * Drop claims for a config, optionally narrowed to one adapter.
 *
 * Needed because claims are DURABLE and cumulative by design — that is what
 * makes corroboration accumulate across runs. The same property means a bad
 * batch (an adapter bug, a probe run with hand-fed values) leaves permanent
 * evidence that the reconciler will keep counting as a real voice. Fabricated
 * or mis-parsed provenance in a ledger whose entire purpose is provenance is
 * worse than no ledger, so removing it has to be a first-class operation
 * rather than a manual dashboard edit.
 */
export const purgeClaims = internalMutation({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    /** Restrict to one adapter (e.g. "pipeline_extraction"). Omit = all. */
    adapter: v.optional(v.string()),
    /** Restrict to one source domain. Omit = all. */
    sourceDomain: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("field_claims")
      .withIndex("by_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .collect();
    let deleted = 0;
    for (const r of rows) {
      if (args.adapter != null && r.adapter !== args.adapter) continue;
      if (args.sourceDomain != null && r.source_domain !== args.sourceDomain) continue;
      await ctx.db.delete(r._id);
      deleted++;
    }
    console.log(
      `[claim-ledger] purged ${deleted} claim(s) for ${args.vehicleConfigId}` +
        (args.adapter ? ` adapter=${args.adapter}` : "") +
        (args.sourceDomain ? ` domain=${args.sourceDomain}` : ""),
    );
    return { deleted };
  },
});

/** Every claim on file for a config, for reconciliation across runs. */
export const _claimsForConfig = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("field_claims")
      .withIndex("by_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .collect();
    return rows.map((r) => ({
      field_key: r.field_key,
      value: r.value,
      value_raw: r.value_raw ?? undefined,
      source_family: r.source_family,
      source_domain: r.source_domain,
      source_url: r.source_url,
      method: r.method,
      observed_label: r.observed_label ?? undefined,
      observed_at: r.observed_at,
    }));
  },
});

/**
 * Run every fetchable adapter that can attest at least one of `fieldKeys`,
 * persist what they claim, and return the reconciled consensus per field.
 *
 * `fieldKeys` empty ⇒ every field any registered adapter can attest.
 *
 * NEVER throws: an adapter that fails, times out or is blocked is recorded and
 * skipped. A total network outage returns an empty consensus, which callers
 * treat as "no evidence", never as "no value".
 */
export const gatherClaims = internalAction({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    runId: v.optional(v.id("enrichment_runs")),
    year: v.float64(),
    make: v.string(),
    model: v.string(),
    trim: v.optional(v.union(v.string(), v.null())),
    engineCode: v.optional(v.union(v.string(), v.null())),
    displacementL: v.optional(v.union(v.float64(), v.null())),
    cylinders: v.optional(v.union(v.float64(), v.null())),
    /** Restrict to adapters that can attest these fields. Empty = all. */
    fieldKeys: v.optional(v.array(v.string())),
    /**
     * The PIPELINE's own extracted values, entered into the ledger as claims.
     *
     * Without these the ledger is a monologue: the six adapters cover disjoint
     * field sets (rotors / filters / bulbs / wipers), so every field has
     * exactly one family and reconcileClaims correctly reports `single_source`
     * — never `consensus`. Corroboration requires two INDEPENDENT families
     * asserting the SAME field, and the pipeline's web-search extraction is a
     * genuine second family for exactly the fields the adapters cover.
     *
     * Entered at family `web_search`, the weakest weight in the table (1), so
     * it can corroborate a catalogue but never outvote one.
     */
    pipelineClaims: v.optional(
      v.array(
        v.object({
          field_key: v.string(),
          value: v.string(),
          source_url: v.optional(v.string()),
          source_domain: v.optional(v.string()),
        }),
      ),
    ),
    /**
     * OEM part numbers already on file, for PART-KEYED adapters (RockAuto).
     *
     * Those adapters cannot walk a vehicle cascade — they answer "is this
     * number real, and what is it" — so without this they are inert by design
     * rather than falling back to a lookup they cannot perform.
     */
    knownParts: v.optional(
      v.array(
        v.object({
          field_key: v.string(),
          part_number: v.string(),
          role_key: v.optional(v.union(v.string(), v.null())),
        }),
      ),
    ),
  },
  handler: async (ctx, args): Promise<GatherResult> => {
    const result: GatherResult = {
      ran: [],
      skipped_headless: [],
      adapters: [],
      claims_written: 0,
      consensus: [],
    };

    try {
      const wanted = args.fieldKeys ?? [];
      const selected: SourceAdapter[] =
        wanted.length > 0
          ? [...new Set(wanted.flatMap((f) => byField(f)))]
          : [...SOURCE_ADAPTERS];

      const vehicle: AdapterVehicle = {
        year: args.year,
        make: args.make,
        model: args.model,
        trim: args.trim ?? null,
        engine_code: args.engineCode ?? null,
        displacement_l: args.displacementL ?? null,
        cylinders: args.cylinders ?? null,
        known_parts: (args.knownParts ?? []).map((p) => ({
          field_key: p.field_key,
          part_number: p.part_number,
          role_key: p.role_key ?? null,
        })),
      };

      // Claims carry no adapter name of their own (a Claim is a source's
      // assertion, not a record of who fetched it), so attribution is tracked
      // alongside rather than guessed from the result set.
      const pending: Array<{ claim: Claim; adapter: string }> = [];
      const gatherStartedAt = Date.now();
      for (const adapter of selected) {
        const elapsed = Date.now() - gatherStartedAt;
        if (elapsed >= GATHER_DEADLINE_MS) {
          // Budget spent. Record the skip rather than dropping it silently —
          // a shrinking adapter roster must never look like a clean run.
          result.adapters.push({
            adapter: adapter.name,
            ok: false,
            claims: 0,
            error: `skipped: gather budget exhausted after ${Math.round(elapsed / 1000)}s`,
          });
          continue;
        }
        if (
          PART_KEYED_ADAPTERS.has(adapter.name) &&
          (vehicle.known_parts?.length ?? 0) === 0
        ) {
          // Inert without part numbers — skip rather than pay for a lookup
          // that can only return empty.
          result.adapters.push({
            adapter: adapter.name,
            ok: true,
            claims: 0,
            error: "skipped: part-keyed adapter with no known_parts",
          });
          continue;
        }
        if (ADAPTER_FETCHABILITY[adapter.name] === "needs_headless") {
          // Wave 3 (Aug 2026): Scrapling IS the headless tier now. When it's
          // configured, attempt the adapter — amsoil's whole API cascade is
          // plain-fetch-fine; only its final Cloudflare-fronted page 403s,
          // and that exact failure is rescued below via a stealth fetch of
          // the URL the adapter names. Without Scrapling, the old skip
          // stands (a guaranteed 20s timeout is not a chance of data).
          // Only adapters with a wired rescue seam attempt — summitCentric's
          // WHOLE flow needs a browser, so attempting it would just burn
          // ~45s of the gather deadline for nothing.
          //
          // RE-PROBED LIVE Aug 2026, and the exclusion still holds. It is
          // worth writing down because summit_centric is the only broad
          // US-application rotor DISCARD source we have (Brembo skews
          // European/performance), it has filed ZERO claims fleet-wide, and
          // that makes it a standing temptation to "just switch on". Measured
          // against summitracing.com:
          //   bare fetch      → 200, 6.0 KB, Imperva "Pardon Our Interruption"
          //   scrapling http  → 200, 5.7 KB, same wall
          //   scrapling auto  → 200, 5.7 KB, same wall
          //   scrapling stealth → 502 from the scraper service
          // So Imperva ABP currently defeats every tier we have, and widening
          // this gate would buy nothing but latency. The blocker is the
          // SCRAPER SERVICE (the stealth 502), not this condition — fix that
          // first, re-run devOnly/summitProbe, and only then revisit.
          //
          // NOTE: the adapter also still uses a bare `fetch()` rather than
          // `sourceAdapters/http.ts`'s `adapterFetch`, so it would not reach
          // Scrapling even if this gate let it through. Both need doing.
          const scraplingOn =
            process.env.PARTS_SCRAPLING === "on" &&
            scraplingEnabled() &&
            adapter.name === "amsoil";
          if (!scraplingOn) {
            result.skipped_headless.push(adapter.name);
            result.adapters.push({
              adapter: adapter.name,
              ok: false,
              claims: 0,
              needs_headless: true,
              error: "skipped: no headless fetch tier available",
            });
            continue;
          }
        }

        // Never let one adapter's ceiling overrun what's left of the total.
        const remaining = GATHER_DEADLINE_MS - (Date.now() - gatherStartedAt);
        let outcome = await withDeadline(
          adapter,
          vehicle,
          Math.min(ADAPTER_DEADLINE_MS, Math.max(1000, remaining)),
        );
        // Scrapling rescue: amsoil reports the blocked page's URL in its
        // error by design ("…the headless tier can go straight to the page
        // and feed parseAmsoilVehiclePage"). Stealth-fetch that one page and
        // parse it — the claims are indistinguishable from a direct success.
        if (
          !outcome.ok &&
          outcome.needs_headless &&
          adapter.name === "amsoil" &&
          process.env.PARTS_SCRAPLING === "on" &&
          scraplingEnabled()
        ) {
          const pageUrl = /(https?:\/\/\S+)$/.exec(outcome.error ?? "")?.[1] ?? null;
          if (pageUrl) {
            try {
              const fetched = await scraplingFetchUrlWithHtml(pageUrl, {
                mode: "stealth",
                timeoutMs: 30_000,
              });
              // null is now the miss signal (upstream 4xx, empty, or an
              // interstitial). Falling to "" yields zero claims, so the rescue
              // reports failure instead of parsing a challenge page as a page.
              const html = fetched?.html ?? fetched?.markdown ?? "";
              const claims = parseAmsoilVehiclePage(html, {
                source_url: pageUrl,
                observed_at: Date.now(),
              });
              if (claims.length > 0) {
                outcome = { ok: true, claims, error: `headless_rescue: ${pageUrl}` };
              }
            } catch (e) {
              console.warn("[claims] scrapling rescue failed (non-fatal):", e);
            }
          }
        }
        result.ran.push(adapter.name);
        result.adapters.push({
          adapter: adapter.name,
          ok: outcome.ok,
          claims: outcome.claims.length,
          ...(outcome.needs_headless ? { needs_headless: true } : {}),
          ...(outcome.error ? { error: outcome.error.slice(0, 300) } : {}),
        });
        // A claim for a field nobody asked about is still evidence worth
        // keeping — the cost is already paid, and the next run reconciles it.
        for (const c of outcome.claims) pending.push({ claim: c, adapter: adapter.name });
      }

      // The pipeline's own extraction, entered as a rival voice. Only for
      // fields some registered adapter can attest — a web_search claim on a
      // field nothing else covers adds a row that can never be corroborated,
      // and would quietly inflate `fields_with_claims` without adding evidence.
      const attestable = new Set(SOURCE_ADAPTERS.flatMap((a) => [...a.fields]));
      const now = Date.now();
      for (const pc of args.pipelineClaims ?? []) {
        if (!attestable.has(pc.field_key)) continue;
        if (pc.value.trim() === "") continue;
        const domain = (pc.source_domain ?? "pipeline_extraction").toLowerCase();
        pending.push({
          adapter: "pipeline_extraction",
          claim: {
            field_key: pc.field_key,
            value: pc.value,
            source_family: "web_search",
            source_domain: domain,
            source_url: pc.source_url ?? "",
            method: "llm_extraction",
            observed_at: now,
          },
        });
      }

      for (let i = 0; i < pending.length; i += CLAIM_WRITE_SLICE) {
        const slice = pending.slice(i, i + CLAIM_WRITE_SLICE).map(({ claim: c, adapter }) => ({
          field_key: c.field_key,
          value: c.value,
          value_raw: c.value_raw,
          source_family: c.source_family,
          source_domain: c.source_domain,
          source_operator: resolveOperator(c.source_domain),
          source_url: c.source_url,
          method: c.method,
          adapter,
          observed_label: c.observed_label,
          observed_at: c.observed_at,
        }));
        try {
          const w = await ctx.runMutation(internal.vehicleEnrichment.claimGathering._writeClaims, {
            vehicleConfigId: args.vehicleConfigId,
            runId: args.runId,
            claims: slice,
          });
          result.claims_written += w.written;
        } catch (e) {
          console.warn("[claim-ledger] claim slice write failed (non-fatal):", e);
        }
      }

      // Reconcile over EVERY claim on file for this config, not just this run's
      // — corroboration is cumulative, and a claim gathered last week is still
      // an independent voice today.
      let all: Claim[] = [];
      try {
        const rows = await ctx.runQuery(
          internal.vehicleEnrichment.claimGathering._claimsForConfig,
          { vehicleConfigId: args.vehicleConfigId },
        );
        all = rows.filter((r: any) => KNOWN_FAMILIES.has(r.source_family)) as Claim[];
      } catch (e) {
        console.warn("[claim-ledger] claim read-back failed, reconciling this run only:", e);
        all = pending.map((p) => p.claim);
      }

      const fields = [...new Set(all.map((c) => c.field_key))].sort();
      result.consensus = fields.map((f) => reconcileClaims(f, all));

      const agreed = result.consensus.filter((c) => c.outcome === "consensus").length;
      const ties = result.consensus.filter((c) => c.outcome === "conflict_tie").length;
      console.log(
        `[claim-ledger] ran=[${result.ran.join(",")}] ` +
          `skipped_headless=[${result.skipped_headless.join(",")}] ` +
          `claims=${result.claims_written} fields=${fields.length} ` +
          `consensus=${agreed} ties=${ties}`,
      );
    } catch (e) {
      console.warn("[claim-ledger] gatherClaims failed (non-fatal):", e);
    }

    return result;
  },
});

/**
 * Config-resolved gather: look up the vehicle and its OEM part numbers from the
 * DB, run the adapters, and persist the claims.
 *
 * `gatherClaims` takes its vehicle and part numbers as ARGUMENTS because the
 * pipeline already has them in memory at finalize. Every other caller — fleet
 * heals, re-gathers after an adapter fix, a config that finalized before the
 * ledger worked — would otherwise have to assemble that arg list by hand from
 * three tables, which is exactly the kind of manual step that gets a
 * `displacement` string passed into a number field.
 */
export const _gatherInputsForConfig = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const cfg: any = await ctx.db.get(args.vehicleConfigId);
    if (!cfg) return null;
    const [make, model, engine] = await Promise.all([
      cfg.make_id ? ctx.db.get(cfg.make_id) : null,
      cfg.model_id ? ctx.db.get(cfg.model_id) : null,
      cfg.engine_id ? ctx.db.get(cfg.engine_id) : null,
    ]);

    // OEM numbers already on file, for the part-keyed adapters.
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .collect();
    const knownParts: Array<{ field_key: string; part_number: string; role_key: string | null }> = [];
    const seen = new Set<string>();
    for (const f of fitments) {
      const part: any = await ctx.db.get(f.part_id);
      const oem = part?.oem_part_number ?? "";
      const sub = part?.subcategory ?? null;
      if (!oem || oem.startsWith("OTOPAIR-UNIV") || seen.has(oem)) continue;
      seen.add(oem);
      knownParts.push({
        // The adapters route on the PART_FIELD_MAP key; `${subcategory}_oem` is
        // its shape for the slots that matter here.
        field_key: sub ? `${sub}_oem` : "unknown_oem",
        part_number: oem,
        role_key: sub,
      });
    }

    const eng = engine as any;
    const rawDisp = eng?.displacement_l ?? eng?.displacement_liters ?? null;
    return {
      year: cfg.year as number,
      make: (make as any)?.name ?? "",
      model: (model as any)?.name ?? "",
      trim: (cfg.trim_name as string) ?? null,
      engineCode: (engine as any)?.engine_code ?? null,
      displacementL: rawDisp == null ? null : Number(rawDisp) || null,
      cylinders: (engine as any)?.cylinders ?? null,
      knownParts,
    };
  },
});

/** Gather claims for one config, resolving every input from the DB. */
export const gatherClaimsForConfig = internalAction({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args): Promise<GatherResult | { error: string }> => {
    const inp: any = await ctx.runQuery(
      internal.vehicleEnrichment.claimGathering._gatherInputsForConfig,
      { vehicleConfigId: args.vehicleConfigId },
    );
    if (!inp) return { error: "config_not_found" };
    return await ctx.runAction(internal.vehicleEnrichment.claimGathering.gatherClaims, {
      vehicleConfigId: args.vehicleConfigId,
      year: inp.year,
      make: inp.make,
      model: inp.model,
      trim: inp.trim,
      engineCode: inp.engineCode,
      displacementL: inp.displacementL,
      cylinders: inp.cylinders,
      knownParts: inp.knownParts,
    });
  },
});

/**
 * One-shot adapter probe. Runs each fetchable adapter against a vehicle and
 * reports what came back WITHOUT writing anything.
 *
 * This exists because two questions about the adapters cannot be answered by
 * reading source: whether Brembo's ASP.NET antiforgery cookie handshake
 * survives Convex's V8 fetch, and whether a given vehicle exists in a
 * catalogue at all (the 2020 Yaris is a rebadged Mazda2 — exactly the shape
 * that misses on US-market catalogues). Ship the wiring, then ask the network.
 */
export const probeAdapters = internalAction({
  args: {
    year: v.float64(),
    make: v.string(),
    model: v.string(),
    trim: v.optional(v.union(v.string(), v.null())),
    displacementL: v.optional(v.union(v.float64(), v.null())),
    cylinders: v.optional(v.union(v.float64(), v.null())),
    /**
     * Part numbers to hand the adapters that need them.
     *
     * Required to probe the CORROBORATING adapters at all: rockauto is
     * part-keyed, and wix_filters short-circuits before its first request when
     * it has no number to confirm (see THE LAW in wixFilters.ts). Without this
     * a probe reports them inert and answers nothing about their fetch paths —
     * which is the one question this probe exists to answer.
     */
    knownParts: v.optional(
      v.array(
        v.object({
          field_key: v.string(),
          part_number: v.string(),
          role_key: v.optional(v.union(v.string(), v.null())),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const vehicle: AdapterVehicle = {
      year: args.year,
      make: args.make,
      model: args.model,
      trim: args.trim ?? null,
      displacement_l: args.displacementL ?? null,
      cylinders: args.cylinders ?? null,
      known_parts: (args.knownParts ?? []).map((p) => ({
        field_key: p.field_key,
        part_number: p.part_number,
        role_key: p.role_key ?? null,
      })),
    };
    const out: Array<AdapterRunRecord & { fields: string[]; sample: string[] }> = [];
    for (const adapter of SOURCE_ADAPTERS) {
      if (ADAPTER_FETCHABILITY[adapter.name] === "needs_headless") {
        out.push({
          adapter: adapter.name,
          ok: false,
          claims: 0,
          needs_headless: true,
          error: "skipped: no headless fetch tier available",
          fields: [...adapter.fields],
          sample: [],
        });
        continue;
      }
      const r = await withDeadline(adapter, vehicle, ADAPTER_DEADLINE_MS);
      out.push({
        adapter: adapter.name,
        ok: r.ok,
        claims: r.claims.length,
        ...(r.needs_headless ? { needs_headless: true } : {}),
        ...(r.error ? { error: r.error.slice(0, 300) } : {}),
        fields: [...adapter.fields],
        sample: r.claims.slice(0, 6).map((c) => `${c.field_key}=${c.value} @${c.source_domain}`),
      });
    }
    console.log(`[claim-probe] ${args.year} ${args.make} ${args.model}:`, JSON.stringify(out, null, 2));
    return out;
  },
});
