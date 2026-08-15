/**
 * convex/lib/inspectionHealth.ts — pure, Convex-only, scoring only.
 *
 * Turns a submitted multi-point inspection's zone data into the grade
 * fields `convex/maintenance.ts`'s `mergeMechanicGradeIntoRecord` persists
 * into `maintenance_records.customInputs`. Pure function — no `ctx`, no DB
 * reads. The one exception (brake fluid decline detection needs the
 * *previous* inspection's reading) is handled by the caller passing that
 * value in via `opts.previousBfLevel`, keeping this module itself free of
 * side effects and fully unit-testable.
 *
 * See the plan sections "Inspection → core-type mapping," "Proportional
 * severity for brakes," and "Brake fluid level as a brake-wear signal."
 */

import {
  classify,
  BF_LEVEL_RANK,
  INSPECTION_ZONES_BY_ID,
  type CornerZoneId,
  type InspectionState,
  type TriValue,
  type ZoneState,
} from "../../lib/inspection-template";

export type CoreType = "oil" | "brakes" | "tires" | "battery";
export type MinorType = "cool_condition" | "trans" | "ps" | "filter" | "bf_condition";

export type CoreGrade = {
  grade: TriValue;
  reason: string;
  /** Brakes-only per-corner + brake-fluid blended float, 0–1. `min()`'d
   *  against the interval's own score downstream in
   *  utils/maintenanceStatus.ts's computeBrakeStatusCore. */
  rawScore?: number;
};

/** Minor items only ever appear here when flagged yellow/red — green stays
 *  inert and simply produces no entry (Consolidated model: a fully-green
 *  minor item shouldn't dilute the weighted average). */
export type MinorGrade = { grade: "y" | "r"; reason: string };

export type DeriveCoreGradesResult = {
  core: Partial<Record<CoreType, CoreGrade>>;
  minor: Partial<Record<MinorType, MinorGrade>>;
};

const SCORE_BY_LEVEL = { g: 1.0, y: 0.35, r: 0.1 } as const;
const GRADE_RANK: Record<TriValue, number> = { g: 0, y: 1, r: 2 };

function worstGrade(a: TriValue, b: TriValue): TriValue {
  return GRADE_RANK[b] > GRADE_RANK[a] ? b : a;
}

const CORNER_IDS: readonly CornerZoneId[] = ["FL", "FR", "RL", "RR"];

// ---------------------------------------------------------------------------
// oil — single field, no per-corner
// ---------------------------------------------------------------------------

function deriveOilGrade(state: InspectionState): CoreGrade | undefined {
  const grade = state.zones.ENG?.tri.oil_condition;
  if (!grade) return undefined;
  return {
    grade,
    reason:
      grade === "g"
        ? "Oil condition checked — no issues"
        : "Oil condition flagged during inspection",
  };
}

// ---------------------------------------------------------------------------
// tires — worst of 4 corners: tread classify() + wear tri
// ---------------------------------------------------------------------------

function deriveTiresGrade(state: InspectionState): CoreGrade | undefined {
  let worst: TriValue | undefined;
  let reason = "";
  let sawAny = false;

  for (const id of CORNER_IDS) {
    const zs = state.zones[id];
    if (!zs) continue;
    const treadField = INSPECTION_ZONES_BY_ID[id].fields.find(
      (f) => f.type === "measure" && f.key === "tread",
    );
    let treadGrade: TriValue | null = null;
    if (treadField && treadField.type === "measure" && !zs.statuses.tread) {
      const raw = zs.measures.tread;
      if ((raw ?? "").trim() !== "") {
        sawAny = true;
        const res = classify("tread", raw, treadField.ref);
        if (res.lvl === "bad") treadGrade = "r";
        else if (res.lvl === "warn") treadGrade = "y";
      }
    }
    const wear = zs.statuses.wear ? undefined : zs.tri.wear;
    if (wear) sawAny = true;

    // Priority within a corner: tread-depth > wear-tri (matches the
    // reason-string priority in "Inspection → core-type mapping").
    let cornerGrade: TriValue | null = null;
    let cornerReason = "";
    if (treadGrade) {
      cornerGrade = treadGrade;
      cornerReason = "Tread depth critically low";
    }
    if (wear && wear !== "g" && (!cornerGrade || GRADE_RANK[wear] > GRADE_RANK[cornerGrade])) {
      cornerGrade = wear;
      cornerReason = "Uneven tire wear reported";
    }
    if (cornerGrade) {
      if (!worst || GRADE_RANK[cornerGrade] > GRADE_RANK[worst]) {
        worst = cornerGrade;
        reason = cornerReason;
      }
    }
  }

  if (!sawAny) return undefined;
  return { grade: worst ?? "g", reason: worst ? reason : "Tires checked — no issues" };
}

