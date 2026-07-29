# Shop-Entered Mods → Affected-Systems Tagging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the per-entry `{location, description}[]` modifications model with `{ has_mods, notes, affected_systems }`, capture it in the Pre-Job survey (Yes/No + notes + affected-system chips + live preview), and ship the system→service "brain" that powers the preview now and the job flag in Phase B.

**Architecture:** A pure mapping module (`lib/vehicle-mod-systems.ts`) is the brain. Data lives on `vehicle_passports.modifications`. We **clear** the 6 existing legacy rows first (so the new validator validates), then reshape via expand→update-consumers→contract so every commit compiles. Spec: [docs/superpowers/specs/2026-06-29-vehicle-mod-systems-design.md](../specs/2026-06-29-vehicle-mod-systems-design.md).

**Tech stack:** Next.js 16 / React 19 (client), Convex, Vitest. Deployment: `dev:flippant-mink-750` (`.env.local`). `npx convex dev --once` = one-shot push.

**Scope:** Phase A only (capture + brain + preview + displays). NO job-flag firing / Surface-2 / `low_clearance` — that's Phase B.

**Baseline notes:** Suite has 3 PRE-EXISTING unrelated failures (`customer_late`, `partSelector`, `timeSlotAvailability`) — not ours. Unrelated uncommitted working-tree files (`components/ui/combobox.tsx`, `components/booking-detail-panel.tsx`) must NOT be staged by any task. Each task commits only its own files.

---

## Canonical shapes (identical across tasks)

```ts
type AffectedSystem =
  | "suspension_ride_height" | "wheels_tires" | "brakes" | "exhaust_emissions"
  | "engine_drivetrain" | "electrical_lighting" | "cosmetic_only";

type VehiclePassportModifications = {
  has_mods: boolean;
  notes?: string | null;
  affected_systems: AffectedSystem[];
};
```

---

### Task 1: The "brain" module + tests (`lib/vehicle-mod-systems.ts`)

**Files:** Create `lib/vehicle-mod-systems.ts`; Create `tests/vehicleModSystems.test.ts`

- [ ] **Step 1: Write the failing tests** — `tests/vehicleModSystems.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AFFECTED_SYSTEMS,
  affectedSystemLabel,
  servicesForSystems,
} from "../lib/vehicle-mod-systems";

describe("affectedSystemLabel", () => {
  it("labels known systems", () => {
    expect(affectedSystemLabel("suspension_ride_height")).toBe("Suspension / ride height");
    expect(affectedSystemLabel("cosmetic_only")).toBe("Cosmetic only");
  });
  it("has 7 systems", () => {
    expect(AFFECTED_SYSTEMS).toHaveLength(7);
  });
});

describe("servicesForSystems", () => {
  it("returns [] for none", () => {
    expect(servicesForSystems([])).toEqual([]);
  });
  it("returns [] for cosmetic_only", () => {
    expect(servicesForSystems(["cosmetic_only"])).toEqual([]);
  });
  it("maps a single system", () => {
    expect(servicesForSystems(["brakes"]).map((s) => s.slug)).toEqual([
      "brake-pad-replacement",
      "rotor-replacement",
      "brake-fluid-flush",
    ]);
  });
  it("dedupes the union of suspension + wheels_tires to exactly 6 services in order", () => {
    expect(servicesForSystems(["suspension_ride_height", "wheels_tires"]).map((s) => s.name)).toEqual([
      "Wheel Alignment",
      "Tire Balance",
      "Tire Rotation",
      "Tire Replacement",
      "Brake Pad Replacement",
      "Rotor Replacement",
    ]);
  });
  it("ignores cosmetic_only when mixed with real systems", () => {
    expect(servicesForSystems(["cosmetic_only", "brakes"]).length).toBe(3);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run tests/vehicleModSystems.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `lib/vehicle-mod-systems.ts`:**

```ts
// The "brain": coarse affected-system tags the shop picks, mapped to the exact
// service slugs they should flag. Powers the live preview at entry time and
// (Phase B) the future-job flag. Pure module — no React, no Convex.

