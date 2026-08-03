/**
 * vehicleEnrichment/utils/roleResource.ts — STATE-based re-source for empty
 * binding core roles (round 12, batch-12 Crosstrek).
 *
 * backfillKilledRoles (round 10) is EVENT-based: it fires only when the
 * fitment verifier kills a part in THIS run. On a re-run, blocklisted numbers
 * are rejected at WRITE time instead — no kill event, no backfill, and the
 * role stays empty forever (the Crosstrek's front pads/rotor: correct
 * wrong-generation kills, zero re-source attempts ever after). This module
 * asks the state question — "which binding core roles are empty NOW?" — and
 * repairs per role:
 *
 *   Tier 1 (deterministic): position-specific site-scoped SERP against the
 *     make's registry storefront; a detail page must carry YEAR evidence
 *     covering this model year (year-less model-scoped pages produced every
 *     wrong keep in batch-11), a role-identity-passing listing title, and a
 *     JSON-LD OEM number. Writes part + price directly — this is the same
 *     evidence standard the adversarial verifier itself checks against.
 *   Tier 2 (research fallback): ONE batched Haiku web-search call for the
 *     roles Tier 1 couldn't fill — position stated as BINDING, with a
 *     structured not_applicable escape (rear drums → no rear rotor) that the
 *     caller persists to vehicle_configs.na_role_keys so physically-absent
 *     roles stop alarming forever. Candidates write ONLY on an adversarial
 *     verifyPartFitments "confirmed" — an uncertain candidate stays an honest
 *     gap (false confirm poisons; false refute just leaves the hole).
 *
 * Every write funnels through upsertPartAndFitment, so the refute blocklist,
 * cross-make, role-identity, and format gates all still apply — the loop can
 * only add a DIFFERENT, gate-passing number, never resurrect a refuted one,
 * and it NEVER overwrites an occupied role (empty-fill only; round-6 lesson).
 * Fail-open per role and never throws.
 */

import Anthropic from "@anthropic-ai/sdk";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { checkRoleIdentity, isCoreRoleKey } from "../roleIdentity";
import { getSourceConfig } from "../sourceRegistry";
import { searchAndFetch } from "../firecrawl";
import { isStorefrontHomepage } from "../rpCatalog";
import { normalizeOemNumber, parsePartPrices } from "../priceParser";
import { MODEL_HAIKU } from "./batchClient";
import { positionForRoleKey, verifyPartFitments } from "./partFitmentVerifier";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

/** The PART_FIELD_MAP meta a repairing write needs — passed in by the caller
 *  (v3pipeline owns the map; importing it here would cycle). */
export interface RoleWriteMeta {
  name: string;
  category: string;
  subcategory: string;
  serviceSlug: string | null;
  serviceRole: "core" | "as_needed" | "kit";
  position?: string;
}

export interface RoleResourceVehicle {
  year: number;
  make: string;
  model: string;
  trim?: string | null;
  engineCode?: string | null;
  displacement?: string | null;
  transmissionType?: string | null;
  vehicleConfigId: Id<"vehicle_configs">;
  makeId: Id<"makes">;
  /** P2.5 badge-engineering brand, forwarded to the write gate. */
  buildSourceMake?: string | null;
}

export interface RoleResourceOutcome {
  roleKey: string;
  outcome:
    | "written"
    | "rejected_refuted"
    | "rejected_other"
    | "never_found"
    | "not_applicable"
    /**
     * DEPRECATED as an emitted value — kept so historical run rows still type.
     * It conflated two opposite situations and made them indistinguishable in
     * the run record:
     *
     *   - this run ran out of per-run budget (the role is untried and a bigger
     *     budget, or simply another run, would attempt it); versus
     *   - this role has burned its lifetime attempts (trying again is futile
     *     and more budget changes nothing).
     *
     * Diagnosing the Round 14 part shortfall required knowing which — six roles
     * on the Altima read `skipped_budget` and the log could not say whether
     * raising the cap would help. Use the two members below.
     */
    | "skipped_budget"
    /** Untried this run: the per-run cap (PARTS_ROLE_RESOURCE_MAX) was reached.
     *  More budget WOULD attempt it. */
    | "skipped_run_budget"
    /** Untried and not worth retrying: this role has already used its lifetime
     *  attempts across runs. More budget changes nothing. */
    | "skipped_lifetime_cap";
  tier?: 1 | 2;
  oem?: string;
  sourceUrl?: string | null;
  naReason?: string;
  /** Round 13: what this repair was — filling an EMPTY role, or writing a
   *  verified RIVAL for a role whose only candidates are soft-flagged. */
  kind?: "fill" | "rival";
}

