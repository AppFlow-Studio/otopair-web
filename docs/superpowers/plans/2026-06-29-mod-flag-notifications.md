# Phase B — Mod Flag on New-Booking Notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Surface a "THIS VEHICLE IS MODIFIED" flag (showing the mod description) on a New-booking notification card when the booking's service is affected by the vehicle's recorded mods; plus a temp inline-preview button to demo it.

**Architecture:** Pure matching helper in `lib/vehicle-mod-systems.ts`; `getFeed` computes the flag per booking item from VIN→passport mods vs. the booking's service slugs; `NotificationCard` renders the amber callout (+ a `preview` mode); a temp button in the booking detail panel renders a client-side preview of the card. Spec: [docs/superpowers/specs/2026-06-29-mod-flag-notifications-design.md](../specs/2026-06-29-mod-flag-notifications-design.md).

**Tech stack:** Next.js 16 / React 19, Convex, Vitest. Deployment `dev:flippant-mink-750`. `npx convex dev --once` pushes once.

**Scope:** Phase B as specced. NOT in scope: aligning all service slugs to the taxonomy, removing temp buttons, the standalone mobile surface.

**Baseline:** suite has 3 pre-existing unrelated failures (`customer_late`, `partSelector`, `timeSlotAvailability`). Unrelated uncommitted files (`components/ui/combobox.tsx`, `components/booking-detail-panel.tsx` already has the 🧪 temp button) — each task commits only its own files; the booking-detail-panel change in Task 4 is intentional.

---

### Task 1: Matching helpers + tests (`lib/vehicle-mod-systems.ts`)

**Files:** Modify `lib/vehicle-mod-systems.ts`; Modify `tests/vehicleModSystems.test.ts`

- [ ] **Step 1: Add failing tests** to `tests/vehicleModSystems.test.ts` (new `describe`, import the new helpers):

```ts
import { anyServiceAffected } from "../lib/vehicle-mod-systems";

describe("anyServiceAffected", () => {
  it("true when a booking slug is in the union", () => {
    expect(anyServiceAffected(["wheel-alignment"], ["suspension_ride_height"])).toBe(true);
  });
  it("true on overlap among multiple booking slugs", () => {
    expect(anyServiceAffected(["oil-change", "rotor-replacement"], ["brakes"])).toBe(true);
  });
  it("false when none overlap", () => {
    expect(anyServiceAffected(["oil-change"], ["suspension_ride_height"])).toBe(false);
  });
  it("false for cosmetic_only", () => {
    expect(anyServiceAffected(["wheel-alignment"], ["cosmetic_only"])).toBe(false);
  });
  it("false for empty systems or empty slugs", () => {
    expect(anyServiceAffected(["wheel-alignment"], [])).toBe(false);
    expect(anyServiceAffected([], ["suspension_ride_height"])).toBe(false);
  });
});
```

- [ ] **Step 2: Run, see fail** — `npx vitest run tests/vehicleModSystems.test.ts` → FAIL (export missing).

- [ ] **Step 3: Implement** — append to `lib/vehicle-mod-systems.ts`:

```ts
// Slugs of every service the selected systems flag (deduped union).
export function affectedServiceSlugs(systems: AffectedSystem[]): Set<string> {
  return new Set(servicesForSystems(systems).map((s) => s.slug));
}

// True if any of the booking's service slugs is flagged by the systems.
export function anyServiceAffected(
  serviceSlugs: string[],
  systems: AffectedSystem[]
): boolean {
  const affected = affectedServiceSlugs(systems);
  return serviceSlugs.some((slug) => affected.has(slug));
}
```

- [ ] **Step 4: Run, see pass** — `npx vitest run tests/vehicleModSystems.test.ts` → all pass.

- [ ] **Step 5: Commit** — `git add lib/vehicle-mod-systems.ts tests/vehicleModSystems.test.ts && git commit -m "feat(mods): service-affected matching helpers"`

---

### Task 2: Flag computation in `getFeed` (`convex/mechanicNotifications.ts`)

**Files:** Modify `convex/mechanicNotifications.ts`

- [ ] **Step 1: Import the helper** — add near the top imports:
```ts
import { anyServiceAffected } from "../lib/vehicle-mod-systems";
```