// ---------------------------------------------------------------------------
// battery — batt classify() + term tri, worst
// ---------------------------------------------------------------------------

function deriveBatteryGrade(state: InspectionState): CoreGrade | undefined {
  const eng = state.zones.ENG;
  if (!eng) return undefined;
  const battField = INSPECTION_ZONES_BY_ID.ENG.fields.find(
    (f) => f.type === "measure" && f.key === "batt",
  );
  let battGrade: TriValue | null = null;
  let sawAny = false;
  if (battField && battField.type === "measure" && !eng.statuses.batt) {
    const raw = eng.measures.batt;
    if ((raw ?? "").trim() !== "") {
      sawAny = true;
      const res = classify("batt", raw, battField.ref);
      if (res.lvl === "bad") battGrade = "r";
      else if (res.lvl === "warn") battGrade = "y";
    }
  }
  const term = eng.statuses.term ? undefined : eng.tri.term;
  if (term) sawAny = true;

  // Priority: load-test > terminals.
  let grade: TriValue | null = null;
  let reason = "";
  if (battGrade) {
    grade = battGrade;
    reason = "Battery load test below spec";
  }
  if (term && term !== "g" && (!grade || GRADE_RANK[term] > GRADE_RANK[grade])) {
    grade = term;
    reason = "Corroded/loose battery terminals reported";
  }

  if (!sawAny) return undefined;
  return { grade: grade ?? "g", reason: grade ? reason : "Battery checked — no issues" };
}

// ---------------------------------------------------------------------------
// brakes — per-corner blend (pad/rotor/brake_visual) + category-level
// brake fluid level (decline-gated) + leak. See "Proportional severity for
// brakes" and "Brake fluid level as a brake-wear signal."
// ---------------------------------------------------------------------------

type CornerBrakeFinding = {
  gradeLevel: TriValue;
  /** Which signal drove this corner's grade, for the reason-string
   *  priority below. null when the corner is clean. */
  signal: "rotor_thickness" | "pad_thickness" | "rotor_surface" | "visual" | null;
};

function deriveCornerBrakeFinding(id: CornerZoneId, zs: ZoneState): CornerBrakeFinding {
  const rotorField = INSPECTION_ZONES_BY_ID[id].fields.find(
    (f) => f.type === "measure" && f.key === "rotor",
  );
  const rotorApplicable = zs.select.rotor_applicable !== "no";

  // Pad thickness — worst of inner/outer.
  let padLevel: "ok" | "warn" | "bad" | null = null;
  for (const key of ["pad_inner", "pad_outer"] as const) {
    if (zs.statuses[key]) continue;
    const raw = zs.measures[key];
    if ((raw ?? "").trim() === "") continue;
    const res = classify("pad", raw, null);
    if (res.lvl === "none") continue;
    if (!padLevel || (res.lvl === "bad") || (res.lvl === "warn" && padLevel === "ok")) {
      padLevel = res.lvl as "ok" | "warn" | "bad";
    }
  }

  // Rotor thickness (only when a rotor is actually present on this corner).
  let rotorThicknessLevel: "ok" | "warn" | "bad" | null = null;
  if (rotorApplicable && rotorField && rotorField.type === "measure" && !zs.statuses.rotor) {
    const raw = zs.measures.rotor;
    if ((raw ?? "").trim() !== "") {
      const res = classify("rotor", raw, rotorField.ref);
      if (res.lvl !== "none") rotorThicknessLevel = res.lvl as "ok" | "warn" | "bad";
    }
  }

  // Rotor surface descriptors — only a distinct (yellow-tier) signal when
  // thickness itself is normal; a below-min thickness already covers it.
  const descs = zs.statuses.desc ? [] : zs.descriptors.desc ?? [];
  const rotorSurfaceBad =
    rotorApplicable &&
    rotorThicknessLevel !== "bad" &&
    descs.some((d) => ["scored", "pitted", "grooved", "warped"].includes(d));

  const visual = zs.statuses.brake_visual ? undefined : zs.tri.brake_visual;

  // Priority: rotor-thickness > pad-thickness > rotor-surface > visual.
  if (rotorThicknessLevel === "bad") return { gradeLevel: "r", signal: "rotor_thickness" };
  if (padLevel === "bad") return { gradeLevel: "r", signal: "pad_thickness" };
  if (rotorThicknessLevel === "warn") return { gradeLevel: "y", signal: "rotor_thickness" };
  if (padLevel === "warn") return { gradeLevel: "y", signal: "pad_thickness" };
  if (rotorSurfaceBad) return { gradeLevel: "y", signal: "rotor_surface" };
  if (visual === "r") return { gradeLevel: "r", signal: "visual" };
  if (visual === "y") return { gradeLevel: "y", signal: "visual" };
  return { gradeLevel: "g", signal: null };
}

