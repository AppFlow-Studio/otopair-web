/**
 * vehicleEnrichment/utils/roleBackfill.ts — re-extract parts for roles the
 * fitment verifier emptied (round 10, batch-11).
 *
 * A hard-deleted wrong part used to leave a permanent hole: the Cobalt
 * re-run rebuilt 1 of ~14 part roles and nothing refilled it; the Crosstrek
 * ended with 8 empty roles. This one focused Haiku web-search call asks for
 * the correct OEM number for THIS exact vehicle for just the killed roles.
 * Its answers flow through upsertPartAndFitment, so the refute blocklist
 * (mode "block") still rejects the very number that was just killed — the
 * backfill can only add a DIFFERENT number, never resurrect the refuted one.
 * Fail-open and never throws: on any failure the roles simply stay empty
 * (an honest gap, which was the previous behavior anyway).
 */

import Anthropic from "@anthropic-ai/sdk";
import { MODEL_HAIKU } from "./batchClient";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

export interface RoleBackfillResult {
  roleKey: string;
  oem: string;
  name: string;
  source_url: string | null;
}

const SYSTEM = `You are an automotive OEM parts researcher. You are given ONE exact vehicle and a short list of part roles whose previous part numbers were REJECTED as wrong-vehicle contamination. Search the web and find the CORRECT OEM part number for each role for THIS exact vehicle.

Rules:
- The part must be confirmed for this exact year + model + engine (and generation). A listing whose year range or engine excludes this vehicle is wrong.
- Prefer OEM/dealer parts-catalog sources (parts.<make>.com, dealer eStores) over aftermarket listings.
- If you cannot confirm a role's part for this exact vehicle within your search budget, OMIT that role — a missing answer is an honest gap; a guessed answer poisons a quote.
- Respond with ONLY a JSON array:
[{"role": "<roleKey as given>", "oem": "<OEM part number>", "name": "<part name>", "source_url": "<page that confirms fitment>"}]`;

export async function backfillKilledRoles(
  vehicle: {
    year: number;
    make: string;
    model: string;
    trim?: string | null;
    engineCode?: string | null;
    displacement?: string | null;
  },
  killedRoles: { roleKey: string; killedOem: string }[],
): Promise<RoleBackfillResult[]> {
  if (killedRoles.length === 0) return [];
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  const desc =
    `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? ` ${vehicle.trim}` : ""}` +
    (vehicle.engineCode ? `, engine ${vehicle.engineCode}` : "") +
    (vehicle.displacement ? ` ${vehicle.displacement}L` : "");
  const roleLines = killedRoles
    .map((r) => `- ${r.roleKey} (previous number ${r.killedOem} was refuted — do NOT return it)`)
    .join("\n");

  try {
    const resp = await getClient().messages.create({
      model: MODEL_HAIKU,
      max_tokens: 1500,
      temperature: 0,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Vehicle: ${desc}\n\nRoles to research:\n${roleLines}`,
        },
      ],
      tools: [
        {
          type: "web_search_20250305" as any,
          name: "web_search",
          max_uses: Math.min(2 * killedRoles.length, 8),
        } as any,
      ],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as any).text)
      .join("")
      .trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    const killedByRole = new Map(killedRoles.map((r) => [r.roleKey, r.killedOem.toUpperCase()]));
    return parsed
      .filter(
        (p: any) =>
          p &&
          typeof p.role === "string" &&
          typeof p.oem === "string" &&
          p.oem.trim().length >= 3 &&
          killedByRole.has(p.role) &&
          p.oem.trim().toUpperCase() !== killedByRole.get(p.role),
      )
      .map((p: any) => ({
        roleKey: p.role,
        oem: p.oem.trim(),
        name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : p.role,
        source_url: typeof p.source_url === "string" ? p.source_url : null,
      }));
  } catch (e) {
    console.warn("[role-backfill] failed (non-fatal):", e);
    return [];
  }
}
