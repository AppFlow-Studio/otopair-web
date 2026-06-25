import { describe, it, expect } from "vitest";
import {
  STABLE_PROMPT_SECTION,
  STABLE_PROMPT_VERSION,
  SYSTEM_PROMPT_COMPOSITE_VERSION,
} from "../convex/oto/prompt";

// =============================================================================
// Prompt guard — "# Recent context" section
// =============================================================================
//
// Defense-in-depth pair to the getCrossConversationMemory read filter. Even
// when legitimate prior-conversation facts are present, Oto must never (a)
// attribute a <recent_context> bullet to the current user ("you mentioned…"),
// (b) let a stale memory override a live tool result, or (c) invent a "let me
// pull up the record" reconciliation. These are structural assertions on the
// prompt string — they guard the section's presence, placement, and the
// version bump it requires.
// =============================================================================

describe("stable prompt — # Recent context section", () => {
  it("contains the recent-context guard with the no-attribution rule", () => {
    expect(STABLE_PROMPT_SECTION).toContain("# Recent context");
    expect(STABLE_PROMPT_SECTION).toContain("<recent_context>");
    expect(STABLE_PROMPT_SECTION).toContain("Never attribute");
  });

  it("places the section between the untrusted-input boundary and the scope section", () => {
    const iUntrusted = STABLE_PROMPT_SECTION.indexOf("# Untrusted user input");
    const iRecent = STABLE_PROMPT_SECTION.indexOf("# Recent context");
    const iScope = STABLE_PROMPT_SECTION.indexOf("# Scope — Operational vs Mechanical");
    expect(iUntrusted).toBeGreaterThanOrEqual(0);
    expect(iRecent).toBeGreaterThan(iUntrusted);
    expect(iScope).toBeGreaterThan(iRecent);
  });

  it("bumps the stable + composite prompt versions", () => {
    expect(STABLE_PROMPT_VERSION).toBe("v0.33-stable");
    expect(SYSTEM_PROMPT_COMPOSITE_VERSION.startsWith("v0.33-stable+")).toBe(true);
  });
});
