/**
 * diagnoseVin — public diagnostic queries to inspect a VIN's resolved state.
 *
 * Used to verify the BMW M-car / m_sport-false-positive fix:
 *
 *   1. Run against the BUGGED deployment (ardent-crab) to capture the current state:
 *        npx convex run --url <ardent-crab-url> diagnoseVin:byVin '{"vin":"WBS43AY0XNFM51260"}'
 *
 *   2. Push the fix to your dev deployment (flippant-mink-750) via `convex dev`.
 *
 *   3. Re-enrich the same VIN on your dev deployment:
 *        npx convex run vehicleEnrichment/runPublic:purgeAndRerun '{"vin":"WBS43AY0XNFM51260"}'
 *
 *   4. Query the same diagnostic against your dev deployment:
 *        npx convex run diagnoseVin:byVin '{"vin":"WBS43AY0XNFM51260"}'
 *
 *   5. Compare: bugged should show model="3 Series" with m_sport in packages_available;
 *      fixed should show model="M3" with no m_sport (M3 ships M Performance hardware standard).
 */

// ACTIONS internal since Jun 9 2026 (review: the repair/backfill actions were
// public, unauthenticated writers that can mint 'online_discount' price rows —
// poison-excluded from quotes but still a foot-gun, and they could overwrite a
// corrected 'sale' row via upsertPartPrice's (part, domain) patch semantics).
// CLI/dashboard admin usage is unchanged. Read-only queries stay public.
// Jun 10 2026: the 4 price writers now route through writeVerifiedLlmPrice
// (the same two-tier contract as enrichment Batch-2) — no more poison minting.
import { internalAction, internalQuery, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { reextractPartPrice, isAffirmativeRejection } from "./vehicleEnrichment/priceReextract";
import { UNVERIFIED_PRICE_TYPE, isNonPooledPriceType } from "./lib/priceTypes";

/**
 * Write an LLM web-search price through the SAME two-tier verification
 * contract as enrichment Batch-2 (Jun-9 review item 9 follow-up):
 *   - verified against its cited page → trusted 'sale'
 *   - the page affirmatively testified AGAINST the number → 'unverified'
 *     (kept for audit, excluded from the customer median)
 *   - passive failure (no URL / fetch failed / LLM error) → fail-open
 *     'llm_estimate' — we learned nothing new about the number.
 * These writers used to stamp poison 'online_discount' rows the aggregator
 * ignores — self-defeating Claude spend that could also overwrite corrected
 * 'sale' rows via the (part, domain) upsert.
 */
async function writeVerifiedLlmPrice(
  ctx: { runMutation: (ref: any, args: any) => Promise<any> },
  args: {
    part_id: Id<"oem_parts">;
    price: number;
    oem: string | null;
    partName?: string | null;
    source_url?: string | null;
    source_domain: string;
  },
): Promise<"sale" | "unverified" | "llm_estimate"> {
  let verified: number | null = null;
  let affirmativeReject = false;
  if (args.source_url) {
    try {
      const outcome = await reextractPartPrice({
        oem: args.oem,
        partName: args.partName ?? null,
        source_url: args.source_url,
        crossSourceMedian: null,
      });
      if (outcome.status === "sale") {
        verified = outcome.price;
      } else if (
        outcome.status === "unverified" &&
        isAffirmativeRejection(outcome.reason)
      ) {
        affirmativeReject = true;
      }
    } catch (e) {
      console.warn("[diagnoseVin] reextract failed (non-fatal):", e);
    }
  }
  const price_type =
    verified != null ? "sale" : affirmativeReject ? UNVERIFIED_PRICE_TYPE : "llm_estimate";
  await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartPrice, {
    part_id: args.part_id,
    price: verified ?? args.price,
    price_type,
    source_url: args.source_url ?? undefined,
    source_domain: args.source_domain,
  });
  return price_type;
}

/**
 * QA helper — at-a-glance lock state for a VIN. Returns just enough to verify
 * the booking gate without parsing the full byVin output. The FE "Setting
 * up..." pill and the booking flow's parts-dependent service gating both key
 * off enrichment_status === "complete" — this query is the canonical readback.
 *
 *   npx convex run diagnoseVin:enrichmentLockState '{"vin":"..."}'
 *
 * locked_categories lists service categories that are blocked by the gate
 * (i.e. NOT labor-only). Returned by joining services where is_labor_only=false,
 * deduped by category. When status === "complete", locked_categories is empty.
 */
export const enrichmentLockState = query({
  args: { vin: v.string() },
  handler: async (ctx, { vin }): Promise<{
    status: "no_vehicle" | "no_config" | "ok";
    vin: string;
    enrichment_status?: string | null;
    fill_rate?: number | null;
    is_locked?: boolean;
    last_enriched_at?: number | null;
    config_id?: string | null;
    locked_service_count?: number;
    sample_locked_services?: string[];
  }> => {
    const normalized = vin.toUpperCase().trim();
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", q => q.eq("vin", normalized))
      .first();
    if (!vehicle) return { status: "no_vehicle" as const, vin: normalized };

    const configId = (vehicle as any).vehicle_config_id;
    if (!configId) {
      return {
        status: "no_config" as const,
        vin: normalized,
        is_locked: true, // No config attached → anything parts-dependent is gated
      };
    }

    const config = await ctx.db.get(configId);
    const cfg = config as any;
    const enrichmentStatus = cfg?.enrichment_status ?? null;
    const isLocked = enrichmentStatus !== "complete";

    // Sample of services that would be blocked under the gate (is_labor_only !== true).
    // Cheap because services is a small reference table — pulling the whole list.
    let lockedServiceCount = 0;
    let sampleLockedServices: string[] = [];
    if (isLocked) {
      const services = await ctx.db.query("services").take(100);
      const locked = services.filter(s => !(s as any).is_labor_only);
      lockedServiceCount = locked.length;
      sampleLockedServices = locked.slice(0, 10).map(s => (s as any).name ?? (s as any).slug ?? "?");
    }

    return {
      status: "ok" as const,
      vin: normalized,
      enrichment_status: enrichmentStatus,
      fill_rate: cfg?.fill_rate ?? null,
      is_locked: isLocked,
      last_enriched_at: cfg?.last_enriched_at ?? null,
      config_id: String(configId),
      locked_service_count: lockedServiceCount,
      sample_locked_services: sampleLockedServices,
    };
  },
});