/** Round 13: a repair target. Structurally a superset of quotability's
 *  MissingCoreRole so fill targets pass through unchanged; rival targets add
 *  the flagged incumbents (excluded from research, named in the prompt). */
export interface RoleRepairTarget {
  serviceSlug: string;
  roleKey: string;
  fitmentService: string;
  kind?: "fill" | "rival";
  /** For rivals: the soft-flagged incumbent number(s), normalized. */
  flaggedOems?: string[];
}

// ─── Round 13: sole-flagged-winner detection (pure) ─────────────────────────
//
// The 7-layer selector already demotes a refute_flagged candidate DECISIVELY
// whenever an unflagged rival exists (partSelector.ts "Fitment Refute
// Demotion") — but with no rival, "a flagged sole candidate still quotes"
// (the batch-11 "demoted-wrong-winner": the Crosstrek's 2022-2023-only front
// pad 26296FL032 kept winning). Detect exactly that shape: core role groups where
// EVERY candidate is soft-flagged. The remedy is ADDITIVE — research + verify
// a rival and let the existing demotion swap winners. Nothing is deleted or
// overwritten (round-6 lesson); a wrong rival just loses or sits beside the
// incumbent for review.

export interface FitmentCandidateRow {
  serviceType: string | null;
  subcategory: string | null;
  serviceRole: string | null;
  refuteFlagged: boolean;
  refuteReason: string | null;
  mechanicVerified: boolean;
  packageCode: string | null;
  oemNormalized: string;
}

export interface SoleFlaggedRole {
  roleKey: string;
  serviceType: string;
  flaggedOems: string[];
  reasons: string[];
}

