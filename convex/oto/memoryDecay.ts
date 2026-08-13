// =============================================================================
// Oto AI — memoryDecay.ts (Wave 3 pure-function module)
// =============================================================================
//
// Sprint 2 Day 6 (2026-05-17). Authority: docs/SPRINT_2/WAVE_3_DESIGN.md §2.2,
// Decision Log D-3.5 (120-day exponential confidence decay).
// Owner: Memory Systems Engineer.
//
// PURPOSE
// -------
// Pure-function module that applies the 120-day half-life exponential decay
// formula to a stored `user_semantic_facts.confidence` value at READ time.
// Per design §2.2, the stored confidence is the LAST-REINFORCED value; the
// retrieval layer computes effective confidence by composing this function
// against `(now - last_reinforced)` whenever it ranks/uses the row.
//
// IMPORT DISCIPLINE
// -----------------
// Wave 5 reranker (next sprint) is the primary consumer. The reranker eval
// harness lives outside the Convex runtime, so this module is **DELIBERATELY
// FREE OF CONVEX-RUNTIME DEPENDENCIES** — no `convex/values`, no `_generated`,
// no `MutationCtx`. Just TypeScript + Math. Anything that needs to import
// `decayConfidence` from a non-Convex harness can `import { decayConfidence }
// from "../../convex/oto/memoryDecay"` and it just works.
//
// Cross-mandate note (Day 6 consultation): RAG Specialist initially suggested
// storing only `last_reinforced` and recomputing decay on every read; that
// misreads the design. The design says STORE the last-reinforced value,
// REINFORCE asymptotically on observation, and COMPUTE decay from the stored
// pair `(confidence, last_reinforced)` at read time. Follow the design.
//
// THE FORMULA (D-3.5)
// -------------------
//   effective = stored * 2^(-elapsed_days / 120)
//   clamp to [0, 1]
//
// Equivalent to `stored * exp(-ln(2) * elapsed_days / 120)`. Half-life is
// EXACTLY 120 days: at elapsed=120d, the multiplier is 0.5; at 240d, 0.25;
// at 360d, 0.125. Floor handling (the design's max-with-0.1) is the
// RERANKER's concern, not this function's — `decayConfidence` returns the
// pure decayed value and the reranker decides whether to floor at 0.1, gate
// at a higher threshold, or use the raw decay. This keeps the math
// composable.
//
// CLOCK SKEW
// ----------
// If `lastReinforced > now` (clock skew or the row was just written in the
// same millisecond by a faster writer), return `stored` unchanged. We do NOT
// apply negative-elapsed decay (which would amplify confidence above 1.0);
// we treat skew as "the row is fresh, no decay yet."
//
// =============================================================================

/**
 * 120-day half-life in milliseconds. The exponential decay multiplier is
 * `2^(-elapsed_ms / HALF_LIFE_MS)`. Exported so callers (eval harness, future
 * cron) can reason about the constant without re-deriving it.
 */
export const HALF_LIFE_DAYS = 120 as const;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const HALF_LIFE_MS = HALF_LIFE_DAYS * MS_PER_DAY;

/**
 * Apply the D-3.5 120-day exponential-decay function to a stored confidence.
 *
 * @param stored          The last-reinforced confidence value (typically in [0, 1]).
 *                        Values outside [0, 1] are clamped on output (defense in
 *                        depth against admin_edit bypasses).
 * @param lastReinforced  Epoch ms of the last reinforcement (or initial insert).
 * @param now             Epoch ms representing the read instant. Pass Date.now()
 *                        from the caller; this module takes no implicit clock
 *                        dependency so unit tests can pump deterministic values.
 * @returns               Decayed confidence in [0, 1]. Never NaN, never negative,
 *                        never >1. If `lastReinforced > now` (clock skew), returns
 *                        `stored` unchanged (clamped to [0, 1]).
 *
 * Composition contract (per design §2.2 + Wave 5 reranker import discipline):
 * the retrieval layer calls this once per row at rank time and decides whether
 * to floor at 0.1, gate above a threshold, or surface raw. This function does
 * NOT floor; that's the reranker's policy choice.
 */