export const byVin = query({
  args: { vin: v.string() },
  handler: async (ctx, { vin }) => {
    const normalized = vin.toUpperCase().trim();

    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", q => q.eq("vin", normalized))
      .first();

    if (!vehicle) return { status: "no_vehicle" as const, vin: normalized };

    const configId = (vehicle as any).vehicle_config_id;
    if (!configId) {
      return { status: "no_config" as const, vin: normalized, vehicleId: vehicle._id };
    }

    const config = await ctx.db.get(configId);
    if (!config) {
      return { status: "config_not_found" as const, vin: normalized, configId };
    }

    const [make, model] = await Promise.all([
      (config as any).make_id  ? ctx.db.get((config as any).make_id)  : Promise.resolve(null),
      (config as any).model_id ? ctx.db.get((config as any).model_id) : Promise.resolve(null),
    ]);

    const trimSpecs = await ctx.db
      .query("trim_specs")
      .withIndex("by_vehicle_config", q => q.eq("vehicle_config_id", configId))
      .first();

    const tireOptions: any[] = Array.isArray((trimSpecs as any)?.tire_options)
      ? (trimSpecs as any).tire_options
      : [];

    const packagesAvailable: any[] = Array.isArray((config as any).packages_available)
      ? (config as any).packages_available
      : [];

    return {
      status: "ok" as const,
      vin: normalized,
      configId: String(configId),
      configKey: (config as any).config_key ?? null,
      year: (config as any).year ?? null,
      make: (make as any)?.name ?? null,
      model: (model as any)?.name ?? null,
      trim: (config as any).trim_name ?? null,
      drivetrain: (config as any).drivetrain ?? null,
      chassis_code: (config as any).chassis_code ?? null,
      packages: {
        count: packagesAvailable.length,
        codes: packagesAvailable.map(p => p.code),
        m_sport_present: packagesAvailable.some(p => p.code === "m_sport"),
        m_sport_detail: packagesAvailable.find(p => p.code === "m_sport") ?? null,
        all: packagesAvailable.map(p => ({
          code: p.code,
          label: p.label,
          confidence: p.confidence,
          detected_from: p.detected_from,
          services_affected: p.services_affected,
        })),
      },
      tires: {
        single_fitment_front: (trimSpecs as any)?.tire_size_front ?? null,
        single_fitment_rear:  (trimSpecs as any)?.tire_size_rear ?? null,
        pressure_front_psi:   (trimSpecs as any)?.recommended_tire_pressure_front_psi ?? null,
        pressure_rear_psi:    (trimSpecs as any)?.recommended_tire_pressure_rear_psi ?? null,
        tire_options_count:   tireOptions.length,
        tire_options_source:  (trimSpecs as any)?.tire_options_source ?? null,
        tire_options:         tireOptions.map(t => ({
          size_front: t.size_front,
          size_rear: t.size_rear ?? null,
          is_oem_standard: t.is_oem_standard,
        })),
      },
    };
  },
});

/**
 * Headless surgical repair for a VIN whose enrichment ran before the halo-
 * variant fix. Two writes, no Claude calls, no full re-enrichment:
 *
 *   1. Re-fetch tire fitments via wheel-size.com. The scraper now consults
 *      lib/haloVariantRules.ts and promotes the model before querying, so an
 *      M3 stored as "3 Series" gets M3 fitments back. Writes tire_options +
 *      single-fitment fields to trim_specs.
 *
 *   2. Strip any redundant_when_halo packages (m_sport, amg_line, audi_s_line,
 *      etc.) from vehicle_configs.packages_available when the vehicle matches
 *      a halo rule with hardwareStandard=true. Stops quoting from upselling
 *      brake/rotor packages whose hardware is already baseline equipment.
 *
 * Everything else (engine specs, intervals, labor times, drivetrain, brake
 * fluid, filters) is driven off engine_id and stays correct as-is — those
 * fields don't change when the model label flips from "3 Series" to "M3"
 * since the engine code (S58) was already right.
 *
 *   npx convex run diagnoseVin:repairVin '{"vin":"WBS43AY0XNFM51260"}'
 */
export const repairVin = internalAction({
  args: { vin: v.string() },
  handler: async (ctx, { vin }): Promise<{
    status: "ok" | "no_vehicle" | "no_config" | "missing_labels" | "no_tire_data";
    vin: string;
    vehicle?: string;
    tires?: { count: number; oem_standard: number; source: string };
    packages_removed?: string[];
    packages_remaining?: string[];
  }> => {
    const normalized = vin.toUpperCase().trim();

    const vehicle = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getVehicleByVin,
      { vin: normalized },
    );
    if (!vehicle) return { status: "no_vehicle" as const, vin: normalized };

    const configId = (vehicle as any).vehicle_config_id;
    if (!configId) return { status: "no_config" as const, vin: normalized };

    const labels = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getVehicleLabels,
      { vehicleConfigId: configId },
    );
    if (!labels?.year || !labels?.make || !labels?.model) {
      return { status: "missing_labels" as const, vin: normalized };
    }

    const vehicleLabel = [labels.year, labels.make, labels.model, labels.trim].filter(Boolean).join(" ");

    // 1. Tire refresh. wheelSizeScraper internally calls findHaloVariant and
    //    promotes the model before querying — so we don't need to mess with
    //    the model string here; passing labels.model is enough.
    const { scrapeWheelSizeOptions } = await import("./vehicleEnrichment/utils/wheelSizeScraper");
    const wheelResult = await scrapeWheelSizeOptions(
      labels.year,
      labels.make,
      labels.model,
      labels.trim || undefined,
      labels.displacement_l,
    ).catch(() => null);

    if (!wheelResult || wheelResult.tireOptions.length === 0) {
      return { status: "no_tire_data" as const, vin: normalized, vehicle: vehicleLabel };
    }

    // Pick the OEM-standard fitment for the single-fitment legacy columns,
    // falling back to the first option if nothing is flagged OEM.
    const primary = wheelResult.tireOptions.find(t => t.is_oem_standard) ?? wheelResult.tireOptions[0];
    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertTrimSpecs, {
      vehicle_config_id: configId,
      tire_options: wheelResult.tireOptions,
      tire_options_source: wheelResult.sourceUrl,
      tire_size_front: primary.size_front,
      tire_size_rear: primary.size_rear ?? primary.size_front,
      recommended_tire_pressure_front_psi: primary.pressure_front_psi,
      recommended_tire_pressure_rear_psi: primary.pressure_rear_psi,
      is_staggered: !!primary.size_rear && primary.size_rear !== primary.size_front,
    } as any);

    // 2. Strip redundant_when_halo packages when this vehicle matches a halo rule.
    const { findHaloVariant } = await import("./lib/haloVariantRules");
    const { PACKAGE_RULES, TRIM_INFERENCE_RULES } = await import("./lib/packageRules");
    const halo = findHaloVariant(labels.make, labels.model, labels.trim ?? "");

    const config = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getVehicleConfigById, {
      vehicleConfigId: configId,
    });
    const packagesNow = config?.packages_available ?? [];

    const removed: string[] = [];
    let remaining = packagesNow;
    if (halo?.hardwareStandard && packagesNow.length > 0) {
      const redundantCodes = new Set(
        [...PACKAGE_RULES, ...TRIM_INFERENCE_RULES]
          .filter(r => r.redundant_when_halo)
          .map(r => r.code),
      );
      remaining = packagesNow.filter(p => {
        if (redundantCodes.has(p.code)) {
          removed.push(p.code);
          return false;
        }
        return true;
      });
      if (removed.length > 0) {
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.patchVehicleConfig, {
          vehicle_config_id: configId,
          packages_available: remaining,
        });
      }
    }

    return {
      status: "ok" as const,
      vin: normalized,
      vehicle: vehicleLabel,
      tires: {
        count: wheelResult.tireOptions.length,
        oem_standard: wheelResult.tireOptions.filter(t => t.is_oem_standard).length,
        source: wheelResult.sourceUrl,
      },
      packages_removed: removed,
      packages_remaining: remaining.map(p => p.code),
    };
  },
});