export const AFFECTED_SYSTEMS = [
  { value: "suspension_ride_height", label: "Suspension / ride height" },
  { value: "wheels_tires", label: "Wheels & tires" },
  { value: "brakes", label: "Brakes" },
  { value: "exhaust_emissions", label: "Exhaust / emissions" },
  { value: "engine_drivetrain", label: "Engine / drivetrain" },
  { value: "electrical_lighting", label: "Electrical / lighting" },
  { value: "cosmetic_only", label: "Cosmetic only" },
] as const;

export type AffectedSystem = (typeof AFFECTED_SYSTEMS)[number]["value"];

export function affectedSystemLabel(value: AffectedSystem): string {
  return AFFECTED_SYSTEMS.find((s) => s.value === value)?.label ?? value;
}

export type ModServiceRef = { slug: string; name: string };

// Locked product taxonomy (slug → display name). Slugs need not all exist in a
// given deployment's services table for the preview; Phase B matches booked
// service slugs against the union.
export const SYSTEM_SERVICE_MAP: Record<AffectedSystem, ModServiceRef[]> = {
  suspension_ride_height: [
    { slug: "wheel-alignment", name: "Wheel Alignment" },
    { slug: "tire-balance", name: "Tire Balance" },
    { slug: "tire-rotation", name: "Tire Rotation" },
    { slug: "tire-replacement", name: "Tire Replacement" },
  ],
  wheels_tires: [
    { slug: "tire-balance", name: "Tire Balance" },
    { slug: "wheel-alignment", name: "Wheel Alignment" },
    { slug: "tire-rotation", name: "Tire Rotation" },
    { slug: "tire-replacement", name: "Tire Replacement" },
    { slug: "brake-pad-replacement", name: "Brake Pad Replacement" },
    { slug: "rotor-replacement", name: "Rotor Replacement" },
  ],
  brakes: [
    { slug: "brake-pad-replacement", name: "Brake Pad Replacement" },
    { slug: "rotor-replacement", name: "Rotor Replacement" },
    { slug: "brake-fluid-flush", name: "Brake Fluid Flush" },
  ],
  exhaust_emissions: [
    { slug: "emissions-test", name: "Emissions Test" },
    { slug: "state-inspection-nys", name: "NYS Inspection" },
    { slug: "check-engine-light-diagnosis", name: "Check Engine Light Diagnosis" },
    { slug: "diagnostic-scan", name: "Diagnostic Scan" },
  ],
  engine_drivetrain: [
    { slug: "oil-change", name: "Oil Change" },
    { slug: "spark-plugs", name: "Spark Plugs" },
    { slug: "fuel-system-induction-service", name: "Fuel System / Induction Service" },
    { slug: "filter-replacement", name: "Filter Replacement" },
    { slug: "check-engine-light-diagnosis", name: "Check Engine Light Diagnosis" },
    { slug: "diagnostic-scan", name: "Diagnostic Scan" },
    { slug: "emissions-test", name: "Emissions Test" },
    { slug: "transmission-service", name: "Transmission Service" },
    { slug: "differential-service", name: "Differential Service" },
  ],
  electrical_lighting: [
    { slug: "battery-test", name: "Battery Test" },
    { slug: "battery-replacement", name: "Battery Replacement" },
    { slug: "check-engine-light-diagnosis", name: "Check Engine Light Diagnosis" },
  ],
  cosmetic_only: [],
};

