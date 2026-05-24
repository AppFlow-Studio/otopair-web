/**
 * tax.ts — Sales-tax computation for booking breakdowns.
 *
 * Three improvements over the previous flat-rate placeholder:
 *
 *   1. **Local rate overrides.** State base rates are augmented by a
 *      ZIP-3 lookup table for major US metros (NYC, LA, Chicago, etc.)
 *      whose city/county taxes meaningfully exceed the state base.
 *
 *   2. **Service taxability rules.** Auto-repair tax law varies by state:
 *        - `labor_and_parts`: both subject to sales tax (most states)
 *        - `parts_only`:      labor exempt, parts taxed (CA, NY, NJ, ...)
 *        - `services_exempt`: no sales tax on services or parts (AK, OR,
 *                             MT, NH, DE — no statewide sales tax at all)
 *
 *   3. **Single source of truth.** Imported by both the mobile client
 *      (for breakdown display) AND Convex (for server-side authoritative
 *      computation). The client value is purely UI — `convex/bookings.ts`
 *      recomputes via this same module and ignores client input.
 *
 * Limits:
 *
 *   - Still an approximation. ZIP-3 covers metros; smaller cities use the
 *     state base. County-level deviations elsewhere are not modeled.
 *
 *   - Auto-repair labor exemptions are state-specific even within the
 *     `parts_only` group. Some states only exempt labor on *new* parts,
 *     others only on certain vehicle classes, etc. Not modeled.
 *
 *   - The proper fix is `automatic_tax: { enabled: true }` on the
 *     PaymentIntent (Stripe Tax) — see `convex/payments_stripe.ts` for
 *     the env-flag-gated path that uses Stripe Tax Calculations and
 *     reports for auto-filing. This local table remains the default
 *     while Stripe Tax registration is pending in the dashboard.
 */

// ─────────────────────────────────────────────────────────────────────
// State base rates (1 January 2025 snapshot, Tax Foundation)
// ─────────────────────────────────────────────────────────────────────

const STATE_SALES_TAX_RATES: Record<string, number> = {
  AL: 0.04,
  AK: 0.0,
  AZ: 0.056,
  AR: 0.065,
  CA: 0.0725,
  CO: 0.029,
  CT: 0.0635,
  DE: 0.0,
  DC: 0.06,
  FL: 0.06,
  GA: 0.04,
  HI: 0.04,
  ID: 0.06,
  IL: 0.0625,
  IN: 0.07,
  IA: 0.06,
  KS: 0.065,
  KY: 0.06,
  LA: 0.0445,
  ME: 0.055,
  MD: 0.06,
  MA: 0.0625,
  MI: 0.06,
  MN: 0.06875,
  MS: 0.07,
  MO: 0.04225,
  MT: 0.0,
  NE: 0.055,
  NV: 0.0685,
  NH: 0.0,
  NJ: 0.06625,
  NM: 0.05,
  NY: 0.04,
  NC: 0.0475,
  ND: 0.05,
  OH: 0.0575,
  OK: 0.045,
  OR: 0.0,
  PA: 0.06,
  RI: 0.07,
  SC: 0.06,
  SD: 0.045,
  TN: 0.07,
  TX: 0.0625,
  UT: 0.047,
  VT: 0.06,
  VA: 0.053,
  WA: 0.065,
  WV: 0.06,
  WI: 0.05,
  WY: 0.04,
};

// ─────────────────────────────────────────────────────────────────────
// ZIP-3 metro overrides — combined state + local rate for major metros.
// Keyed by the first 3 digits of the ZIP code. These OVERRIDE the state
// base when the shop's ZIP starts with one of these prefixes.
// ─────────────────────────────────────────────────────────────────────

const ZIP3_METRO_RATES: Record<string, number> = {
  // New York City (Manhattan, Bronx, Brooklyn, Queens, Staten Island)
  "100": 0.08875, "101": 0.08875, "102": 0.08875, "103": 0.08875, "104": 0.08875,
  // Los Angeles county
  "900": 0.0975, "901": 0.0975, "902": 0.0975, "903": 0.0975, "904": 0.0975, "905": 0.0975,
  // Chicago / Cook County
  "606": 0.1025, "607": 0.1025, "608": 0.1025,
  // San Francisco / Bay Area
  "940": 0.08625, "941": 0.08625, "943": 0.08625, "944": 0.08625, "945": 0.08625,
  // Seattle / King County
  "980": 0.1025, "981": 0.1025,
  // Houston
  "770": 0.0825, "771": 0.0825, "772": 0.0825,
  // Dallas–Fort Worth
  "751": 0.0825, "752": 0.0825, "753": 0.0825, "760": 0.0825, "761": 0.0825, "762": 0.0825,
  // Austin
  "787": 0.0825, "786": 0.0825,
  // Tampa Bay
  "335": 0.075, "336": 0.075, "337": 0.075,
  // Miami–Dade
  "330": 0.07, "331": 0.07, "332": 0.07,
  // Orlando
  "327": 0.065, "328": 0.065, "329": 0.065,
  // Phoenix
  "850": 0.086, "851": 0.086, "852": 0.086, "853": 0.086,
  // Denver
  "802": 0.081,
  // Atlanta
  "303": 0.089, "311": 0.089, "300": 0.089,
  // Boston
  "021": 0.0625, "022": 0.0625,
  // Washington DC (DC has no ZIP3 split — handled at state)
  // Philadelphia
  "191": 0.08,
  // Pittsburgh
  "152": 0.07,
  // Minneapolis–St. Paul
  "551": 0.07875, "554": 0.07875,
  // Detroit
  "482": 0.06,
  // Cleveland
  "441": 0.075,
  // Cincinnati
  "452": 0.0775,
  // St. Louis
  "631": 0.09238,
  // Kansas City
  "641": 0.0975,
  // Las Vegas
  "891": 0.0838,
  // New Orleans
  "701": 0.0945,
  // Nashville
  "372": 0.0925, "370": 0.0925,
  // Memphis
  "381": 0.0975,
  // Charlotte
  "282": 0.0725,
  // Raleigh
  "276": 0.0725, "275": 0.0725,
  // Salt Lake City
  "841": 0.0775,
  // Honolulu
  "968": 0.045,
};

