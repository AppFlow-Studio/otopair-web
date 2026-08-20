# Otopair Web

Next.js shop-side web portal. Shares one Convex backend with `otopair` (mobile,
driver-facing) — a separate repo.

## Known gap: `known_issue_events` can drift from its source record

The mechanic-inspection path (`convex/inspectionHealthDeferred.ts`) writes the
same finding to both `known_issue_events` (the provenance log) and
`vehicle_inspections.zones` (the inspection's own record) in the same deferred
job. If either write path is ever touched independently, they can disagree —
check both before changing one. See `convex/lib/knownIssueEvents.ts`.
