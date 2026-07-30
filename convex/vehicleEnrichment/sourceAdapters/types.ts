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
  | "llm_extraction"      // model-read content
  | "api"                 // structured endpoint response
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
  /** Hostname the claim came from — the dedup unit WITHIN a family. */
  source_domain: string;
  source_url: string;
  method: ClaimMethod;
  /** Verbatim label/context the value was read under, when it matters
   *  (rotor minimums MUST carry a discard-supporting label). */
  observed_label?: string;
  observed_at: number;
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
