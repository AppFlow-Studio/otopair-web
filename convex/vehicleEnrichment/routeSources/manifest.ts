// =============================================================================
// routeSources/manifest.ts — the roster of website-route sources.
//
// The manifest is the review surface. Adding a host to this file is the only
// way to make the walker reach it, and every entry has to declare three things
// that are easy to get wrong and expensive to get wrong quietly:
//
//   license — the legal posture. `walkRouteSource` refuses anything that is
//             not public / licensed / attribution_required, so a source cannot
//             be added by editing a URL somewhere in a walk.
//   family  — the independence class for the ledger's corroboration math. A
//             republisher of manufacturer text is `aggregator`; claiming
//             `owners_manual` would let PDF + route double-count as two
//             families of what is really one source read twice.
//   tier    — who serves the bytes, which decides the interval provenance
//             stamp and therefore whether this source can ever outrank the PDF
//             pipeline. See ./provenance.ts.
//
// ADDING A LICENSED SOURCE
// ------------------------
// A commercial manual API (ALLDATA, Mitchell 1, MOTOR, Identifix) is an entry
// like any other: `license: "licensed"`, its own path grammar, and an auth
// header supplied by the fetch tier. No engine changes — that was the point of
// making the walk manifest-driven rather than writing a second adapter.
// =============================================================================

import { mycarusermanualSource } from "../sourceAdapters/myCarUserManual";
import { assertRouteProvenanceSane } from "./provenance";
import type { RouteSource } from "./types";

/**
 * Registered route sources, in stable order.
 *
 * Currently one. mycarusermanual is the entry the engine was generalized out
 * of, so it is also the proof the abstraction fits a real site rather than an
 * imagined one — every rule in its grammar was found by walking the site, not
 * by designing the interface.
 */
export const ROUTE_SOURCES: readonly RouteSource[] = [mycarusermanualSource];

/** Look a source up by id. */
export function routeSourceById(id: string): RouteSource | null {
  return ROUTE_SOURCES.find((s) => s.id === id) ?? null;
}

/**
 * Static validation of the roster.
 *
 * Returns the problems rather than throwing, so a caller can log them without
 * taking the pipeline down — but a non-empty result is a bug in this file, not
 * a runtime condition, and the pipeline test asserts it is empty.
 */
export function validateManifest(
  sources: readonly RouteSource[] = ROUTE_SOURCES,
): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const hosts = new Set<string>();

  for (const s of sources) {
    if (ids.has(s.id)) problems.push(`duplicate source id: ${s.id}`);
    ids.add(s.id);

    // Two entries on one host would be two voices in the ledger that share an
    // upstream — exactly what resolveOperator exists to prevent.
    if (hosts.has(s.host)) problems.push(`duplicate host: ${s.host} (${s.id})`);
    hosts.add(s.host);

    if (s.license !== "public" && s.license !== "licensed" && s.license !== "attribution_required") {
      problems.push(`${s.id}: unknown license "${String(s.license)}"`);
    }
    if (s.rungs.length === 0) problems.push(`${s.id}: ladder has no rungs`);
    if (s.leaf.maxPages < 1) problems.push(`${s.id}: leaf.maxPages must be >= 1`);
    if (s.crawlDelayMs < 0) problems.push(`${s.id}: negative crawlDelayMs`);
    if (s.minContentChars < 0) problems.push(`${s.id}: negative minContentChars`);
    if (s.maxContentChars <= s.minContentChars) {
      problems.push(`${s.id}: maxContentChars must exceed minContentChars`);
    }

    const provenance = assertRouteProvenanceSane(s);
    if (provenance) problems.push(provenance);
  }

  return problems;
}
