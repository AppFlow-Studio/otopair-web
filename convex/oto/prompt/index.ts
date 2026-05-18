// =============================================================================
// Oto AI — Composite System Prompt (Wave 4 split)
// =============================================================================
//
// This module composes the STABLE and VOLATILE halves of the Oto system prompt
// into a single string suitable for the Anthropic API call in convex/oto/chat.ts.
//
// Composition rule: STABLE_PROMPT_SECTION is concatenated DIRECTLY with
// VOLATILE_PROMPT_SECTION, in that order. No separator is inserted — the section
// boundary already contains the necessary CRLF whitespace from the original
// monolithic prompt (the volatile half opens with the blank line + `# Examples`
// header). This keeps the composed result byte-identical to the pre-split prompt
// at v0.9, which is a refactor invariant verified at write time.
//
// Versioning: SYSTEM_PROMPT_COMPOSITE_VERSION is derived from the two half
// versions. Any change to either half automatically changes the composite version
// (and therefore the cache key) — no manual bump of this file is required.
//
// Cache invalidation note: changing the STABLE half invalidates cache for every
// active user. Changing the VOLATILE half also invalidates cache, but is gated by
// the cheaper Wave 1.5 protocol cadence (5% canary, 48h).
// =============================================================================

import { STABLE_PROMPT_SECTION, STABLE_PROMPT_VERSION } from "./stable";
import { VOLATILE_PROMPT_SECTION, VOLATILE_PROMPT_VERSION } from "./volatile";

export { STABLE_PROMPT_SECTION, STABLE_PROMPT_VERSION } from "./stable";
export { VOLATILE_PROMPT_SECTION, VOLATILE_PROMPT_VERSION } from "./volatile";

export const SYSTEM_PROMPT: string =
  STABLE_PROMPT_SECTION + VOLATILE_PROMPT_SECTION;

export const SYSTEM_PROMPT_COMPOSITE_VERSION =
  `${STABLE_PROMPT_VERSION}+${VOLATILE_PROMPT_VERSION}` as const;
