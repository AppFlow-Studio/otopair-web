# Convex Backend

## What This Space Is For
All backend logic: database schema, queries, mutations, actions, scheduled functions. Convex is the sole backend — no REST API layer.

## Process
1. **Schema first.** All table changes start in convex/schema.ts.
2. **Run `npx convex dev`** after any schema change to regenerate types.
3. **Auth check in every user-facing function.** Use `ctx.auth.getUserIdentity()`.
4. **Queries for reads** (reactive, auto-update UI). **Mutations for writes** (transactional). **Actions for external APIs** (not reactive).
5. **Test with `npx convex run`** for quick function testing.

## Key Files
- `schema.ts` — 56+ table definitions. THE source of truth.
- `vehicles.ts` — Vehicle CRUD
- `bookings.ts` — Booking lifecycle
- `services.ts` — Service definitions and categories
- `shops.ts` — Shop queries
- `mechanics.ts` — Mechanic queries
- `users.ts` — User profile management
- `vehicleEnrichment/` — 40+ files for the 3-tier enrichment pipeline (see pipeline CONTEXT)

## Conventions
- One file per table (mostly). Related tables can share a file.
- Export queries with `query()`, mutations with `mutation()`, actions with `action()`.
- Use validators (`v.string()`, `v.number()`, etc.) for all args.
- Vehicle config key format: `{year}_{make}_{model}_{trim}_{engineCode}`

## What NOT To Do
- Don't edit convex/_generated/. Ever.
- Don't skip auth checks in user-facing functions.
- Don't use `action()` when `mutation()` suffices — actions can't read/write the DB directly.
- Don't forget to run `npx convex dev` after schema changes.
