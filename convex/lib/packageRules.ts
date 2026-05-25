/**
 * lib/packageRules.ts — Curated rules for detecting service-impacting packages.
 *
 * Each rule maps a make + a regex (matched against VDB option strings, trim names,
 * or installed-equipment entries) to a normalized package code with:
 *   - canonical label
 *   - which of the 23 services it affects
 *   - confidence weight (0–1)
 *
 * Rules whose `services_affected` doesn't intersect the 23 services are filtered out
 * by assessAvailablePackages — we only care about packages that change parts.
 *
 * See docs/PACKAGE_AWARE_PARTS.md.
 */

export interface PackageRule {
  /** Make this rule applies to. "*" = any make. */
  make: string;
  /** Regex matched (case-insensitive) against VDB option/equipment/trim strings. */
  pattern: RegExp;
  /** Normalized code stored on vehicle_configs.packages_available[].code. */
  code: string;
  /** Human-readable label for UI. */
  label: string;
  /** Service slugs (from seed_services_catalog) this package affects. */
  services_affected: string[];
  /** Confidence weight if matched. VDB explicit hits will scale this up; trim-name inference scales it down. */
  base_confidence: number;
  /**
   * When true, this rule is skipped if the vehicle matches a halo-variant rule
   * (lib/haloVariantRules.ts) with hardwareStandard=true. Use for "sport-line"
   * package codes whose hardware is already baseline on the halo trim — e.g.
   * m_sport on an M3, amg_line on an AMG GT, audi_s_line on an RS4. Without
   * this gate the same brakes/rotors get double-counted and quoting upsells
   * parts the customer already has.
   */
  redundant_when_halo?: boolean;
}

/**
 * Service slugs from seed_services_catalog.ts. Centralized so rules stay in sync.
 * If a slug here doesn't appear in services.slug, the rule has no effect.
 */
export const KNOWN_SERVICE_SLUGS = [
  "oil-change",
  "engine-air-filter",
  "cabin-air-filter",
  "wiper-blade-replacement",
  "spark-plug-replacement",
  "serpentine-belt-replacement",
  "battery-replacement",
  "battery-test",
  "coolant-flush",
  "transmission-fluid-service",
  "brake-pad-replacement",
  "brake-rotor-replacement",
  "brake-fluid-flush",
  "tire-rotation",
  "wheel-balancing",
  "wheel-alignment",
  "tire-replacement",
  "tire-installation",
  "tpms-sensor-calibration",
  "ny-state-inspection",
  "general-diagnostic",
  "check-engine-light",
  "brake-system-inspection",
] as const;

export type ServiceSlug = (typeof KNOWN_SERVICE_SLUGS)[number];

/**
 * Initial rules table. Expand as we encounter packages in the wild.
 *
 * Naming convention for codes: snake_case, make-prefixed where ambiguous.
 * Order doesn't matter; assessAvailablePackages dedupes by code.
 */
