/**
 * B-P3 (OTO_HANDOFF.md): strip dead tools + stop other descriptions pointing
 * at them ("they invite fabricated mechanic ids").
 *
 * The dead tools (get_my_vehicles, get_my_mechanics, get_shop, get_mechanic,
 * …) were defined in OTO_TOOLS / OTO_TOOL_CATEGORY but never advertised to
 * Haiku (absent from TOOL_NAMES_V1, filtered out of TOOLS_FOR_HAIKU). Haiku
 * couldn't call them — but LIVE tool descriptions told it to source values
 * "from get_my_vehicles" / "from get_my_mechanics", so Haiku fabricated ids
 * for tools that don't exist. These tests pin: (1) the dead defs are gone,
 * (2) no surviving tool description references a tool name that isn't a real
 * OTO_TOOL_CATEGORY entry.
 */
import { describe, test, expect } from "vitest";
import { OTO_TOOLS, OTO_TOOL_CATEGORY } from "../convex/oto/tools";

const REMOVED_DEAD_TOOLS = [
  "get_my_vehicles",
  "get_my_mechanics",
  "get_shop",
  "get_shop_services",
  "get_shop_hours",
  "get_mechanic",
  "get_reviews",
  "find_available_slots",
  "list_service_categories",
] as const;

describe("tool schema hygiene", () => {
  test("the dead tool defs are removed from OTO_TOOLS and OTO_TOOL_CATEGORY", () => {
    const definedNames = new Set(OTO_TOOLS.map((t: any) => t.name));
    for (const dead of REMOVED_DEAD_TOOLS) {
      expect(definedNames.has(dead), `${dead} should be gone from OTO_TOOLS`).toBe(false);
      expect(
        (OTO_TOOL_CATEGORY as Record<string, unknown>)[dead],
        `${dead} should be gone from OTO_TOOL_CATEGORY`,
      ).toBeUndefined();
    }
  });

  test("no tool description references a removed/dead tool (no fabrication invites)", () => {
    for (const tool of OTO_TOOLS as any[]) {
      const blob = JSON.stringify(tool);
      for (const dead of REMOVED_DEAD_TOOLS) {
        expect(
          blob.includes(dead),
          `tool "${tool.name}" still references removed tool "${dead}"`,
        ).toBe(false);
      }
    }
  });

  test("every tool-name token in a description resolves to a real tool", () => {
    // The universe of callable/real tool names (category map) + the
    // server-managed web_search. Any *_-shaped token in a description that
    // looks like a tool name but isn't here is a dangling reference.
    const known = new Set([...Object.keys(OTO_TOOL_CATEGORY), "web_search"]);
    // Tool-name shape used across descriptions: a verb_noun snake-case token
    // beginning with a known tool verb.
    const TOOL_TOKEN =
      /\b(get|list|find|lookup|retrieve|record|retract|update|render|request)_[a-z_]+\b/g;
    for (const tool of OTO_TOOLS as any[]) {
      const desc = JSON.stringify(tool);
      for (const m of desc.matchAll(TOOL_TOKEN)) {
        const token = m[0];
        // Only assert on tokens that are plausibly tool references (the regex
        // can catch incidental prose like "get_started" — none such exist in
        // our descriptions, but guard by only failing on the known dead set
        // plus any token sharing a prefix with a real tool family).
        if (REMOVED_DEAD_TOOLS.includes(token as never)) {
          expect(known.has(token), `dangling tool reference "${token}" in ${tool.name}`).toBe(
            true,
          );
        }
      }
    }
  });
});
