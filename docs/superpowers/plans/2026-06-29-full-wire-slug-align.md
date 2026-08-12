# Full Wire — Slug Alignment + Real-Booking Simulate — Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Align the affected-systems map to the deployment's canonical service slugs with separator-insensitive matching (so the flag auto-fires on real bookings), and change the 🔔 temp button to spawn a REAL pending booking on the just-edited car (so a genuine flagged notification appears in the bell). Temp buttons stay until the user validates.

**Decisions (locked):** canonical underscore slugs + separator-insensitive matching (fires on both canonical and demo bookings); keep temp buttons for now.

**Discovery:** the deployment has two service sets — canonical (underscore slugs, the real 23-service taxonomy) and a demo set (hyphen slugs from `seedDashboardBookings`). The map must use canonical slugs; matching must be separator-insensitive to also catch demo bookings.

**Stack:** Next.js 16 / React 19, Convex, Vitest. Deployment `dev:flippant-mink-750`.

---

### Task 1: Align map to canonical slugs + separator-insensitive matching (`lib/vehicle-mod-systems.ts`)

**Files:** Modify `lib/vehicle-mod-systems.ts`; Modify `tests/vehicleModSystems.test.ts`.

- [ ] **Step 1: Update the failing tests** in `tests/vehicleModSystems.test.ts`:
  - The `servicesForSystems(["brakes"]).map(s => s.slug)` test → expect canonical underscore slugs:
    ```ts
    expect(servicesForSystems(["brakes"]).map((s) => s.slug)).toEqual([
      "brake_pad_replacement",
      "rotor_replacement",
      "brake_fluid_flush",
    ]);
    ```
  - The union NAME test (suspension + wheels_tires → 6 names) is UNCHANGED (names are the same).
  - Add a normalization test:
    ```ts
    it("matches slugs separator-insensitively (hyphen vs underscore)", () => {
      // map uses canonical underscore slugs; a demo hyphen booking slug still matches
      expect(anyServiceAffected(["oil-change"], ["engine_drivetrain"])).toBe(true);
      expect(anyServiceAffected(["brake-pad-replacement"], ["brakes"])).toBe(true);
      expect(anyServiceAffected(["wheel_alignment"], ["suspension_ride_height"])).toBe(true);
    });
    ```

- [ ] **Step 2: Run → fail** — `npx vitest run tests/vehicleModSystems.test.ts`.