export function decayConfidence(
  stored: number,
  lastReinforced: number,
  now: number,
): number {
  // Defense-in-depth clamp on input (admin_edit could have written an out-of-
  // range stored value; we tolerate but normalize).
  if (!Number.isFinite(stored)) return 0;
  const clampedStored = Math.max(0, Math.min(1, stored));

  // Clock-skew guard: treat future-stamped reinforcements as "no elapsed time
  // yet." Returning the unmodified stored value avoids amplification > 1.0.
  if (lastReinforced > now) {
    return clampedStored;
  }

  const elapsedMs = now - lastReinforced;
  if (elapsedMs <= 0) return clampedStored;

  // 2^(-elapsed_ms / HALF_LIFE_MS) — exponential half-life with base 2.
  const multiplier = Math.pow(2, -elapsedMs / HALF_LIFE_MS);
  const decayed = clampedStored * multiplier;

  // Output clamp — multiplier is in [0, 1] so this is structurally guaranteed,
  // but the clamp documents the contract and defuses any FP edge cases.
  return Math.max(0, Math.min(1, decayed));
}

// =============================================================================
// Self-test block — gated on MEMORY_DECAY_SELFTEST=1.
// =============================================================================
//
// Run with:  MEMORY_DECAY_SELFTEST=1 npx tsx convex/oto/memoryDecay.ts
//
// Tests the four cases enumerated in the Day 6 dispatch brief:
//   1. Fresh (just reinforced)       — decayConfidence(0.875, now, now) ≈ 0.875
//   2. One half-life elapsed (120d)  — decayConfidence(0.875, now-120d, now) ≈ 0.4375
//   3. Two half-lives (240d)         — decayConfidence(0.875, now-240d, now) ≈ 0.21875
//   4. Clock skew (future-stamped)   — decayConfidence(0.5, now+1d, now) === 0.5
// =============================================================================
if (typeof process !== "undefined" && process.env?.MEMORY_DECAY_SELFTEST) {
  const EPS = 1e-9;
  const ok: string[] = [];
  const fail: string[] = [];

  const approx = (got: number, want: number, tol = EPS): boolean =>
    Math.abs(got - want) < tol;

  const T0 = 1_700_000_000_000; // arbitrary fixed epoch ms for determinism
  const day = MS_PER_DAY;

  // Case 1 — fresh row, zero elapsed.
  {
    const got = decayConfidence(0.875, T0, T0);
    (approx(got, 0.875) ? ok : fail).push(
      `case 1 (fresh): got=${got} want=0.875`,
    );
  }

  // Case 2 — one half-life elapsed (120 days).
  {
    const got = decayConfidence(0.875, T0 - 120 * day, T0);
    (approx(got, 0.4375) ? ok : fail).push(
      `case 2 (120d / one half-life): got=${got} want=0.4375`,
    );
  }

  // Case 3 — two half-lives elapsed (240 days). Design §6 Day 4 plan
  // reference value: 0.875 / 4 = 0.21875.
  {
    const got = decayConfidence(0.875, T0 - 240 * day, T0);
    (approx(got, 0.21875) ? ok : fail).push(
      `case 3 (240d / two half-lives): got=${got} want=0.21875`,
    );
  }

  // Case 4 — clock-skew: lastReinforced > now. Must return stored unchanged.
  {
    const got = decayConfidence(0.5, T0 + day, T0);
    (got === 0.5 ? ok : fail).push(
      `case 4 (clock skew +1d): got=${got} want=0.5 (exact)`,
    );
  }

  console.log(`memoryDecay self-test: ${ok.length} ok, ${fail.length} fail`);
  for (const line of ok) console.log(`  OK   ${line}`);
  for (const line of fail) console.log(`  FAIL ${line}`);
  if (fail.length > 0) process.exit(1);
}