export function soleFlaggedWinnerRoles(
  rows: readonly FitmentCandidateRow[],
): SoleFlaggedRole[] {
  const groups = new Map<string, FitmentCandidateRow[]>();
  for (const r of rows) {
    if (r.packageCode != null) continue;
    if (!r.subcategory || !r.serviceType) continue;
    const isCore = r.serviceRole === "core" || isCoreRoleKey(r.subcategory);
    if (!isCore) continue;
    const key = `${r.serviceType}::${r.subcategory}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: SoleFlaggedRole[] = [];
  for (const [key, candidates] of groups) {
    // A mechanic-verified candidate is a human confirmation — never rival it.
    if (candidates.some((c) => c.mechanicVerified)) continue;
    if (!candidates.every((c) => c.refuteFlagged)) continue; // unflagged rival exists — selector already handles it
    const [serviceType, roleKey] = key.split("::");
    out.push({
      roleKey,
      serviceType,
      flaggedOems: [...new Set(candidates.map((c) => c.oemNormalized).filter(Boolean))],
      reasons: [...new Set(candidates.map((c) => c.refuteReason).filter((x): x is string => !!x))],
    });
  }
  return out;
}

/** Deterministic year-coverage check over a page's title + markdown head.
 *  Accepts "2023-2025", "2024–present" ranges and bare year mentions. */
export function pageCoversYear(text: string, year: number): boolean {
  const rangeRe = /\b((?:19|20)\d{2})\s*[-–—]\s*((?:19|20)\d{2}|present|current)/gi;
  let m: RegExpExecArray | null;
  while ((m = rangeRe.exec(text)) !== null) {
    const a = Number(m[1]);
    const b = /^\d{4}$/.test(m[2]) ? Number(m[2]) : 9999;
    if (a <= year && year <= b) return true;
  }
  return (text.match(/\b(?:19|20)\d{2}\b/g) ?? []).map(Number).includes(year);
}

const TIER2_SYSTEM = `You are an automotive OEM parts researcher. You are given ONE exact vehicle and a short list of part ROLES that are currently EMPTY in our catalog — or filled only by a number that was FLAGGED as wrong for this vehicle (the role line says so). Search the web and find the CORRECT OEM part number for each role for THIS exact vehicle.

Rules:
- The part must be confirmed for this exact year + model + engine (and generation). A listing whose year range or engine excludes this vehicle is wrong.
- AXLE POSITION IS BINDING. A role marked FRONT means the front-axle part; a rear-axle part number is WRONG for it, and vice versa. Never satisfy a front role with a rear part "because it was easier to find".
- The part must be the COMPONENT ITSELF, never adjacent hardware or an accessory for it: a battery CABLE is not a battery, a filter HOUSING is not a filter, a rotor dust SHIELD is not a rotor.
- Prefer OEM/dealer parts-catalog sources (parts.<make>.com, dealer eStores) over aftermarket listings.
- If this vehicle does NOT have that component at all (rear DRUM brakes have no rear rotor or rear pad set; electric power steering has no PS fluid), return {"role": "<roleKey>", "not_applicable": "<one-line reason>"} — a positive not-applicable finding is a valuable answer.
- If you cannot confirm a role's part for this exact vehicle within your search budget, OMIT that role — a missing answer is an honest gap; a guessed answer poisons a quote.
- Respond with ONLY a JSON array:
[{"role": "<roleKey>", "oem": "<OEM part number>", "name": "<the listing's product title, verbatim>", "source_url": "<page that confirms fitment>"} | {"role": "<roleKey>", "not_applicable": "<reason>"}]`;

export async function resourceMissingRoles(
  ctx: any,
  vehicle: RoleResourceVehicle,
  /** Fill targets (MissingCoreRole is structurally a fill-kind target) and —
   *  round 13 — rival targets for sole-flagged-winner roles. */
  missing: readonly RoleRepairTarget[],
  metaBySubcategory: Record<string, RoleWriteMeta>,
  opts?: {
    maxRoles?: number;
    /** roleKey → prior re-source attempts from earlier runs' field_gaps. */
    priorAttemptsByRole?: Map<string, number>;
    lifetimeCap?: number;
    /** NORMALIZED OEM numbers hard-blocked for this config (refuted_fitments
     *  mode "block") plus — for rival targets — the flagged incumbents.
     *  Excluded at every tier — observed live: the Tier-2 researcher re-found
     *  the blocklisted 26300SA001 rotor because it dominates the open web;
     *  the write gate rejected it, but without this exclusion every retry
     *  re-finds the same wrong number. */
    blockedOems?: ReadonlySet<string>;
  },
): Promise<RoleResourceOutcome[]> {
  // Default raised 4 -> 10 on measured evidence, not intuition. A 2016 Altima
  // arrived at this stage with ELEVEN missing roles; at 4 it repaired 3 and
  // logged six `skipped_budget`, finishing with 4 parts. Re-run at 12 it
  // attempted the six it had skipped and wrote ALL SIX — they were never a
  // sourcing failure, the repair simply was not allowed to try. Parts went
  // 4 -> 11, all priced, fill 77 -> 88.
  //
  // 10 rather than 12: with the BASE slug set now covering all 13 core roles
  // deterministically, far fewer roles should reach this stage at all, so this
  // is a safety net for the bad case rather than the primary source of parts.
  // The cost is bounded — each attempt is one search plus one extraction, and
  // only ever for roles that are genuinely empty.
  const maxRoles = opts?.maxRoles ?? Number(process.env.PARTS_ROLE_RESOURCE_MAX ?? "10");
  const lifetimeCap = opts?.lifetimeCap ?? 3;
  const outcomes: RoleResourceOutcome[] = [];

  // Dedupe by roleKey (rotor_replacement borrows front_brake_pad from
  // brake_pad_replacement — one repair fills every borrower), keep list order
  // (callers put fill targets before rival targets — an EMPTY role outranks a
  // flagged-but-present one for the budget).
  const uniqueRoles: RoleRepairTarget[] = [];
  const seen = new Set<string>();
  for (const m of missing) {
    if (seen.has(m.roleKey)) continue;
    seen.add(m.roleKey);
    uniqueRoles.push(m);
  }

  const eligible: RoleRepairTarget[] = [];
  for (const role of uniqueRoles) {
    const prior = opts?.priorAttemptsByRole?.get(role.roleKey) ?? 0;
    if (prior >= lifetimeCap) {
      // Exhausted across runs — raising the per-run budget would not help.
      outcomes.push({
        roleKey: role.roleKey,
        outcome: "skipped_lifetime_cap",
        kind: role.kind ?? "fill",
      });
      continue;
    }
    if (eligible.length >= maxRoles) {
      // Untried purely because this run ran out of room. A larger
      // PARTS_ROLE_RESOURCE_MAX, or simply the next run, WILL attempt it.
      outcomes.push({
        roleKey: role.roleKey,
        outcome: "skipped_run_budget",
        kind: role.kind ?? "fill",
      });
      continue;
    }
    eligible.push(role);
  }
  if (eligible.length === 0) return outcomes;
  const kindOf = new Map(eligible.map((t) => [t.roleKey, t.kind ?? "fill"] as const));

  const writeCandidate = async (
    roleKey: string,
    cand: { oem: string; title: string | null; price?: number | null; sourceUrl: string | null },
    tier: 1 | 2,
  ): Promise<RoleResourceOutcome> => {
    const meta = metaBySubcategory[roleKey];
    if (!meta) return { roleKey, outcome: "never_found", tier };
    const sourceDomain = (() => {
      try {
        return cand.sourceUrl ? new URL(cand.sourceUrl).hostname.replace(/^www\./, "") : undefined;
      } catch {
        return undefined;
      }
    })();
    const res: any = await ctx.runMutation(
      internal.vehicleEnrichment.v3mutations.upsertPartAndFitment,
      {
        oem_part_number: cand.oem,
        name: meta.name,
        category: meta.category,
        subcategory: meta.subcategory,
        make_id: vehicle.makeId,
        vehicle_config_id: vehicle.vehicleConfigId,
        service_type: meta.serviceSlug ?? meta.subcategory,
        quantity_needed: roleKey === "front_rotor" || roleKey === "rear_rotor" ? 2 : 1,
        position: meta.position,
        service_role: meta.serviceRole,
        confidence: 0.7,
        source_domain: sourceDomain,
        build_source_make: vehicle.buildSourceMake ?? undefined,
        observed_title: cand.title ?? undefined,
      },
    );
    if (res?.rejected === "refuted") {
      return { roleKey, outcome: "rejected_refuted", tier, oem: cand.oem, sourceUrl: cand.sourceUrl };
    }
    if (res?.rejected || !res?.part_id) {
      return { roleKey, outcome: "rejected_other", tier, oem: cand.oem, sourceUrl: cand.sourceUrl };
    }
    if (cand.price != null && cand.price > 0 && sourceDomain && cand.sourceUrl) {
      try {
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartPrice, {
          part_id: res.part_id,
          price: cand.price,
          price_type: "sale",
          source_url: cand.sourceUrl,
          source_domain: sourceDomain,
        });
      } catch (e) {
        console.warn(`[role-resource] price write failed for ${cand.oem} (non-fatal):`, e);
      }
    }
    return { roleKey, outcome: "written", tier, oem: cand.oem, sourceUrl: cand.sourceUrl };
  };

  // ── Tier 1: deterministic storefront lookup per role ──────────────────────
  const config = getSourceConfig(vehicle.make);
  const storeHost = (() => {
    try {
      return config ? new URL(config.parts.storeBaseUrl).hostname.replace(/^www\./, "") : null;
    } catch {
      return null;
    }
  })();

  const tier2Queue: RoleRepairTarget[] = [];
  for (const role of eligible) {
    const meta = metaBySubcategory[role.roleKey];
    if (!meta) {
      outcomes.push({ roleKey: role.roleKey, outcome: "never_found", kind: kindOf.get(role.roleKey) });
      continue;
    }
    if (!storeHost) {
      tier2Queue.push(role);
      continue;
    }
    try {
      // meta.name carries the position word ("Front Brake Rotor") — the same
      // year-in-query steering the main scrape uses.
      const serpQuery = `site:${storeHost} ${vehicle.year} ${vehicle.model} ${meta.name}`;
      const results = await searchAndFetch(serpQuery, 4, true);
      const pos = positionForRoleKey(role.roleKey);
      let written: RoleResourceOutcome | null = null;
      for (const r of results) {
        try {
          const parsed = new URL(r.url);
          if (parsed.hostname.replace(/^www\./, "") !== storeHost) continue;
          if (!parsed.pathname.startsWith("/oem-parts/")) continue;
        } catch {
          continue;
        }
        if (isStorefrontHomepage(r.html ?? null, r.markdown)) continue;
        const pageTitle = r.title ?? "";
        // Positioned roles demand the position word on the page identity —
        // a rear-pad page must not satisfy the front role.
        if (
          pos &&
          !pageTitle.toLowerCase().includes(pos) &&
          !r.url.toLowerCase().includes(pos)
        ) {
          continue;
        }
        // Year evidence: the batch-11 bar — model-scoped year-less pages are
        // exactly what produced every wrong keep.
        const evidenceText = `${pageTitle}\n${(r.markdown ?? "").slice(0, 3000)}`;
        if (!pageCoversYear(evidenceText, vehicle.year)) continue;
        const products = r.html ? parsePartPrices(r.html, r.url) : [];
        const candidate = products.find((p) => {
          if (opts?.blockedOems?.has(p.oem_part_number)) return false; // already refuted
          const title = p.name ?? pageTitle;
          // Reject ONLY on positive evidence that this listing is a different
          // component. roleIdentity.ts's own contract says so verbatim: a
          // require-miss "is only a soft signal (dealer titles like
          // '84257919 - GM Genuine Part' carry no noun); callers promote
          // require-misses to the adversarial verifier, never reject on them."
          //
          // Testing `=== "pass"` inverted that. `unknown_role` (the roleKey has
          // no lexicon entry at all), `no_title` (the listing carried no name)
          // and `require_miss` are all NOT "pass", so every candidate on the
          // page was discarded and the repair fell through to `never_found` —
          // indistinguishable from a storefront that listed nothing. Nine
          // SERVICE_PARTS_REFERENCE roles have no lexicon entry, so those were
          // unfillable by this path on EVERY vehicle, of every make.
          const v = checkRoleIdentity(role.roleKey, title);
          return !(v.verdict === "reject" && v.mode === "reject");
        });
        if (!candidate) continue;
        written = await writeCandidate(
          role.roleKey,
          {
            oem: candidate.oem_part_number_raw,
            title: candidate.name ?? pageTitle,
            price: candidate.price,
            sourceUrl: candidate.source_url,
          },
          1,
        );
        break;
      }
      if (written) {
        written.kind = kindOf.get(role.roleKey);
        outcomes.push(written);
        console.log(
          `[role-resource] tier1 ${role.roleKey} (${written.kind}): ${written.outcome}${written.oem ? ` ${written.oem}` : ""}`,
        );
        // A refuted rejection means the storefront still serves the blocked
        // number — fall through to research for a DIFFERENT one.
        if (written.outcome === "rejected_refuted") tier2Queue.push(role);
      } else {
        tier2Queue.push(role);
      }
    } catch (e) {
      console.warn(`[role-resource] tier1 failed for ${role.roleKey} (non-fatal):`, e);
      tier2Queue.push(role);
    }
  }

  // ── Tier 2: one batched research call + adversarial verify ────────────────
  if (tier2Queue.length === 0 || !process.env.ANTHROPIC_API_KEY) {
    for (const role of tier2Queue) {
      outcomes.push({ roleKey: role.roleKey, outcome: "never_found", tier: 2, kind: kindOf.get(role.roleKey) });
    }
    return outcomes;
  }

  const desc =
    `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? ` ${vehicle.trim}` : ""}` +
    (vehicle.engineCode ? `, engine ${vehicle.engineCode}` : "") +
    (vehicle.displacement ? ` ${vehicle.displacement}L` : "") +
    (vehicle.transmissionType ? `, ${vehicle.transmissionType} transmission` : "");
  const roleLines = tier2Queue
    .map((r) => {
      const pos = positionForRoleKey(r.roleKey);
      const meta = metaBySubcategory[r.roleKey];
      // Round 13 rival targets: name the flagged incumbent so the researcher
      // hunts the CORRECT-generation replacement instead of re-deriving the
      // web-dominant wrong one.
      const rivalNote =
        r.kind === "rival" && (r.flaggedOems?.length ?? 0) > 0
          ? ` — currently stored number(s) ${r.flaggedOems!.join(", ")} were flagged WRONG for this exact vehicle (wrong generation/fitment); find the correct current number, never those`
          : "";
      return `- ${r.roleKey} (${meta?.name ?? r.roleKey})${pos ? ` — ${pos.toUpperCase()} axle, position is binding` : ""}${rivalNote}`;
    })
    .join("\n");
  const blockedList = [...(opts?.blockedOems ?? [])];
  const blockedNote =
    blockedList.length > 0
      ? `\n\nThese part numbers were already REFUTED for this exact vehicle (wrong generation/engine/component) — NEVER return any of them, even if search results tie them to this model:\n${blockedList
          .slice(0, 20)
          .map((n) => `- ${n}`)
          .join("\n")}`
      : "";

  const resolvedTier2 = new Map<string, RoleResourceOutcome>();
  try {
    const resp = await getClient().messages.create({
      model: MODEL_HAIKU,
      max_tokens: 1500,
      temperature: 0,
      system: TIER2_SYSTEM,
      messages: [{ role: "user", content: `Vehicle: ${desc}\n\nEmpty roles to research:\n${roleLines}${blockedNote}` }],
      tools: [
        {
          type: "web_search_20250305" as any,
          name: "web_search",
          max_uses: Math.min(2 * tier2Queue.length, 8),
        } as any,
      ],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as any).text)
      .join("")
      .trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    const queueKeys = new Set(tier2Queue.map((r) => r.roleKey));

    const found: Array<{ roleKey: string; oem: string; name: string | null; sourceUrl: string | null }> = [];
    for (const p of Array.isArray(parsed) ? parsed : []) {
      if (!p || typeof p.role !== "string" || !queueKeys.has(p.role) || resolvedTier2.has(p.role)) continue;
      if (typeof p.not_applicable === "string" && p.not_applicable.trim()) {
        resolvedTier2.set(p.role, {
          roleKey: p.role,
          outcome: "not_applicable",
          tier: 2,
          naReason: p.not_applicable.trim().slice(0, 200),
        });
        continue;
      }
      if (typeof p.oem === "string" && p.oem.trim().length >= 3) {
        // Belt-and-braces: drop blocklisted numbers before verify/write even
        // when the prompt exclusion was ignored.
        if (opts?.blockedOems?.has(normalizeOemNumber(p.oem))) {
          console.log(
            `[role-resource] tier2 ${p.role}: researcher returned blocklisted ${p.oem} — dropped`,
          );
          continue;
        }
        found.push({
          roleKey: p.role,
          oem: p.oem.trim(),
          name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : null,
          sourceUrl: typeof p.source_url === "string" ? p.source_url : null,
        });
      }
    }

    // Adversarial verify before ANY tier-2 write: "confirmed" writes,
    // "uncertain" stays an honest gap (a false confirm is the poisoning
    // direction), "refuted" obviously never writes.
    if (found.length > 0) {
      const verdicts = await verifyPartFitments(
        {
          year: vehicle.year,
          make: vehicle.make,
          model: vehicle.model,
          trim: vehicle.trim ?? "",
          engineCode: vehicle.engineCode,
          displacement: vehicle.displacement,
          transmissionType: vehicle.transmissionType ?? undefined,
        },
        found.map((f) => ({
          roleKey: f.roleKey,
          oem: f.oem,
          name: metaBySubcategory[f.roleKey]?.name ?? f.roleKey,
          observedTitle: f.name,
        })),
      );
      const verdictByRole = new Map(verdicts.map((vd) => [vd.roleKey, vd]));
      for (const f of found) {
        const vd = verdictByRole.get(f.roleKey);
        if (vd?.verdict === "confirmed") {
          resolvedTier2.set(
            f.roleKey,
            await writeCandidate(f.roleKey, { oem: f.oem, title: f.name, sourceUrl: f.sourceUrl }, 2),
          );
        } else {
          console.log(
            `[role-resource] tier2 ${f.roleKey}: candidate ${f.oem} not confirmed (${vd?.verdict ?? "no verdict"}) — honest gap`,
          );
        }
      }
    }
  } catch (e) {
    console.warn("[role-resource] tier2 research failed (non-fatal):", e);
  }

  for (const role of tier2Queue) {
    const resolved = resolvedTier2.get(role.roleKey);
    if (resolved) {
      resolved.kind = kindOf.get(role.roleKey);
      outcomes.push(resolved);
      console.log(
        `[role-resource] tier2 ${role.roleKey} (${resolved.kind}): ${resolved.outcome}${resolved.oem ? ` ${resolved.oem}` : ""}${resolved.naReason ? ` (${resolved.naReason})` : ""}`,
      );
    } else if (!outcomes.some((o) => o.roleKey === role.roleKey && o.outcome === "rejected_refuted")) {
      outcomes.push({ roleKey: role.roleKey, outcome: "never_found", tier: 2, kind: kindOf.get(role.roleKey) });
    }
  }
  return outcomes;
}
