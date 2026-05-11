# Director Panel — Dev Notes

Internal admin panel served at `admin.otopair.com` (locally: `localhost:3000/director`).
Route group: `app/(director-panel)/director/`. No Clerk auth — access-controlled at middleware level.

---

## Status per Tab

### ✅ Overview — Done
- All 9 counters pull from Convex (bookings, shops, users, bugs, app_feedback tables)
- Sub-labels: "X unassigned" under Open Bugs, "X negative" under Open Feedback
- Today's bookings table is live from Convex
- Bug + feedback triage lists pull from real tables
- Sidebar badges (Bugs, Feedback, Stripe) update live via `sidebarCounts` query

### ✅ Shops — Done
- Table: real shop list with mechanic counts (shop_users), 7d booking counts, Stripe status, rating
- Filters: search, status, Stripe-only, has-bookings-7d — all work on live data
- Modal: fetches `shopDetail` on demand — real team members, last 5 bookings, Stripe connect details
- "Open Shop CRM" → opens `/dashboard?shop=<id>` in new tab
- "Open in Stripe" → links to Stripe Connect account dashboard
- Notes panel present (not yet persisted — see TODO below)

### ⬜ Users — Needs Convex wiring
- `usersList` query exists in `convex/director.ts` (name, email, phone, joined, booking count)
- Vehicles count is hardcoded 0 — needs join with `vehicles` table
- Last booking date works
- Modal: vehicles panel, recent bookings, transactions, admin actions (Resend/Reset/Soft Delete)
- Admin action mutations not yet wired — need to call Clerk API or Convex mutations
- Confirm dialog present but does nothing yet

### ⬜ Bookings — Needs Convex wiring
- `recentBookingsList` query exists in `convex/director.ts`
- Table needs full Convex data (user name, shop name, service names, status, total)
- Modal: BookingTimeline needs real `booking_status_history` data
- Payment details (Stripe payment ID, card) need Stripe lookup
- Mechanic assigned panel needs real mechanic data
- User rating from `reviews` table

### ✅ Bugs — Done
- `bugs` table added to schema
- `convex/bugs.ts`: `listByStatus`, `updateStatus`, `updateAssignee`, `create`, `seed`
- Kanban board fully wired — 6 columns, real data
- Modal: status + assignee editable and saved to Convex
- Seed data available via `bugs:seed` mutation (run once from Convex dashboard)

### ✅ Feedback — Done
- `app_feedback` table added to schema
- `convex/app_feedback.ts`: `listByStatus`, `updateStatus`, `updateFields`, `seed`
- Kanban board fully wired — 7 columns, real data
- Modal: category, sentiment, status all editable and saved to Convex
- Seed data available via `app_feedback:seed` mutation (run once from Convex dashboard)

### ⬜ Stripe — Partially done
- Accounts view: pulls from `shopsList` query — real Stripe connect status
- Pending payout amounts are fake (Math.random) — needs real Stripe API data
- Refunds view: pulls from bookings with status = "refunded"
- Tag Refund modal present but save doesn't persist reason yet
- Needs: Stripe API integration or a `refund_reason` field on bookings table

### ⬜ Audit — Partially done
- Uses `AUDIT_ENTRIES` mock data from `data.ts`
- Needs a real `audit_log` table in Convex schema
- Should record every director action (status change, note, field edit) as an entry
- Filter UI (action type, actor, search) is built — just needs real data source

---

## TODOs / Known Gaps

- **Notes panel**: ✅ Done — `director_notes` table wired. Notes persist per entity across all modals (bugs, feedback, shops, users, bookings).
- **Audit log**: ✅ Done — `audit_log` table wired. Entries written on: bug status/assignee changes, feedback field/status changes, user soft delete, note added. TabAudit shows live data with search + filter.
- **Users tab**: vehicles count needs `vehicles` table join. Admin actions (resend verification, reset password, soft delete) need Clerk API calls via Convex actions.
- **Bookings tab**: full modal wiring — status history, Stripe payment details, mechanic data, reviews.
- **Stripe tab**: pending/last payout amounts need real Stripe Connect API data (Convex action calling Stripe).
- **Subdomain**: `admin.otopair.com` DNS must point to the Next.js deployment. Middleware rewrite already handles the routing.
- **Auth**: director panel is currently public (no auth at the route level). Add IP allowlist or a simple secret header check before going to production.

---

## Key Files

| File | Purpose |
|------|---------|
| `app/(director-panel)/director/page.tsx` | Next.js page — injects CSS vars + fonts, renders AdminPanel |
| `app/(director-panel)/director/AdminPanel.tsx` | Hash routing, sidebar counts, tab switching |
| `app/(director-panel)/director/components/Shell.tsx` | Sidebar (with live badge counts) + SectionAnchor |
| `app/(director-panel)/director/components/Primitives.tsx` | All UI primitives (icons, badges, modal, notes, etc.) |
| `app/(director-panel)/director/components/tabs/` | One file per tab |
| `convex/director.ts` | All director-specific queries (overview, shops, users, bookings) |
| `convex/bugs.ts` | Bugs CRUD + seed |
| `convex/app_feedback.ts` | Feedback CRUD + seed |
| `middleware.ts` | Rewrites `admin.otopair.com` → `/director` |

---

## Seeding Bugs & Feedback

Tables are empty until seeded. Run these once from the Convex dashboard (Functions tab):
- `bugs:seed` — inserts 18 sample bugs across all 6 kanban columns
- `app_feedback:seed` — inserts 12 sample feedback items across all 7 columns

Both mutations are idempotent (check for existing data first).