/**
 * Bug A backfill — re-price part_fitments for one VIN without re-running the
 * rest of enrichment. Uses the corrected per-unit pricing contract:
 *
 *   - Asks Claude (Sonnet, with web_search) for the PER-UNIT retail price of
 *     each OEM part number already attached to this vehicle_config.
 *   - Writes each returned price directly to part_prices via upsertPartPrice
 *     — NO division by fitments.length. (That's the same fix shipped in
 *     v3pipeline's pricing loop.)
 *   - Does not touch Batch 1 OEM-part discovery, intervals, labor times, or
 *     anything else. Cheap, focused, idempotent.
 *
 *   npx convex run diagnoseVin:repricePartsForVin '{"vin":"WBA13BK0XMCF98543"}'
 */
export const repricePartsForVin = internalAction({
  args: { vin: v.string() },
  handler: async (ctx, { vin }): Promise<{
    status: "ok" | "no_vehicle" | "no_config" | "missing_labels" | "no_fitments" | "no_anthropic_key" | "claude_failed";
    vin: string;
    vehicle?: string;
    parts_priced?: number;
    parts_skipped?: number;
    services_covered?: string[];
    error?: string;
  }> => {
    const normalized = vin.toUpperCase().trim();

    const vehicle = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getVehicleByVin,
      { vin: normalized },
    );
    if (!vehicle) return { status: "no_vehicle" as const, vin: normalized };

    const configId = (vehicle as any).vehicle_config_id;
    if (!configId) return { status: "no_config" as const, vin: normalized };

    const labels = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getVehicleLabels,
      { vehicleConfigId: configId },
    );
    if (!labels?.year || !labels?.make || !labels?.model) {
      return { status: "missing_labels" as const, vin: normalized };
    }
    const vehicleLabel = [labels.year, labels.make, labels.model, labels.trim].filter(Boolean).join(" ");

    // Pull the existing fitments grouped by service via the same query the
    // director panel uses, so the reprice scope exactly matches what the user sees.
    const fitmentsResult = await ctx.runQuery(api.directorCars.vehicleConfigFitments, {
      vehicle_config_id: configId,
    });
    if (!fitmentsResult || fitmentsResult.total === 0) {
      return { status: "no_fitments" as const, vin: normalized, vehicle: vehicleLabel };
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      return { status: "no_anthropic_key" as const, vin: normalized, vehicle: vehicleLabel };
    }

    // Build a compact, per-part input list. Deduplicate by part_number so we
    // never pay Claude twice for the same OEM SKU even when it appears under
    // multiple services (e.g. a filter shared between two slugs).
    type FitmentItemForPrompt = {
      partId: string;
      partNumber: string;
      partName: string | null;
      brand: string | null;
      services: string[];
    };
    const partMap = new Map<string, FitmentItemForPrompt>();
    for (const group of fitmentsResult.groups as Array<{ service: string; items: any[] }>) {
      for (const it of group.items) {
        if (!it.partNumber) continue;
        const existing = partMap.get(it.partNumber);
        if (existing) {
          if (!existing.services.includes(group.service)) existing.services.push(group.service);
        } else {
          partMap.set(it.partNumber, {
            partId:     String(it.partId),
            partNumber: it.partNumber,
            partName:   it.partName ?? null,
            brand:      it.brand ?? null,
            services:   [group.service],
          });
        }
      }
    }
    const partInputs = [...partMap.values()];
    if (partInputs.length === 0) {
      return { status: "no_fitments" as const, vin: normalized, vehicle: vehicleLabel };
    }

    // Focused per-unit pricing prompt. Same per-unit contract as the corrected
    // batch2Prompt — but trimmed down to JUST pricing, no gap-fill, no labor.
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: anthropicKey });

    const partsList = partInputs.map((p, i) =>
      `  ${i + 1}. ${p.partNumber} — ${p.partName ?? "(unnamed)"}${p.brand ? ` [${p.brand}]` : ""} · used for: ${p.services.join(", ")}`
    ).join("\n");

    const system = `You are a vehicle parts pricing specialist. Look up the current retail price for each OEM part number provided and return JSON.

CRITICAL RULES:
1. Return PER-UNIT prices, NEVER total cost. Examples:
   - Spark plug: a 4.4L V8 needs 8 plugs, but you return the price of ONE plug (~$15-25 OEM), not $200.
   - Brake pads: OEM pad sets are sold as one front-axle set OR one rear-axle set, so return the price of ONE set, not front+rear combined.
   - Oil filter / cabin filter / battery: one filter / one battery. Always per OEM part number.
2. price_low = best online/discount per-unit price found (e.g. fcpeuro.com, ecstuning.com, oempartsonline.com).
3. price_high = dealership or retail per-unit price (typically 20-40% higher).
4. Use 1-2 targeted web searches per part: "[part_number] OEM price". Do NOT do broad searches.
5. If you cannot find a price after 2 searches, omit that part from the response (do NOT guess).
6. Return VALID JSON only, no markdown fences, no preamble.`;

    const userPrompt = `Vehicle: ${vehicleLabel}

OEM parts to price (${partInputs.length}):
${partsList}

Return JSON in this exact shape:
{
  "prices": [
    {
      "part_number": "<verbatim OEM number from the input>",
      "price_low": <number — per-unit online/discount price>,
      "price_high": <number — per-unit retail/dealer price>,
      "source_url": "<url where you confirmed the price, or null>"
    },
    ...
  ]
}`;

    let parsed: { prices: Array<{ part_number: string; price_low: number; price_high: number; source_url?: string | null }> };
    try {
      const res = await client.messages.create({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 8000,
        temperature: 0,
        system,
        messages: [{ role: "user", content: userPrompt }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: Math.min(2 * partInputs.length, 30) }],
      });
      let raw = "";
      for (const block of res.content) {
        if (block.type === "text") raw += block.text;
      }
      raw = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
      parsed = JSON.parse(raw);
    } catch (e) {
      return {
        status: "claude_failed" as const,
        vin: normalized,
        vehicle: vehicleLabel,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    // Resolve part_number → part_id from our input map, then upsert prices.
    const partNumberToId = new Map<string, string>();
    for (const p of partInputs) partNumberToId.set(p.partNumber, p.partId);

    const servicesCovered = new Set<string>();
    let priced = 0;
    let skipped = 0;
    for (const item of parsed.prices ?? []) {
      const partId = partNumberToId.get(item.part_number);
      if (!partId) { skipped++; continue; }
      const priceLow = Number(item.price_low);
      if (!Number.isFinite(priceLow) || priceLow <= 0) { skipped++; continue; }

      const sourceUrl    = typeof item.source_url === "string" ? item.source_url : undefined;
      const sourceDomain = sourceUrl
        ? (sourceUrl.match(/^https?:\/\/([^/]+)/i)?.[1] ?? "reprice-action")
        : "reprice-action";

      const partInput0 = partInputs.find(p => p.partNumber === item.part_number);
      await writeVerifiedLlmPrice(ctx, {
        part_id:       partId as any,
        price:         priceLow,
        oem:           item.part_number ?? null,
        partName:      (partInput0 as any)?.name ?? null,
        source_url:    sourceUrl,
        source_domain: sourceDomain,
      });

      const partInput = partInputs.find(p => p.partNumber === item.part_number);
      if (partInput) for (const s of partInput.services) servicesCovered.add(s);
      priced++;
    }

    return {
      status: "ok" as const,
      vin: normalized,
      vehicle: vehicleLabel,
      parts_priced: priced,
      parts_skipped: skipped + (partInputs.length - (parsed.prices?.length ?? 0)),
      services_covered: [...servicesCovered].sort(),
    };
  },
});