const BRAKE_REASON_BY_SIGNAL: Record<
  Exclude<CornerBrakeFinding["signal"], null>,
  string
> = {
  rotor_thickness: "Rotor below minimum spec",
  pad_thickness: "Brake pad thickness critically low",
  rotor_surface: "Rotor surface scored/warped",
  visual: "Uneven brake wear reported",
};
// Priority order — first present signal, across all 4 corners, wins the
// category-level reason string (independent of which single corner is
// numerically worst).
const SIGNAL_PRIORITY: ReadonlyArray<Exclude<CornerBrakeFinding["signal"], null>> = [
  "rotor_thickness",
  "pad_thickness",
  "rotor_surface",
  "visual",
];

function deriveBrakesGrade(
  state: InspectionState,
  opts?: { previousBfLevel?: string },
): CoreGrade | undefined {
  const findings: Partial<Record<CornerZoneId, CornerBrakeFinding>> = {};
  let sawAnyCorner = false;
  for (const id of CORNER_IDS) {
    const zs = state.zones[id];
    if (!zs) continue;
    sawAnyCorner = true;
    findings[id] = deriveCornerBrakeFinding(id, zs);
  }

  const eng = state.zones.ENG;
  const bfLevel = eng?.statuses.bf_level ? "" : eng?.select.bf_level ?? "";
  const bfLeak = eng?.statuses.bf_leak ? "" : eng?.select.bf_leak ?? "";
  const sawBf = !!bfLevel || !!bfLeak;

  if (!sawAnyCorner && !sawBf) return undefined;

  // --- Per-corner blend (brakes-only rawScore ingredient #1) ---
  let blendSum = 0;
  let blendCount = 0;
  for (const id of CORNER_IDS) {
    const f = findings[id];
    blendSum += f ? SCORE_BY_LEVEL[f.gradeLevel] : SCORE_BY_LEVEL.g;
    blendCount += 1;
  }
  const blendedCornerScore = blendCount > 0 ? blendSum / blendCount : 1.0;

  // --- Brake fluid level (decline-gated, leak-free) + leak (ingredients #2/#3) ---
  let fluidLevelScore = 1.0;
  let leakScore = 1.0;
  if (bfLeak === "yes") {
    leakScore = 0.1;
  } else if (bfLevel && opts?.previousBfLevel) {
    const prevRank = BF_LEVEL_RANK[opts.previousBfLevel];
    const curRank = BF_LEVEL_RANK[bfLevel];
    if (prevRank != null && curRank != null && curRank < prevRank) {
      // A genuine decline since the previous inspection for this VIN.
      if (bfLevel === "high") fluidLevelScore = 0.7;
      else if (bfLevel === "mid") fluidLevelScore = 0.35;
      else fluidLevelScore = 0.1; // low / min
    }
  }

  const rawScore = Math.min(blendedCornerScore, fluidLevelScore, leakScore);

  // --- Simple g/y/r grade + reason for status/description worst-of.
  // Leak is the one deliberate exception that overrides display; a
  // leak-free fluid-level decline stays numeric-only (rawScore above),
  // never touching grade/reason here. ---
  if (bfLeak === "yes") {
    return {
      grade: "r",
      reason: "Active brake fluid leak reported",
      rawScore,
    };
  }

  let worstSignal: Exclude<CornerBrakeFinding["signal"], null> | null = null;
  let worstLevel: TriValue = "g";
  for (const signal of SIGNAL_PRIORITY) {
    const hit = Object.values(findings).find((f) => f?.signal === signal);
    if (hit) {
      worstSignal = signal;
      worstLevel = hit.gradeLevel;
      break;
    }
  }
  // Worst corner grade even without a specific named signal (shouldn't
  // happen given the priority list above covers every non-"g" signal, but
  // keep the plain worst-of as a defensive fallback).
  if (!worstSignal) {
    for (const f of Object.values(findings)) {
      if (f && GRADE_RANK[f.gradeLevel] > GRADE_RANK[worstLevel]) worstLevel = f.gradeLevel;
    }
  }

  return {
    grade: worstLevel,
    reason: worstSignal ? BRAKE_REASON_BY_SIGNAL[worstSignal] : "Brakes checked — no issues",
    rawScore,
  };
}

