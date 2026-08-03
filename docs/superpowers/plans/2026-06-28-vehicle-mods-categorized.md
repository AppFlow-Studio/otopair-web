# Categorized Vehicle Modifications (capture) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat `{ status, notes }` vehicle-modifications structure with a list of categorized entries (`{ location, description }`) captured in the Pre-Job survey and shown in the Vehicle Passport.

**Architecture:** The modifications data lives on `vehicle_passports.modifications` (keyed by VIN). We migrate it from `{ status, notes }` to `{ entries: Array<{ location, description }> }` using an **expand → migrate → contract** sequence so every commit compiles and the Convex schema push never rejects existing rows. Spec: [docs/superpowers/specs/2026-06-28-vehicle-mods-categorized-design.md](../specs/2026-06-28-vehicle-mods-categorized-design.md).

**Tech Stack:** Next.js 16 + React 19 (client components), Convex (schema/validators/mutations), Vitest, Tailwind. Convex deployment target: the one configured in `.env.local` (`dev:flippant-mink-750`).

**Scope:** Capture only. Auto-flagging a mod on related future bookings is a deferred follow-up.

**Migration note (expand/contract):** Tasks 1–7 keep `status`/`notes` as *optional* on both the TS type and the Convex validator so old and new shapes coexist. Task 3 backfills existing rows. Task 8 removes the legacy fields (contract). Re-run the backfill (Task 3) immediately before Task 8 in case any legacy-shape rows were written in between.

---

## Canonical shapes (used across tasks — keep names identical)

```ts
// location enum values (order = UI order)
"engine" | "exhaust" | "drivetrain" | "suspension" | "brakes" |
"wheels_tires" | "exterior_body" | "interior" | "electrical" | "other"

type VehicleModificationEntry = { location: ModLocation; description?: string | null };
type VehiclePassportModifications = { entries: VehicleModificationEntry[] }; // after contract
```

---

### Task 1: Shared types, labels, and legacy converter (`lib/vehicle-passport.ts`)

**Files:**
- Modify: `lib/vehicle-passport.ts`
- Test: `lib/vehicle-passport.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `lib/vehicle-passport.test.ts` (near the top-level `describe`, or a new one):

```ts
import {
  MOD_LOCATIONS,
  modLocationLabel,
  legacyModificationsToEntries,
} from "./vehicle-passport";

describe("modLocationLabel", () => {
  it("returns the label for a known location", () => {
    expect(modLocationLabel("wheels_tires")).toBe("Wheels & Tires");
    expect(modLocationLabel("engine")).toBe("Engine");
  });
  it("has 10 locations", () => {
    expect(MOD_LOCATIONS).toHaveLength(10);
  });
});

