// =============================================================================
// sourceAdapters/types.ts — the claim contract every rival adapter emits.
//
// A Claim is one source's assertion about one field of one vehicle. Adapters
// NEVER decide truth — they fetch, parse, and emit; the deterministic
// reconciler (claimLedger.ts) computes consensus and confidence from
// source-family diversity. This is rival-on-confirm (R13) generalized into the
// default for every core field.
//
// Source families are the independence unit: two OEM dealer storefronts
// agreeing is weaker evidence than one storefront + one aftermarket catalog,
// because storefronts share an upstream (the OEM's own catalog). Confidence is
// a function of DISTINCT FAMILIES in agreement, never of repetition within one.
//
// Inside a family the unit is the OPERATOR, not the hostname — a hostname is a
// brand, and one operator sells under many. See resolveOperator in
// claimLedger.ts for the mapping and the evidence behind it.
// =============================================================================

/** Independence classes for corroboration math. */
export type SourceFamily =
  | "oem_catalog"        // dealer storefronts, OEM EPC-derived pages
  | "aftermarket_catalog" // WIX, MANN, Brembo, Centric, Trico, Sylvania…
  | "aggregator"          // AMSOIL-style multi-field lookups (independent aggregation)
  | "owners_manual"       // manufacturer manual / warranty-guide extraction
  | "gov"                 // NHTSA / EPA
  | "web_search"          // LLM web-search extraction (weakest family)
  | "human";              // mechanic cast-reading / director entry (outranks all)

/** How the value was obtained — provenance for the sellable layer. */
export type ClaimMethod =
  | "deterministic_parse" // fixed selector/regex on a fetched page
  | "llm_extraction"      // model-read content, from a page WE chose
  | "api"                 // structured endpoint response
  // An autonomous research agent that picked its own sources (Firecrawl
  // /agent). Deliberately NOT folded into "llm_extraction": that is a model
  // reading a page the pipeline selected and can name, whereas this is a model
  // choosing where to look. Same words, very different reliability — the live
  // probe answered a Ford rotor-minimum question from an aftermarket rotor
  // RETAILER — and in a ledger whose entire purpose is provenance, that
  // distinction has to survive to the audit.
  | "agent_research"
  | "human_entry";

export interface Claim {
  /** V4_FIELD_KEYS name or oem_parts role key (e.g. "oil_filter_oem"). */
  field_key: string;
  /** Normalized comparable value (OEM numbers via normalizeOemNumber,
   *  capacities as qts numbers-as-strings, sizes trimmed uppercase). */
  value: string;
  /** Verbatim value as seen on the page, for audit. */
  value_raw?: string;
  source_family: SourceFamily;
  /** Hostname the claim came from. Recorded verbatim for audit; the ledger
   *  dedups on resolveOperator(source_domain), because four sibling storefronts
   *  on one catalog backend are one voice, not four. */
  source_domain: string;
  source_url: string;
  method: ClaimMethod;
  /** Verbatim label/context the value was read under, when it matters
   *  (rotor minimums MUST carry a discard-supporting label). */
  observed_label?: string;
  observed_at: number;
}

/** One part number the pipeline already believes in, offered to adapters that
 *  are keyed by PART rather than by vehicle. */
export interface AdapterKnownPart {
  /** The field/role slot the number currently fills, e.g. "front_brake_pad_oem". */
  field_key: string;
  /** Verbatim OEM number as stored, e.g. "45022-T0A-A01". */
  part_number: string;
  /** Role key for a category cross-check, e.g. "front_brake_pad". */
  role_key?: string | null;
}

/** What an adapter needs to look a vehicle up. */
export interface AdapterVehicle {
  year: number;
  make: string;
  model: string;
  /** Optional refinements — adapters use what their catalog's cascade needs. */
  trim?: string | null;
  engine_code?: string | null;
  displacement_l?: number | null;
  cylinders?: number | null;
  /**
   * Part numbers already on file for this vehicle.
   *
   * Most adapters are keyed by vehicle: give them Y/M/M and they walk a
   * catalogue cascade to a part. A PART-NUMBER-KEYED source (RockAuto) inverts
   * that — it can only answer "is this number real, and what is it?" — so it
   * needs the numbers as input. Adapters that don't use this ignore it, and an
   * adapter that needs it emits nothing when it is absent rather than falling
   * back to a vehicle search it cannot perform.
   */
  known_parts?: readonly AdapterKnownPart[];
}

export interface AdapterResult {
  adapter: string;
  ok: boolean;
  claims: Claim[];
  /** Set when the domain refused server-side fetch — routes to the headless tier. */
  needs_headless?: boolean;
  /** Diagnostic, never thrown — adapters fail open. */
  error?: string;
}

/** Every adapter exports this shape. Fetching happens inside the adapter with
 *  an AbortSignal timeout; a network/parse failure returns ok:false with
 *  claims:[] — NEVER throws (pipeline law: fail open). */
export type SourceAdapter = {
  name: string;
  family: SourceFamily;
  /** Fields this adapter can attest — lets the pipeline pick adapters per gap. */
  fields: readonly string[];
  lookup: (vehicle: AdapterVehicle) => Promise<AdapterResult>;
};
