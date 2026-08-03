# Handoff — Vehicle-Mod Flag: 3 Follow-ups + Final Cleanup

**Date:** 2026-06-29
**Branch:** `waleed-fix`
**Deployment:** `dev:flippant-mink-750` (Convex). Localhost dev server: `npm run dev` (Next.js 16 / Turbopack).
**Tests:** `npx vitest run` (config only includes `tests/**/*.test.ts`). Mod tests: `tests/vehicleModSystems.test.ts`.

---

## Where things stand (DONE + verified)

The vehicle-modification flag feature is **built, committed, and verified end-to-end in the user's Chrome**:

- **Phase A (capture):** Pre-job form captures mods as a boolean + one free-text description + a multi-select of "affected systems" (chips). The brain is `lib/vehicle-mod-systems.ts` (`AFFECTED_SYSTEMS`, `SYSTEM_SERVICE_MAP`, `servicesForSystems`, `affectedServiceSlugs`, `anyServiceAffected`, `normalizeSlug`).
- **Phase B (flag):** New-booking notifications in the bell append a **"⚠ THIS VEHICLE IS MODIFIED"** flag when the booked service is affected by the car's recorded mods. Acknowledge-gate: big flag → "Tap to acknowledge" → collapses to a small "⚠ Vehicle modified · View" chip and reveals Accept/Decline/Details.
- **Full wire (slug alignment):** `SYSTEM_SERVICE_MAP` uses the deployment's **canonical underscore slugs**; matching is **separator-insensitive** (`normalizeSlug`, `[\s_-]+ → -`) so the flag fires on both canonical and demo bookings.

**Key commits (newest first):** `bbb7e09` (temp button → real booking), `0339968` (temp mutation), `54a3f86` (slug align), `355feb3` (acknowledge gate), `6ad1477`/`0757c5e`/`6934030`/`30fb248`/`2313658` (Phase B flag), `8039b25`/`911a562`/`c973987` (Phase A affected-systems model).

**Verified live:** 🧪 edit a car's mods → 🔔 spawn → bell shows a REAL pending "New booking" (e.g. Casey M. · 2019 Subaru Outback · Diagnostic Scan) with the flag → acknowledge reveals working actions. The flag fires through the real `getFeed` path.

---

## ⚠ Editing constraint (notification-card.tsx)

`components/notifications/notification-card.tsx` uses **HTML entities, NOT literal glyphs** — `&#9888;` (⚠), `&#183;` (·), `&ldquo;`/`&rdquo;` (smart quotes). A prior Edit corrupted this file by inserting real smart quotes (U+201C/U+201D), breaking tsc. **When editing this file, preserve the entities and never paste raw smart quotes.**

---

## FOLLOW-UP 1 — "More" button should only show on real overflow — ✅ DONE (commit `2a265d9`)

> Implemented: new `ModNotes` component measures real overflow via `ResizeObserver` (`scrollHeight > clientHeight + 1`), gates the toggle on `overflowing || expanded`. Typecheck clean; adversarially verified (6/6 reviewers pass, incl. a 5-scenario behavioral trace). Details below kept for reference.

**Where:** `components/notifications/notification-card.tsx:264` (inside the `hasModFlag && !acknowledged` flag block, ~lines 250-294).

**Current logic:**
```ts
const long = notes.length > 80;
// ...
<p className={`mt-1 text-xs text-amber-900/90 ${long && !modExpanded ? "line-clamp-2" : ""}`}>
  {notes}
</p>
{long && ( <button ...>{modExpanded ? "Less" : "More"}</button> )}
```

**Problem:** `notes.length > 80` is a char-count heuristic. 80 chars often fits inside the 2-line clamp on a wide card, so "More" shows even when nothing is actually truncated — a useless button.

**Desired (user):** "only show when there's an x amount of characters or 3+ lines of mod description … so theres an actual use to the button." → Show "More" **only when the description genuinely overflows the clamp.**

**Recommended fix (measure actual overflow):** replace the char heuristic with a ref measurement. Add a `ref` to the `<p>` and a `const [overflowing, setOverflowing] = useState(false)`; in a `useLayoutEffect` (re-run on `notes` + when `modExpanded` is false), compare `el.scrollHeight > el.clientHeight` while the clamp is applied, and gate the button on `overflowing` instead of `long`. (A `ResizeObserver` makes it robust to width changes, but a `useLayoutEffect` keyed on `notes` is enough for the card.) Keep the entity/glyph constraint above.

> Note: the passport-card mods display (Follow-up 2) shows the full notes with `whitespace-pre-wrap` and no clamp — no "More" button there. The "More" only exists in the notification card.

---

## FOLLOW-UP 2 — Move mods into their own "Vehicle Mods" section (not under customer notes) — ✅ DONE (commit `dbd1157`)

> Implemented on `vehicle-passport-card.tsx`: mods pulled out of the "Customer notes" section into a new `<Section title="Vehicle mods" icon={Wrench}>` placed right after "Previous mechanic comments", rendering the mod description + affected-system chips; `NotesSection` now shows only customer notes; `hasNotes` dropped the mods condition. Typecheck clean; adversarially verified (spec-compliance + edge-state reviewers pass). Surface confirmed = `vehicle-passport-card.tsx`. Details below kept for reference.

**Current:** In `components/vehicle-passport-card.tsx`, the **"Customer notes"** `<Section>` (line `932`) renders `NotesSection` (lines `606-655`), which stacks two blocks under one header: `CUSTOMER NOTES` then `MODIFICATIONS` (notes + "Affects: …" affected-system labels). So mods visually live **under customer notes**.