describe("legacyModificationsToEntries", () => {
  it("returns [] for none_observed and no notes", () => {
    expect(legacyModificationsToEntries({ status: "none_observed", notes: null })).toEqual([]);
  });
  it("returns [] for empty/undefined", () => {
    expect(legacyModificationsToEntries(undefined)).toEqual([]);
    expect(legacyModificationsToEntries({})).toEqual([]);
  });
  it("converts aftermarket_observed into one 'other' entry carrying the notes", () => {
    expect(
      legacyModificationsToEntries({ status: "aftermarket_observed", notes: "Lowered springs" })
    ).toEqual([{ location: "other", description: "Lowered springs" }]);
  });
  it("converts notes-only into one 'other' entry", () => {
    expect(legacyModificationsToEntries({ notes: "Cold air intake" })).toEqual([
      { location: "other", description: "Cold air intake" },
    ]);
  });
  it("passes through already-migrated entries unchanged", () => {
    const entries = [{ location: "suspension", description: "coilovers" }];
    expect(legacyModificationsToEntries({ entries })).toEqual(entries);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/vehicle-passport.test.ts`
Expected: FAIL — `modLocationLabel`/`legacyModificationsToEntries`/`MOD_LOCATIONS` are not exported.

- [ ] **Step 3: Implement in `lib/vehicle-passport.ts`**

Replace the existing modifications block (lines ~18-22):

```ts
export const MODIFICATION_STATUSES = [
  "none_observed",
  "aftermarket_observed",
] as const;
export type ModificationStatus = (typeof MODIFICATION_STATUSES)[number];
```

with (keep `MODIFICATION_STATUSES`/`ModificationStatus` for now — removed in Task 8):

```ts
export const MODIFICATION_STATUSES = [
  "none_observed",
  "aftermarket_observed",
] as const;
export type ModificationStatus = (typeof MODIFICATION_STATUSES)[number];

// Broad physical areas of the car where a mod resides. The specific component
// (turbo, coilovers, cat-back, etc.) goes in the per-entry description.
export const MOD_LOCATIONS = [
  { value: "engine", label: "Engine" },
  { value: "exhaust", label: "Exhaust" },
  { value: "drivetrain", label: "Drivetrain" },
  { value: "suspension", label: "Suspension" },
  { value: "brakes", label: "Brakes" },
  { value: "wheels_tires", label: "Wheels & Tires" },
  { value: "exterior_body", label: "Exterior / Body" },
  { value: "interior", label: "Interior" },
  { value: "electrical", label: "Electrical" },
  { value: "other", label: "Other" },
] as const;
export type ModLocation = (typeof MOD_LOCATIONS)[number]["value"];

export function modLocationLabel(value: ModLocation): string {
  return MOD_LOCATIONS.find((m) => m.value === value)?.label ?? "Other";
}

export type VehicleModificationEntry = {
  location: ModLocation;
  description?: string | null;
};

// Convert the legacy { status, notes } modifications shape into the new
// entries list. Used by the one-time backfill (convex/migrations.ts).
export function legacyModificationsToEntries(
  mods:
    | {
        entries?: VehicleModificationEntry[];
        status?: ModificationStatus | null;
        notes?: string | null;
      }
    | null
    | undefined
): VehicleModificationEntry[] {
  if (!mods) return [];
  if (Array.isArray(mods.entries)) return mods.entries;
  const hasNotes = typeof mods.notes === "string" && mods.notes.trim().length > 0;
  if (mods.status === "aftermarket_observed" || hasNotes) {
    return [{ location: "other", description: mods.notes ?? null }];
  }
  return [];
}
```

Then EXPAND the `VehiclePassportModifications` type (currently lines ~82-85):

```ts
export type VehiclePassportModifications = {
  status?: ModificationStatus | null;
  notes?: string | null;
};
```

to (entries added; legacy kept optional during migration — contracted in Task 8):

```ts
export type VehiclePassportModifications = {
  entries?: VehicleModificationEntry[];
  // legacy — removed in the contract step once all reads/writes use `entries`
  status?: ModificationStatus | null;
  notes?: string | null;
};
```

Leave `modificationStatusLabel` (lines ~348-351) untouched for now.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/vehicle-passport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/vehicle-passport.ts lib/vehicle-passport.test.ts
git commit -m "feat(mods): add ModLocation taxonomy + legacy converter (expand)"
```

---

### Task 2: Convex validators — expand (`convex/lib/vehicle_passports.ts`)

**Files:**
- Modify: `convex/lib/vehicle_passports.ts`

- [ ] **Step 1: Add the location + entry validators**

After `modificationStatusValidator` (lines ~30-33), add:

```ts
export const modLocationValidator = v.union(
  v.literal("engine"),
  v.literal("exhaust"),
  v.literal("drivetrain"),
  v.literal("suspension"),
  v.literal("brakes"),
  v.literal("wheels_tires"),
  v.literal("exterior_body"),
  v.literal("interior"),
  v.literal("electrical"),
  v.literal("other")
);

export const vehicleModificationEntryValidator = v.object({
  location: modLocationValidator,
  description: v.optional(nullableStringValidator),
});
```

- [ ] **Step 2: Expand the modifications validator**

Replace (lines ~79-82):

```ts
export const vehiclePassportModificationsValidator = v.object({
  status: v.optional(v.union(modificationStatusValidator, v.null())),
  notes: v.optional(nullableStringValidator),
});
```

with (entries added; legacy kept optional so existing rows still validate):

```ts
export const vehiclePassportModificationsValidator = v.object({
  entries: v.optional(v.array(vehicleModificationEntryValidator)),
  // legacy — removed in the contract step (Task 8)
  status: v.optional(v.union(modificationStatusValidator, v.null())),
  notes: v.optional(nullableStringValidator),
});
```

- [ ] **Step 3: Push the expanded schema**

Run: `npx convex dev --once`
Expected: schema pushes successfully (existing `{status,notes}` rows still valid; new `entries` now allowed). No type errors.

- [ ] **Step 4: Commit**

```bash
git add convex/lib/vehicle_passports.ts
git commit -m "feat(mods): expand passport modifications validator to allow entries"
```

---

### Task 3: One-time backfill of existing passports (`convex/migrations.ts`)

**Files:**
- Modify: `convex/migrations.ts`

- [ ] **Step 1: Add the backfill mutation**

Append to `convex/migrations.ts` (ensure imports: `import { mutation } from "./_generated/server";` if not already present, and `import { legacyModificationsToEntries } from "../lib/vehicle-passport";`):

```ts
export const backfillModificationEntries = mutation({
  args: {},
  handler: async (ctx) => {
    const passports = await ctx.db.query("vehicle_passports").collect();
    let converted = 0;
    let alreadyNew = 0;
    let empty = 0;
    for (const p of passports) {
      const mods = p.modifications as
        | { entries?: unknown; status?: unknown; notes?: unknown }
        | undefined;
      if (!mods) {
        empty++;
        continue;
      }
      if (Array.isArray(mods.entries)) {
        alreadyNew++;
        continue;
      }
      const entries = legacyModificationsToEntries(mods as any);
      await ctx.db.patch(p._id, { modifications: { entries } });
      converted++;
    }
    return { total: passports.length, converted, alreadyNew, empty };
  },
});
```

- [ ] **Step 2: Push + run the backfill**

Run: `npx convex dev --once` then
`npx convex run migrations:backfillModificationEntries`
Expected: returns `{ total: 25, converted: >=6, alreadyNew: ..., empty: ... }`. (6 rows carry legacy status today.)

- [ ] **Step 3: Verify no legacy shapes remain**

Run: `npx convex data vehicle_passports | grep -oE "none_observed|aftermarket_observed" | sort | uniq -c`
Expected: no output (all legacy `status` values gone; rows now carry `entries`).

- [ ] **Step 4: Commit**

```bash
git add convex/migrations.ts
git commit -m "chore(mods): backfill passport modifications into entries"
```

---

### Task 4: Server writers emit entries (`convex/bookings.ts`, `convex/seed.ts`)

**Files:**
- Modify: `convex/bookings.ts:4382-4385`
- Modify: `convex/seed.ts:4173-4226`

- [ ] **Step 1: Update the passport-data builder (`convex/bookings.ts`)**

Replace (lines ~4382-4385):

```ts
    modifications: {
      status: passportRecord?.modifications?.status ?? null,
      notes: firstDefinedString(passportRecord?.modifications?.notes),
    },
```

with:

```ts
    modifications: {
      entries: passportRecord?.modifications?.entries ?? [],
    },
```

- [ ] **Step 2: Update the seed (`convex/seed.ts`)**

Replace the legacy status computation (lines ~4173-4175):

```ts
      const modificationsRatio = dashboardSeedRatio(`${vehicle.vin}:mods`);
      const modificationStatus: "aftermarket_observed" | "none_observed" =
        modificationsRatio > 0.72 ? "aftermarket_observed" : "none_observed";
```

with:

```ts
      const hasMods = dashboardSeedRatio(`${vehicle.vin}:mods`) > 0.72;
```

Then replace the modifications object (lines ~4220-4226):

```ts
        modifications: {
          status: modificationStatus,
          notes:
            modificationStatus === "aftermarket_observed"
              ? "Aftermarket wheels noted during prior visit."
              : null,
        },
```

with:

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

- [ ] **Step 3: Push + typecheck**

Run: `npx convex dev --once`
Expected: pushes clean, no type errors in `bookings.ts`/`seed.ts`.

- [ ] **Step 4: Commit**

```bash
git add convex/bookings.ts convex/seed.ts
git commit -m "feat(mods): server writers emit modification entries"
```

---

### Task 5: Pre-Job survey — entries editor (`components/pre-job-survey-dialog.tsx`)

**Files:**
- Modify: `components/pre-job-survey-dialog.tsx`

This task is verified manually (no component-test harness for this dialog).

- [ ] **Step 1: Add imports**

Add to the existing import from `@/lib/vehicle-passport` (or add a new import line):

```ts
import {
  MOD_LOCATIONS,
  modLocationLabel,
  type ModLocation,
  type VehicleModificationEntry,
} from "@/lib/vehicle-passport";
```

- [ ] **Step 2: Replace state (lines ~662-671)**

Replace:

```ts
  const [modificationsStatus, setModificationsStatus] = useState<
    "" | "none_observed" | "aftermarket_observed"
  >(
    prefillData?.modifications?.status ??
      passportData?.passport.modifications.status ??
      ""
  );
  const [modificationNotes, setModificationNotes] = useState(
    prefillData?.modifications?.notes ?? passportData?.passport.modifications.notes ?? ""
  );
```

with:

```ts
  const [modEntries, setModEntries] = useState<VehicleModificationEntry[]>(
    prefillData?.modifications?.entries ??
      passportData?.passport.modifications.entries ??
      []
  );
```

- [ ] **Step 3: Remove the local `modificationStatusLabel` helper (lines ~388-392)**

Delete:

```ts
function modificationStatusLabel(value: string) {
  if (value === "none_observed") return "None observed";
  if (value === "aftermarket_observed") return "Yes - see notes";
  return "Select...";
}
```

- [ ] **Step 4: Update the change-tracking snapshots**

In `initialSnapshot` (lines ~774-781) replace:

```ts
        modificationsStatus:
          prefillData?.modifications?.status ??
          passportData?.passport.modifications.status ??
          "",
        modificationNotes:
          prefillData?.modifications?.notes ??
          passportData?.passport.modifications.notes ??
          "",
```

with:

```ts
        modEntries:
          prefillData?.modifications?.entries ??
          passportData?.passport.modifications.entries ??
          [],
```

In `currentSnapshot` (lines ~817-818) replace:

```ts
    modificationsStatus,
    modificationNotes,
```

with:

```ts
    modEntries,
```

- [ ] **Step 5: Update `buildPayload` (lines ~876-879)**

Replace:

```ts
      modifications: {
        status: modificationsStatus === "" ? null : modificationsStatus,
        notes: modificationNotes.trim() || null,
      },
```

with:

```ts
      modifications: {
        entries: modEntries
          .filter((e) => e.location)
          .map((e) => ({
            location: e.location,
            description:
              typeof e.description === "string" && e.description.trim()
                ? e.description.trim()
                : null,
          })),
      },
```

- [ ] **Step 6: Replace the Modifications SectionBlock body (lines ~1899-1946)**

Replace the `<FieldRow label="Any aftermarket parts?">…</FieldRow>` Select + the conditional textarea with the entries editor:

```tsx
              {modEntries.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">
                  No modifications recorded.
                </p>
              ) : (
                <div className="space-y-3">
                  {modEntries.map((entry, index) => (
                    <div
                      key={index}
                      className="rounded-lg border border-border p-3 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Select
                          selectedKey={entry.location}
                          onSelectionChange={(key) =>
                            setModEntries((rows) =>
                              rows.map((r, i) =>
                                i === index
                                  ? { ...r, location: String(key) as ModLocation }
                                  : r
                              )
                            )
                          }
                        >
                          <SelectTrigger
                            className={cn(selectTriggerClassName, "w-[180px] justify-between")}
                          >
                            <SelectValue>{modLocationLabel(entry.location)}</SelectValue>
                          </SelectTrigger>
                          <SelectPopover className={selectPopoverClassName}>
                            <SelectListBox shouldFocusWrap className={selectListBoxClassName}>
                              {MOD_LOCATIONS.map((loc) => (
                                <SelectItem
                                  key={loc.value}
                                  id={loc.value}
                                  textValue={loc.label}
                                  className={selectItemClassName}
                                >
                                  {loc.label}
                                </SelectItem>
                              ))}
                            </SelectListBox>
                          </SelectPopover>
                        </Select>
                        <button
                          type="button"
                          onClick={() =>
                            setModEntries((rows) => rows.filter((_, i) => i !== index))
                          }
                          className="text-[12px] font-medium text-muted-foreground hover:text-destructive"
                        >
                          Remove
                        </button>
                      </div>
                      <textarea
                        value={entry.description ?? ""}
                        onChange={(event) =>
                          setModEntries((rows) =>
                            rows.map((r, i) =>
                              i === index ? { ...r, description: event.target.value } : r
                            )
                          )
                        }
                        placeholder="Describe the mod (e.g. cold air intake, lowered 2in)."
                        className={cn(
                          baseField(),
                          "min-h-[60px] w-full resize-y py-2 text-left"
                        )}
                      />
                    </div>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={() =>
                  setModEntries((rows) => [...rows, { location: "engine", description: "" }])
                }
                className="mt-3 inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline"
              >
                + Add modification
              </button>
```

- [ ] **Step 7: Verify it builds (HMR)**

Ensure the dev server is running (`preview_start`). Check `preview_logs --level error` — expected: no errors. Run `npx tsc --noEmit -p tsconfig.json` and confirm no NEW errors mention `pre-job-survey-dialog.tsx` (pre-existing implicit-any errors elsewhere are unrelated).

- [ ] **Step 8: Manual verification**

Open a job → Pre-Job form (use the temp button) → Modifications tab → "Add modification" → pick Suspension, type "lowered 2in coilovers" → add a second (Engine, "cold air intake") → Submit. Confirm no console errors.

- [ ] **Step 9: Commit**

```bash
git add components/pre-job-survey-dialog.tsx
git commit -m "feat(mods): categorized modification entries in pre-job survey"
```

---

### Task 6: Display — Vehicle Passport card (`components/vehicle-passport-card.tsx`)

**Files:**
- Modify: `components/vehicle-passport-card.tsx:612-648` and `:734-738`

- [ ] **Step 1: Add import**

Add `modLocationLabel` to the existing `@/lib/vehicle-passport` import (or new import line):

```ts
import { modLocationLabel } from "@/lib/vehicle-passport";
```

- [ ] **Step 2: Update `NotesSection` (lines ~612-648)**

Replace:

```tsx
  const mods = passport?.passport.modifications;
  const customerNotes = job.customerNotes?.trim();
  const hasMods = mods?.status === "aftermarket_observed" || mods?.notes;
```

with:

```tsx
  const modEntries = passport?.passport.modifications?.entries ?? [];
  const customerNotes = job.customerNotes?.trim();
  const hasMods = modEntries.length > 0;
```

Then replace the `{hasMods && ( … )}` block:

```tsx
      {hasMods && (
        <div>
          <p className="text-[10px] font-bold tracking-widest text-muted-foreground">
            MODIFICATIONS
          </p>
          <p className="mt-1 text-foreground">
            {mods?.status === "aftermarket_observed"
              ? "Aftermarket observed"
              : "None observed"}
          </p>
          {mods?.notes && (
            <p className="mt-1 text-xs text-muted-foreground">{mods.notes}</p>
          )}
        </div>
      )}
```

with:

```tsx
      {hasMods && (
        <div>
          <p className="text-[10px] font-bold tracking-widest text-muted-foreground">
            MODIFICATIONS
          </p>
          <ul className="mt-1 space-y-1">
            {modEntries.map((entry, index) => (
              <li key={index} className="text-foreground">
                <span className="font-medium">{modLocationLabel(entry.location)}</span>
                {entry.description ? (
                  <span className="text-muted-foreground"> — {entry.description}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
```

- [ ] **Step 3: Update the `hasNotes` indicator (lines ~734-738)**

Replace:

```tsx
  const hasNotes = Boolean(
    job.customerNotes?.trim() ||
      passport?.passport.modifications?.status === "aftermarket_observed" ||
      passport?.passport.modifications?.notes,
  );
```

with:

```tsx
  const hasNotes = Boolean(
    job.customerNotes?.trim() ||
      (passport?.passport.modifications?.entries?.length ?? 0) > 0,
  );
```

- [ ] **Step 4: Verify + Manual check**

Run `npx tsc --noEmit -p tsconfig.json` — no new errors in `vehicle-passport-card.tsx`. On localhost, open the job whose Pre-Job mods you saved in Task 5 → confirm the Vehicle Passport card Notes section lists "Suspension — lowered 2in coilovers" and "Engine — cold air intake".

- [ ] **Step 5: Commit**

```bash
git add components/vehicle-passport-card.tsx
git commit -m "feat(mods): list categorized modifications in passport card"
```

---

### Task 7: Display — Vehicle Passport section row (`components/vehicle-passport-section.tsx`)

**Files:**
- Modify: `components/vehicle-passport-section.tsx:10` and `:270-275`

- [ ] **Step 1: Swap the import**

Replace `modificationStatusLabel` in the `@/lib/vehicle-passport` import (line ~10) with `modLocationLabel`.

- [ ] **Step 2: Update the Modifications row (lines ~270-275)**

Replace:

```tsx
    {
      label: "Modifications",
      value: data.passport.modifications.status
        ? modificationStatusLabel(data.passport.modifications.status)
        : "Unknown",
    },
```

with:

```tsx
    {
      label: "Modifications",
      value:
        (data.passport.modifications.entries?.length ?? 0) > 0
          ? data.passport.modifications.entries!
              .map((entry) => modLocationLabel(entry.location))
              .join(", ")
          : "None recorded",
    },
```

- [ ] **Step 3: Verify**

Run `npx tsc --noEmit -p tsconfig.json` — no new errors in `vehicle-passport-section.tsx`.

- [ ] **Step 4: Commit**

```bash
git add components/vehicle-passport-section.tsx
git commit -m "feat(mods): summarize modification locations in passport section"
```

---

### Task 8: Contract — remove legacy fields (`lib/vehicle-passport.ts`, `convex/lib/vehicle_passports.ts`, test)

**Files:**
- Modify: `lib/vehicle-passport.ts`
- Modify: `convex/lib/vehicle_passports.ts`
- Modify: `lib/vehicle-passport.test.ts`

- [ ] **Step 1: Re-run the backfill (safety)**

In case any legacy-shape row was written between Task 3 and now:
Run: `npx convex run migrations:backfillModificationEntries`
Expected: `converted: 0` (or small), confirming all rows are entries-shaped.

- [ ] **Step 2: Update the test fixture (`lib/vehicle-passport.test.ts:56-59`)**

Replace:

```ts
    modifications: {
      status: "none_observed",
      notes: null,
    },
```

with:

```ts
    modifications: {
      entries: [],
    },
```

- [ ] **Step 3: Contract the TS type (`lib/vehicle-passport.ts`)**

Change `VehiclePassportModifications` to entries-only:

```ts
export type VehiclePassportModifications = {
  entries: VehicleModificationEntry[];
};
```

Remove the now-unused legacy exports:

```ts
export const MODIFICATION_STATUSES = [
  "none_observed",
  "aftermarket_observed",
] as const;
export type ModificationStatus = (typeof MODIFICATION_STATUSES)[number];
```

and

```ts
export function modificationStatusLabel(value?: ModificationStatus | null) {
  if (value === "aftermarket_observed") return "Aftermarket observed";
  if (value === "none_observed") return "None observed";
  return "Unknown";
}
```

Update `legacyModificationsToEntries`'s param type to drop the `ModificationStatus` reference (use a string literal union inline):

```ts
export function legacyModificationsToEntries(
  mods:
    | {
        entries?: VehicleModificationEntry[];
        status?: "none_observed" | "aftermarket_observed" | null;
        notes?: string | null;
      }
    | null
    | undefined
): VehicleModificationEntry[] {
```

- [ ] **Step 4: Contract the Convex validator (`convex/lib/vehicle_passports.ts`)**

Change `vehiclePassportModificationsValidator` to entries-only:

```ts
export const vehiclePassportModificationsValidator = v.object({
  entries: v.array(vehicleModificationEntryValidator),
});
```

Remove the now-unused `modificationStatusValidator` (lines ~30-33).

- [ ] **Step 5: Make pre-job writes always include entries**

In `buildPayload` (Task 5) `modifications.entries` is always an array — confirm it is (it is). The validator now requires `entries`; confirm no writer emits `{}`. (`bookings.ts` builder and `seed.ts` both emit `{ entries }` after Task 4.)

- [ ] **Step 6: Push schema + run tests + typecheck**

Run: `npx convex dev --once`
Expected: schema push succeeds (all rows are entries-shaped after the backfill).
Run: `npx vitest run lib/vehicle-passport.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no NEW errors referencing `modificationStatusLabel`, `ModificationStatus`, `.modifications.status`, or `.modifications.notes` anywhere.

- [ ] **Step 7: Grep for stragglers**

Run: `git grep -nE "modificationStatusLabel|ModificationStatus|modifications\\??\\.(status|notes)|modificationsStatus|modificationNotes" -- '*.ts' '*.tsx' | grep -v vehicle-passport.test`
Expected: no matches in app/component/convex source (only allowed: the `legacyModificationsToEntries` inline `status` literal). Fix any straggler.

- [ ] **Step 8: Commit**

```bash
git add lib/vehicle-passport.ts convex/lib/vehicle_passports.ts lib/vehicle-passport.test.ts
git commit -m "refactor(mods): contract passport modifications to entries-only"
```

---

### Task 9: Full verification

- [ ] **Step 1: Full test run**

Run: `npx vitest run`
Expected: PASS (no regressions from the modifications change).

- [ ] **Step 2: End-to-end manual check (localhost)**

1. Ensure dev server running + signed in as the mechanic.
2. Open a job → Pre-Job form → Modifications tab → add two mods (Suspension "lowered 2in coilovers", Engine "cold air intake") → submit.
3. Re-open the same job → Vehicle Passport card Notes section lists both with location + description.
4. Open a *different* booking for the *same VIN* → confirm the mods prefill (persisted on the passport per-VIN).

- [ ] **Step 3: Remove the temporary pre-job button (if still present)**

If the `🧪 Open Pre-Job form (temp)` button from the earlier session is no longer needed, remove it from `components/booking-detail-panel.tsx` (the block marked `// TEMP …`). Otherwise leave it for ongoing testing.

- [ ] **Step 4: Commit any cleanup**

```bash
git add -A
git commit -m "chore(mods): final verification + cleanup"
```

---

## Self-review notes (author)

- **Spec coverage:** data model (Tasks 1,2,8), enum (Task 1), migration/overwrite (Tasks 2,3,8), pre-job UI (Task 5), card display (Task 6), section display (Task 7), bookings builder (Task 4), seed (Task 4), test (Tasks 1,8). All spec touch-points have a task.
- **Type consistency:** `VehicleModificationEntry { location, description }`, `ModLocation` union, `MOD_LOCATIONS` (value/label), `modLocationLabel`, `legacyModificationsToEntries`, `vehicleModificationEntryValidator` — names identical across tasks.
- **No placeholders:** every code step shows the full replacement.
- **Compiles at each step:** expand (Tasks 1-2) keeps legacy optional; consumers migrate (Tasks 4-7); contract (Task 8) removes legacy after all reads/writes use entries.
