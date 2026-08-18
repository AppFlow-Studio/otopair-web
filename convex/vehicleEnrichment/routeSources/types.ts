// =============================================================================
// routeSources/types.ts — the contract for a WEBSITE-ROUTE source.
//
// WHY THIS MODULE EXISTS
// ----------------------
// manualLibrary's pipeline is PDF-shaped end to end: discover a PDF, upload it
// to the Files API, read it with a document block, keep page-level citations.
// Some manufacturers publish no PDF at all (BMW, Mercedes, VW, Audi — probed
// Aug 5 2026), and some sites carry the same content as chapterised HTML. For
// those, the unit of discovery is not a document — it is a ROUTE.
//
// sourceAdapters/myCarUserManual.ts already implemented that walk, correctly
// and in detail, for exactly one host. This module is that engine with the host
// lifted out: a source declares its path grammar, and the walker runs it.
//
// ============================================================================
// THE SHAPE OF A ROUTE WALK
// ============================================================================
// Every site of this kind is a LADDER. You enter at a URL you can build from
// the vehicle alone, and each rung's page tells you the next URL — because the
// slugs are the site's, not yours, and guessing them is how you 404 silently.
// The last rung lists CONTENT pages, which are scored and fetched.
//
//   entry(vehicle) ─→ rung ─→ rung ─→ … ─→ leaf ─→ [content pages]
//
// mycarusermanual is: /{make} → /{make}/{model} → /{gen} → chapter pages.
//
// ============================================================================
// THE THREE OUTCOMES A RUNG CAN HAVE
// ============================================================================
// Distinguishing these is the whole reliability story, and getting it wrong is
// how a coverage hole comes to look like an honest gap (the bug the
// single-year-generation comment in myCarUserManual.ts documents):
//
//   advance — we found the next URL.
//   gap     — the site genuinely does not carry this vehicle. ok:true, no
//             claims, no retry. A model the site never had is not a failure.
//   fail    — the site broke, blocked us, or changed shape. ok:false, and the
//             walk is worth retrying later.
//
// A source that cannot tell `gap` from `fail` will either retry forever on
// vehicles it will never have, or cache a redesign as "this vehicle doesn't
// exist". Both are silent.
// =============================================================================

import type { AdapterVehicle, SourceFamily } from "../sourceAdapters/types";
import type { DirectSourceTier } from "../manualDirectSources";

/**
 * Legal posture of a source, and the gate that keeps this module from becoming
 * a general-purpose crawler.
 *
 *   public               — openly published, no access control, terms permit
 *                          automated reading.
 *   licensed             — we hold a commercial agreement; requests carry auth.
 *   attribution_required — usable, but extracted values must carry the
 *                          source's attribution downstream (CC-BY-SA and kin).
 *
 * `walkRouteSource` refuses any source whose license is not one of these, so
 * adding a host is a deliberate, reviewable edit to the manifest rather than a
 * URL change somewhere in a walk.
 */
export type RouteLicense = "public" | "licensed" | "attribution_required";

/** Accumulated slugs discovered during the walk (make slug, model slug, …). */
export type RouteVars = Readonly<Record<string, string>>;

export type RouteWalkContext = {
  vehicle: AdapterVehicle;
  /** What earlier rungs resolved. Rungs read this to build their regexes. */
  vars: RouteVars;
};

export type RungOutcome =
  | { kind: "advance"; url: string; vars?: RouteVars }
  | { kind: "gap"; reason: string }
  | { kind: "fail"; reason: string };

/**
 * One rung of the ladder. `next` is PURE — HTML in, decision out — so the whole
 * grammar of a site is unit-testable against a saved page with no network.
 * It must never throw; the walker treats a throw as `fail`, but a source that
 * relies on that is hiding a parse bug.
 */
export type RouteRung = {
  name: string;
  next: (html: string, ctx: RouteWalkContext) => RungOutcome;
};

/** A candidate content page found on the leaf listing. */
export type RouteContentLink = {
  /** Stable identifier within the source — the chapter slug, typically. */
  slug: string;
  url: string;
};

/**
 * The final rung: it lists content pages instead of advancing to one.
 *
 * `score` exists because manufacturer chapter taxonomies share no vocabulary
 * (BMW files oil under `mobility--engine-oil`, Mercedes under
 * `maintenance-and-care`). Scoring rather than hardcoding is what lets a source
 * work for a make nobody has looked at yet. A score of 0 means never fetch.
 */
export type RouteLeaf = {
  name: string;
  candidates: (html: string, ctx: RouteWalkContext) => RouteContentLink[];
  score: (link: RouteContentLink, ctx: RouteWalkContext) => number;
  /** Cost dial: content pages fetched per vehicle. */
  maxPages: number;
  /**
   * Drop candidates made redundant by others, after scoring and before the
   * page budget is applied.
   *
   * This exists because OVERLAPPING PAGES BREAK CITATION. Caught live on the
   * 2021 CR-V (Aug 13 2026): the walk selected both `maintenance` and
   * `maintenance--before-performing-maintenance`, and the parent chapter
   * republishes its children, so every quote appeared in two sections and
   * locateQuote correctly refused to place any of them — the vehicle produced
   * zero claims from four successful fetches.
   *
   * Applied before the slice so a dropped parent frees its slot for the next
   * candidate rather than shrinking the walk.
   */
  collapse?: (links: RouteContentLink[]) => RouteContentLink[];
};

export type RouteSource = {
  id: string;
  host: string;
  /**
   * Independence class for the claim ledger's corroboration math.
   *
   * A republisher of manufacturer text is `aggregator`, NOT `owners_manual` —
   * the text originates with the manufacturer but this is a third-party
   * transcription on a third-party host, and `resolveOperator` must be able to
   * keep it from double-counting with the PDF extraction of the same manual.
   */
  family: SourceFamily;
  /** Who serves the bytes. Decides the interval provenance stamp — see
   *  routeIntervalProvenance in routeSources/provenance.ts. */
  tier: DirectSourceTier;
  license: RouteLicense;
  /** Entry URL from the vehicle alone, or null when the source cannot even be
   *  addressed for it (unknown make slug). Pure. */
  entry: (vehicle: AdapterVehicle) => string | null;
  rungs: readonly RouteRung[];
  leaf: RouteLeaf;
  /** Politeness delay between requests to this host, in ms. */
  crawlDelayMs: number;
  /** Below this, a fetched content page is treated as empty rather than text. */
  minContentChars: number;
  /** Per-page cap on cleaned text kept, so one pathological page cannot blow
   *  the extraction context. */
  maxContentChars: number;
  /**
   * Does this page look like the content we asked for?
   *
   * `looksBlockedBody` catches generic anti-bot interstitials, but a site
   * REDESIGN returns a perfectly valid 200 that parses to nothing — which is
   * indistinguishable from "this vehicle isn't here" unless the source asserts
   * something structural about its own pages. Optional, and worth writing.
   */
  looksLikeContent?: (html: string) => boolean;
};

export type RouteWalkSection = {
  slug: string;
  url: string;
  text: string;
};

export type RouteWalkResult = {
  source: string;
  ok: boolean;
  sections: RouteWalkSection[];
  /** Every URL fetched, in order — the audit trail for a walk. */
  visited: string[];
  /** Set when the walk ended early. `gap` reasons are normal outcomes. */
  reason?: string;
  /** True when the walk stopped because the site refused us, as opposed to not
   *  carrying the vehicle. Routes to the headless tier / a later retry. */
  blocked?: boolean;
};