/**
 * Bug B backfill — add an engine_oil_oem fitment (and price) to a VIN that
 * was enriched before engine_oil_oem existed in the schema. One Claude call,
 * one oem_parts upsert, one part_fitments upsert, one part_prices upsert.
 *
 * - Asks Claude for the make's per-unit bottle SKU + per-unit price (e.g. BMW
 *   TwinPower 5W-30 1qt SKU 83215A2AF99 at ~$13/qt).
 * - quantity_needed on the fitment is 1 (per-bottle) — quoting multiplies by
 *   engine_specs.oil_capacity_qts at quote time, mirroring how coolant_oem is
 *   sized via coolant_capacity_qts.
 * - Idempotent — if an oil fitment for this config already exists, returns
 *   `status: "already_present"` unless { force: true } is passed.
 *
 *   npx convex run diagnoseVin:backfillEngineOilForVin '{"vin":"WBA13BK0XMCF98543"}'
 *   npx convex run diagnoseVin:backfillEngineOilForVin '{"vin":"...", "force": true}'
 */
export const backfillEngineOilForVin = internalAction({
  args: { vin: v.string(), force: v.optional(v.boolean()) },
  handler: async (ctx, { vin, force }): Promise<{
    status: "ok" | "already_present" | "no_vehicle" | "no_config" | "missing_labels" | "no_anthropic_key" | "claude_failed" | "claude_unknown_sku" | "rejected_cross_make";
    vin: string;
    vehicle?: string;
    oem_part_number?: string;
    price_per_qt?: number;
    oil_capacity_qts?: number | null;
    source_url?: string | null;
    fitment_action?: "inserted" | "patched";
    error?: string;
  }> => {
    const normalized = vin.toUpperCase().trim();

    const vehicle = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getVehicleByVin,
      { vin: normalized },
    );
    if (!vehicle) return { status: "no_vehicle" as const, vin: normalized };

    const configId = (vehicle as any).vehicle_config_id;
    if (!configId) return { status: "no_config" as const, vin: normalized };

    const config = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getVehicleConfigById, {
      vehicleConfigId: configId,
    });
    if (!config) return { status: "no_config" as const, vin: normalized };

    const labels = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getVehicleLabels,
      { vehicleConfigId: configId },
    );
    if (!labels?.year || !labels?.make || !labels?.model) {
      return { status: "missing_labels" as const, vin: normalized };
    }
    const vehicleLabel = [labels.year, labels.make, labels.model, labels.trim].filter(Boolean).join(" ");

    // Bail if an engine_oil fitment is already present (subcategory=engine_oil
    // OR a part_fitment under oil_change whose part is in the "fluid/engine_oil"
    // shape). Cheap check via the existing fitments query.
    const fitmentsResult = await ctx.runQuery(api.directorCars.vehicleConfigFitments, {
      vehicle_config_id: configId,
    });
    const oilChangeGroup = (fitmentsResult?.groups as Array<{ service: string; items: any[] }> | undefined)
      ?.find(g => g.service === "oil_change");
    const existingOil = oilChangeGroup?.items.find(it => it.subcategory === "engine_oil");
    if (existingOil && !force) {
      return {
        status: "already_present" as const,
        vin: normalized,
        vehicle: vehicleLabel,
        oem_part_number: existingOil.partNumber ?? undefined,
      };
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      return { status: "no_anthropic_key" as const, vin: normalized, vehicle: vehicleLabel };
    }

    // Single focused Claude call — find the bottle SKU AND its per-unit price.
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: anthropicKey });

    const system = `You identify the OEM engine oil bottle SKU and per-quart retail price for a vehicle.

RULES:
1. Return the make's own-branded oil bottle SKU when one exists (BMW TwinPower, Toyota Genuine, Honda HG, Mercedes 229.x, Mazda Genuine, Hyundai/Kia Quartz, etc.). Fall back to the OEM-recommended third-party SKU (Mobil 1, Castrol Edge, Pentosin) only when no own-branded option exists.
2. Prefer the 1-QUART or 1-LITER BOTTLE SKU over a 5L/jug SKU. Quoting multiplies by the vehicle's oil_capacity_qts at quote time — per-bottle pricing is what we need.
3. price_per_qt MUST be per-unit (price of ONE quart/liter bottle), not total for a 5-quart change.
4. If you genuinely cannot find a manufacturer-specific oil SKU after 2 searches, return { "found": false } — do NOT guess.
5. Return VALID JSON only, no markdown fences, no preamble.`;

    const userPrompt = `Vehicle: ${vehicleLabel}

What is the OEM engine oil 1-quart (or 1-liter) bottle part number and per-bottle retail price?

Return JSON:
{
  "found": true | false,
  "oem_part_number": "<verbatim SKU>",
  "oil_grade": "<e.g. 5W-30 LL-04>",
  "container_size": "<e.g. 1 qt or 1 L>",
  "price_per_qt": <number — per-bottle retail USD>,
  "source_url": "<url where you confirmed the SKU + price>"
}`;

    let parsed: any;
    try {
      const res = await client.messages.create({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 1000,
        temperature: 0,
        system,
        messages: [{ role: "user", content: userPrompt }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
      });
      let raw = "";
      for (const block of res.content) {
        if (block.type === "text") raw += block.text;
      }
      raw = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
      parsed = JSON.parse(raw);
    } catch (e) {
      return {
        status: "claude_failed" as const,
        vin: normalized,
        vehicle: vehicleLabel,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    if (!parsed?.found || typeof parsed?.oem_part_number !== "string" || !parsed.oem_part_number.trim()) {
      return { status: "claude_unknown_sku" as const, vin: normalized, vehicle: vehicleLabel };
    }

    const oemPartNumber = String(parsed.oem_part_number).trim();
    const pricePerQt = Number(parsed.price_per_qt);
    const sourceUrl: string | undefined = typeof parsed.source_url === "string" && parsed.source_url ? parsed.source_url : undefined;
    const sourceDomain = sourceUrl
      ? (sourceUrl.match(/^https?:\/\/([^/]+)/i)?.[1] ?? "engine-oil-backfill")
      : "engine-oil-backfill";

    const makeId = (config as any).make_id;
    if (!makeId) {
      // Defensive — vehicle_configs should always have make_id, but guard anyway.
      return { status: "no_config" as const, vin: normalized, vehicle: vehicleLabel };
    }

    const { part_id: partId } = await ctx.runMutation(
      internal.vehicleEnrichment.v3mutations.upsertPartAndFitment,
      {
        oem_part_number:   oemPartNumber,
        name:              "Engine Oil",
        category:          "fluid",
        subcategory:       "engine_oil",
        make_id:           makeId,
        vehicle_config_id: configId,
        service_type:      "oil_change",
        quantity_needed:   1, // per-bottle; quoting multiplies by oil_capacity_qts at quote time
        confidence:        0.85,
        source_domain:     sourceDomain,
      },
    );

    if (!partId) {
      return {
        status: "rejected_cross_make" as const,
        vin: normalized,
        vehicle: vehicleLabel,
        oem_part_number: oemPartNumber,
      };
    }

    if (Number.isFinite(pricePerQt) && pricePerQt > 0) {
      await writeVerifiedLlmPrice(ctx, {
        part_id:       partId,
        price:         pricePerQt,
        oem:           oemPartNumber,
        partName:      "Engine Oil",
        source_url:    sourceUrl,
        source_domain: sourceDomain,
      });
    }

    return {
      status: "ok" as const,
      vin: normalized,
      vehicle: vehicleLabel,
      oem_part_number: oemPartNumber,
      price_per_qt: Number.isFinite(pricePerQt) ? pricePerQt : undefined,
      oil_capacity_qts: (config as any).oil_capacity_qts ?? null,
      source_url: sourceUrl ?? null,
      fitment_action: existingOil ? "patched" : "inserted",
    };
  },
});