export const PACKAGE_RULES: PackageRule[] = [
  // ─── BMW ────────────────────────────────────────────────────────────────────
  {
    make: "BMW",
    pattern: /\bM\s*Performance\s+Brake/i,
    code: "m_performance_brakes",
    label: "M Performance Brake Package",
    services_affected: ["brake-pad-replacement", "brake-rotor-replacement"],
    base_confidence: 0.95,
    redundant_when_halo: true,
  },
  {
    make: "BMW",
    pattern: /\bM\s*Performance\b(?!.*Brake)/i,
    code: "m_performance",
    label: "M Performance Package",
    services_affected: ["brake-pad-replacement", "brake-rotor-replacement"],
    base_confidence: 0.85,
    redundant_when_halo: true,
  },
  {
    make: "BMW",
    // Only match hardware-bearing M Sport designations, NOT interior trim items
    // like "M Sport Steering Wheel" or "M Sport Seats" — those ship standard on
    // M-cars and were causing false m_sport detection on M3/M5/etc, which then
    // surfaced the wrong brake/rotor specs in quoting.
    pattern: /\bM\s*Sport\s+(Package|Suspension|Brakes?|Differential|Plus|Pro|II)\b/i,
    code: "m_sport",
    label: "M Sport Package",
    services_affected: ["brake-pad-replacement", "brake-rotor-replacement"],
    base_confidence: 0.85,
    redundant_when_halo: true,
  },
  {
    make: "BMW",
    pattern: /\bTrack\s+Handling\b/i,
    code: "track_handling",
    label: "Track Handling Package",
    services_affected: ["brake-pad-replacement", "brake-rotor-replacement", "tire-replacement"],
    base_confidence: 0.9,
  },
  {
    make: "BMW",
    pattern: /\bCold\s+Weather\b/i,
    code: "cold_weather",
    label: "Cold Weather Package",
    services_affected: ["battery-replacement"],
    base_confidence: 0.85,
  },

  // ─── Mercedes-Benz ──────────────────────────────────────────────────────────
  {
    make: "Mercedes-Benz",
    pattern: /\bAMG\s+Performance\s+Brake/i,
    code: "amg_performance_brakes",
    label: "AMG Performance Brake Package",
    services_affected: ["brake-pad-replacement", "brake-rotor-replacement"],
    base_confidence: 0.95,
    redundant_when_halo: true,
  },
  {
    make: "Mercedes-Benz",
    pattern: /\bAMG\s+Track\s+Pace\b/i,
    code: "amg_track_pace",
    label: "AMG Track Pace",
    services_affected: ["brake-pad-replacement", "brake-rotor-replacement", "tire-replacement"],
    base_confidence: 0.9,
  },
  {
    make: "Mercedes-Benz",
    pattern: /\bAMG\s+Line\b/i,
    code: "amg_line",
    label: "AMG Line",
    services_affected: ["brake-pad-replacement", "brake-rotor-replacement"],
    base_confidence: 0.8,
    redundant_when_halo: true,
  },

  // ─── Audi ───────────────────────────────────────────────────────────────────
  {
    make: "Audi",
    pattern: /\bS\s*line\b/i,
    code: "audi_s_line",
    label: "S line Package",
    services_affected: ["brake-pad-replacement", "brake-rotor-replacement"],
    base_confidence: 0.8,
    redundant_when_halo: true,
  },
  {
    make: "Audi",
    pattern: /\bDynamic\s+(?:Plus|Package)\b/i,
    code: "audi_dynamic",
    label: "Dynamic Package",
    services_affected: ["brake-pad-replacement", "brake-rotor-replacement", "tire-replacement"],
    base_confidence: 0.85,
  },
  {
    make: "Audi",
    pattern: /\bCarbon\s+Ceramic\b/i,
    code: "audi_ceramic_brakes",
    label: "Carbon Ceramic Brakes",
    services_affected: ["brake-pad-replacement", "brake-rotor-replacement"],
    base_confidence: 0.95,
  },

  // ─── Porsche ────────────────────────────────────────────────────────────────
  {
    make: "Porsche",
    pattern: /\bPCCB\b|Porsche\s+Ceramic/i,
    code: "porsche_pccb",
    label: "Porsche Ceramic Composite Brakes (PCCB)",
    services_affected: ["brake-pad-replacement", "brake-rotor-replacement"],
    base_confidence: 0.95,
  },
  {
    make: "Porsche",
    pattern: /\bPSCB\b|Surface\s+Coated/i,
    code: "porsche_pscb",
    label: "Porsche Surface Coated Brakes (PSCB)",
    services_affected: ["brake-pad-replacement", "brake-rotor-replacement"],
    base_confidence: 0.95,
  },

  // ─── Generic / cross-make ───────────────────────────────────────────────────
  {
    make: "*",
    pattern: /\bTow(?:ing)?\s+Package\b|\bTrailer(?:ing)?\s+Package\b/i,
    code: "tow_package",
    label: "Tow Package",
    services_affected: ["transmission-fluid-service", "coolant-flush"],
    base_confidence: 0.8,
  },
  {
    make: "*",
    pattern: /\bHeavy[\s-]Duty\s+Battery\b|\bHD\s+Battery\b/i,
    code: "hd_battery",
    label: "Heavy-Duty Battery",
    services_affected: ["battery-replacement", "battery-test"],
    base_confidence: 0.9,
  },
  {
    make: "*",
    pattern: /\bOff[\s-]Road\s+Package\b/i,
    code: "off_road",
    label: "Off-Road Package",
    services_affected: ["tire-replacement", "tire-rotation"],
    base_confidence: 0.85,
  },
  {
    make: "*",
    pattern: /\bSummer\s+Performance\s+Tire/i,
    code: "summer_performance_tires",
    label: "Summer Performance Tires",
    services_affected: ["tire-replacement", "tire-installation"],
    base_confidence: 0.9,
  },
];

/**
 * Trim-name patterns that imply a package even when the option isn't explicit.
 * Lower confidence than VDB explicit hits.
 *
 * Example: a "M340i" trim implies M Sport at the very least.
 */
export const TRIM_INFERENCE_RULES: PackageRule[] = [
  {
    make: "BMW",
    // Only fire on M-Sport BADGED trims: M240i, M340i, M440i, M550i, M760i, etc.
    // Pure M-cars (M2/M3/M4/M5/M6/M8) and X-M cars (X3 M, X4 M, X5 M, X6 M, X7 M)
    // are real M-cars — they ship M Performance hardware as standard, not as a
    // package. They're caught by the haloVariantRules table; we also tighten
    // this regex (M\d{3}i — exactly 3 digits + i) so it can't match them in
    // the first place. The redundant_when_halo flag belt-and-braces this.
    pattern: /\bM\d{3}i\b/i,
    code: "m_sport",
    label: "M Sport Package (inferred from trim)",
    services_affected: ["brake-pad-replacement", "brake-rotor-replacement"],
    base_confidence: 0.6,
    redundant_when_halo: true,
  },
  {
    make: "Audi",
    pattern: /\bS\d\b|\bRS\d\b/i, // S3, S4, S5, RS6, etc.
    code: "audi_s_line",
    label: "S line Package (inferred from trim)",
    services_affected: ["brake-pad-replacement", "brake-rotor-replacement"],
    base_confidence: 0.6,
    redundant_when_halo: true,
  },
  {
    make: "Mercedes-Benz",
    pattern: /\bAMG\b/i,
    code: "amg_line",
    label: "AMG Line (inferred from trim)",
    services_affected: ["brake-pad-replacement", "brake-rotor-replacement"],
    base_confidence: 0.6,
    redundant_when_halo: true,
  },
];
