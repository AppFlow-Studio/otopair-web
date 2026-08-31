/**
 * lib/haloVariantRules.ts — Halo-variant promotion + hardware-standard table
 *
 * "Halo variants" are performance trims that every OEM/aftermarket catalog
 * (wheel-size.com, RealOEM, FCP Euro, Bilstein, Tirerack, etc.) files as their
 * own model line — even though VIN-decode sources (VDB, NHTSA) report them as
 * trims of the base series.
 *
 * Examples (decode → catalog):
 *   "3 Series / M3 Competition"   → wheel-size queries `bmw/m3`
 *   "C-Class / C 63 AMG"          → wheel-size queries `mercedes-benz/c-class-amg`
 *   "Civic / Type R"              → wheel-size queries `honda/civic-type-r`
 *   "Charger / SRT Hellcat"       → wheel-size queries `dodge/charger-srt`
 *
 * Two independent signals come out of a rule:
 *
 *   1. promotedModel    — the model name catalogs use. Used by processVin,
 *      wheelSizeScraper, and anywhere else we query an external catalog.
 *      Identity (= base model) is fine when we haven't verified the catalog
 *      name yet — that just means "we don't promote, but we still know it's
 *      a halo for package-detection purposes."
 *
 *   2. hardwareStandard — true when the halo trim ships performance hardware
 *      (brakes, rotors, suspension) as STANDARD. Used by assessAvailablePackages
 *      to skip PackageRules tagged `redundant_when_halo` (m_sport, amg_line,
 *      audi_s_line, etc.) so we don't double-count baseline equipment as a
 *      package and quote the wrong parts.
 *
 * To extend coverage: add a rule. No code changes needed at the call sites.
 *
 * The Haiku-based long-tail fallback lives in lib/haloVariantInference.ts and
 * is only invoked when no rule here matches AND the downstream catalog returns
 * zero results — most decodes never trigger it.
 */

export interface HaloVariantRule {
  /** Stable identifier for logs/telemetry. */
  ruleId: string;
  /** Make this rule applies to. Case-insensitive exact match. No "*". */
  make: string;
  /** Required: regex matched against the trim string. */
  trimPattern: RegExp;
  /**
   * Optional: also require the base model to match. Use when a trim pattern
   * is too generic on its own (e.g. "Type R" — both Civic Type R and
   * Integra Type R, but the rule wants only Civic).
   */
  modelPattern?: RegExp;
  /**
   * Model name to use downstream when this rule matches. Either:
   *  - A literal string: "M3", "AMG GT", "Civic Type R"
   *  - A function: (baseModel, trimMatch) => string — for rules that need to
   *    pull info from the trim or compose with the base model.
   *
   * If you haven't verified the catalog model name yet, set this to the
   * identity (return baseModel) — that still lets the hardwareStandard flag
   * skip redundant packages while leaving model lookups alone.
   */
  promotedModel: string | ((baseModel: string, trimMatch: RegExpMatchArray) => string);
  /**
   * True when the halo ships performance hardware (brakes/rotors/suspension)
   * as standard. Drives the package-rule skip in assessAvailablePackages.
   */
  hardwareStandard: boolean;
}

export interface HaloVariantMatch {
  ruleId: string;
  promotedModel: string;
  hardwareStandard: boolean;
}

/**
 * Curated rules. Order matters only within a make: the FIRST matching rule
 * wins, so put more specific patterns above more general ones.
 */