- [ ] **Step 3: Rewrite `SYSTEM_SERVICE_MAP`** in `lib/vehicle-mod-systems.ts` to the canonical underscore slugs (all verified to exist in the deployment's `services` table):
  ```ts
  export const SYSTEM_SERVICE_MAP: Record<AffectedSystem, ModServiceRef[]> = {
    suspension_ride_height: [
      { slug: "wheel_alignment", name: "Wheel Alignment" },
      { slug: "tire_balance", name: "Tire Balance" },
      { slug: "tire_rotation", name: "Tire Rotation" },
      { slug: "tire_replacement", name: "Tire Replacement" },
    ],
    wheels_tires: [
      { slug: "tire_balance", name: "Tire Balance" },
      { slug: "wheel_alignment", name: "Wheel Alignment" },
      { slug: "tire_rotation", name: "Tire Rotation" },
      { slug: "tire_replacement", name: "Tire Replacement" },
      { slug: "brake_pad_replacement", name: "Brake Pad Replacement" },
      { slug: "rotor_replacement", name: "Rotor Replacement" },
    ],
    brakes: [
      { slug: "brake_pad_replacement", name: "Brake Pad Replacement" },
      { slug: "rotor_replacement", name: "Rotor Replacement" },
      { slug: "brake_fluid_flush", name: "Brake Fluid Flush" },
    ],
    exhaust_emissions: [
      { slug: "emissions_test", name: "Emissions Test" },
      { slug: "state_inspection", name: "State Inspection" },
      { slug: "check_engine_light", name: "Check Engine Light Diagnosis" },
      { slug: "diagnostic_scan", name: "Diagnostic Scan" },
    ],
    engine_drivetrain: [
      { slug: "oil_change", name: "Oil Change" },
      { slug: "spark_plugs", name: "Spark Plugs" },
      { slug: "fuel_system_cleaning", name: "Fuel System Cleaning" },
      { slug: "filter_replacement", name: "Filter Replacement" },
      { slug: "check_engine_light", name: "Check Engine Light Diagnosis" },
      { slug: "diagnostic_scan", name: "Diagnostic Scan" },
      { slug: "emissions_test", name: "Emissions Test" },
      { slug: "transmission_service", name: "Transmission Service" },
      { slug: "differential_service", name: "Differential Service" },
    ],
    electrical_lighting: [
      { slug: "battery_test", name: "Battery Test" },
      { slug: "battery_replacement", name: "Battery Replacement" },
      { slug: "check_engine_light", name: "Check Engine Light Diagnosis" },
    ],
    cosmetic_only: [],
  };
  ```

- [ ] **Step 4: Add slug normalization** + make matching separator-insensitive. Add a helper and update both functions:
  ```ts
  // Normalize a service slug so hyphen/underscore variants match (the deployment
  // has both "oil-change" and "oil_change"). Lowercase, collapse separators to "-".
  export function normalizeSlug(slug: string): string {
    return slug.toLowerCase().replace(/[\s_-]+/g, "-");
  }

  export function affectedServiceSlugs(systems: AffectedSystem[]): Set<string> {
    return new Set(servicesForSystems(systems).map((s) => normalizeSlug(s.slug)));
  }

  export function anyServiceAffected(serviceSlugs: string[], systems: AffectedSystem[]): boolean {
    const affected = affectedServiceSlugs(systems);
    return serviceSlugs.some((slug) => affected.has(normalizeSlug(slug)));
  }
  ```

- [ ] **Step 5: Run → pass** — `npx vitest run tests/vehicleModSystems.test.ts`.

- [ ] **Step 6: Commit** — `git add lib/vehicle-mod-systems.ts tests/vehicleModSystems.test.ts && git commit -m "feat(mods): align map to canonical service slugs + separator-insensitive matching"`

---

### Task 2: Temp mutation — spawn a real pending booking on a car (`convex/bookings.ts`)

**Files:** Modify `convex/bookings.ts`.

- [ ] **Step 1: Imports** — ensure `affectedServiceSlugs` and `normalizeSlug` are importable: add to the existing imports
  ```ts
  import { affectedServiceSlugs, normalizeSlug } from "../lib/vehicle-mod-systems";
  ```
  (and `mutation`, `v` are already imported in this file).

- [ ] **Step 2: Append the temp mutation** (mark TEMP clearly):
  ```ts
  // TEMP dev tool: clone a booking into a fresh "pending_shop_acceptance" booking
  // on the same vehicle, swapping in a service that the vehicle's recorded mods
  // affect — so a real, flagged "New booking" surfaces in the bell. Remove with
  // the temp UI buttons before shipping.
  export const simulateNewBookingFromBooking = mutation({
    args: { sourceBookingId: v.id("bookings") },
    handler: async (ctx, args) => {
      const src: any = await ctx.db.get(args.sourceBookingId);
      if (!src) throw new Error("Source booking not found.");

      // Pick a service the vehicle's mods affect (separator-insensitive slug match).
      let serviceId: any = src.service_ids?.[0] ?? null;
      const passport: any = await ctx.db
        .query("vehicle_passports")
        .withIndex("by_vin", (q: any) => q.eq("vin", src.vin))
        .first();
      const mods = passport?.modifications;
      if (mods?.has_mods === true) {
        const affected = affectedServiceSlugs(mods.affected_systems ?? []);
        if (affected.size > 0) {
          const services: any[] = await ctx.db.query("services").collect();
          const match = services.find(
            (s) => s.slug && affected.has(normalizeSlug(s.slug)),
          );
          if (match) serviceId = match._id;
        }
      }

      const now = Date.now();
      const bookingId = await ctx.db.insert("bookings", {
        user_id: src.user_id,
        vin: src.vin,
        vehicle_id: src.vehicle_id,
        shop_id: src.shop_id,
        mechanic_id: src.mechanic_id,
        service_ids: serviceId ? [serviceId] : (src.service_ids ?? []),
        scheduled_date: src.scheduled_date,
        scheduled_time: src.scheduled_time,
        labor_cost: src.labor_cost ?? 0,
        parts_cost: src.parts_cost ?? 0,
        total_cost: src.total_cost ?? null,
        status: "pending_shop_acceptance",
        created_at: now,
        updated_at: now,
      } as any);

      return { bookingId };
    },
  });
  ```

- [ ] **Step 3: Push + typecheck** — `npx convex dev --once` clean; `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "bookings.ts"` → no NEW errors in `convex/bookings.ts` (the file has none in scope; ignore unrelated app-file errors).

- [ ] **Step 4: Commit** — `git add convex/bookings.ts && git commit -m "feat(mods): temp mutation to spawn a real flagged pending booking"`

---

### Task 3: Rewire the 🔔 temp button to call the mutation (`components/booking-detail-panel.tsx`)

**Files:** Modify `components/booking-detail-panel.tsx`. READ the current 🔔 button block to anchor.

- [ ] **Step 1: Add the mutation hook** near the panel's other `useMutation` calls:
  ```ts
  const simulateNewBookingFromBooking = useMutation(api.bookings.simulateNewBookingFromBooking);
  ```

- [ ] **Step 2: Replace the 🔔 button's onClick** (currently builds a `NotificationItem` and dispatches a window CustomEvent) with a call to the mutation:
  ```tsx
                {/* TEMP: spawn a REAL pending booking on this vehicle with a
                    mod-affected service, so a flagged "New booking" appears in
                    the bell. No mock — real getFeed path. Remove before shipping. */}
                <button
                  type="button"
                  onClick={async () => {
                    if (!job) return;
                    try {
                      await simulateNewBookingFromBooking({ sourceBookingId: job._id });
                    } catch {
                      // best-effort dev tool
                    }
                  }}
                  className="w-full rounded-lg border border-dashed border-amber-400 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100"
                >
                  🔔 Spawn flagged booking in bell (temp)
                </button>
  ```

- [ ] **Step 3: Remove now-unused imports** — if `NotificationItem` / `NotificationCard` / `servicesForSystems` are no longer referenced anywhere else in the file, remove those imports. (Grep the file to confirm before removing each.) Leave everything else (the 🧪 button, etc.) intact.

- [ ] **Step 4: Verify** — `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "booking-detail-panel"` → only the known pre-existing errors (no new ones from this region). `grep -n "otopair:sim-notification\|dispatchEvent" components/booking-detail-panel.tsx` → empty (the dispatch is gone).

- [ ] **Step 5: Commit** — `git add components/booking-detail-panel.tsx && git commit -m "feat(mods): temp button spawns a real flagged booking instead of a mock"`

---

### Task 4: Verification

- [ ] **Step 1:** `npx vitest run tests/vehicleModSystems.test.ts` → pass; `npx vitest run` → only the 3 pre-existing failures.
- [ ] **Step 2:** Manual (Chrome): open a booking → 🧪 Open Pre-Job → set mods (e.g. Engine/drivetrain + Suspension) → Save and close → click 🔔 → open the bell → a NEW "New booking" on that car appears with the big "THIS VEHICLE IS MODIFIED" flag + "Tap to acknowledge"; acknowledging reveals Accept/Decline/Details. Confirm the service shown is a mod-affected one.

---

## Out of scope (next pass, after validation)
Remove ALL temp scaffolding: the 🧪 + 🔔 buttons, the `simulateNewBookingFromBooking` mutation, the bell's now-dead sim-injection (`simItems`/event listener/`mergedFeed`), the card's `simulated` field + `preview` plumbing, the temp clear/seed dev mutations. Then the flag is fully production-wired.

## Self-review
- Slug align + normalize (T1) + tests; temp real-booking mutation (T2); button rewire (T3); verify (T4). Decisions honored (canonical + separator-insensitive; temp buttons kept). Bell sim-injection left dead-but-harmless for the final cleanup pass.
