/**
 * vehicleEnrichment/roleIdentityAudit.ts — retroactive component-identity
 * sweep over EXISTING core fitments (round 12). FLAG-ONLY, never deletes.
 *
 * The role-identity gate protects new writes, but the fleet's stored parts
 * predate title capture: 84257919 (a battery ground extension CABLE) sat in
 * the Equinox battery role through eleven rounds AND a manual ground-truth
 * review — per-number web lookup is blind to component-type substitution
 * unless the check asks "what IS this part", which is exactly what this sweep
 * asks.
 *
 *   Phase A (free, deterministic): stored scraped_name vs the role lexicon.
 *   Phase B (batched Haiku web-search): title-less core fitments — "is PN X
 *     actually a <role>?" ~30 per call; only an explicit "no" acts.
 *
 * A hit patches the fitment refute_flagged with the machine-readable
 * "role_identity: " reason prefix (the Wrong-Parts panel's Wrong-component
 * chip) and inserts a mode-"flag" refuted_fitments row so the finding
 * survives purge + re-run PRE-DEMOTED — never mode "block", never a delete
 * (round-6 lesson: flag on positive evidence; a human adjudicates).
 *
 * Run in slices, dry-run first:
 *   npx convex run vehicleEnrichment/roleIdentityAudit:auditRoleIdentity '{"dryRun":true,"maxParts":60}'
 *   npx convex run vehicleEnrichment/roleIdentityAudit:auditRoleIdentity '{"configKey":"2024_chevrolet_equinox_premier_lsd","dryRun":true}'
 */

import Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { MODEL_HAIKU } from "./utils/batchClient";
import { checkRoleIdentity, isCoreRoleKey, ROLE_IDENTITY_LEXICON } from "./roleIdentity";
import { normalizeOemNumber } from "./priceParser";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// ─── Data plumbing ──────────────────────────────────────────────────────────

export const pageCoreFitments = internalQuery({
  args: {
    cursor: v.optional(v.string()),
    numItems: v.number(),
    configKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let fitments: any[];
    let continueCursor: string | null = null;
    let isDone = true;
    if (args.configKey) {
      const cfg = await ctx.db
        .query("vehicle_configs")
        .withIndex("by_config_key", (q) => q.eq("config_key", args.configKey!))
        .first();
      if (!cfg) return { rows: [], cursor: null, isDone: true };
      fitments = await ctx.db
        .query("part_fitments")
        .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", cfg._id))
        .collect();
    } else {
      const page = await ctx.db
        .query("part_fitments")
        .order("desc")
        .paginate({ numItems: args.numItems, cursor: args.cursor ?? null });
      fitments = page.page;
      continueCursor = page.isDone ? null : page.continueCursor;
      isDone = page.isDone;
    }

    const rows: Array<{
      fitmentId: string;
      partId: string;
      configId: string;
      makeName: string | null;
      oem: string;
      subcategory: string | null;
      name: string;
      scrapedName: string | null;
      serviceType: string | null;
      serviceRole: string | null;
      refuteFlagged: boolean;
      refuteReason: string | null;
      mechanicVerified: boolean;
      packageCode: string | null;
    }> = [];
    const makeNameCache = new Map<string, string | null>();
    for (const f of fitments) {
      const part: any = await ctx.db.get(f.part_id);
      if (!part) continue;
      const cfg: any = await ctx.db.get(f.vehicle_config_id);
      let makeName: string | null = null;
      if (cfg?.make_id) {
        const key = String(cfg.make_id);
        if (!makeNameCache.has(key)) {
          const make: any = await ctx.db.get(cfg.make_id);
          makeNameCache.set(key, make?.name ?? null);
        }
        makeName = makeNameCache.get(key) ?? null;
      }
      rows.push({
        fitmentId: String(f._id),
        partId: String(f.part_id),
        configId: String(f.vehicle_config_id),
        makeName,
        oem: part.oem_part_number ?? "",
        subcategory: part.subcategory ?? null,
        name: part.name ?? "",
        scrapedName: part.scraped_name ?? null,
        serviceType: f.service_type ?? null,
        serviceRole: f.service_role ?? null,
        refuteFlagged: !!f.refute_flagged,
        refuteReason: (f.refute_reason ?? null) as string | null,
        mechanicVerified: !!f.mechanic_verified,
        packageCode: f.package_code ?? null,
      });
    }
    return { rows, cursor: continueCursor, isDone };
  },
});