**Desired (user):** a **new dedicated section titled "Vehicle Mods"**, placed near the mechanic-facing sections (user said "under mechanic notes"), showing **what systems are affected + the mod description** — separated from customer notes.

**⚠ Surface ambiguity to confirm with the user first:**
- `vehicle-passport-card.tsx` (the booking-detail passport card) is where mods render **under "Customer notes"** — this matches the user's description. BUT this file's mechanic-facing section is titled **"Previous mechanic comments"** (line `917`), there is no section literally titled "Mechanic notes" here.
- `vehicle-passport-section.tsx` (the enrichment accordion) is the file that HAS a **"Mechanic notes"** section (line `331-333`); there, mods are a **row under "Usage"** (line `270-280`), not under customer notes.

The "mods under customer notes" wording points to **`vehicle-passport-card.tsx`** as the target surface. Most likely intent: in `vehicle-passport-card.tsx`, **extract the `MODIFICATIONS` block out of `NotesSection`** into a new `<Section icon={...} title="Vehicle mods">` placed right after "Previous mechanic comments" (line `917-929`) and before/after "Customer notes". Confirm placement + whether they also want the `vehicle-passport-section.tsx` "Usage" row changed.

**Implementation sketch (vehicle-passport-card.tsx):**
1. In `NotesSection` (606-655): remove the `{hasMods && (…MODIFICATIONS…)}` block (626-652) so it renders **only** customer notes. Update the early-return at 617-623 to key on `customerNotes` only (and update `hasNotes` at lines `738-741` which currently also checks `modifications?.has_mods`).
2. Add a new `VehicleModsSection({ passport })` component rendering: the mod `notes` (or "Aftermarket parts present." fallback) + the affected systems via `affectedSystemLabel(s)` — reuse the existing markup from 636-652. Pick a fitting `lucide-react` icon (e.g. `Wrench` or `Settings2`; check existing imports).
3. Add a `<Section icon={Wrench} title="Vehicle mods" rightSlot={…count or "None"}>` near the mechanic sections; render it only when `passport?.passport.modifications?.has_mods === true` (or always, with a "None recorded" empty state — confirm with user).
4. `affectedSystemLabel` is already imported in this file. Keep theme tokens (`text-muted-foreground`, `text-foreground`) consistent with the surrounding sections.

---

## FOLLOW-UP 3 — Conditional-flag wiring (ANSWERED: already wired)

**Question:** does the notification only flag when the mods affect the booked service?

**Answer: yes.** `convex/mechanicNotifications.ts` `getFeed` (lines `268-282`) sets `modFlag` only when `mods?.has_mods === true && anyServiceAffected(serviceSlugs, mods.affected_systems ?? [])`; otherwise `modFlag = null`. Non-affected bookings show the normal notification **without** the flag. The booking notification itself always appears (every pending booking notifies) — only the flag is conditional. This is the intended behavior; no change needed. (If the user later wants the *whole* notification suppressed when unaffected, that's a different, larger change — don't assume it.)

---

## Final cleanup — ✅ DONE 2026-07-02 (commits `dad6c13`, `d1d30a4`, `9a6bc3c`; 6 test bookings deleted via dry-run-reviewed one-shot; verified live with zero scaffolding — real vehicle-check edit flagged another customer's pending booking on the same VIN, negative case confirmed). Original checklist kept below for reference.

The user explicitly wants this as the closing step ("then we can get rid of all the temp buttons and fully wire"), **after** they're satisfied with the follow-ups. Remove:

- `components/booking-detail-panel.tsx`: the `🧪 Open Pre-Job form (temp)` button and the `🔔 Spawn flagged booking in bell (temp)` button + its `simulateNewBookingFromBooking` `useMutation` hook.
- `convex/bookings.ts`: the `simulateNewBookingFromBooking` TEMP mutation.
- `components/notification-bell.tsx`: the now-DEAD sim-injection mechanism — `simItems` state, the `otopair:sim-notification` window listener, and `mergedFeed` (the bell should just use the live `getFeed` query).
- `components/notifications/notification-card.tsx`: the `preview?` prop and `simulated?` field plumbing on `NotificationItem` (only used by the removed preview). Keep `modFlag`, `acknowledged`, `modExpanded` (production).
- Any temp dev clear/seed mutations added during testing (e.g. a `clearAllModifications`), if still present.
- **Test bookings:** clicking 🔔 + the smoke test created several real `pending_shop_acceptance` bookings cluttering the bell — clean them up (decline/cancel/delete) when removing the buttons.

After cleanup: re-run `npx tsc --noEmit -p tsconfig.json` (baseline is ~215 pre-existing errors; `booking-detail-panel.tsx` has 3 known pre-existing errors unrelated to this work — `scheduledStartMs`, `VehiclePassportCardProps`, implicit-any `photo`). `npx vitest run` should show only the pre-existing failures.

---

## Uncommitted / untracked (do NOT auto-commit without asking)

- `components/ui/combobox.tsx` (M) — the portal-dropdown clipping fix; user hasn't asked to commit it.
- `docs/superpowers/specs/*` + `docs/superpowers/plans/*` (untracked) — the mod-feature spec/plan docs.
- This handoff.

Commit/push ONLY when the user asks. Shared dev deployment — be careful with data ops. Never enter Clerk credentials (that's the user's job).

## Test login / seed context

Mechanic `lukeskywalker+clerk_test@gmail.com`, Shop Owner `shopowner+clerk_test@gmail.com` (Clerk test users; user logs in). Data was seeded via `seedDashboardBookings` + `npx convex import` matched to those Clerk IDs. Two service sets exist in the deployment: **canonical** (underscore slugs, ~23 services) and a **demo** set (hyphen slugs from `seedDashboardBookings`) — which is why matching must be separator-insensitive.