// ---------------------------------------------------------------------------
// Minor items — catalog-matched, Consolidated model. Only ever produced
// when flagged yellow/red; green creates no entry at all.
// ---------------------------------------------------------------------------

function deriveMinorGrades(state: InspectionState): Partial<Record<MinorType, MinorGrade>> {
  const eng = state.zones.ENG;
  const minor: Partial<Record<MinorType, MinorGrade>> = {};
  if (!eng) return minor;

  const fromTri = (fieldKey: string, label: string): MinorGrade | undefined => {
    const v = eng.statuses[fieldKey] ? undefined : eng.tri[fieldKey];
    if (!v || v === "g") return undefined;
    return { grade: v, reason: `${label} flagged on eye-check` };
  };

  const coolCondition = fromTri("cool_condition", "Coolant condition");
  if (coolCondition) minor.cool_condition = coolCondition;

  const trans = fromTri("trans", "Transmission fluid");
  if (trans) minor.trans = trans;

  const ps = fromTri("ps", "Power steering fluid");
  if (ps) minor.ps = ps;

  const bfCondition = fromTri("bf_condition", "Brake fluid condition");
  if (bfCondition) minor.bf_condition = bfCondition;

  // Air + cabin filters share one weight-10 line — worst of the two.
  const af = eng.statuses.af ? undefined : eng.tri.af;
  const cf = eng.statuses.cf ? undefined : eng.tri.cf;
  const filterWorst =
    af && cf ? worstGrade(af, cf) : af ?? cf;
  if (filterWorst && filterWorst !== "g") {
    minor.filter = { grade: filterWorst, reason: "Air / cabin filter flagged on eye-check" };
  }

  return minor;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Derive every core + minor grade from one submitted inspection's zones.
 * `shopId`/`now` aren't consumed here (the caller stamps
 * `mechanicGradeSource`/`mechanicGradedAt` when persisting via
 * `mergeMechanicGradeIntoRecord`) — kept on the signature per the plan so
 * callers don't have to thread them separately, and so a future self-check
 * here can stamp reasons with a timestamp if useful.
 */
export function deriveCoreGrades(
  state: InspectionState,
  _shopId: string,
  _now: number,
  opts?: { previousBfLevel?: string },
): DeriveCoreGradesResult {
  const core: Partial<Record<CoreType, CoreGrade>> = {};
  const oil = deriveOilGrade(state);
  if (oil) core.oil = oil;
  const brakes = deriveBrakesGrade(state, opts);
  if (brakes) core.brakes = brakes;
  const tires = deriveTiresGrade(state);
  if (tires) core.tires = tires;
  const battery = deriveBatteryGrade(state);
  if (battery) core.battery = battery;

  return { core, minor: deriveMinorGrades(state) };
}

/** Self-check — run via `node -e` or a small test, not wired into any
 *  request path. Exercises worst-of, green-inert, reason-string priority,
 *  and the per-corner blend boundary cases (0/1/2/3/4 corners affected). */