// Distinct union of services for the selected systems, in first-seen order.
// cosmetic_only contributes nothing.
export function servicesForSystems(systems: AffectedSystem[]): ModServiceRef[] {
  const seen = new Set<string>();
  const out: ModServiceRef[] = [];
  for (const sys of systems) {
    for (const svc of SYSTEM_SERVICE_MAP[sys] ?? []) {
      if (!seen.has(svc.slug)) {
        seen.add(svc.slug);
        out.push(svc);
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run, verify pass** — `npx vitest run tests/vehicleModSystems.test.ts` → 6 pass.

- [ ] **Step 5: Commit** — `git add lib/vehicle-mod-systems.ts tests/vehicleModSystems.test.ts && git commit -m "feat(mods): affected-system → service mapping brain"`

---

### Task 2: Clear legacy modifications + retire the old backfill (`convex/migrations.ts`)

**Files:** Modify `convex/migrations.ts`

- [ ] **Step 1: Remove the obsolete `backfillModificationEntries` mutation** (added last cycle; it imports `legacyModificationsToEntries`, which Task 7 deletes). Remove the whole `export const backfillModificationEntries = mutation({...})` block AND its `import { legacyModificationsToEntries } from "../lib/vehicle-passport";` line.

- [ ] **Step 2: Add the clear mutation** (use the existing `mutation` import in the file):

```ts
export const clearAllModifications = mutation({
  args: {},
  handler: async (ctx) => {
    const passports = await ctx.db.query("vehicle_passports").collect();
    let cleared = 0;
    for (const p of passports) {
      if (p.modifications !== undefined) {
        await ctx.db.patch(p._id, { modifications: undefined });
        cleared++;
      }
    }
    return { total: passports.length, cleared };
  },
});
```

- [ ] **Step 3: Push (still the entries validator — removing an optional field is valid):** `npx convex dev --once` → clean.

- [ ] **Step 4: Run it:** `npx convex run migrations:clearAllModifications` → expect `{ total: 25, cleared: 6 }`. Paste result.

- [ ] **Step 5: Verify all rows mods-less:** `npx convex data vehicle_passports | grep -cE "\"entries\"|\"modifications\""` → expect `0`. Paste.

- [ ] **Step 6: Commit** — `git add convex/migrations.ts && git commit -m "chore(mods): clear legacy modifications; drop entries backfill"`

---

### Task 3: Expand the type + validator (both shapes, all optional)

**Files:** Modify `lib/vehicle-passport.ts`; Modify `convex/lib/vehicle_passports.ts`

This is the "expand" step — keep the old `entries` readable AND allow the new fields, all optional, so consumers migrate one file at a time and the schema push still validates (data is already cleared, but this keeps it robust).

- [ ] **Step 1: `convex/lib/vehicle_passports.ts` — add the system validator** (after `nullableBooleanValidator`, near the existing `modLocationValidator`):

```ts
export const affectedSystemValidator = v.union(
  v.literal("suspension_ride_height"),
  v.literal("wheels_tires"),
  v.literal("brakes"),
  v.literal("exhaust_emissions"),
  v.literal("engine_drivetrain"),
  v.literal("electrical_lighting"),
  v.literal("cosmetic_only")
);
```

- [ ] **Step 2: `convex/lib/vehicle_passports.ts` — expand the modifications validator.** Replace:

```ts
export const vehiclePassportModificationsValidator = v.object({
  entries: v.array(vehicleModificationEntryValidator),
});
```
with:
```ts
export const vehiclePassportModificationsValidator = v.object({
  has_mods: v.optional(v.boolean()),
  notes: v.optional(nullableStringValidator),
  affected_systems: v.optional(v.array(affectedSystemValidator)),
  // legacy — removed in the contract step (Task 7)
  entries: v.optional(v.array(vehicleModificationEntryValidator)),
});
```

- [ ] **Step 3: `lib/vehicle-passport.ts` — expand the type.** Replace:

```ts
export type VehiclePassportModifications = {
  entries: VehicleModificationEntry[];
};
```
with:
```ts
import type { AffectedSystem } from "./vehicle-mod-systems";

export type VehiclePassportModifications = {
  has_mods?: boolean;
  notes?: string | null;
  affected_systems?: AffectedSystem[];
  // legacy — removed in the contract step (Task 7)
  entries?: VehicleModificationEntry[];
};
```
(Put the `import type` with the other imports at the top of the file, not mid-file.)

- [ ] **Step 4: Push + typecheck** — `npx convex dev --once` (clean) and `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "vehicle-passport\.ts|vehicle_passports\.ts"` → no NEW errors (old consumers still read `.entries`, which is still allowed).

- [ ] **Step 5: Commit** — `git add lib/vehicle-passport.ts convex/lib/vehicle_passports.ts && git commit -m "feat(mods): expand modifications model to affected-systems (transitional)"`

---

### Task 4: Server writers emit the new shape (`convex/bookings.ts`, `convex/seed.ts`)

**Files:** Modify `convex/bookings.ts`; Modify `convex/seed.ts`

- [ ] **Step 1: `convex/bookings.ts` passport-data builder.** Find:
```ts
    modifications: {
      entries: passportRecord?.modifications?.entries ?? [],
    },
```
Replace with:
```ts
    modifications: {
      has_mods: passportRecord?.modifications?.has_mods ?? false,
      notes: firstDefinedString(passportRecord?.modifications?.notes),
      affected_systems: passportRecord?.modifications?.affected_systems ?? [],
    },
```

- [ ] **Step 2: `convex/seed.ts`.** Find the current seeded modifications block:
```ts
        modifications: {
          entries: hasMods
            ? [
                {
                  location: "wheels_tires" as const,
                  description: "Aftermarket wheels noted during prior visit.",
                },
              ]
            : [],
        },
```
Replace with:
```ts
        modifications: {
          has_mods: hasMods,
          notes: hasMods ? "Aftermarket wheels and lowering springs noted during prior visit." : null,
          affected_systems: hasMods
            ? ["wheels_tires" as const, "suspension_ride_height" as const]
            : [],
        },
```
(`hasMods` already exists from last cycle.)

- [ ] **Step 3: Push + typecheck** — `npx convex dev --once` clean; `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "bookings\.ts|seed\.ts"` → no new errors.

- [ ] **Step 4: Commit** — `git add convex/bookings.ts convex/seed.ts && git commit -m "feat(mods): server writers emit affected-systems shape"`

---

### Task 5: Pre-Job survey capture UI (`components/pre-job-survey-dialog.tsx`)

**Files:** Modify `components/pre-job-survey-dialog.tsx`. Verified manually (no component test harness).

READ the current Modifications section, state, snapshots, and `buildPayload` first to anchor (line numbers approximate). Current state uses `modEntries`/`ModRow`/`MOD_LOCATIONS` — all of that is replaced.

- [ ] **Step 1: Imports.** Remove the `@/lib/vehicle-passport` imports that are now unused here (`MOD_LOCATIONS`, `modLocationLabel`, `type ModLocation`, `type VehicleModificationEntry`) and add:
```ts
import {
  AFFECTED_SYSTEMS,
  servicesForSystems,
  type AffectedSystem,
} from "@/lib/vehicle-mod-systems";
```

- [ ] **Step 2: Remove** the `type ModRow = ...` local type.

- [ ] **Step 3: Replace state.** Replace the `const [modEntries, setModEntries] = useState<ModRow[]>(...)` block with:
```ts
  const [hasMods, setHasMods] = useState<boolean>(
    prefillData?.modifications?.has_mods ??
      passportData?.passport.modifications.has_mods ??
      false
  );
  const [modNotes, setModNotes] = useState<string>(
    prefillData?.modifications?.notes ??
      passportData?.passport.modifications.notes ??
      ""
  );
  const [affectedSystems, setAffectedSystems] = useState<AffectedSystem[]>(
    prefillData?.modifications?.affected_systems ??
      passportData?.passport.modifications.affected_systems ??
      []
  );
```

- [ ] **Step 4: Snapshots.** In `initialSnapshot`, replace the `modEntries: ...` line with:
```ts
        hasMods:
          prefillData?.modifications?.has_mods ??
          passportData?.passport.modifications.has_mods ??
          false,
        modNotes:
          prefillData?.modifications?.notes ??
          passportData?.passport.modifications.notes ??
          "",
        affectedSystems:
          prefillData?.modifications?.affected_systems ??
          passportData?.passport.modifications.affected_systems ??
          [],
```
In `currentSnapshot`, replace the `modEntries: ...` line with:
```ts
    hasMods,
    modNotes,
    affectedSystems,
```

- [ ] **Step 5: `buildPayload`.** Replace the `modifications: { entries: ... }` block with:
```ts
      modifications: {
        has_mods: hasMods,
        notes: hasMods ? (modNotes.trim() || null) : null,
        affected_systems: hasMods
          ? affectedSystems.filter((s) => s !== "cosmetic_only" || affectedSystems.length === 1)
          : [],
      },
```

- [ ] **Step 6: Replace the Modifications SectionBlock body** (everything inside `<SectionBlock ... eyebrow="Modifications" ...>` currently rendering the `modEntries` editor) with the new Yes/No + notes + chips + preview. Keep the `<SectionBlock ...>` wrapper unchanged:

```tsx
              <div className="row" style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
                <span className="lbl" style={{ fontSize: 14, fontWeight: 500 }}>Any aftermarket parts?</span>
                <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => setHasMods(true)}
                    className={cn(
                      "rounded-lg border px-4 py-1.5 text-sm font-semibold transition-colors",
                      hasMods
                        ? "border-green-300 bg-green-50 text-green-700"
                        : "border-border bg-card text-muted-foreground hover:bg-muted"
                    )}
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setHasMods(false);
                      setAffectedSystems([]);
                    }}
                    className={cn(
                      "rounded-lg border px-4 py-1.5 text-sm font-semibold transition-colors",
                      !hasMods
                        ? "border-foreground bg-card text-foreground"
                        : "border-border bg-card text-muted-foreground hover:bg-muted"
                    )}
                  >
                    No
                  </button>
                </span>
              </div>

              {hasMods ? (
                <>
                  <div className="field-lbl" style={{ fontSize: 14, fontWeight: 500, margin: "0 0 7px" }}>Notes</div>
                  <textarea
                    value={modNotes}
                    onChange={(e) => setModNotes(e.target.value)}
                    placeholder="e.g. H&R springs ~1.5in drop, 25mm wheel spacers, cat-back exhaust."
                    className={cn(baseField(), "min-h-[72px] w-full resize-y py-2 text-left")}
                  />

                  <div className="mt-4 rounded-xl border border-border bg-muted/40 p-4">
                    <div className="text-sm font-semibold text-foreground">Which systems do these affect?</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Tap every system these mods touch. Otopair flags them to future shops on the right services — automatically.
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {AFFECTED_SYSTEMS.map((sys) => {
                        const selected = affectedSystems.includes(sys.value);
                        return (
                          <button
                            key={sys.value}
                            type="button"
                            onClick={() =>
                              setAffectedSystems((prev) => {
                                if (sys.value === "cosmetic_only") {
                                  return prev.includes("cosmetic_only") ? [] : ["cosmetic_only"];
                                }
                                const withoutCosmetic = prev.filter((s) => s !== "cosmetic_only");
                                return withoutCosmetic.includes(sys.value)
                                  ? withoutCosmetic.filter((s) => s !== sys.value)
                                  : [...withoutCosmetic, sys.value];
                              })
                            }
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                              selected
                                ? "border-blue-300 bg-blue-50 text-blue-700"
                                : "border-border bg-card text-muted-foreground hover:bg-muted"
                            )}
                          >
                            {selected ? <Check className="h-3.5 w-3.5" /> : null}
                            {sys.label}
                          </button>
                        );
                      })}
                    </div>

                    {(() => {
                      const onlyCosmetic =
                        affectedSystems.length === 1 && affectedSystems[0] === "cosmetic_only";
                      const services = servicesForSystems(affectedSystems);
                      if (onlyCosmetic) {
                        return (
                          <div className="mt-3 rounded-lg border border-border bg-card px-3.5 py-3 text-xs text-muted-foreground">
                            Cosmetic only — recorded, but won&apos;t flag any future service.
                          </div>
                        );
                      }
                      if (services.length === 0) {
                        return (
                          <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-3.5 py-3 text-xs text-blue-700">
                            No systems selected yet — tap the systems above and Otopair flags the right future services automatically.
                          </div>
                        );
                      }
                      return (
                        <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-3.5 py-3">
                          <div className="text-xs font-semibold text-blue-700">
                            Future shops will be alerted on {services.length} service{services.length === 1 ? "" : "s"}
                          </div>
                          <div className="mt-1 text-xs text-blue-700/90">
                            {services.map((s) => s.name).join(" · ")}. <span className="font-semibold">Hidden on everything else.</span>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </>
              ) : null}
```
(`Check` is already imported in this file — confirm; if not, add it to the `lucide-react` import. `cn` and `baseField` are already used in the file.)

- [ ] **Step 7: Verify** — `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "pre-job-survey-dialog"` → empty. `grep -n "modEntries\|ModRow\|MOD_LOCATIONS\|modLocationLabel" components/pre-job-survey-dialog.tsx` → empty.

- [ ] **Step 8: Manual** — dev server: open a job → 🧪 temp pre-job button → Modifications → toggle Yes → type notes → tap Suspension/ride height + Wheels & tires → preview reads "Future shops will be alerted on 6 services: Wheel Alignment · Tire Balance · Tire Rotation · Tire Replacement · Brake Pad Replacement · Rotor Replacement. Hidden on everything else." → toggling Cosmetic only clears others + shows the cosmetic line. No console errors.

- [ ] **Step 9: Commit** — `git add components/pre-job-survey-dialog.tsx && git commit -m "feat(mods): affected-systems capture UI in pre-job survey"`

---

### Task 6: Displays (`components/vehicle-passport-card.tsx`, `components/vehicle-passport-section.tsx`)

**Files:** Modify both. READ current code first (they currently read `.entries` + `modLocationLabel`).

- [ ] **Step 1: `vehicle-passport-card.tsx` imports** — remove `modLocationLabel` from `@/lib/vehicle-passport`; add `import { affectedSystemLabel } from "@/lib/vehicle-mod-systems";`.

- [ ] **Step 2: `vehicle-passport-card.tsx` NotesSection.** Replace the `const modEntries = ...; const hasMods = modEntries.length > 0;` lines with:
```ts
  const mods = passport?.passport.modifications;
  const customerNotes = job.customerNotes?.trim();
  const hasMods = mods?.has_mods === true;
  const affectedSystems = mods?.affected_systems ?? [];
```
Replace the `{hasMods && (...)}` block (currently the `<ul>` of `modLocationLabel(entry.location)`) with:
```tsx
      {hasMods && (
        <div>
          <p className="text-[10px] font-bold tracking-widest text-muted-foreground">
            MODIFICATIONS
          </p>
          {mods?.notes ? (
            <p className="mt-1 whitespace-pre-wrap text-foreground">{mods.notes}</p>
          ) : (
            <p className="mt-1 text-foreground">Aftermarket parts present.</p>
          )}
          {affectedSystems.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Affects: {affectedSystems.map((s) => affectedSystemLabel(s)).join(", ")}
            </p>
          )}
        </div>
      )}
```

- [ ] **Step 3: `vehicle-passport-card.tsx` hasNotes indicator.** Replace the `(passport?.passport.modifications?.entries?.length ?? 0) > 0` check with:
```tsx
      passport?.passport.modifications?.has_mods === true,
```
(keep the `job.customerNotes?.trim() ||` part).

- [ ] **Step 4: `vehicle-passport-section.tsx`** — swap import `modLocationLabel` → `affectedSystemLabel` (from `@/lib/vehicle-mod-systems`). Replace the Modifications row value:
```tsx
      value:
        data.passport.modifications.has_mods
          ? (data.passport.modifications.affected_systems?.length ?? 0) > 0
            ? data.passport.modifications.affected_systems!
                .map((s) => affectedSystemLabel(s))
                .join(", ")
            : "Yes"
          : "None recorded",
```

- [ ] **Step 5: Verify** — `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "vehicle-passport-card|vehicle-passport-section"` → empty. `grep -rn "modLocationLabel\|\.entries" components/vehicle-passport-card.tsx components/vehicle-passport-section.tsx` → empty.

- [ ] **Step 6: Commit** — `git add components/vehicle-passport-card.tsx components/vehicle-passport-section.tsx && git commit -m "feat(mods): show affected systems in passport displays"`

---

### Task 7: Contract — remove the old shape (`lib/vehicle-passport.ts`, `convex/lib/vehicle_passports.ts`, remove old test)

**Files:** Modify `lib/vehicle-passport.ts`, `convex/lib/vehicle_passports.ts`; Delete `tests/vehicleModifications.test.ts`

- [ ] **Step 1: Re-run clear (safety):** `npx convex run migrations:clearAllModifications` → `cleared` should be 0 (the new-shape rows written via UI/seed have `has_mods`; this only clears rows with a modifications field that... ) — actually it clears ANY modifications field. DO NOT run this after seeding/entering data you want to keep. SKIP this step if you've already entered/seeded new-shape mods you want to preserve; otherwise the contract push below works because all rows either have no modifications or a valid new-shape one. (The contract validator accepts the new shape; it rejects only the old `entries` shape, which no longer exists.) Just verify no `entries` remain: `npx convex data vehicle_passports | grep -cE "\"entries\""` → expect 0.

- [ ] **Step 2: `convex/lib/vehicle_passports.ts` — contract the validator.** Replace the expanded `vehiclePassportModificationsValidator` with:
```ts
export const vehiclePassportModificationsValidator = v.object({
  has_mods: v.boolean(),
  notes: v.optional(nullableStringValidator),
  affected_systems: v.array(affectedSystemValidator),
});
```
Remove the now-unused `modLocationValidator` and `vehicleModificationEntryValidator` (grep first: `grep -rn "modLocationValidator\|vehicleModificationEntryValidator" convex/ lib/` — should be only their definitions now).

- [ ] **Step 3: `lib/vehicle-passport.ts` — contract the type + remove old symbols.** Set:
```ts
export type VehiclePassportModifications = {
  has_mods: boolean;
  notes?: string | null;
  affected_systems: AffectedSystem[];
};
```
Remove `MOD_LOCATIONS`, `ModLocation`, `modLocationLabel`, `VehicleModificationEntry`, and `legacyModificationsToEntries` (all defined in this file, now unused).

- [ ] **Step 4: Delete the obsolete test** — `git rm tests/vehicleModifications.test.ts` (it tested the removed `legacyModificationsToEntries`/`modLocationLabel`; coverage now lives in `tests/vehicleModSystems.test.ts`).

- [ ] **Step 5: Straggler grep:**
```
git grep -nE "modLocationLabel|MOD_LOCATIONS|ModLocation|VehicleModificationEntry|legacyModificationsToEntries|modLocationValidator|vehicleModificationEntryValidator|modifications\?\.(entries)|modifications\.entries" -- '*.ts' '*.tsx'
```
Expected: ZERO matches. Fix any straggler (if it's in an out-of-scope file you weren't assigned, STOP and report).

- [ ] **Step 6: Push + typecheck + tests** — `npx convex dev --once` (clean push; all rows valid). `npx tsc --noEmit -p tsconfig.json` → no errors mentioning `vehicle-passport.ts`/`vehicle_passports.ts` (pre-existing out-of-scope errors are fine). `npx vitest run tests/vehicleModSystems.test.ts` → 6 pass.

- [ ] **Step 7: Commit** — `git add lib/vehicle-passport.ts convex/lib/vehicle_passports.ts tests/vehicleModifications.test.ts && git commit -m "refactor(mods): contract to affected-systems-only model"`

---

### Task 8: Full verification

- [ ] **Step 1:** `npx vitest run` → only the 3 pre-existing failures (`customer_late`, `partSelector`, `timeSlotAvailability`); `tests/vehicleModSystems.test.ts` passes; no new failures.
- [ ] **Step 2:** End-to-end manual on localhost (signed in as mechanic): job → temp pre-job button → Modifications → Yes → notes + Suspension + Wheels & tires → preview shows 6 services → submit → Vehicle Passport card shows the notes + "Affects: Suspension / ride height, Wheels & tires"; re-open a different booking for the same VIN → values prefill.
- [ ] **Step 3:** Confirm working tree clean except the known unrelated files (`combobox.tsx`, `booking-detail-panel.tsx`) and docs.

---

## Self-review (author)
- **Spec coverage:** data model (T3,T7), brain+mapping (T1), migration/clear (T2), capture UI incl. cosmetic-exclusivity + 3 preview states (T5), displays (T6), writers (T4), out-of-scope flagging untouched. ✓
- **Type consistency:** `AffectedSystem`, `AFFECTED_SYSTEMS`, `affectedSystemLabel`, `servicesForSystems`, `SYSTEM_SERVICE_MAP`, `affectedSystemValidator`, `VehiclePassportModifications {has_mods,notes?,affected_systems}` — identical across tasks. ✓
- **Compiles each step:** brain additive (T1); migration (T2); expand keeps old readable (T3); writers/UI/displays migrate under expand (T4–T6); contract after all migrated (T7). ✓
- **No placeholders.** ✓
