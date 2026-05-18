// =============================================================================
// Oto AI — question canonicalization + cache-key hashing (pure functions)
// =============================================================================
//
// Sprint 1 Day 2 (2026-05-16). Authority: MEMORY_SCHEMA_V3_CONSOLIDATED §4.
// Owner: Memory Systems Engineer.
//
// PURPOSE
// -------
// Two questions asked in slightly different surface forms ("What oil does my
// engine take?", "what oil does my engine take", "WHAT OIL DOES MY ENGINE
// TAKE?!?!") must map to the same `vehicle_facts.canonical_question_key`.
// That key is what the agent probes the KB by — without canonicalization,
// trivial surface variation forks the cache and the unverified-row count
// balloons.
//
// CONSUMERS
// ---------
//   - `convex/oto/vehicleFactsEditing.ts → recordVehicleFact`
//       Computes `canonical_question_key` at write time before insert.
//   - `convex/oto/migrations/backfillV3Lifecycle.ts → backfillV3Lifecycle`
//       Computes `canonical_question_key` inline for each pre-v3 row whose
//       `verification_status` is still `undefined`.
//   - Any future chat-agent read path that does an O(log n) point lookup on
//       `by_canonical_question` before falling back to structural / search.
//
// CONTRACT
// --------
// This module is PURE. It must not:
//   - import from `convex/server` or `_generated/`
//   - call Date.now or any randomness source
//   - perform any I/O beyond the synchronous bytes-in / bytes-out of
//     `crypto.subtle.digest`, which is part of the V8 runtime that Convex
//     uses for both actions and mutations
//
// The purity rule is what lets the backfill mutation call these helpers
// without escalating to an action.
//
// RUNTIME
// -------
// Convex runs both mutations and actions on V8 with the WebCrypto API
// available. We prefer `crypto.subtle.digest("SHA-256", ...)` over the
// Node-only `crypto.createHash` for that reason — one implementation works
// in both contexts.
// =============================================================================

/**
 * Normalize a user-facing question into its canonical form.
 *
 * Steps (in order):
 *   1. Lowercase (`.toLowerCase()`).
 *   2. NFKC unicode normalization (`.normalize("NFKC")`).
 *      Folds compatibility characters (fullwidth digits, ligatures, etc.) so
 *      that visually-similar inputs collapse to the same code points.
 *   3. Strip terminal punctuation runs: `.`, `!`, `?`, `;`, `:`, `,`, and
 *      trailing whitespace.
 *   4. Collapse internal whitespace runs to a single space.
 *   5. Trim leading/trailing whitespace.
 *
 * Properties:
 *   - Deterministic: same input → same output, always.
 *   - Idempotent:    `normalize(normalize(x)) === normalize(x)` for all x.
 *   - Pure:          no I/O, no time, no randomness.
 *
 * Examples:
 *   "What oil does my engine take?"        → "what oil does my engine take"
 *   "WHAT OIL DOES MY ENGINE TAKE?"        → "what oil does my engine take"
 *   "  what  oil  does my engine take.  "  → "what oil does my engine take"
 *   "What oil does my engine take?!?!"     → "what oil does my engine take"
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    // Strip runs of terminal punctuation and trailing whitespace at the end
    // of the string. The character class includes `.!?;:,` plus any
    // whitespace. Anchored to end-of-string so internal punctuation
    // (e.g., "model's" apostrophes, hyphens) is preserved.
    .replace(/[.!?;:,\s]+$/g, "")
    // Collapse all runs of internal whitespace to a single ASCII space.
    .replace(/\s+/g, " ")
    // Trim any remaining leading/trailing whitespace. (Trailing whitespace
    // is already handled by the terminal-punct strip above, but leading
    // whitespace is not.)
    .trim();
}

/**
 * Compute the lowercase hex SHA-256 of `text`.
 *
 * Implementation uses WebCrypto (`crypto.subtle.digest`) because it is
 * available in both Convex mutation and action runtimes. The Node-only
 * `node:crypto.createHash` would not work inside mutations.
 *
 * Async because `crypto.subtle.digest` returns a Promise<ArrayBuffer>.
 * The Convex internalMutation handler that drives the v3 backfill awaits
 * this in its per-row loop — Convex mutation handlers support async
 * bodies and serialize the awaited work into a single transaction.
 *
 * Returns the 64-character lowercase hex string.
 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  // Convert ArrayBuffer → lowercase hex. Plain-loop hex encoding is the
  // standard pattern; no Buffer because we want to stay browser/V8-portable.
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * The convenience helper that callers should use whenever they need a
 * `vehicle_facts.canonical_question_key`. This is the value written by
 * `recordVehicleFact` and by the v3 lifecycle backfill.
 *
 * Equivalent to `sha256Hex(normalize(text))`. Centralizes the two-step
 * composition so callers do not accidentally hash an un-normalized string.
 *
 *   const key = await canonicalQuestionKey(args.question_text);
 *   // store `key` in vehicle_facts.canonical_question_key
 */
export async function canonicalQuestionKey(text: string): Promise<string> {
  return sha256Hex(normalize(text));
}