export const HALO_VARIANT_RULES: HaloVariantRule[] = [
  // ─── BMW ──────────────────────────────────────────────────────────────────
  // M2/M3/M4/M5/M6/M8 (incl. CS, Competition). NOT M340i / M550i / M760i —
  // those are M-Sport-badged trims of the base series, handled by packageRules
  // trim inference instead.
  {
    ruleId: "bmw-m-coupe",
    make: "BMW",
    trimPattern: /^\s*(M[2-8])(\s+(CS|Competition))?\b/i,
    promotedModel: (_base, m) => m[1].toUpperCase() + (m[3]?.toUpperCase() === "CS" ? " CS" : ""),
    hardwareStandard: true,
  },
  // X3 M / X4 M / X5 M / X6 M / X7 M (incl. Competition).
  {
    ruleId: "bmw-x-m",
    make: "BMW",
    trimPattern: /^\s*(X[3-7])\s+M(\s+Competition)?\b/i,
    promotedModel: (_base, m) => `${m[1].toUpperCase()} M`,
    hardwareStandard: true,
  },

  // ─── Mercedes-Benz ────────────────────────────────────────────────────────
  // AMG GT (standalone model line in every catalog).
  {
    ruleId: "mb-amg-gt",
    make: "Mercedes-Benz",
    trimPattern: /\bAMG\s+GT\b/i,
    promotedModel: "AMG GT",
    hardwareStandard: true,
  },
  // Real AMG performance trims (badge 35/43/45/53/55/63/65, incl. "S"). Every
  // catalog files these as their own "<Class> AMG" model line — verified against
  // wheel-size.com GET /v2/models/?make=mercedes: A-Class AMG→a-class-amg,
  // C-Class AMG→c-class-amg, GLE-Class AMG→gle-class-amg, … (consistent across
  // all 30 AMG models). Decode reports them as trims of the base "-Class" model,
  // so promote to "<base> AMG". Guarded by the badge number so cosmetic
  // "AMG Line"/"AMG Styling" trims (no badge) fall through to mb-amg-generic
  // (identity) and don't mis-route the catalog query to the AMG model.
  {
    ruleId: "mb-amg-performance",
    make: "Mercedes-Benz",
    trimPattern: /(?=.*\bAMG\b)(?=.*\b(?:35|43|45|53|55|63|65)\b)/i,
    promotedModel: (base) => `${base} AMG`,
    hardwareStandard: true,
  },
  // Any other AMG mention ("AMG Line", "AMG Styling", badge-less "G 63" edge
  // cases). Model promotion stays identity — catalog naming varies too much to
  // hardcode safely and the LLM fallback can refine. The hardwareStandard flag
  // still skips redundant amg_line package detection.
  {
    ruleId: "mb-amg-generic",
    make: "Mercedes-Benz",
    trimPattern: /\bAMG\b/i,
    promotedModel: (base) => base,
    hardwareStandard: true,
  },

  // ─── Audi ─────────────────────────────────────────────────────────────────
  // RS trims (RS3/RS4/RS5/RS6/RS7, RS Q3/Q8, RS e-tron GT). RS is its own
  // model line in catalogs (`audi/rs4`, `audi/rs-q8`).
  {
    ruleId: "audi-rs-q",
    make: "Audi",
    trimPattern: /^\s*RS\s+Q(\d)\b/i,
    promotedModel: (_b, m) => `RS Q${m[1]}`,
    hardwareStandard: true,
  },
  {
    ruleId: "audi-rs-numbered",
    make: "Audi",
    trimPattern: /^\s*RS\s*(\d)\b/i,
    promotedModel: (_b, m) => `RS${m[1]}`,
    hardwareStandard: true,
  },
  // S trims (S3/S4/S5/S6/S7/S8) — sport hardware standard relative to base A4,
  // but model promotion is identity for now (Audi catalog naming varies).
  {
    ruleId: "audi-s-numbered",
    make: "Audi",
    trimPattern: /^\s*S\s*(\d)\b/i,
    promotedModel: (b) => b,
    hardwareStandard: true,
  },
  // R8 — its own model already in every catalog; mostly here for completeness.
  {
    ruleId: "audi-r8",
    make: "Audi",
    trimPattern: /\bR8\b/i,
    promotedModel: "R8",
    hardwareStandard: true,
  },

  // ─── Honda / Acura ────────────────────────────────────────────────────────
  // Civic Type R — wheel-size files as `civic-type-r`.
  {
    ruleId: "honda-civic-type-r",
    make: "Honda",
    modelPattern: /Civic/i,
    trimPattern: /Type\s*R/i,
    promotedModel: "Civic Type R",
    hardwareStandard: true,
  },
  // Integra Type R / Type S (Acura).
  {
    ruleId: "acura-integra-type",
    make: "Acura",
    modelPattern: /Integra/i,
    trimPattern: /Type\s*[RS]\b/i,
    promotedModel: (_b, m) => `Integra Type ${m[0].slice(-1).toUpperCase()}`,
    hardwareStandard: true,
  },
  // NSX — its own model.
  {
    ruleId: "acura-nsx",
    make: "Acura",
    trimPattern: /\bNSX\b/i,
    promotedModel: "NSX",
    hardwareStandard: true,
  },

  // ─── Cadillac ─────────────────────────────────────────────────────────────
  // Blackwing — Cadillac's modern halo (CT4-V Blackwing, CT5-V Blackwing).
  {
    ruleId: "cadillac-blackwing",
    make: "Cadillac",
    trimPattern: /Blackwing/i,
    promotedModel: (b) => b,
    hardwareStandard: true,
  },
  // V-Series (CTS-V, ATS-V, CT5-V, CT4-V) — V trims have upgraded brakes.
  {
    ruleId: "cadillac-v-series",
    make: "Cadillac",
    trimPattern: /-?V\b|\bV-?Series\b/i,
    promotedModel: (b) => b,
    hardwareStandard: true,
  },

  // ─── Dodge ────────────────────────────────────────────────────────────────
  // SRT Hellcat / Demon / SRT8 / Redeye / Jailbreak — all have Brembo halo brakes.
  {
    ruleId: "dodge-srt-halo",
    make: "Dodge",
    trimPattern: /\b(Hellcat|Demon|SRT\s*8|Redeye|Jailbreak|Super\s*Stock)\b/i,
    promotedModel: (b) => b,
    hardwareStandard: true,
  },
  // Generic SRT (covers Durango SRT 392 etc.).
  {
    ruleId: "dodge-srt",
    make: "Dodge",
    trimPattern: /\bSRT\b/i,
    promotedModel: (b) => b,
    hardwareStandard: true,
  },

  // ─── Jeep ─────────────────────────────────────────────────────────────────
  // Grand Cherokee Trackhawk / SRT — Hellcat / Hemi halo with Brembo brakes.
  {
    ruleId: "jeep-trackhawk-srt",
    make: "Jeep",
    trimPattern: /\b(Trackhawk|SRT)\b/i,
    promotedModel: (b) => b,
    hardwareStandard: true,
  },
  // Wrangler 392 — V8 Rubicon with upgraded brakes.
  {
    ruleId: "jeep-wrangler-392",
    make: "Jeep",
    modelPattern: /Wrangler/i,
    trimPattern: /\b392\b/i,
    promotedModel: (b) => b,
    hardwareStandard: true,
  },

  // ─── Ford ─────────────────────────────────────────────────────────────────
  // Mustang Shelby (GT350, GT350R, GT500) — Brembo halo brakes.
  {
    ruleId: "ford-mustang-shelby",
    make: "Ford",
    modelPattern: /Mustang/i,
    trimPattern: /\b(Shelby|GT\s*3?50|GT500)\b/i,
    promotedModel: (b) => b,
    hardwareStandard: true,
  },
  // F-150 Raptor / Raptor R — its own platform.
  {
    ruleId: "ford-raptor",
    make: "Ford",
    trimPattern: /\bRaptor\b/i,
    promotedModel: (b) => b,
    hardwareStandard: true,
  },

  // ─── Chevrolet ────────────────────────────────────────────────────────────
  // Corvette Z06 / ZR1 / E-Ray / Grand Sport — halo trims of an already-halo model.
  {
    ruleId: "chevy-corvette-halo",
    make: "Chevrolet",
    modelPattern: /Corvette/i,
    trimPattern: /\b(Z06|ZR1|E-?Ray|Grand\s*Sport)\b/i,
    promotedModel: (b) => b,
    hardwareStandard: true,
  },
  // Camaro ZL1 / Z/28 / SS 1LE.
  {
    ruleId: "chevy-camaro-halo",
    make: "Chevrolet",
    modelPattern: /Camaro/i,
    trimPattern: /\b(ZL1|Z\/?28|1LE)\b/i,
    promotedModel: (b) => b,
    hardwareStandard: true,
  },

  // ─── Lexus ────────────────────────────────────────────────────────────────
  // F variants (IS F, GS F, RC F, LC F, LFA). "F SPORT" is NOT an F variant —
  // negative lookahead excludes the false positive.
  {
    ruleId: "lexus-f",
    make: "Lexus",
    trimPattern: /\bF\b(?!\s*SPORT)/i,
    promotedModel: (b) => b,
    hardwareStandard: true,
  },

  // ─── Subaru ───────────────────────────────────────────────────────────────
  // WRX STI — model is usually "WRX" with trim "STI". STI ships upgraded
  // Brembo brakes vs. base WRX.
  {
    ruleId: "subaru-sti",
    make: "Subaru",
    trimPattern: /\bSTI\b/i,
    promotedModel: (b) => b,
    hardwareStandard: true,
  },

  // ─── Toyota ───────────────────────────────────────────────────────────────
  // GR Supra / GR Corolla / GR86 / GR Yaris — Gazoo Racing halos.
  // Most catalogs file these as standalone (`toyota/gr-corolla`).
  {
    ruleId: "toyota-gr",
    make: "Toyota",
    trimPattern: /^\s*GR\b/i,
    promotedModel: (_b, m) => `GR ${m.input!.replace(/^\s*GR\s+/i, "").split(/\s+/)[0]}`.trim(),
    hardwareStandard: true,
  },
  // Older TRD Pro variants (Tacoma TRD Pro, 4Runner TRD Pro) — upgraded brakes/susp.
  {
    ruleId: "toyota-trd-pro",
    make: "Toyota",
    trimPattern: /TRD\s+Pro/i,
    promotedModel: (b) => b,
    hardwareStandard: true,
  },

  // ─── Nissan / Infiniti ────────────────────────────────────────────────────
  // GT-R — its own model.
  {
    ruleId: "nissan-gt-r",
    make: "Nissan",
    trimPattern: /\bGT-?R\b/i,
    promotedModel: "GT-R",
    hardwareStandard: true,
  },
  // NISMO variants (370Z NISMO, Z NISMO).
  {
    ruleId: "nissan-nismo",
    make: "Nissan",
    trimPattern: /\bNISMO\b/i,
    promotedModel: (b) => b,
    hardwareStandard: true,
  },

  // ─── Porsche ──────────────────────────────────────────────────────────────
  // 911 GT3 / GT2 / GT3 RS / GT2 RS — halo brakes (often PCCB optional).
  {
    ruleId: "porsche-911-gt",
    make: "Porsche",
    modelPattern: /911/i,
    trimPattern: /\bGT[23](\s+RS)?\b/i,
    promotedModel: (b) => b,
    hardwareStandard: true,
  },
  // Cayman / Boxster GT4 / Spyder.
  {
    ruleId: "porsche-718-gt",
    make: "Porsche",
    trimPattern: /\b(GT4|Spyder\s*RS|Spyder)\b/i,
    promotedModel: (b) => b,
    hardwareStandard: true,
  },
  // Turbo S — top brake spec across the lineup.
  {
    ruleId: "porsche-turbo-s",
    make: "Porsche",
    trimPattern: /Turbo\s+S\b/i,
    promotedModel: (b) => b,
    hardwareStandard: true,
  },

  // ─── Hyundai / Kia / Genesis ──────────────────────────────────────────────
  // Hyundai N (Elantra N, Veloster N, Kona N, i30 N).
  {
    ruleId: "hyundai-n",
    make: "Hyundai",
    trimPattern: /^\s*N\b|N\s+Line\s+Plus/i,
    promotedModel: (b) => b,
    hardwareStandard: true,
  },
  // Kia GT (Stinger GT) — Brembo halo on GT.
  {
    ruleId: "kia-stinger-gt",
    make: "Kia",
    modelPattern: /Stinger/i,
    trimPattern: /\bGT\b/i,
    promotedModel: (b) => b,
    hardwareStandard: true,
  },

  // ─── Volkswagen ───────────────────────────────────────────────────────────
  // Golf R / GTI — sport hardware standard.
  {
    ruleId: "vw-golf-halo",
    make: "Volkswagen",
    modelPattern: /Golf/i,
    trimPattern: /\b(GTI|R)\b/i,
    promotedModel: "Golf",
    hardwareStandard: true,
  },
];

/**
 * Find the halo-variant rule (if any) matching this make/model/trim.
 * Returns the resolved promotedModel + hardwareStandard, or null if no rule
 * applies. Pure / synchronous — safe to call from queries.
 */
export function findHaloVariant(
  make: string,
  model: string,
  trim: string,
): HaloVariantMatch | null {
  const m = (make ?? "").toLowerCase();
  const modelStr = model ?? "";
  const trimStr = trim ?? "";

  for (const rule of HALO_VARIANT_RULES) {
    if (rule.make.toLowerCase() !== m) continue;
    if (rule.modelPattern && !rule.modelPattern.test(modelStr)) continue;
    const match = trimStr.match(rule.trimPattern);
    if (!match) continue;
    const promoted =
      typeof rule.promotedModel === "string"
        ? rule.promotedModel
        : rule.promotedModel(modelStr, match);
    return {
      ruleId: rule.ruleId,
      promotedModel: promoted.replace(/\s+/g, " ").trim(),
      hardwareStandard: rule.hardwareStandard,
    };
  }
  return null;
}