export const flagRoleIdentityFitment = internalMutation({
  args: {
    fitmentId: v.id("part_fitments"),
    partId: v.id("oem_parts"),
    vehicleConfigId: v.id("vehicle_configs"),
    serviceType: v.optional(v.string()),
    reason: v.string(),
    /** Listing title Phase B saw — adjudicated evidence: RESTORES the part's
     *  scraped_name even when one exists (a live purge+re-run showed Batch-2
     *  can overwrite good evidence with a COMPOSED title). */
    observedTitle: v.optional(v.string()),
    /** Round 12b: escalate to a hard block + remove the fitment. Set by the
     *  sweep for reject-mode lexicon roles on a POSITIVE wrong-component
     *  identification — component identity is binary and does not get truer
     *  with more sources, so the flag-only demote left the wrong part running
     *  unopposed (the batch-11 "demoted-wrong-winner" failure, observed live
     *  when 84257919 re-entered the battery role after a purge). Mirrors the
     *  verifier's existing hard-delete + block contract; reversible by
     *  deleting the refuted_fitments row. */
    escalateToBlock: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const fitment = await ctx.db.get(args.fitmentId);
    if (!fitment) return { flagged: false };
    const part: any = await ctx.db.get(args.partId);
    const normalized = part
      ? (part.oem_part_number_normalized ?? normalizeOemNumber(part.oem_part_number ?? ""))
      : null;

    if (normalized) {
      const existing = await ctx.db
        .query("refuted_fitments")
        .withIndex("by_config_oem", (q) =>
          q.eq("vehicle_config_id", args.vehicleConfigId).eq("oem_part_number_normalized", normalized),
        )
        .first();
      if (!existing) {
        await ctx.db.insert("refuted_fitments", {
          vehicle_config_id: args.vehicleConfigId,
          oem_part_number_normalized: normalized,
          service_type: args.serviceType,
          mode: args.escalateToBlock ? "block" : "flag",
          reason: args.reason,
          refuted_at: Date.now(),
        });
      } else if (args.escalateToBlock && (existing as any).mode === "flag") {
        // Upgrade flag → block (never the reverse).
        await ctx.db.patch(existing._id, { mode: "block", reason: args.reason, refuted_at: Date.now() });
      }
      if (part && args.observedTitle) {
        await ctx.db.patch(args.partId, { scraped_name: args.observedTitle.slice(0, 200) });
      }
    }

    if (args.escalateToBlock) {
      // Hard-remove the wrong-component fitment so the role becomes an honest
      // gap eligible for re-source — a blocked number must not keep winning
      // selection from a row that predates its block.
      await ctx.db.delete(args.fitmentId);
      console.log(
        `[role-identity-audit] BLOCK+REMOVED fitment ${args.fitmentId} (${part?.oem_part_number ?? "?"}) — ${args.reason}`,
      );
      return { flagged: true, blocked: true };
    }

    await ctx.db.patch(args.fitmentId, {
      refute_flagged: true,
      refute_reason: args.reason,
    });
    return { flagged: true, blocked: false };
  },
});

// ─── The sweep ──────────────────────────────────────────────────────────────

const PHASE_B_SYSTEM = `You are an automotive parts identity checker. Each numbered line gives an OEM part number and the ROLE our catalog claims it fills. Search the web for each number and determine what the part ACTUALLY is. The question is NOT vehicle fitment — only whether the part IS that component type.

- "yes": the number is that component (a 12V starter battery for the battery role, a brake pad set for a brake pad role, a rotor for a rotor role).
- "no": the number is something ELSE — an accessory or adjacent hardware (a battery CABLE / tray / hold-down for the battery role, a filter HOUSING for a filter role, a dust SHIELD for a rotor role) or a different component entirely. Say what it actually is in "actual" and copy the listing title you saw into "title".
- "unknown": you could not establish what the part is. NEVER guess "no" — flagging a correct part wastes review time; when unsure, "unknown".

Respond with ONLY a JSON array, one object per input line, same order:
[{"idx": 1, "is_component": "yes" | "no" | "unknown", "actual": "<what it is>", "title": "<listing title if seen>"}]`;

