/**
 * vehicleEnrichment/partialEnrichment.ts — Task 25: Targeted Gap Fill
 *
 * Instead of re-running the full pipeline, this action:
 *   1. Diagnoses which fields are missing from a vehicle config
 *   2. Builds a focused prompt asking ONLY about those gaps
 *   3. Calls Sonnet with web search to fill them
 *   4. Writes results using existing upsert mutations (never overwrites)
 *
 * Use case: A GLE 63 S at 70% fill — instead of a full 10-minute enrichment,
 * a 30-second targeted call fills the specific missing fields.
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import Anthropic from "@anthropic-ai/sdk";
import { MODEL_HAIKU } from "./utils/batchClient";

const PARTIAL_SYSTEM = `You are a vehicle data specialist. You will be given a vehicle and a list of SPECIFIC missing fields.
Research ONLY the missing fields — do not provide data for fields already filled.

Return ONLY valid JSON matching the requested schema. No explanation, no markdown, just JSON.
If you cannot find a value, use null. Never guess — use null if uncertain.`;

export const partialEnrich = internalAction({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
  },
  handler: async (ctx, args): Promise<any> => {
    // 1. Diagnose gaps
    const gaps = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.diagnoseFillGaps,
      { vehicle_config_id: args.vehicle_config_id },
    );

    if (!gaps) {
      console.log("[partial] Config not found");
      return { status: "error", reason: "config_not_found" };
    }

    if (gaps.summary.total_gaps === 0) {
      console.log(`[partial] ${gaps.vehicle} — no gaps to fill`);
      return { status: "no_gaps", vehicle: gaps.vehicle };
    }

    console.log(
      `[partial] ${gaps.vehicle} — ${gaps.summary.total_gaps} gaps in: ${gaps.summary.categories_with_gaps.join(", ")}`
    );

    // 2. Get vehicle identity for prompting
    const config = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getVehicleConfigById,
      { vehicleConfigId: args.vehicle_config_id },
    );
    if (!config) return { status: "error", reason: "config_not_found" };

    const engine = config.engine_id
      ? await ctx.runQuery(internal.vehicleEnrichment.v3queries.getEngine, { engineId: config.engine_id })
      : null;

    const vehicleStr = `${config.year} ${config.trim_name ?? ""} (engine: ${(engine as any)?.engine_code ?? "unknown"}, ${(engine as any)?.displacement_l ?? "?"}L, ${config.drivetrain ?? "?"})`;

    // 3. Build targeted prompt
    const requestedFields: Record<string, string> = {};

    if (gaps.gaps.engine.length > 0) {
      for (const f of gaps.gaps.engine) {
        requestedFields[f] = `Engine: ${f.replace(/_/g, " ")}`;
      }
    }
    if (gaps.gaps.trim.length > 0) {
      for (const f of gaps.gaps.trim) {
        requestedFields[f] = `Trim/Specs: ${f.replace(/_/g, " ")}`;
      }
    }
    if (gaps.gaps.config.length > 0) {
      for (const f of gaps.gaps.config) {
        requestedFields[f] = `Config: ${f.replace(/_/g, " ")}`;
      }
    }

    const fieldList = Object.entries(requestedFields)
      .map(([key, desc]) => `  "${key}": ${desc}`)
      .join("\n");

    const userPrompt = `Vehicle: ${vehicleStr}

I need the following missing fields filled. Search the web to find accurate values.

Missing fields:
${fieldList}

Return JSON with these exact keys. Use null for any value you cannot confirm.
Example: { "oil_viscosity": "0W-40", "battery_group": "H8", ... }`;

    // 4. Call Sonnet with web search
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { status: "error", reason: "no_api_key" };

    const client = new Anthropic({ apiKey });

    try {
      const message = await client.messages.create({
        model: MODEL_HAIKU,
        max_tokens: 4096,
        temperature: 0,
        system: PARTIAL_SYSTEM,
        messages: [{ role: "user", content: userPrompt }],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 5,
          } as any,
        ],
      });

      // Extract text from response
      let rawText = "";
      for (const block of message.content ?? []) {
        if (block.type === "text") rawText += block.text;
      }

      const tokensIn = (message as any).usage?.input_tokens ?? 0;
      const tokensOut = (message as any).usage?.output_tokens ?? 0;

      console.log(`[partial] Response: ${tokensIn} in / ${tokensOut} out`);
      console.log(`[partial] Raw: ${rawText.substring(0, 200)}`);

      // 5. Parse JSON
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn("[partial] Could not extract JSON from response");
        return { status: "error", reason: "no_json_in_response" };
      }

      let parsed: Record<string, any>;
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        console.warn("[partial] Invalid JSON in response");
        return { status: "error", reason: "invalid_json" };
      }

      // 6. Write results — engine fields
      let filled = 0;
      const engineUpdates: Record<string, any> = {};
      for (const f of gaps.gaps.engine) {
        if (parsed[f] != null) {
          engineUpdates[f] = parsed[f];
          filled++;
        }
      }
      if (Object.keys(engineUpdates).length > 0 && config.engine_id) {
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.patchEngine, {
          engine_id: config.engine_id,
          ...engineUpdates,
        });
        console.log(`[partial] Patched engine: ${Object.keys(engineUpdates).join(", ")}`);
      }

      // Trim spec fields
      const trimUpdates: Record<string, any> = {};
      const trimFieldMap: Record<string, string> = {
        front_tire_size: "front_tire_size",
        rear_tire_size: "rear_tire_size",
        tire_pressure_front: "recommended_tire_pressure_front_psi",
        tire_pressure_rear: "recommended_tire_pressure_rear_psi",
        lug_nut_torque: "lug_nut_torque_ft_lbs",
        battery_group: "battery_group",
        battery_cca: "battery_cca",
        battery_type: "battery_type",
        battery_location: "battery_location",
      };
      for (const f of gaps.gaps.trim) {
        const dbField = trimFieldMap[f] ?? f;
        if (parsed[f] != null) {
          trimUpdates[dbField] = parsed[f];
          filled++;
        }
      }
      if (Object.keys(trimUpdates).length > 0) {
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.patchTrimSpecs, {
          vehicle_config_id: args.vehicle_config_id,
          ...trimUpdates,
        });
        console.log(`[partial] Patched trim: ${Object.keys(trimUpdates).join(", ")}`);
      }

      // Config-level fields
      const configUpdates: Record<string, any> = {};
      for (const f of gaps.gaps.config) {
        if (parsed[f] != null) {
          configUpdates[f] = parsed[f];
          filled++;
        }
      }
      if (Object.keys(configUpdates).length > 0) {
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.patchVehicleConfig, {
          vehicle_config_id: args.vehicle_config_id,
          ...configUpdates,
        });
        console.log(`[partial] Patched config: ${Object.keys(configUpdates).join(", ")}`);
      }

      console.log(`[partial] Done: filled ${filled}/${gaps.summary.total_gaps} gaps for ${gaps.vehicle}`);

      return {
        status: "ok",
        vehicle: gaps.vehicle,
        gaps_found: gaps.summary.total_gaps,
        gaps_filled: filled,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
      };
    } catch (e: any) {
      console.error("[partial] API call failed:", e);
      return { status: "error", reason: e.message };
    }
  },
});
