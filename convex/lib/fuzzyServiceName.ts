/**
 * Typo tolerance for the off-catalog name suggester.
 *
 * ─── WHY THIS IS SEPARATE FROM serviceMatch.ts ──────────────────────────────
 * serviceMatch.ts already handles casing, punctuation, word order, plurals and
 * shop shorthand. The one thing it deliberately does NOT do is tolerate
 * misspellings, and loosening it there would be the wrong trade: that matcher
 * feeds the catalog gate, where a false positive silently costs a driver their
 * maintenance credit. Precision is the whole point of it.
 *
 * Here the stakes invert. This module powers "other shops call it…" — a list of
 * names offered while the mechanic types. A false positive costs one ignored
 * suggestion; a false negative costs a duplicate cluster forever, which is the
 * exact failure the feature exists to prevent. So this is allowed to be loose
 * in a way the gate is not.
 */

import { serviceTokens } from "./serviceMatch";

/**
 * Damerau-Levenshtein distance, capped — we only ever ask "is this within N",
 * so the row-min bailout keeps a long non-match cheap.
 *
 * Transpositions are included because the common failure is a fast typist
 * swapping adjacent keys ("brkae", "cabron"), which plain Levenshtein charges
 * two edits for and would push past any sane threshold.
 */
export function boundedEditDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  // Three rolling rows: i-2 is needed for the transposition case.
  let prevPrev: number[] | null = null;
  let prev: number[] = new Array<number>(b.length + 1);
  let curr: number[] = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
      if (
        prevPrev &&
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        value = Math.min(value, prevPrev[j - 2] + 1); // transposition
      }
      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }
    // Every path through this row already costs more than the cap.
    if (rowMin > max) return max + 1;
    const recycled = prevPrev ?? new Array<number>(b.length + 1);
    prevPrev = prev;
    prev = curr;
    curr = recycled;
  }
  return prev[b.length];
}

/**
 * How many edits a token of this length is allowed to be wrong by. Short tokens
 * get none: at four characters, one edit already reaches a different word
 * ("gear"/"rear", "disc"/"disk"), and folding those together would suggest the
 * wrong work.
 */
function editBudget(token: string): number {
  if (token.length <= 4) return 0;
  if (token.length <= 7) return 1;
  return 2;
}

/** Exact, prefix (shop shorthand), or within the token's typo budget. */
export function fuzzyTokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 4 && long.startsWith(short)) return true;
  const budget = Math.min(editBudget(a), editBudget(b));
  if (budget === 0) return false;
  return boundedEditDistance(a, b, budget) <= budget;
}

/**
 * Sørensen–Dice over token sets using the typo-tolerant comparison above.
 * Mirrors serviceMatch.tokenSimilarity — greedy pairing, each token consumed
 * once, exact partners preferred over fuzzy ones so a near-miss can't steal a
 * token that had a perfect partner available.
 */
export function fuzzyNameSimilarity(typed: string, candidate: string): number {
  const a = Array.from(new Set(serviceTokens(typed)));
  const b = Array.from(new Set(serviceTokens(candidate)));
  if (a.length === 0 || b.length === 0) return 0;

  const taken = new Array<boolean>(b.length).fill(false);
  let shared = 0;
  for (const token of a) {
    let hit = b.findIndex((other, i) => !taken[i] && other === token);
    if (hit === -1) {
      hit = b.findIndex((other, i) => !taken[i] && fuzzyTokensMatch(token, other));
    }
    if (hit !== -1) {
      taken[hit] = true;
      shared += 1;
    }
  }
  return (2 * shared) / (a.length + b.length);
}