export function __selfCheck(): void {
  const assertEq = (actual: unknown, expected: unknown, label: string) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`__selfCheck failed: ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  };

  const emptyZone = (): ZoneState => ({
    done: true,
    dirty: false,
    measures: {},
    tri: {},
    descriptors: {},
    text: {},
    select: {},
    statuses: {},
    methods: {},
    photoIds: [],
    photoTags: {},
    lights: {},
  });

  // Green is inert: all corners clean, no bf signal → no core.brakes entry
  // beyond a "g" grade with a perfect blend.
  {
    const zones: InspectionState["zones"] = {};
    for (const id of CORNER_IDS) {
      zones[id] = { ...emptyZone(), tri: { brake_visual: "g" } };
    }
    const result = deriveCoreGrades({ template_version: "test", zones }, "shop", Date.now());
    assertEq(result.core.brakes?.grade, "g", "all-clean brakes grade");
    assertEq(result.core.brakes?.rawScore, 1.0, "all-clean brakes rawScore");
  }

  // One corner red pad → blended 0.25×0.1 + 0.75×1.0 = 0.775.
  {
    const zones: InspectionState["zones"] = {};
    for (const id of CORNER_IDS) {
      zones[id] = { ...emptyZone(), tri: { brake_visual: "g" } };
    }
    zones.FL = {
      ...emptyZone(),
      tri: { brake_visual: "g" },
      measures: { pad_inner: "2", pad_outer: "2" },
    };
    const result = deriveCoreGrades({ template_version: "test", zones }, "shop", Date.now());
    if (!result.core.brakes || Math.abs(result.core.brakes.rawScore! - 0.775) > 0.001) {
      throw new Error(`__selfCheck failed: one-corner-red blend — got ${result.core.brakes?.rawScore}`);
    }
    assertEq(result.core.brakes.reason, "Brake pad thickness critically low", "one-corner-red reason");
  }

  // Two corners red → 0.5×0.1 + 0.5×1.0 = 0.55, strictly worse than one.
  {
    const zones: InspectionState["zones"] = {};
    for (const id of CORNER_IDS) {
      zones[id] = { ...emptyZone(), tri: { brake_visual: "g" } };
    }
    zones.FL = { ...emptyZone(), tri: { brake_visual: "g" }, measures: { pad_inner: "2", pad_outer: "2" } };
    zones.FR = { ...emptyZone(), tri: { brake_visual: "g" }, measures: { pad_inner: "2", pad_outer: "2" } };
    const result = deriveCoreGrades({ template_version: "test", zones }, "shop", Date.now());
    if (!result.core.brakes || Math.abs(result.core.brakes.rawScore! - 0.55) > 0.001) {
      throw new Error(`__selfCheck failed: two-corner-red blend — got ${result.core.brakes?.rawScore}`);
    }
  }

  // Leak overrides both score (0.1, unconditional) and reason, regardless
  // of a leak-free decline having also been observed.
  {
    const zones: InspectionState["zones"] = {};
    for (const id of CORNER_IDS) {
      zones[id] = { ...emptyZone(), tri: { brake_visual: "g" } };
    }
    zones.ENG = {
      ...emptyZone(),
      select: { bf_level: "low", bf_leak: "yes" },
    };
    const result = deriveCoreGrades(
      { template_version: "test", zones },
      "shop",
      Date.now(),
      { previousBfLevel: "max" },
    );
    assertEq(result.core.brakes?.grade, "r", "leak grade");
    assertEq(result.core.brakes?.reason, "Active brake fluid leak reported", "leak reason");
    assertEq(result.core.brakes?.rawScore, 0.1, "leak rawScore");
  }

  // Minor item: green produces no entry; yellow does.
  {
    const zones: InspectionState["zones"] = {
      ENG: { ...emptyZone(), tri: { cool_condition: "g" } },
    };
    const clean = deriveCoreGrades({ template_version: "test", zones }, "shop", Date.now());
    assertEq(clean.minor.cool_condition, undefined, "green minor item produces no entry");

    zones.ENG = { ...emptyZone(), tri: { cool_condition: "y" } };
    const flagged = deriveCoreGrades({ template_version: "test", zones }, "shop", Date.now());
    assertEq(flagged.minor.cool_condition?.grade, "y", "flagged minor item grade");
  }
}