- [ ] **Step 2: In the `confirmItems` builder** (the `pendingConfirm.map(async (booking) => {...})`), collect service slugs and compute the flag. Replace the service-name collection block:
```ts
        const serviceNames: string[] = [];
        if (booking.service_ids?.length) {
          const services = await Promise.all(
            booking.service_ids.map((id: any) => ctx.db.get(id))
          );
          for (const s of services) {
            if (s && (s as any).name) serviceNames.push((s as any).name);
          }
        }
```
with:
```ts
        const serviceNames: string[] = [];
        const serviceSlugs: string[] = [];
        if (booking.service_ids?.length) {
          const services = await Promise.all(
            booking.service_ids.map((id: any) => ctx.db.get(id))
          );
          for (const s of services) {
            if (s && (s as any).name) serviceNames.push((s as any).name);
            if (s && (s as any).slug) serviceSlugs.push((s as any).slug);
          }
        }

        // Vehicle-mod flag: does this vehicle have recorded mods that affect
        // one of this booking's services?
        let modFlag: { affected: boolean; notes: string | null } | null = null;
        if (booking.vin) {
          const passport: any = await ctx.db
            .query("vehicle_passports")
            .withIndex("by_vin", (q: any) => q.eq("vin", booking.vin))
            .first();
          const mods = passport?.modifications;
          if (
            mods?.has_mods === true &&
            anyServiceAffected(serviceSlugs, mods.affected_systems ?? [])
          ) {
            modFlag = { affected: true, notes: mods.notes ?? null };
          }
        }
```

- [ ] **Step 3: Add `modFlag` to the returned confirm item** — in the `return { kind: "booking" as const, ... }` object (after `rotorSpecs: null,`), add:
```ts
          modFlag,
```

- [ ] **Step 4: Add `modFlag: null` to the tire and rotor item returns** (keep the item shape uniform) — in both `tireItems` and `rotorItems` `return {...}`, add after `rotorSpecs: ...,`:
```ts
          modFlag: null,
```

- [ ] **Step 5: Push + typecheck** — `npx convex dev --once` clean; `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "mechanicNotifications"` → no errors.

- [ ] **Step 6: Commit** — `git add convex/mechanicNotifications.ts && git commit -m "feat(mods): compute mod flag on new-booking feed items"`

---

### Task 3: Flag UI + preview mode (`components/notifications/notification-card.tsx`)

**Files:** Modify `components/notifications/notification-card.tsx`. Manual verification.

- [ ] **Step 1: Extend the `NotificationItem` type** — add a field (after `urgency?: ...`):
```ts
  modFlag?: { affected: boolean; notes?: string | null } | null;
```

- [ ] **Step 2: Add `preview` prop** — change the props interface + signature:
```ts
interface NotificationCardProps {
  item: NotificationItem;
  onSkip: (bookingId: string) => void;
  onAfterAction?: () => void;
  preview?: boolean;
}
```
```ts
export function NotificationCard({
  item,
  onSkip,
  onAfterAction,
  preview = false,
}: NotificationCardProps) {
```

- [ ] **Step 3: Add expand state** — near the other `useState`s in the component:
```ts
  const [modExpanded, setModExpanded] = useState(false);
```

- [ ] **Step 4: Render the flag** — insert ABOVE the `{error && (...)}` block (i.e. after the `{item.note && (...)}` block), so it sits above the actions:
```tsx
      {isBooking && item.modFlag?.affected && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800">
            <span aria-hidden>⚠</span> This vehicle is modified
          </p>
          {(() => {
            const notes = item.modFlag.notes?.trim();
            if (!notes) {
              return (
                <p className="mt-1 text-xs text-amber-900/90">
                  Aftermarket modifications affect this service.
                </p>
              );
            }
            const long = notes.length > 80;
            return (
              <>
                <p
                  className={`mt-1 text-xs text-amber-900/90 ${
                    long && !modExpanded ? "line-clamp-2" : ""
                  }`}
                >
                  {notes}
                </p>
                {long && (
                  <button
                    type="button"
                    onClick={() => setModExpanded((v) => !v)}
                    className="mt-0.5 text-[11px] font-semibold text-amber-800 hover:text-amber-900"
                  >
                    {modExpanded ? "Less" : "More"}
                  </button>
                )}
              </>
            );
          })()}
        </div>
      )}
```

- [ ] **Step 5: Hide actions in preview mode** — wrap the actions. Change `{!confirmingDecline && (` (the action row) to also require `!preview`:
```tsx
      {!confirmingDecline && !preview && (
```
(Leave the `confirmingDecline` block as-is; preview mode never enters it.)

- [ ] **Step 6: Verify** — `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "notification-card"` → empty.

- [ ] **Step 7: Commit** — `git add components/notifications/notification-card.tsx && git commit -m "feat(mods): mod flag UI + preview mode on notification card"`

---

### Task 4: Temp simulate button + inline preview (`components/booking-detail-panel.tsx`)

**Files:** Modify `components/booking-detail-panel.tsx`. Manual verification. READ the existing 🧪 temp button block first to anchor.

- [ ] **Step 1: Imports** — add:
```ts
import { NotificationCard, type NotificationItem } from "@/components/notifications/notification-card";
import { servicesForSystems } from "@/lib/vehicle-mod-systems";
```

