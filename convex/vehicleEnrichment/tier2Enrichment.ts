/**
 * vehicleEnrichment/tier2Enrichment.ts — Tier 2: Open Web Multi-Source Enrichment
 *
 * After Tier 1 (Batch API) completes, Tier 2 searches the open web for
 * additional evidence on under-evidenced fields. Uses FireCrawl searchAndFetch
 * (no site: restriction) + Claude Haiku for extraction. No source_registry
 * dependency — searches the open web directly, just like Batch 1B.
 *
 * Cost: ~5 FireCrawl credits per query (search + scrape). With ~6 queries
 * per run = ~30 credits per Tier 2 run. Plus ~$0.01 in Haiku tokens.
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { searchAndFetch } from "./firecrawl";
import { extractFieldsFromMarkdown } from "./sourceDiscovery";
import { computeConsensus } from "../services/consensus";
import Anthropic from "@anthropic-ai/sdk";
import type { Doc } from "../_generated/dataModel";

// ── Haiku extraction ────────────────────────────────────────────

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const HAIKU_MAX_CONTENT = 8000;
const HAIKU_CONFIDENCE = 0.82;
const REGEX_CONFIDENCE = 0.70;

let _anthropic: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (!_anthropic) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

async function extractFieldsWithHaiku(
  markdown: string,
  fieldsNeeded: string[],
  year: number,
  make: string,
  model: string,
  trim: string,
): Promise<Record<string, string | number> | null> {
  const client = getAnthropicClient();
  const content = markdown.slice(0, HAIKU_MAX_CONTENT);

  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 2048,
    temperature: 0,
    system:
      "Extract vehicle data fields from the provided content. " +
      "Return ONLY a JSON object with field names as keys and extracted values. " +
      "If a field is not found in the content, omit it. Do not guess or infer.",
    messages: [
      {
        role: "user",
        content:
          `Vehicle: ${year} ${make} ${model} ${trim}\n\n` +
          `Fields needed: ${fieldsNeeded.join(", ")}\n\n` +
          `Content:\n${content}\n\n` +
          `Return JSON only. No explanation.`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") return null;

  let raw = textBlock.text.trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }

  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, string | number>;
}

// ── Constants ───────────────────────────────────────────────────

const ENRICHABLE_FIELDS = [
  "oil_filter_oem", "drain_plug_gasket_oem", "air_filter_oem", "cabin_filter_oem",
  "spark_plug_oem", "front_brake_pad_oem", "rear_brake_pad_oem",
  "rotor_front_oem", "rotor_rear_oem", "serpentine_belt_oem",
  "battery_oem", "coolant_oem", "wiper_blade_set_oem",
  "oil_viscosity", "front_tire_size", "rear_tire_size",
];

const MIN_EVIDENCE = 3;

function isGarbageValue(val: string): boolean {
  return (
    val === "undefined" ||
    val === "null" ||
    val === "NaN" ||
    val === "" ||
    val === "0" ||
    val.length < 2 ||
    val.length > 50
  );
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function classifySourceType(domain: string): string {
  if (domain.includes("partsdeal") || domain.includes("oemparts") ||
      domain.includes("realoem") || domain.includes("parts."))
    return "oem_catalog";
  if (domain.includes("fcpeuro") || domain.includes("ecstuning") ||
      domain.includes("rockauto") || domain.includes("autozone"))
    return "parts_retailer";
  if (domain.includes("bimmer") || domain.includes("forum") ||
      domain.includes("enthusiast"))
    return "enthusiast_forum";
  if (domain.includes("tirerack") || domain.includes("tiresize"))
    return "tire_retailer";
  return "web_search";
}

// ── Main action ─────────────────────────────────────────────────

export const runTier2Enrichment = internalAction({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
  },
  handler: async (ctx, args): Promise<any> => {
    console.log(`[tier2] Starting for vehicle_config ${args.vehicle_config_id}`);

    // 1. LOAD CONTEXT
    const vc = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getVehicleConfigById,
      { vehicleConfigId: args.vehicle_config_id },
    );
    if (!vc) {
      console.error("[tier2] Vehicle config not found");
      return { error: "not_found" };
    }

    const makeDoc = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getMakeById,
      { makeId: vc.make_id },
    );
    const makeName = makeDoc?.name ?? "Unknown";

    const modelDoc = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getModelById,
      { modelId: vc.model_id },
    );
    const modelName = modelDoc?.name ?? "Unknown";

    const engine = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getEngine,
      { engineId: vc.engine_id },
    );

    // 2. FIND FIELDS NEEDING MORE EVIDENCE
    const allExistingEvidence: Array<{ source_domain?: string; field_name: string }> = [];
    const fieldsNeedingEvidence: string[] = [];

    for (const field of ENRICHABLE_FIELDS) {
      const evidence = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getEvidenceForField,
        { entityId: String(args.vehicle_config_id), fieldName: field },
      );
      if (evidence.length < MIN_EVIDENCE) {
        fieldsNeedingEvidence.push(field);
      }
      for (const e of evidence) {
        allExistingEvidence.push({ source_domain: e.source_domain ?? undefined, field_name: e.field_name });
      }
    }

    console.log(`[tier2] ${fieldsNeedingEvidence.length}/${ENRICHABLE_FIELDS.length} fields need more evidence`);

    if (fieldsNeedingEvidence.length === 0) {
      console.log("[tier2] All fields well-covered — nothing to do");
      return { fieldsNeeding: 0, evidenceWritten: 0, totalEvidence: 0 };
    }

    // 3. GROUP FIELDS INTO SEARCH QUERIES
    const partsFields = fieldsNeedingEvidence.filter((f) => f.endsWith("_oem"));
    const fluidFields = fieldsNeedingEvidence.filter((f) =>
      f.includes("viscosity") || f.includes("coolant") ||
      f.includes("fluid") || f.includes("capacity"),
    );
    const specFields = fieldsNeedingEvidence.filter((f) =>
      f.includes("tire") || f.includes("battery") ||
      f.includes("lug") || f.includes("spark_plug") || f.includes("wiper"),
    );

    const vehicleDesc = `${vc.year} ${makeName} ${vc.trim_name}`;
    const queries: Array<{ query: string; fields: string[] }> = [];

    if (partsFields.length > 0) {
      queries.push({
        query: `${vehicleDesc} OEM oil filter part number`,
        fields: ["oil_filter_oem", "drain_plug_gasket_oem"],
      });
      queries.push({
        query: `${vehicleDesc} OEM brake pad rotor part number`,
        fields: ["front_brake_pad_oem", "rear_brake_pad_oem", "rotor_front_oem", "rotor_rear_oem"],
      });
      queries.push({
        query: `${vehicleDesc} OEM spark plug air filter cabin filter part number`,
        fields: ["spark_plug_oem", "air_filter_oem", "cabin_filter_oem"],
      });
      queries.push({
        query: `${vehicleDesc} OEM battery serpentine belt wiper part number`,
        fields: ["battery_oem", "serpentine_belt_oem", "wiper_blade_set_oem", "coolant_oem"],
      });
    }

    if (fluidFields.length > 0) {
      queries.push({
        query: `${vehicleDesc} ${engine?.engine_code ?? ""} oil type viscosity capacity specifications`,
        fields: fluidFields,
      });
    }

    if (specFields.length > 0) {
      queries.push({
        query: `${vehicleDesc} tire size pressure battery group CCA lug nut torque`,
        fields: specFields,
      });
    }

    // Only keep queries with fields that actually need evidence
    const activeQueries = queries.filter((q) =>
      q.fields.some((f) => fieldsNeedingEvidence.includes(f)),
    );

    console.log(`[tier2] ${activeQueries.length} queries planned`);

    // 4. LOAD BLOCKED DOMAINS
    const blockedDomainDocs = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getBlockedDomains,
      {},
    );
    const blockedSet = new Set(blockedDomainDocs.map((d: any) => d.domain));

    // 5. EXECUTE SEARCHES + HAIKU EXTRACTION
    const batchRows: Array<{
      entity_type: string;
      entity_id: string;
      field_name: string;
      observed_value: string;
      observed_type: string;
      source_url?: string;
      source_domain?: string;
      source_type: string;
      confidence: number;
      observed_at: number;
    }> = [];

    let totalQueriesRun = 0;
    let skippedGarbage = 0;

    for (const q of activeQueries) {
      totalQueriesRun++;
      try {
        const results = await searchAndFetch(q.query, 5);
        console.log(`[tier2] "${q.query.substring(0, 55)}..." → ${results.length} results`);

        for (const result of results) {
          if (!result.markdown || result.markdown.length < 200) continue;

          const domain = extractDomain(result.url);
          if (blockedSet.has(domain)) {
            console.log(`[tier2] Blocked domain ${domain}, skipping`);
            continue;
          }

          // Haiku extraction first, regex fallback
          let extracted: Record<string, string | number> | null = null;
          let confidence = HAIKU_CONFIDENCE;

          const targetFields = q.fields.filter((f) => fieldsNeedingEvidence.includes(f));

          try {
            extracted = await extractFieldsWithHaiku(
              result.markdown,
              targetFields,
              vc.year,
              makeName,
              modelName,
              vc.trim_name,
            );
            if (extracted && Object.keys(extracted).length > 0) {
              console.log(`[tier2] ${domain}: Haiku extracted ${Object.keys(extracted).length} fields`);
            }
          } catch (err) {
            console.log(`[tier2] Haiku failed for ${domain}, falling back to regex`);
          }

          if (!extracted || Object.keys(extracted).length === 0) {
            extracted = extractFieldsFromMarkdown(result.markdown, targetFields, makeName);
            confidence = REGEX_CONFIDENCE;
            if (Object.keys(extracted).length > 0) {
              console.log(`[tier2] ${domain}: regex fallback extracted ${Object.keys(extracted).length} fields`);
            }
          }

          for (const [fieldName, value] of Object.entries(extracted)) {
            if (!fieldsNeedingEvidence.includes(fieldName)) continue;

            const val = String(value);
            if (isGarbageValue(val)) {
              skippedGarbage++;
              continue;
            }

            // Dedup: skip if this domain+field already has evidence
            const exists = allExistingEvidence.some(
              (e) => e.source_domain === domain && e.field_name === fieldName,
            );
            if (exists) continue;

            batchRows.push({
              entity_type: fieldName.endsWith("_oem") ? "part" : "vehicle_config",
              entity_id: String(args.vehicle_config_id),
              field_name: fieldName,
              observed_value: val,
              observed_type: typeof value === "number" ? "number" : "string",
              source_url: result.url,
              source_domain: domain,
              source_type: classifySourceType(domain),
              confidence,
              observed_at: Date.now(),
            });

            allExistingEvidence.push({ source_domain: domain, field_name: fieldName });
          }
        }
      } catch (err) {
        console.log(`[tier2] Query failed: ${err}`);
      }
    }

    // 6. WRITE EVIDENCE
    let evidenceWritten = 0;
    if (batchRows.length > 0) {
      for (let i = 0; i < batchRows.length; i += 50) {
        const batch = batchRows.slice(i, i + 50);
        const count = await ctx.runMutation(
          internal.vehicleEnrichment.v3mutations.addEvidenceBatch,
          { evidence_rows: batch },
        );
        evidenceWritten += count;
      }
    }

    const uniqueSources = new Set(batchRows.map((r) => r.source_domain)).size;
    console.log(`[tier2] Wrote ${evidenceWritten} evidence rows from ${uniqueSources} sources`);

    if (skippedGarbage > 0) {
      console.log(`[tier2] Skipped ${skippedGarbage} garbage values`);
    }

    // 7. RUN CONSENSUS on fields with new evidence
    let consensusChanges = 0;
    if (evidenceWritten > 0) {
      console.log("[tier2] Running consensus on fields with new evidence...");
      const fieldsWithNewEvidence = new Set(batchRows.map((r) => r.field_name));

      for (const fieldName of fieldsWithNewEvidence) {
        const allFieldEvidence = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getEvidenceForField,
          { entityId: String(args.vehicle_config_id), fieldName },
        );

        if (allFieldEvidence.length < 2) continue;

        try {
          const result = computeConsensus(
            allFieldEvidence as Doc<"enrichment_evidence">[],
            makeName,
          );

          const tier1Evidence = allFieldEvidence
            .filter((e: any) => e.confidence >= 0.8)
            .sort((a: any, b: any) => b.confidence - a.confidence);
          const previousValue = tier1Evidence[0]?.observed_value;

          if (previousValue && result.value !== previousValue) {
            console.log(
              `[tier2] Consensus CHANGED for ${fieldName}: "${previousValue}" → "${result.value}" ` +
                `(conf=${result.confidence.toFixed(2)}, ${result.source_count} sources)`,
            );
            consensusChanges++;
          } else {
            console.log(
              `[tier2] Consensus CONFIRMED for ${fieldName}: "${result.value}" ` +
                `(conf=${result.confidence.toFixed(2)}, ${result.source_count} sources)`,
            );
          }
        } catch (e) {
          console.warn(`[tier2] Consensus failed for ${fieldName}: ${e}`);
        }
      }
    }

    // 8. SUMMARY
    const totalEvidence = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getEvidenceCount,
      { entityId: String(args.vehicle_config_id) },
    );

    const estimatedCredits = totalQueriesRun * 5;
    console.log(`[tier2] Queries: ${totalQueriesRun} | Evidence: +${evidenceWritten} (${totalEvidence} total) | Consensus changes: ${consensusChanges} | ~${estimatedCredits} credits`);

    return {
      fieldsNeeding: fieldsNeedingEvidence.length,
      queriesRun: totalQueriesRun,
      evidenceWritten,
      consensusChanges,
      totalEvidence,
      estimatedCredits,
    };
  },
});
