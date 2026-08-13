// =============================================================================
// Oto AI — Cached System Prompt (Wave 4 shim, post-split)
// =============================================================================
//
// As of Wave 4 (Sprint 2), the system prompt body lives in ./prompt/stable.ts
// and ./prompt/volatile.ts, composed by ./prompt/index.ts. This file is now a
// thin shim that re-exports `SYSTEM_PROMPT` so existing imports (chat.ts,etc.)
// keep working without churn. New code should import from `./prompt` directly.
//
// SYSTEM_PROMPT_VERSION is preserved as a re-export of the COMPOSITE version so
// downstream telemetry (oto_telemetry.system_prompt_version) keeps recording a
// single string that changes whenever either half changes.
//
// Change protocol — DO NOT edit prompt text here. Edit the appropriate half:
//   - stable changes  → convex/oto/prompt/stable.ts   (2 reviewers, 25%/48h A/B)
//   - volatile changes → convex/oto/prompt/volatile.ts (1 reviewer, 5%/48h A/B)
// See docs/SPRINT_1/WAVE_1_5_PROMPT_CHANGE_PROTOCOL.md and
// docs/SPRINT_2/WAVE_4_PROMPT_SPLIT.md.
// =============================================================================

import {
  SYSTEM_PROMPT as COMPOSED_SYSTEM_PROMPT,
  SYSTEM_PROMPT_COMPOSITE_VERSION,
} from "./prompt";

export const SYSTEM_PROMPT_VERSION = SYSTEM_PROMPT_COMPOSITE_VERSION;

export const SYSTEM_PROMPT: string = COMPOSED_SYSTEM_PROMPT;