// ─── Bulk engine_oil backfill ────────────────────────────────────────────────

type OilCandidate = {
  _id: Id<"vehicle_configs">;
  make_id: Id<"makes"> | null;
  make: string;
  model: string;
  trim: string;
  year: number | null;
  oil_viscosity: string | null;
  has_oil_fitment: boolean;
};

/**
 * Candidate list for the bulk oil backfill. Walks vehicle_configs newest-first,
 * resolves make/model/trim/engine names, and flags whether each config already
 * has a part_fitment whose service_type="oil_change" and underlying OEM part
 * has subcategory="engine_oil". The action calls this once per run, then
 * iterates the result in the action body so each Claude call lives outside
 * the query.
 *
 * makeFilter (optional, case-insensitive) restricts the walk to a single make
 * — useful for staged rollout / cost control.
 */
export const _listConfigsMissingEngineOil = internalQuery({
  args: {
    limit:        v.number(),
    skipExisting: v.boolean(),
    makeFilter:   v.optional(v.string()),
  },
  handler: async (ctx, { limit, skipExisting, makeFilter }): Promise<OilCandidate[]> => {
    const out: OilCandidate[] = [];
    const wantedMake = makeFilter?.toLowerCase() ?? null;
    // Walk newest-first — most recent configs are the ones a director is likely
    // to be looking at, so fill those first.
    const configs = await ctx.db.query("vehicle_configs").order("desc").take(2000);

    for (const c of configs) {
      const cfg = c as any;
      const [make, model, engine] = await Promise.all([
        cfg.make_id  ? ctx.db.get(cfg.make_id)  : Promise.resolve(null),
        cfg.model_id ? ctx.db.get(cfg.model_id) : Promise.resolve(null),
        cfg.engine_id ? ctx.db.get(cfg.engine_id) : Promise.resolve(null),
      ]);
      const makeName = (make as any)?.name ?? "";
      if (wantedMake && makeName.toLowerCase() !== wantedMake) continue;

      // Does an oil_change fitment with subcategory=engine_oil already exist?
      const oilFitments = await ctx.db
        .query("part_fitments")
        .withIndex("by_config_service", q =>
          q.eq("vehicle_config_id", c._id).eq("service_type", "oil_change"),
        )
        .collect();
      let hasOilFitment = false;
      for (const f of oilFitments) {
        const part = await ctx.db.get(f.part_id);
        if ((part as any)?.subcategory === "engine_oil") { hasOilFitment = true; break; }
      }

      if (skipExisting && hasOilFitment) continue;

      out.push({
        _id:             c._id,
        make_id:         cfg.make_id ?? null,
        make:            makeName,
        model:           (model as any)?.name ?? "",
        trim:            cfg.trim_name ?? "",
        year:            c.year ?? null,
        oil_viscosity:   (engine as any)?.oil_viscosity ?? null,
        has_oil_fitment: hasOilFitment,
      });

      if (out.length >= limit) break;
    }

    return out;
  },
});

type OilResolution = {
  oem_part_number: string;
  price_per_qt: number | null;
  source_url: string | null;
};

