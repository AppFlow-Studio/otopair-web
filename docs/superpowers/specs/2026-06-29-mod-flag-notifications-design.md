# Phase B — Vehicle-Mod Flag on New-Booking Notifications — Design

**Date:** 2026-06-29
**Status:** Approved (design + decisions), pending spec review
**Builds on:** `2026-06-29-vehicle-mod-systems-design.md` (Phase A — capture + the `servicesForSystems` brain).

## Goal

When a new booking arrives whose service is affected by the vehicle's recorded
modifications, surface a **"THIS VEHICLE IS MODIFIED"** flag on that booking's
notification card, showing the shop-entered mod **description** — so the mechanic
knows before accepting. Plus a temp dev button to preview the flag without a real
cross-shop booking.

## How the notification system works (discovered)

Bell (`components/notification-bell.tsx`) → query **`mechanicNotifications.getFeed`**
→ `NotificationPopover` → **`NotificationCard`** (the "New booking" card). `getFeed`
builds each booking item from a pending booking and already has `booking.vin` and
`booking.service_ids`. That's all we need to compute the flag.

## Decisions (locked with user)

- Flag content = the mod **`notes`** (free-text description). **No shop attribution**
  (the brief's "Logged by …" line is dropped).
- Long descriptions **clamp (~2 lines) with a "More" expand toggle**.
- Temp simulate button = **inline preview, no DB write**; lives **in the booking
  detail panel** next to the existing 🧪 button.

## A. Flag matching helper (`lib/vehicle-mod-systems.ts`, additive)

```ts
export function affectedServiceSlugs(systems: AffectedSystem[]): Set<string> {
  return new Set(servicesForSystems(systems).map((s) => s.slug));
}
export function anyServiceAffected(serviceSlugs: string[], systems: AffectedSystem[]): boolean {
  const affected = affectedServiceSlugs(systems);
  return serviceSlugs.some((slug) => affected.has(slug));
}
```
Pure, unit-tested.

## B. Flag data — `convex/mechanicNotifications.ts` `getFeed`

In the `confirmItems` builder (booking kind):
- Collect the booking's service **slugs** (today it collects only `name`s — add `slug`).
- Look up the passport: `vehicle_passports` by_vin (`booking.vin`) → `modifications`.
- Compute:
  ```ts
  const modAffected =
    mods?.has_mods === true &&
    anyServiceAffected(serviceSlugs, mods.affected_systems ?? []);
  ```
- Add to the item:
  ```ts
  modFlag: modAffected ? { affected: true, notes: mods?.notes ?? null } : null,
  ```
- Import `anyServiceAffected` from `../lib/vehicle-mod-systems`.
- Tire/rotor items get `modFlag: null` (keep the item shape uniform).

## C. Flag UI — `components/notifications/notification-card.tsx`

- Extend `NotificationItem`: `modFlag?: { affected: boolean; notes?: string | null } | null`.
- Add an optional `preview?: boolean` prop to `NotificationCard`.
- When `item.kind === "booking"` and `item.modFlag?.affected`, render an amber callout
  **above the action row**:
  - Eyebrow: ⚠ **THIS VEHICLE IS MODIFIED** (amber).
  - Body: the `notes` text, `line-clamp-2` by default; a **"More"/"Less"** text toggle
    expands/collapses when the text overflows. If `notes` is empty, show
    "Aftermarket modifications affect this service." as fallback.
  - No shop name, no date.
- When `preview === true`, **hide the Accept/Decline/Details action row** (it's a
  visual simulation, not a live booking).
- Styling: amber theme (`bg-amber-50`, `border-amber-200`, `text-amber-800`), matching
  the card's existing utility-class style.

## D. Temp simulate button — `components/booking-detail-panel.tsx`

Next to the existing `🧪 Open Pre-Job form (temp)` button, add a second temp button
**🔔 Simulate new-booking notification (temp)** (same dashed-amber dev styling, same
`// TEMP … remove before shipping` marker).

On click, toggle an inline preview block that renders the **real `NotificationCard`** in
`preview` mode, fed a mock item built **client-side** from this booking's vehicle
passport mods:
- `mods = vehiclePassport?.passport.modifications`.
- `services = servicesForSystems(mods.affected_systems ?? [])` (client import from
  `@/lib/vehicle-mod-systems`).
- Mock item: `kind: "booking"`, this vehicle's label, the customer, **the first affected
  service name** as `services: [services[0].name]` (so the flag is relevant),
  `scheduledLabel`/`price` copied from the current job, and
  `modFlag: mods?.has_mods ? { affected: services.length > 0, notes: mods.notes } : null`.
- If `mods?.has_mods` is false or `services.length === 0` (e.g. cosmetic-only), the
  preview still renders the card but with **no flag** (demonstrates the "no mods affect
  this service" case) — optionally a one-line "No modifications affect this service."

No DB writes. Uses the passport data already loaded in the panel.

## Files

- `lib/vehicle-mod-systems.ts` (+ helpers) and `tests/vehicleModSystems.test.ts` (+ tests).
- `convex/mechanicNotifications.ts` (`getFeed` flag computation + service slugs).
- `components/notifications/notification-card.tsx` (type + flag UI + `preview` prop).
- `components/booking-detail-panel.tsx` (temp simulate button + inline preview).

## Out of scope (later)

- Aligning all real service slugs to the locked taxonomy (so real bookings auto-fire
  beyond the slugs that already match: `oil-change`, `wheel-alignment`, `tire-rotation`).
- The standalone mobile Surface-2 redesign (we integrate into the existing card instead).
- `low_clearance` attribute / under-car generic flag.
- Removing the temp buttons (kept for ongoing testing).

## Testing

- Unit (`tests/vehicleModSystems.test.ts`): `anyServiceAffected` — true when a booking
  slug is in the union (e.g. `["wheel-alignment"]` + `["suspension_ride_height"]` → true);
  false when none (`["oil-change"]` + `["suspension_ride_height"]` → false); false for
  `cosmetic_only`; false for empty systems.
- Manual (localhost, Chrome): enter mods (Suspension + Wheels & tires) in pre-job → save →
  click 🔔 simulate → preview card shows "New booking … Wheel Alignment" with the amber
  "THIS VEHICLE IS MODIFIED" + notes; long notes clamp with a working "More" toggle; no
  shop name shown.