// ─────────────────────────────────────────────────────────────────────
// Service taxability rules per state for auto-repair services.
// Approximate — see file header. NOT a substitute for Stripe Tax.
// ─────────────────────────────────────────────────────────────────────

export type ServiceTaxRule =
  /** Labor + parts both taxed. The common case for sales-tax states. */
  | "labor_and_parts"
  /** Parts taxed; labor exempt. CA, NY, NJ, MA, OH, PA, VA, OK. */
  | "parts_only"
  /** Neither parts nor labor taxed. No-statewide-sales-tax states. */
  | "services_exempt";

const STATE_SERVICE_TAX_RULES: Record<string, ServiceTaxRule> = {
  // No statewide sales tax → nothing to tax on services either
  AK: "services_exempt",
  DE: "services_exempt",
  MT: "services_exempt",
  NH: "services_exempt",
  OR: "services_exempt",

  // States that exempt repair labor for tangible-personal-property services
  // (auto-repair labor specifically falls under this carve-out)
  CA: "parts_only",
  MA: "parts_only",
  NJ: "parts_only",
  NY: "parts_only",
  OH: "parts_only",
  OK: "parts_only",
  PA: "parts_only",
  VA: "parts_only",

  // Default `labor_and_parts` for all other states is applied by getServiceTaxRule.
};

// Default when state is unknown / not listed. Use the conservative
// "tax both" rule so we don't undercollect on unrecognized jurisdictions.
const DEFAULT_RULE: ServiceTaxRule = "labor_and_parts";
const DEFAULT_TAX_RATE = 0.06;

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

function normalizeState(state: string | null | undefined): string | null {
  if (!state) return null;
  const code = state.trim().toUpperCase();
  return code.length === 2 ? code : null;
}

function normalizeZip3(zip: string | null | undefined): string | null {
  if (!zip) return null;
  const digits = zip.replace(/\D/g, "");
  return digits.length >= 3 ? digits.slice(0, 3) : null;
}

export function getSalesTaxRate(
  state: string | null | undefined,
  zip?: string | null,
): number {
  const zip3 = normalizeZip3(zip);
  if (zip3 && zip3 in ZIP3_METRO_RATES) {
    return ZIP3_METRO_RATES[zip3];
  }
  const code = normalizeState(state);
  if (code && code in STATE_SALES_TAX_RATES) {
    return STATE_SALES_TAX_RATES[code];
  }
  return DEFAULT_TAX_RATE;
}

export function getServiceTaxRule(
  state: string | null | undefined,
): ServiceTaxRule {
  const code = normalizeState(state);
  if (!code) return DEFAULT_RULE;
  return STATE_SERVICE_TAX_RULES[code] ?? DEFAULT_RULE;
}

export type ComputeBookingTaxArgs = {
  laborDollars: number;
  partsDollars: number;
  state: string | null | undefined;
  zip?: string | null;
};

export type ComputeBookingTaxResult = {
  /** Total tax in dollars, rounded to the cent. */
  taxDollars: number;
  /** Effective combined rate (state + local override). */
  effectiveRate: number;
  /** Rule applied — affects what portion of the subtotal is taxable. */
  rule: ServiceTaxRule;
  /** Which lookup the rate came from. */
  source: "zip_metro_override" | "state_base" | "default";
  /** Taxable base after rule application. */
  taxableBaseDollars: number;
};

export function computeBookingTax(
  args: ComputeBookingTaxArgs,
): ComputeBookingTaxResult {
  const labor = Math.max(0, args.laborDollars);
  const parts = Math.max(0, args.partsDollars);
  const state = normalizeState(args.state);
  const zip3 = normalizeZip3(args.zip);

  const rule = getServiceTaxRule(args.state);
  const rate = getSalesTaxRate(args.state, args.zip);

  let source: ComputeBookingTaxResult["source"];
  if (zip3 && zip3 in ZIP3_METRO_RATES) {
    source = "zip_metro_override";
  } else if (state && state in STATE_SALES_TAX_RATES) {
    source = "state_base";
  } else {
    source = "default";
  }

  let taxableBase: number;
  switch (rule) {
    case "services_exempt":
      taxableBase = 0;
      break;
    case "parts_only":
      taxableBase = parts;
      break;
    case "labor_and_parts":
    default:
      taxableBase = labor + parts;
      break;
  }

  const taxDollars =
    taxableBase > 0 ? Math.round(taxableBase * rate * 100) / 100 : 0;

  return {
    taxDollars,
    effectiveRate: rate,
    rule,
    source,
    taxableBaseDollars: taxableBase,
  };
}

/**
 * Convenience for the common "I just want the tax dollars" call.
 * Equivalent to `computeBookingTax(...).taxDollars`.
 */
export function computeTaxDollars(
  laborDollars: number,
  partsDollars: number,
  state: string | null | undefined,
  zip?: string | null,
): number {
  return computeBookingTax({ laborDollars, partsDollars, state, zip })
    .taxDollars;
}