/**
 * Bulk engine_oil_oem backfill across all vehicle_configs. Same write path as
 * backfillEngineOilForVin but iterates candidates and de-duplicates Claude
 * calls by (make + oil_viscosity) tuple in an in-memory cache for the run.
 *
 *   npx convex run diagnoseVin:backfillAllEngineOilFitments '{}'
 *   npx convex run diagnoseVin:backfillAllEngineOilFitments '{"limit":50,"dryRun":true}'
 *   npx convex run diagnoseVin:backfillAllEngineOilFitments '{"limit":100,"makeFilter":"BMW"}'
 *
 * Args:
 *   - limit         default 25, hard cap 100 (one Claude call per cache miss; cap keeps the action under Convex's 10-min timeout).
 *   - skipExisting  default true. Set false to overwrite (re-fetch SKU + price).
 *   - dryRun        default false. Returns the candidate list without calling Claude / writing anything.
 *   - makeFilter    optional case-insensitive make name (e.g. "BMW") to scope the walk.
 *
 * The (make, viscosity) cache makes the common case cheap: every BMW that uses
 * 5W-30 LL-04 gets the same SKU + price after one Claude call. Same engine code
 * across many vehicle_configs → one Claude hit.
 */
export const backfillAllEngineOilFitments = internalAction({
  args: {
    limit:        v.optional(v.number()),
    skipExisting: v.optional(v.boolean()),
    dryRun:       v.optional(v.boolean()),
    makeFilter:   v.optional(v.string()),
  },
  handler: async (
    ctx,
    { limit = 25, skipExisting = true, dryRun = false, makeFilter },
  ): Promise<{
    requested: number;
    candidates: number;
    dryRun: boolean;
    cache_hits: number;
    claude_calls: number;
    summary: {
      inserted: number;
      patched: number;
      skipped_no_make_or_viscosity: number;
      claude_unknown_sku: number;
      errored: number;
    };
    results: Array<{
      configId: string;
      vehicle: string;
      status: "inserted" | "patched" | "skipped_no_make_or_viscosity" | "claude_unknown_sku" | "errored";
      oem_part_number?: string;
      price_per_qt?: number | null;
      cache_hit?: boolean;
      error?: string;
    }>;
  }> => {
    const max = Math.min(Math.max(1, limit), 100);

    const candidates = await ctx.runQuery(internal.diagnoseVin._listConfigsMissingEngineOil, {
      limit: max,
      skipExisting,
      makeFilter,
    });

    const summary = { inserted: 0, patched: 0, skipped_no_make_or_viscosity: 0, claude_unknown_sku: 0, errored: 0 };
    const results: Array<any> = [];

    if (dryRun) {
      return {
        requested: max,
        candidates: candidates.length,
        dryRun: true,
        cache_hits: 0,
        claude_calls: 0,
        summary,
        results: (candidates as OilCandidate[]).map((c: OilCandidate) => ({
          configId: String(c._id),
          vehicle: [c.year, c.make, c.model, c.trim].filter(Boolean).join(" "),
          status: c.has_oil_fitment ? "patched" as const : "inserted" as const,
        })),
      };
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      return {
        requested: max,
        candidates: candidates.length,
        dryRun: false,
        cache_hits: 0,
        claude_calls: 0,
        summary: { ...summary, errored: candidates.length },
        results: (candidates as OilCandidate[]).map((c: OilCandidate) => ({
          configId: String(c._id),
          vehicle: [c.year, c.make, c.model, c.trim].filter(Boolean).join(" "),
          status: "errored" as const,
          error: "ANTHROPIC_API_KEY not set",
        })),
      };
    }

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: anthropicKey });

    // (make_lower | viscosity_lower) → resolved OEM SKU + price. Assumes a make
    // uses the same factory-fill SKU across all engines of a given viscosity —
    // not perfect (BMW LL-04 vs LL-01 differ; some makes have multiple
    // factory-fill SKUs per viscosity) but close enough for backfill, and one
    // Claude call per tuple instead of per VIN saves a lot. Override per-VIN
    // with backfillEngineOilForVin if a config needs the precise SKU.
    const cache = new Map<string, OilResolution | null>();
    let claudeCalls = 0;
    let cacheHits = 0;

    const resolveOilSku = async (make: string, viscosity: string): Promise<OilResolution | null> => {
      const key = `${make.toLowerCase()}|${viscosity.toLowerCase()}`;
      if (cache.has(key)) { cacheHits++; return cache.get(key) ?? null; }

      const system = `You identify the OEM engine oil bottle SKU and per-quart retail price for a make + viscosity grade.

RULES:
1. Return the make's own-branded oil bottle SKU when one exists (BMW TwinPower, Toyota Genuine, Honda HG, Mercedes 229.x, Mazda Genuine, Hyundai/Kia Quartz, etc.). Fall back to the OEM-recommended third-party SKU (Mobil 1, Castrol Edge, Pentosin) only when no own-branded option exists.
2. Prefer the 1-QUART or 1-LITER BOTTLE SKU over a 5L/jug SKU. Quoting multiplies by oil_capacity_qts at quote time.
3. price_per_qt MUST be per-unit (price of ONE quart/liter bottle), not total for a full oil change.
4. If you cannot find a manufacturer-specific oil SKU after 2 searches, return { "found": false }.
5. Return VALID JSON only.`;

      const user = `Make: ${make}\nOil viscosity grade: ${viscosity}\n\nReturn JSON:\n{ "found": true|false, "oem_part_number": "<SKU>", "container_size": "<e.g. 1 qt>", "price_per_qt": <number>, "source_url": "<url>" }`;

      try {
        const res = await client.messages.create({
          model: "claude-sonnet-4-5-20250929",
          max_tokens: 800,
          temperature: 0,
          system,
          messages: [{ role: "user", content: user }],
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
        });
        claudeCalls++;

        let raw = "";
        for (const block of res.content) if (block.type === "text") raw += block.text;
        raw = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
        const parsed = JSON.parse(raw);

        if (!parsed?.found || typeof parsed?.oem_part_number !== "string" || !parsed.oem_part_number.trim()) {
          cache.set(key, null);
          return null;
        }
        const sourceUrl = typeof parsed.source_url === "string" && parsed.source_url ? parsed.source_url : null;
        const price = Number(parsed.price_per_qt);
        const resolved: OilResolution = {
          oem_part_number: String(parsed.oem_part_number).trim(),
          price_per_qt:    Number.isFinite(price) && price > 0 ? price : null,
          source_url:      sourceUrl,
        };
        cache.set(key, resolved);
        return resolved;
      } catch (e) {
        // Don't cache failures — next call for the same tuple gets a fresh shot.
        console.warn(`[oil-backfill] Claude failed for ${make}|${viscosity}: ${e}`);
        return null;
      }
    };

    for (const c of candidates) {
      const vehicleLabel = [c.year, c.make, c.model, c.trim].filter(Boolean).join(" ");
      const baseResult = { configId: String(c._id), vehicle: vehicleLabel };

      if (!c.make_id || !c.make || !c.oil_viscosity) {
        results.push({ ...baseResult, status: "skipped_no_make_or_viscosity" as const });
        summary.skipped_no_make_or_viscosity++;
        continue;
      }

      const cacheKey = `${c.make.toLowerCase()}|${c.oil_viscosity.toLowerCase()}`;
      const wasCached = cache.has(cacheKey);
      const resolved = await resolveOilSku(c.make, c.oil_viscosity);

      if (!resolved) {
        results.push({ ...baseResult, status: "claude_unknown_sku" as const, cache_hit: wasCached });
        summary.claude_unknown_sku++;
        continue;
      }

      try {
        const sourceDomain = resolved.source_url
          ? (resolved.source_url.match(/^https?:\/\/([^/]+)/i)?.[1] ?? "oil-backfill")
          : "oil-backfill";
        const { part_id: partId } = await ctx.runMutation(
          internal.vehicleEnrichment.v3mutations.upsertPartAndFitment,
          {
            oem_part_number:   resolved.oem_part_number,
            name:              "Engine Oil",
            category:          "fluid",
            subcategory:       "engine_oil",
            make_id:           c.make_id,
            vehicle_config_id: c._id,
            service_type:      "oil_change",
            quantity_needed:   1,
            confidence:        0.85,
            source_domain:     sourceDomain,
          },
        );
        if (!partId) {
          results.push({
            ...baseResult,
            status: "rejected_cross_make" as const,
            oem_part_number: resolved.oem_part_number,
            cache_hit: wasCached,
          });
          continue;
        }
        if (resolved.price_per_qt != null) {
          await writeVerifiedLlmPrice(ctx, {
            part_id:       partId,
            price:         resolved.price_per_qt,
            oem:           resolved.oem_part_number,
            partName:      "Engine Oil",
            source_url:    resolved.source_url ?? undefined,
            source_domain: sourceDomain,
          });
        }
        const status = c.has_oil_fitment ? "patched" as const : "inserted" as const;
        results.push({
          ...baseResult,
          status,
          oem_part_number: resolved.oem_part_number,
          price_per_qt:    resolved.price_per_qt,
          cache_hit:       wasCached,
        });
        if (status === "inserted") summary.inserted++; else summary.patched++;
      } catch (e) {
        results.push({
          ...baseResult,
          status: "errored" as const,
          error: e instanceof Error ? e.message : String(e),
          cache_hit: wasCached,
        });
        summary.errored++;
      }
    }

    return {
      requested:   max,
      candidates:  candidates.length,
      dryRun:      false,
      cache_hits:  cacheHits,
      claude_calls: claudeCalls,
      summary,
      results,
    };
  },
});