export const auditRoleIdentity = internalAction({
  args: {
    configKey: v.optional(v.string()),
    cursor: v.optional(v.string()),
    maxParts: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const maxParts = Math.min(args.maxParts ?? 60, 200);
    const dryRun = args.dryRun ?? false;

    const page: any = await ctx.runQuery(
      internal.vehicleEnrichment.roleIdentityAudit.pageCoreFitments,
      { cursor: args.cursor, numItems: maxParts, configKey: args.configKey },
    );

    // Eligibility: core roles with quote/invoice consequence. Unadjudicated
    // rows are checked fresh; rows ALREADY role_identity-flagged are
    // RE-adjudicated (round 12b) so a confirmed wrong component can escalate
    // flag → block — flag-only left the cable re-entering the battery role as
    // an unopposed demoted winner. Other refute flavors stay skipped.
    const seenPartRole = new Set<string>();
    const eligible = (page.rows as any[]).filter((r) => {
      if (r.packageCode != null) return false;
      if (r.mechanicVerified) return false;
      if (r.refuteFlagged && !String(r.refuteReason ?? "").startsWith("role_identity")) return false;
      if (!r.oem || r.oem.startsWith("OTOPAIR-UNIV")) return false;
      if (!r.subcategory || !ROLE_IDENTITY_LEXICON[r.subcategory]) return false;
      if (r.serviceRole !== "core" && !isCoreRoleKey(r.subcategory)) return false;
      const key = `${r.subcategory}:${normalizeOemNumber(r.oem)}`;
      if (seenPartRole.has(key)) return false; // dedupe part-role pairs
      seenPartRole.add(key);
      return true;
    });

    /** Escalation policy: block only where the lexicon is high-precision
     *  (mode "reject") — flag-mode roles keep flag-only semantics. */
    const escalates = (subcategory: string): boolean =>
      ROLE_IDENTITY_LEXICON[subcategory]?.mode === "reject";

    const findings: Array<{
      configId: string;
      oem: string;
      subcategory: string;
      reason: string;
      phase: "A" | "B";
      title: string | null;
    }> = [];

    // Phase A — deterministic, free: stored titles vs the lexicon. Any reject
    // verdict (both modes) flags — this is a review queue, not a write gate.
    // Round 12b: rows already role_identity-CONTESTED skip Phase A and go to
    // Phase B regardless of title — their stored title may be the composed
    // echo that overwrote the adjudicated evidence, so it cannot clear them.
    const phaseBQueue: any[] = [];
    for (const r of eligible) {
      const contested =
        r.refuteFlagged && String(r.refuteReason ?? "").startsWith("role_identity");
      if (r.scrapedName && !contested) {
        const verdict = checkRoleIdentity(r.subcategory, r.scrapedName);
        if (verdict.verdict === "reject") {
          findings.push({
            configId: r.configId,
            oem: r.oem,
            subcategory: r.subcategory,
            reason: `role_identity: listing titled "${r.scrapedName}" — matched wrong-component term "${verdict.matched}"`,
            phase: "A",
            title: r.scrapedName,
          });
          if (!dryRun) {
            await ctx.runMutation(
              internal.vehicleEnrichment.roleIdentityAudit.flagRoleIdentityFitment,
              {
                fitmentId: r.fitmentId as any,
                partId: r.partId as any,
                vehicleConfigId: r.configId as any,
                serviceType: r.serviceType ?? undefined,
                reason: `role_identity: listing titled "${r.scrapedName}" — matched "${verdict.matched}"`,
                // Deterministic title evidence + hard-reject verdict → block.
                escalateToBlock: verdict.mode === "reject" && escalates(r.subcategory),
              },
            );
          }
        }
      } else {
        phaseBQueue.push(r);
      }
    }

    // Phase B — batched web identity check for title-less parts.
    let phaseBChecked = 0;
    if (phaseBQueue.length > 0 && process.env.ANTHROPIC_API_KEY) {
      const BATCH = 30;
      for (let i = 0; i < phaseBQueue.length; i += BATCH) {
        const batch = phaseBQueue.slice(i, i + BATCH);
        phaseBChecked += batch.length;
        const lines = batch
          .map(
            (r, j) =>
              `${j + 1}. ${r.makeName ?? "unknown make"} OEM ${r.oem} — claimed role: ${r.name || r.subcategory}`,
          )
          .join("\n");
        try {
          const resp = await getClient().messages.create({
            model: MODEL_HAIKU,
            max_tokens: 2500,
            temperature: 0,
            system: PHASE_B_SYSTEM,
            messages: [{ role: "user", content: `Parts to identify:\n${lines}` }],
            tools: [
              { type: "web_search_20250305" as any, name: "web_search", max_uses: 12 } as any,
            ],
          });
          const text = resp.content
            .filter((b) => b.type === "text")
            .map((b) => (b as any).text)
            .join("")
            .trim();
          const jsonMatch = text.match(/\[[\s\S]*\]/);
          const arr = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
          for (const row of Array.isArray(arr) ? arr : []) {
            const r = batch[(row?.idx ?? 0) - 1];
            if (!r || row?.is_component !== "no") continue;
            const actual = typeof row.actual === "string" ? row.actual.slice(0, 160) : "a different component";
            const title = typeof row.title === "string" && row.title.trim() ? row.title.trim().slice(0, 200) : null;
            findings.push({
              configId: r.configId,
              oem: r.oem,
              subcategory: r.subcategory,
              reason: `role_identity: ${actual}`,
              phase: "B",
              title,
            });
            if (!dryRun) {
              await ctx.runMutation(
                internal.vehicleEnrichment.roleIdentityAudit.flagRoleIdentityFitment,
                {
                  fitmentId: r.fitmentId as any,
                  partId: r.partId as any,
                  vehicleConfigId: r.configId as any,
                  serviceType: r.serviceType ?? undefined,
                  reason: `role_identity: ${actual}`,
                  observedTitle: title ?? undefined,
                  // Positive web identification of a different component on a
                  // high-precision role → block + remove (round 12b).
                  escalateToBlock: escalates(r.subcategory),
                },
              );
            }
          }
        } catch (e) {
          console.warn("[role-identity-audit] phase B batch failed (non-fatal):", e);
        }
      }
    }

    const summary = {
      scanned: (page.rows as any[]).length,
      eligible: eligible.length,
      phaseAWithTitle: eligible.length - phaseBQueue.length,
      phaseBChecked,
      flagged: findings.length,
      dryRun,
      findings: findings.slice(0, 40),
      cursor: page.cursor,
      isDone: page.isDone,
    };
    console.log(`[role-identity-audit] ${JSON.stringify({ ...summary, findings: summary.findings.length })}`);
    return summary;
  },
});