- [ ] **Step 2: State** — near the panel's other `useState`s (the inner component that has `showPrejobDialog`), add:
```ts
    const [showModNotifPreview, setShowModNotifPreview] = useState(false);
```

- [ ] **Step 3: Build the mock item + add the button and preview** — directly AFTER the existing `🧪 Open Pre-Job form (temp)` button block (the `<button ...>🧪 Open Pre-Job form (temp)</button>`), insert:
```tsx
                {/* TEMP: simulate the new-booking notification (with mod flag)
                    for this vehicle. Client-side preview only — no DB write.
                    Remove before shipping. */}
                <button
                  type="button"
                  onClick={() => setShowModNotifPreview((v) => !v)}
                  className="w-full rounded-lg border border-dashed border-amber-400 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100"
                >
                  🔔 Simulate new-booking notification (temp)
                </button>
                {showModNotifPreview && job && (() => {
                  const mods = vehiclePassport?.passport.modifications;
                  const affectedServices = servicesForSystems(
                    mods?.affected_systems ?? [],
                  );
                  const flagOn = mods?.has_mods === true && affectedServices.length > 0;
                  const mockItem: NotificationItem = {
                    kind: "booking",
                    bookingId: job._id,
                    createdAt: Date.now(),
                    isUnread: true,
                    customer: { full: job.customerName, short: job.customerName },
                    vehicle: { full: job.vehicle, short: job.vehicle },
                    services: flagOn
                      ? [affectedServices[0].name]
                      : job.serviceNames,
                    scheduledDate: job.scheduledDate ?? null,
                    scheduledTime: job.scheduledTime ?? null,
                    scheduledLabel: formatBookingDate(
                      job.scheduledDate,
                      job.scheduledTime,
                    ),
                    price: job.totalCost ?? null,
                    note: null,
                    urgency: null,
                    tireSpecs: null,
                    rotorSpecs: null,
                    modFlag: flagOn ? { affected: true, notes: mods?.notes ?? null } : null,
                  };
                  return (
                    <div className="rounded-lg border border-border bg-card p-2">
                      <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Simulated bell notification
                      </p>
                      <ul className="rounded-md border border-border">
                        <NotificationCard item={mockItem} onSkip={() => {}} preview />
                      </ul>
                      {!flagOn && (
                        <p className="mt-1 px-1 text-[11px] text-muted-foreground">
                          No modifications affect this service.
                        </p>
                      )}
                    </div>
                  );
                })()}
```
NOTE: the property names (`job._id`, `job.customerName`, `job.vehicle`, `job.serviceNames`, `job.scheduledDate`, `job.scheduledTime`, `job.totalCost`, `vehiclePassport`, `formatBookingDate`) must match what this component actually uses — READ the component and adjust names to the real ones (e.g. price may be `job.totalCost`/`job.price`; the passport variable may be `vehiclePassport`). If a needed field doesn't exist on `job`, use the closest available or a sensible literal, and note it. `NotificationItem.bookingId` is an `Id<"bookings">` — `job._id` satisfies it.

- [ ] **Step 4: Verify** — `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "booking-detail-panel"` → empty. If property-name mismatches appear, fix them against the real `job`/passport shape.

- [ ] **Step 5: Commit** — `git add components/booking-detail-panel.tsx && git commit -m "feat(mods): temp simulate-notification preview in booking panel"`

---

### Task 5: Verification

- [ ] **Step 1:** `npx vitest run tests/vehicleModSystems.test.ts` → all pass; `npx vitest run` shows only the 3 pre-existing failures.
- [ ] **Step 2:** Manual (localhost, Chrome MCP, signed in as mechanic): open a job → 🧪 Open Pre-Job → Modifications → Yes → notes "H&R springs ~1.5in drop, 25mm wheel spacers" → Suspension + Wheels & tires → Save and start (or save) → back in the panel click 🔔 Simulate → confirm the preview card shows "New booking … Wheel Alignment" with amber "THIS VEHICLE IS MODIFIED" + the notes, a working More/Less if long, and NO shop name / NO action buttons.
- [ ] **Step 3:** Confirm working tree clean except known unrelated files + docs.

---

## Self-review (author)
- **Spec coverage:** helper+tests (T1), getFeed flag (T2), card UI+preview (T3), temp button+preview (T4), verification (T5). ✓
- **Type consistency:** `anyServiceAffected`, `affectedServiceSlugs`, `modFlag: { affected; notes? }`, `NotificationItem`, `preview` — consistent across tasks. ✓
- **Compiles each step:** T1 additive; T2 adds an extra prop (harmless before T3 declares it); T3 declares the type + UI; T4 consumes T3. ✓
- **No placeholders** (T4 flags the read-and-match-real-names step explicitly). ✓