// ─── Bulk part-price backfill / reprice ──────────────────────────────────────

type PartPriceCandidate = {
  part_id: Id<"oem_parts">;
  oem_part_number: string;
  name: string;
  category: string | null;
  subcategory: string | null;
  has_price: boolean;
  // One sample fitment used to anchor Claude's per-unit price prompt.
  sample_vehicle: string | null;
  fitment_count: number;
  make: string | null;
};

/**
 * Candidate list for the bulk part-price backfill. Walks oem_parts and, for
 * each, counts existing part_prices and pulls a sample vehicle (from any
 * part_fitment) so Claude has a year/make/model/trim to anchor pricing on.
 * makeFilter scopes to a single make via the sample fitment's vehicle_config.
 */
export const _listPartsMissingPrices = internalQuery({
  args: {
    limit:        v.number(),
    skipExisting: v.boolean(),
    makeFilter:   v.optional(v.string()),
  },
  handler: async (ctx, { limit, skipExisting, makeFilter }): Promise<PartPriceCandidate[]> => {
    const out: PartPriceCandidate[] = [];
    const wantedMake = makeFilter?.toLowerCase() ?? null;
    // Walk oem_parts newest-first. 4000 cap is generous — pricing typically
    // hits this cap only for the very first bulk run.
    const parts = await ctx.db.query("oem_parts").order("desc").take(4000);

    for (const p of parts) {
      const fitments = await ctx.db
        .query("part_fitments")
        .withIndex("by_part", q => q.eq("part_id", p._id))
        .collect();
      if (fitments.length === 0) continue; // Orphan parts — no vehicle context, skip.

      const prices = await ctx.db
        .query("part_prices")
        .withIndex("by_part", q => q.eq("part_id", p._id))
        .collect();
      // A non-pooled fallback row (estimator_endpoint) is NOT a real SKU price,
      // so it must not make skipExisting skip real LLM pricing for the part.
      const hasPrice = prices.some((r) => !isNonPooledPriceType((r as any).price_type));
      if (skipExisting && hasPrice) continue;

      // Sample vehicle from the most recent fitment for Claude context.
      let sampleVehicle: string | null = null;
      let makeName: string | null = null;
      const sampleFitment = fitments[0]; // any fitment is fine
      const cfg = sampleFitment ? await ctx.db.get(sampleFitment.vehicle_config_id) : null;
      if (cfg) {
        const c = cfg as any;
        const [make, model] = await Promise.all([
          c.make_id  ? ctx.db.get(c.make_id)  : Promise.resolve(null),
          c.model_id ? ctx.db.get(c.model_id) : Promise.resolve(null),
        ]);
        makeName = (make as any)?.name ?? null;
        if (wantedMake && (makeName ?? "").toLowerCase() !== wantedMake) continue;
        sampleVehicle = [c.year, makeName, (model as any)?.name, c.trim_name].filter(Boolean).join(" ");
      } else if (wantedMake) {
        continue;
      }

      out.push({
        part_id:         p._id,
        oem_part_number: (p as any).oem_part_number ?? "",
        name:            (p as any).name ?? "",
        category:        (p as any).category ?? null,
        subcategory:     (p as any).subcategory ?? null,
        has_price:       hasPrice,
        sample_vehicle:  sampleVehicle,
        fitment_count:   fitments.length,
        make:            makeName,
      });

      if (out.length >= limit) break;
    }

    return out;
  },
});

/**
 * Bulk part-price backfill / reprice. One Claude call per unique OEM SKU,
 * writes the resulting per-unit price to part_prices. Same per-unit contract
 * as repricePartsForVin and the corrected Batch 2 prompt.
 *
 *   # Default: backfill — only price parts with zero existing prices, 50 SKUs:
 *   npx convex run diagnoseVin:backfillAllPartPrices '{}'
 *
 *   # Dry-run first:
 *   npx convex run diagnoseVin:backfillAllPartPrices '{"limit":100,"dryRun":true}'
 *
 *   # Full reprice (rewrite existing prices too):
 *   npx convex run diagnoseVin:backfillAllPartPrices '{"limit":100,"skipExisting":false}'
 *
 *   # Scope to one make:
 *   npx convex run diagnoseVin:backfillAllPartPrices '{"limit":200,"makeFilter":"BMW"}'
 *
 * Args:
 *   - limit         default 50, hard cap 200 (unique OEM SKUs per run; each is one Claude call).
 *   - skipExisting  default true. Set false to overwrite existing prices.
 *   - dryRun        default false. Lists candidate SKUs without calling Claude / writing.
 *   - makeFilter    optional case-insensitive make name to scope the walk.
 *
 * Returns per-candidate status. A part can land in any of:
 *   - `priced`           — Claude returned a price, we wrote it.
 *   - `claude_unknown`   — Claude couldn't find a price after 2 searches (e.g. dealer-gated BMW SKU).
 *   - `errored`          — Claude API or mutation failed for that part.
 *   - `dry_run`          — dryRun=true.
 */
export const backfillAllPartPrices = internalAction({
  args: {
    limit:        v.optional(v.number()),
    skipExisting: v.optional(v.boolean()),
    dryRun:       v.optional(v.boolean()),
    makeFilter:   v.optional(v.string()),
  },
  handler: async (
    ctx,
    { limit = 50, skipExisting = true, dryRun = false, makeFilter },
  ): Promise<{
    requested: number;
    candidates: number;
    dryRun: boolean;
    claude_calls: number;
    summary: { priced: number; claude_unknown: number; errored: number };
    results: Array<{
      partId: string;
      oem_part_number: string;
      name: string;
      sample_vehicle: string | null;
      status: "priced" | "claude_unknown" | "errored" | "dry_run";
      price?: number;
      source_url?: string | null;
      had_price?: boolean;
      error?: string;
    }>;
  }> => {
    const max = Math.min(Math.max(1, limit), 200);

    const candidates = await ctx.runQuery(internal.diagnoseVin._listPartsMissingPrices, {
      limit: max,
      skipExisting,
      makeFilter,
    });

    const summary = { priced: 0, claude_unknown: 0, errored: 0 };
    const results: Array<any> = [];

    if (dryRun) {
      return {
        requested: max,
        candidates: candidates.length,
        dryRun: true,
        claude_calls: 0,
        summary,
        results: (candidates as PartPriceCandidate[]).map((c: PartPriceCandidate) => ({
          partId: String(c.part_id),
          oem_part_number: c.oem_part_number,
          name: c.name,
          sample_vehicle: c.sample_vehicle,
          status: "dry_run" as const,
          had_price: c.has_price,
        })),
      };
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      return {
        requested: max,
        candidates: candidates.length,
        dryRun: false,
        claude_calls: 0,
        summary: { ...summary, errored: candidates.length },
        results: (candidates as PartPriceCandidate[]).map((c: PartPriceCandidate) => ({
          partId: String(c.part_id),
          oem_part_number: c.oem_part_number,
          name: c.name,
          sample_vehicle: c.sample_vehicle,
          status: "errored" as const,
          error: "ANTHROPIC_API_KEY not set",
        })),
      };
    }

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: anthropicKey });

    const system = `You look up the current per-unit retail price for a single OEM auto part.

RULES:
1. price is ALWAYS per-unit (one OEM part), never total for a service. Examples:
   - One spark plug, not a set of 8.
   - One brake pad SET (front-axle set OR rear-axle set, since OEM pads are sold per-axle), not front+rear combined.
   - One oil filter, one cabin filter, one battery.
2. Prefer best online/discount price (fcpeuro.com, ecstuning.com, oempartsonline.com, hondapartsnow.com, etc.).
3. Use 1-2 targeted web searches: "<part_number> OEM price". No broad searches.
4. If no price after 2 searches, return { "found": false } — never guess.
5. VALID JSON only. No markdown fences.`;

    let claudeCalls = 0;

    for (const c of candidates as PartPriceCandidate[]) {
      const baseResult = {
        partId: String(c.part_id),
        oem_part_number: c.oem_part_number,
        name: c.name,
        sample_vehicle: c.sample_vehicle,
      };

      if (!c.oem_part_number) {
        results.push({ ...baseResult, status: "errored" as const, error: "no_oem_part_number" });
        summary.errored++;
        continue;
      }

      const userPrompt = `Vehicle context: ${c.sample_vehicle ?? "(unknown)"}
OEM part number: ${c.oem_part_number}
Part name: ${c.name}${c.subcategory ? ` (subcategory: ${c.subcategory})` : ""}

Return JSON:
{
  "found": true|false,
  "price": <per-unit retail USD>,
  "source_url": "<url>"
}`;

      let resolvedPrice: number | null = null;
      let resolvedSourceUrl: string | null = null;
      try {
        const res = await client.messages.create({
          model: "claude-sonnet-4-5-20250929",
          max_tokens: 600,
          temperature: 0,
          system,
          messages: [{ role: "user", content: userPrompt }],
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
        });
        claudeCalls++;

        let raw = "";
        for (const block of res.content) if (block.type === "text") raw += block.text;
        raw = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
        const parsed = JSON.parse(raw);

        if (parsed?.found) {
          const price = Number(parsed.price);
          if (Number.isFinite(price) && price > 0) {
            resolvedPrice = price;
            resolvedSourceUrl = typeof parsed.source_url === "string" && parsed.source_url ? parsed.source_url : null;
          }
        }
      } catch (e) {
        results.push({ ...baseResult, status: "errored" as const, error: e instanceof Error ? e.message : String(e), had_price: c.has_price });
        summary.errored++;
        continue;
      }

      if (resolvedPrice == null) {
        results.push({ ...baseResult, status: "claude_unknown" as const, had_price: c.has_price });
        summary.claude_unknown++;
        continue;
      }

      try {
        const sourceDomain = resolvedSourceUrl
          ? (resolvedSourceUrl.match(/^https?:\/\/([^/]+)/i)?.[1] ?? "price-backfill")
          : "price-backfill";
        await writeVerifiedLlmPrice(ctx, {
          part_id:       c.part_id,
          price:         resolvedPrice,
          oem:           c.oem_part_number,
          partName:      c.name,
          source_url:    resolvedSourceUrl ?? undefined,
          source_domain: sourceDomain,
        });
        results.push({
          ...baseResult,
          status: "priced" as const,
          price: resolvedPrice,
          source_url: resolvedSourceUrl,
          had_price: c.has_price,
        });
        summary.priced++;
      } catch (e) {
        results.push({ ...baseResult, status: "errored" as const, error: e instanceof Error ? e.message : String(e), had_price: c.has_price });
        summary.errored++;
      }
    }

    return {
      requested:    max,
      candidates:   candidates.length,
      dryRun:       false,
      claude_calls: claudeCalls,
      summary,
      results,
    };
  },
});
