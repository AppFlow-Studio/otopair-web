// =============================================================================
// Oto AI — moat-table read wrapper helper (Wave 7.3, Option B)
// =============================================================================
//
// Sprint 1 Day 7 (2026-05-16). Owner: AI Security Analyst.
// Authority:
//   * docs/SPRINT_1/WAVE_7_3_RATE_LIMIT_DESIGN.md §2.2 (helper API).
//   * docs/SPRINT_1/WAVE_7_3_QUERY_CONTEXT_DECISION.md §§4–5 (Option B pick).
//   * PM Ruling v3 §6.7; Architecture v3 Amendments §C.4 + §C.4.1.
//
// PURPOSE
// -------
// This is THE ONLY SANCTIONED in-context read path for the 28 moat tables.
// Every moat-table `ctx.db.query("<moat_table>")` inside `convex/oto/` (with
// the explicit bypass list documented below + per-call `EXEMPT:` annotations)
// MUST route through `queryMoat`. Direct reads are forbidden by CI Rule 7
// (`scripts/ci/vehicle-facts-grep.sh`).
//
// SHAPE OF THE COUNTER
// --------------------
// The helper bumps a denormalized per-user counter on `users`:
//     moat_reads_window         number  rows read this rolling 24h window
//     moat_reads_window_start   number  epoch ms of window open
//     moat_reads_is_admin_exempt boolean Waleed/Temur bypass (set via admin)
// At threshold breach the helper degrades the read instead of throwing:
//   * 1× → 2× threshold: SOFT BLOCK. Returns an empty array; emits a
//     warning to console.warn. No user-facing error, no telemetry surface.
//   * > 2× threshold: HARD BLOCK. Throws a friendly user-facing error.
// Calibration: `threshold = N × MOAT_P95_DEFAULT`. Both are placeholders
// pending Sprint 2 production-telemetry calibration; see constants below.
//
// CONTEXT SUPPORT
// ---------------
// `queryMoat` accepts MutationCtx | ActionCtx. Query-context reads are not
// counted by design (Convex queries cannot patch — the read/write split is
// the platform invariant). The Adv-1 four-table residual that this leaves
// is the explicitly-accepted hole per WAVE_7_3_QUERY_CONTEXT_DECISION §6.1
// and is grandfathered in CI Rule 7.
//
// MIGRATION POSTURE
// -----------------
// Sprint 2 Day 2 update (2026-05-16): Option B wire-through partially landed.
//
//   * Mutation-context moat reads in `convex/oto/` are migrated through
//     `queryMoat()`. Today's wave migrates:
//       - convex/oto/vehicleFactsEditing.ts:recordVehicleFact (vehicle_facts)
//
//   * Action-context bump path now lives on this file via the
//     `bumpUserCounter` internalMutation (see below). Action callers
//     resolve userId upstream (chat.ts already does this for auth) and
//     dispatch `ctx.runMutation(internal.oto.queryMoat.bumpUserCounter, ...)`
//     after each `ctx.runQuery(...)` into a moat-reading query function.
//
//   * Query-context moat reads remain uncounted by platform constraint
//     (Convex queries cannot patch). The Adv-1 four-table residual that
//     this leaves is the explicitly-accepted hole per
//     WAVE_7_3_QUERY_CONTEXT_DECISION §6.1. Each existing query-context
//     read site carries a per-call `EXEMPT:` annotation pointing here.
//
// DESIGN CHOICE — caller-explicit action-side wiring (Option ii)
// ---------------------------------------------------------------
// We export `bumpUserCounter` as an `internalMutation` callable from action
// context, but we DO NOT export a `queryMoatFromAction(ctx, ...)` wrapper.
// chat.ts (the largest consumer) already resolves the calling user upstream
// for auth (line ~340) and dispatches moat reads via explicit
// `ctx.runQuery(api.X.Y, ...)` calls. Asking the caller to follow each of
// those with `ctx.runMutation(internal.oto.queryMoat.bumpUserCounter, ...)`
// matches the existing pattern (telemetry + ai_messages persistence at
// explicit `ctx.runMutation` sites). Hiding the bump behind a wrapper would
// obscure the audit at the call site for no surface-area saving.
//
// If a future caller's read shape doesn't expose a row-count delta cleanly
// (e.g., a query that returns a paginated response with rows under a key),
// the caller computes the delta from the result and passes it explicitly.
// =============================================================================

import { internalMutation } from "../_generated/server";
import type { ActionCtx, MutationCtx } from "../_generated/server";
import type { DataModel, Doc, Id } from "../_generated/dataModel";
import type { NamedTableInfo } from "convex/server";
import type { QueryInitializer } from "convex/server";
import { v } from "convex/values";

// -----------------------------------------------------------------------------
// 28 moat tables — verified against convex/schema.ts on 2026-05-16.
// Order mirrors WAVE_7_3_RATE_LIMIT_DESIGN §1.2 groupings A-G.
// -----------------------------------------------------------------------------

export const MOAT_TABLES = [
  // A. Vehicle structural moat (10)
  "makes",
  "models",
  "generations",
  "trims",
  "engines",
  "transmissions",
  "chassis_variants",
  "chassis_specs",
  "vehicle_configs",
  "drivetrain_configs",
  // B. Trim/spec moat (1)
  "trim_specs",
  // C. Parts moat (3)
  "oem_parts",
  "part_fitments",
  "part_prices",
  // D. Service definitions moat (7)
  "services",
  "service_categories",
  "service_options",
  "service_vehicle_specs",
  "service_intervals",
  "labor_times",
  "mechanic_verifications",
  // E. Tire moat (4)
  "tire_brands",
  "tire_size_cache",
  "tire_models",
  "tire_pricing",
  // F. Vehicle-derivative caches (2)
  "model_year_cache",
  "trim_year_cache",
  // G. Consolidated KB (1)
  "vehicle_facts",
] as const;

export type MoatTable = (typeof MOAT_TABLES)[number];

// -----------------------------------------------------------------------------
// Wave 7.3 (Day 9) — PII read-rate-limit surfaces.
//
// These tables store per-user personal data (semantic preferences, full chat
// history). A compromised auth session could exfiltrate a user's entire
// memory + history via repeated reads at full Convex query speed. The limit
// caps per-user PII-read CALL counts in a rolling window; on hard-block the
// wrap site returns the empty array (degraded mode) rather than throwing,
// so a chat turn never breaks on rate-limit alone.
//
// Distinct from the moat-tables list above (chat-tool moat reads with
// EvalTest filter + row-delta counting against a 24h window) — different
// threat model, different threshold, different units (PII = call count;
// moat = row count).
//
// `conversation_audit` is append-only forensic spine with no current read
// surface in the chat path; it is included here so a future read site can
// be wrapped with the same primitive without a list edit.
// -----------------------------------------------------------------------------

export const PII_TABLES = [
  "user_semantic_facts",
  "conversation_audit",
] as const;

export type PIITable = (typeof PII_TABLES)[number];

/**
 * Per-user PII-read threshold: 50 calls / 600s rolling window (10 min).
 *
 * Calibrated for typical chat usage: a normal user generates ~5-10 PII
 * reads per active conversation (one per turn into the cross-conversation
 * memory envelope plus diagnostic queries). 50 in 10 min is ~5x normal,
 * surfaces abuse without false-positive on heavy-use sessions. Tunable
 * via env `OTO_PII_READ_LIMIT` for runtime override without a deploy.
 */
function getPIIReadLimit(): number {
  const raw =
    typeof process !== "undefined" &&
    process.env &&
    typeof process.env.OTO_PII_READ_LIMIT === "string"
      ? process.env.OTO_PII_READ_LIMIT
      : null;
  if (raw === null) return 50;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return parsed;
}

const PII_READ_WINDOW_MS = 600_000;

// -----------------------------------------------------------------------------
// Calibration constants — both are placeholders for Sprint 2 calibration.
// -----------------------------------------------------------------------------

/**
 * Multiplier on observed p95(legitimate_user_24h_moat_reads). N=50 is the
 * design-doc starting point (range 30-200). Configurable via env var
 * `OTO_MOAT_THRESHOLD_N` for runtime overrides without a code deploy.
 */
function getMoatThresholdN(): number {
  const raw =
    typeof process !== "undefined" &&
    process.env &&
    typeof process.env.OTO_MOAT_THRESHOLD_N === "string"
      ? process.env.OTO_MOAT_THRESHOLD_N
      : null;
  if (raw === null) return 50;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return parsed;
}

/**
 * Stand-in for p95(legitimate_user_24h_moat_reads). 200 is the working
 * number in WAVE_7_3_RATE_LIMIT_DESIGN §4.3 used for the residual-exposure
 * math; it is NOT a measured value yet.
 *
 * TODO: calibrate from production telemetry (Sprint 2).
 */
const MOAT_P95_DEFAULT = 200;

const WINDOW_MS = 24 * 60 * 60 * 1000;

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class MoatRateLimitedError extends Error {
  readonly kind = "MoatRateLimitedError" as const;
  constructor(
    readonly userId: Id<"users">,
    readonly counter: number,
    readonly threshold: number,
  ) {
    super(
      "We're seeing unusual traffic on your account; please try again later.",
    );
    this.name = "MoatRateLimitedError";
  }
}

// -----------------------------------------------------------------------------
// Query-builder typing. The build callback receives the table-scoped
// QueryInitializer Convex returns from `ctx.db.query(tableName)`. We thread
// the table-name literal `T extends MoatTable` through to the callback so
// `.withIndex("<index_name>", ...)` and `.eq("<field>", ...)` resolve against
// the actual table's index/field set instead of collapsing to the system-table
// shape (`by_id`/`by_creation_time` only). This was the latent bug behind the
// Sprint 2 Day 2 cascade: the old `ReturnType<CtxWithDb["db"]["query"]>` alias
// erased the table generic at the callback boundary, so every concrete call
// site would TS2345 at the first index name.
// -----------------------------------------------------------------------------

type CtxWithDb = MutationCtx;
type AnyCtx = MutationCtx | ActionCtx;

// The table-scoped query handle the `build` callback receives. Constructed
// from Convex's `NamedTableInfo<DataModel, T>` so index names + field names on
// `.withIndex(...)` / `.eq(...)` resolve precisely.
type MoatQueryHandle<T extends MoatTable> = QueryInitializer<
  NamedTableInfo<DataModel, T>
>;

// -----------------------------------------------------------------------------
// queryMoat — the canonical helper
// -----------------------------------------------------------------------------

/**
 * The single legal in-context read path for moat tables. The `build`
 * callback receives the table's Convex query handle; whatever it returns
 * (an array of rows, a single row from `.first()`, etc.) is forwarded back
 * to the caller after the counter bump.
 *
 * Bumping happens in mutation context only (Convex queries cannot patch).
 * In action context, callers MUST resolve the underlying mutation via
 * `ctx.runMutation` -- see `bumpUserCounter` below for the canonical bump
 * mutation reference. The helper detects which context it is in and dispatches
 * accordingly.
 *
 * @param ctx          The Convex MutationCtx (or ActionCtx with a sibling bump path).
 * @param tableName    A `MoatTable` literal -- compile-time-checked union of the 28 names.
 * @param build        Callback that wires `withIndex(...)` and finalizes the query.
 *                     The callback's `q` parameter is the table-scoped
 *                     `QueryInitializer` so index names + field names type-check
 *                     against the concrete table.
 * @param opts.threshold Optional explicit threshold override (otherwise N × p95).
 */
export async function queryMoat<Table extends MoatTable, Row>(
  ctx: CtxWithDb,
  tableName: Table,
  build: (q: MoatQueryHandle<Table>) => Promise<Row[]>,
  opts?: { threshold?: number },
): Promise<Row[]> {
  const threshold =
    typeof opts?.threshold === "number"
      ? opts.threshold
      : getMoatThresholdN() * MOAT_P95_DEFAULT;

  // Resolve the calling user (best-effort; system/cron calls return null).
  const userId = await resolveCallingUserId(ctx);

  // Execute the underlying query first; the row-count is the bump delta.
  // Cast the table-scoped query handle to the callback's parameter type --
  // Convex's `ctx.db.query(tableName)` returns the table-scoped initializer
  // at runtime; the cast restores that type for the callback after the
  // dispatch through the union of all moat tables (which TS can't narrow on
  // the value `tableName` alone).
  const q = ctx.db.query(tableName) as unknown as MoatQueryHandle<Table>;
  const rows: Row[] = await build(q);
  const rowsDelta = rows.length;

  // System / cron / unauthenticated calls are NOT subject to the counter.
  if (userId === null) {
    return rows;
  }

  // Check admin exemption + window + threshold. May SOFT-BLOCK or HARD-BLOCK.
  const decision = await applyBumpAndDecide(ctx, userId, rowsDelta, threshold);

  if (decision === "ok") {
    return rows;
  }
  if (decision === "soft_block") {
    // 1×-2× breach. Serve a stale/empty result; no user-facing error.
    // Caller may treat empty-array as "no data" and degrade gracefully.
    console.warn(
      `[queryMoat] soft block for user=${userId} on table=${tableName} ` +
        `(counter exceeded threshold; serving empty result)`,
    );
    return [] as Row[];
  }
  // decision === "hard_block"
  throw new MoatRateLimitedError(userId, rowsDelta, threshold);
}

// -----------------------------------------------------------------------------
// Internal: resolve the calling user via Clerk identity → users row lookup.
// Returns null if unauthenticated (system/cron/action-without-auth).
// -----------------------------------------------------------------------------

async function resolveCallingUserId(ctx: AnyCtx): Promise<Id<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;

  // Action context has no direct ctx.db; the bump-mutation handles its own
  // user lookup via ctx.runMutation. In mutation context, we already have
  // ctx.db and can resolve here.
  if (!("db" in ctx)) {
    // ActionCtx: defer; the bump-mutation will re-resolve. Returning a
    // sentinel non-null id is unsafe, so we return null here. Action-side
    // callers in chat.ts should use `ctx.runMutation(internal.oto.queryMoat.bumpUserCounter)`
    // directly with the userId they already resolved upstream.
    return null;
  }

  const mctx = ctx as MutationCtx;
  const user: Doc<"users"> | null = await mctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
    .unique();
  return user ? user._id : null;
}

// -----------------------------------------------------------------------------
// Internal: window + threshold logic. Performs the patch and returns the
// enforcement decision for the caller.
// -----------------------------------------------------------------------------

type BumpDecision = "ok" | "soft_block" | "hard_block";

async function applyBumpAndDecide(
  ctx: CtxWithDb,
  userId: Id<"users">,
  rowsDelta: number,
  threshold: number,
): Promise<BumpDecision> {
  const user: Doc<"users"> | null = await ctx.db.get(userId);
  if (!user) {
    // User row vanished mid-call. Treat as system call.
    return "ok";
  }
  if (user.moat_reads_is_admin_exempt === true) {
    return "ok";
  }

  const now = Date.now();
  const windowStart = user.moat_reads_window_start;
  const currentCount = user.moat_reads_window ?? 0;

  let newCount: number;
  let newWindowStart: number;
  if (
    windowStart === undefined ||
    now - windowStart > WINDOW_MS
  ) {
    // Fresh window opens with this bump.
    newCount = rowsDelta;
    newWindowStart = now;
  } else {
    newCount = currentCount + rowsDelta;
    newWindowStart = windowStart;
  }

  await ctx.db.patch(userId, {
    moat_reads_window: newCount,
    moat_reads_window_start: newWindowStart,
  });

  if (newCount > 2 * threshold) {
    return "hard_block";
  }
  if (newCount > threshold) {
    return "soft_block";
  }
  return "ok";
}

// -----------------------------------------------------------------------------
// bumpUserCounter -- action-context bump path (Option B).
// -----------------------------------------------------------------------------
//
// Callable from any action (or other mutation) that has independently
// resolved the calling user's Convex `users._id`. The action invokes this
// via `ctx.runMutation(internal.oto.queryMoat.bumpUserCounter, ...)` after
// each `ctx.runQuery(api.X.Y, ...)` that drives into a moat-reading query
// function -- the canonical pattern for chat.ts.
//
// Returns the same enforcement decision union as `queryMoat()`'s inline
// path: "ok" | "soft_block" | "hard_block". Threshold defaults to
// `N x MOAT_P95_DEFAULT` matching the inline path; overridable per-call.
//
// Why an internalMutation (not a public mutation)?
//   * The bump must NEVER be triggered by client code directly -- a hostile
//     client could otherwise spam-bump to soft-block themselves and use the
//     resulting "stale empty" SLA degradation as a side-channel. `internal.*`
//     mutations are server-side only (Convex platform invariant).
//   * Callers in `convex/oto/` already hold the userId from upstream auth
//     resolution. They do NOT need a Clerk-identity round-trip here -- the
//     caller's auth check is the source of truth, this mutation just
//     applies the counter math against that id.
//
// Returns the decision; CALLERS DECIDE WHAT TO DO WITH IT. Today's chat.ts
// wire pattern: log on "soft_block"/"hard_block" but don't change behavior
// (the read already returned). The hard-block escalation -- throwing
// MoatRateLimitedError -- is reserved for the inline `queryMoat()` path,
// where the helper still owns the read and can suppress it. Threshold
// breach inside an action-side bump is an alarm signal, not a circuit
// breaker: the read has already happened.
// -----------------------------------------------------------------------------

// @ts-expect-error TS2589 -- Convex internalMutation generic resolution hits
// the TS depth limit through the api.d.ts tree; same root cause and same
// established suppression pattern as convex/oto/chat.ts:252's action decl.
// Runtime is unaffected; Convex registers and dispatches normally.
export const bumpUserCounter = internalMutation({
  args: {
    userId: v.id("users"),
    rowsDelta: v.number(),
    threshold: v.optional(v.number()),
  },
  // @ts-expect-error TS2589 -- same cause as the decl suppression above;
  // the returns validator's union inference depth bottoms out at the limit.
  returns: v.object({
    decision: v.union(
      v.literal("ok"),
      v.literal("soft_block"),
      v.literal("hard_block"),
    ),
  }),
  // @ts-expect-error TS2589 -- handler-arg inference through the registered
  // api tree is the third strike of the same root cause.
  handler: async (
    ctx,
    args,
  ): Promise<{ decision: BumpDecision }> => {
    const threshold =
      typeof args.threshold === "number"
        ? args.threshold
        : getMoatThresholdN() * MOAT_P95_DEFAULT;
    const decision = await applyBumpAndDecide(
      ctx,
      args.userId,
      args.rowsDelta,
      threshold,
    );
    return { decision };
  },
});

// =============================================================================
// Wave 7.3 (Day 9) — PII read-rate-limit primitives.
// =============================================================================
//
// THREAT MODEL
// ------------
// A compromised auth token grants user-scoped access to PII-dense tables
// (`user_semantic_facts`, `conversation_audit`). The rate-limit caps the
// EXFILTRATION SPEED — the attacker cannot pull a user's entire memory
// store at full Convex query speed. Full token revocation is Clerk's
// domain and out of scope here.
//
// The check is keyed on the auth-derived `user_id`, NOT request IP — a
// hostile actor on the same session would still bump the same counter
// regardless of where they call from.
//
// DESIGN POSTURE
// --------------
// * `checkPIIRead` is a READ-ONLY helper callable from a QueryCtx. It
//   inspects the user row's `pii_reads_window` + `pii_reads_window_start`
//   and returns the enforcement decision. It does NOT mutate (Convex
//   queries cannot patch — the platform invariant).
//
// * `bumpPIIReadCounter` is the corresponding internalMutation that
//   PERSISTS the increment. It is callable from action context only:
//   the chat.ts action that initiated the query is responsible for
//   firing `ctx.runMutation(internal.oto.queryMoat.bumpPIIReadCounter,
//   ...)` after each PII-table runQuery, in the same fire-and-forget
//   pattern as `bumpUserCounter`.
//
// * Until that action-side wire-up lands (Day 10 follow-up dispatch
//   coupling — kept out of this round per the partition contract), the
//   counter remains at 0/0 for users who only ever read via the query
//   path. `checkPIIRead` will always return `{ ok: true }` in that
//   regime — the check is in place and observable; persistence wiring
//   is the next step. Documented here so the rate-limit's posture is
//   not surprising on inspection.
//
// FAIL-OPEN POSTURE
// -----------------
// If reading the user row fails for any infrastructure reason (row
// missing, ctx.db transient error, malformed counter fields), the
// helper returns `{ ok: true }` — the underlying read proceeds. The
// rate-limit is a defense-in-depth layer; an infrastructure fault
// must NOT break a chat turn. This is fail-open on infra fault,
// fail-closed on actual abuse (counter-exceeds-threshold).
//
// DISTINCT FROM bumpUserCounter
// -----------------------------
// We add a parallel `bumpPIIReadCounter` rather than generalizing the
// existing `bumpUserCounter` because the two counters differ in three
// axes that cannot be unified cleanly:
//   1. UNITS — moat is row-count delta; PII is call count (delta=1).
//   2. WINDOW — moat is 24h; PII is 10 min.
//   3. THRESHOLD — moat is N×p95 (~10,000); PII is 50.
// Reusing the same fields would conflate the two windows and force
// every moat read to reset the PII window (or vice versa).
// =============================================================================

/**
 * Read-only PII-read rate-limit check. Inspects the user row's PII counter
 * state and returns the enforcement decision. Safe to call from a QueryCtx
 * (read-only). Persistence is the action-side caller's job via
 * `bumpPIIReadCounter` after each PII-table read.
 *
 * Fail-open: any infrastructure error returns `{ ok: true }` so the
 * underlying read proceeds. The wrap site should defensively also
 * try/catch its call to this helper.
 *
 * @param ctx        Convex QueryCtx | MutationCtx (anything with `db`).
 * @param args.user_id    The auth-derived user id (caller's already-resolved id).
 * @param args.table_name The PII table being read (informational; for the
 *                        log line at the wrap site; the counter is single
 *                        per-user, not per-table).
 */
export async function checkPIIRead(
  ctx: { db: { get: (id: Id<"users">) => Promise<Doc<"users"> | null> } },
  args: { user_id: Id<"users">; table_name: PIITable },
): Promise<
  | { ok: true }
  | {
      ok: false;
      reason: "pii_read_rate_limited";
      remaining_seconds: number;
      table_name: PIITable;
    }
> {
  let user: Doc<"users"> | null;
  try {
    user = await ctx.db.get(args.user_id);
  } catch {
    // Infra fault — fail open.
    return { ok: true };
  }
  if (!user) {
    // User row vanished mid-call. Treat as fail-open (the read will likely
    // produce nothing useful anyway). NEVER hard-block a missing user.
    return { ok: true };
  }
  if (user.moat_reads_is_admin_exempt === true) {
    // Admin exemption (Waleed/Temur) — shared with the moat counter's
    // admin flag because the exemption semantic is "this user bypasses
    // ALL per-user rate-limits", not just one surface.
    return { ok: true };
  }

  const now = Date.now();
  const windowStart = user.pii_reads_window_start;
  const currentCount = user.pii_reads_window ?? 0;

  // If no prior window or this is a fresh window, the next call would
  // start at 1 — well under the threshold. Always ok.
  if (windowStart === undefined || now - windowStart > PII_READ_WINDOW_MS) {
    return { ok: true };
  }

  const limit = getPIIReadLimit();
  if (currentCount < limit) {
    // Under threshold — read may proceed; the action-side caller will
    // bump the counter via bumpPIIReadCounter after the read.
    return { ok: true };
  }

  // At or above threshold — hard-block within current window.
  // remaining_seconds tells the caller how long until the window resets.
  const remainingMs = PII_READ_WINDOW_MS - (now - windowStart);
  return {
    ok: false,
    reason: "pii_read_rate_limited",
    remaining_seconds: Math.ceil(remainingMs / 1000),
    table_name: args.table_name,
  };
}

/**
 * Apply a per-user PII-read counter bump. Window-aware: opens a fresh
 * window if the prior one has expired (>10 min since last bump),
 * otherwise increments the current window's count.
 *
 * Fail-open: counter write failures are caught at the call site (the
 * bump runs fire-and-forget after the read has already produced data).
 *
 * Parallel to `applyBumpAndDecide` but for the PII counter fields and
 * with call-count units (delta is always 1 per bump call).
 */
async function applyPIIBump(
  ctx: CtxWithDb,
  userId: Id<"users">,
): Promise<BumpDecision> {
  const user: Doc<"users"> | null = await ctx.db.get(userId);
  if (!user) {
    // User row vanished mid-call. Treat as system call.
    return "ok";
  }
  if (user.moat_reads_is_admin_exempt === true) {
    return "ok";
  }

  const now = Date.now();
  const windowStart = user.pii_reads_window_start;
  const currentCount = user.pii_reads_window ?? 0;

  let newCount: number;
  let newWindowStart: number;
  if (windowStart === undefined || now - windowStart > PII_READ_WINDOW_MS) {
    // Fresh window opens with this bump.
    newCount = 1;
    newWindowStart = now;
  } else {
    newCount = currentCount + 1;
    newWindowStart = windowStart;
  }

  await ctx.db.patch(userId, {
    pii_reads_window: newCount,
    pii_reads_window_start: newWindowStart,
  });

  const limit = getPIIReadLimit();
  // PII counter has no soft-block tier — the wrap site already returns
  // empty array (degraded mode) on hard-block, which is the equivalent
  // SLA degradation. Reporting `hard_block` exclusively keeps the trace
  // signal unambiguous.
  if (newCount > limit) {
    return "hard_block";
  }
  return "ok";
}

/**
 * Action-context PII-read counter bump. Mirror of `bumpUserCounter` for
 * the PII counter. Wired from chat.ts (or any action) AFTER a PII-table
 * `ctx.runQuery(...)` lands. The wrap site inside the query already
 * read-checked the counter via `checkPIIRead`; this is the persistence
 * companion.
 *
 * Returns the enforcement decision; chat.ts treats it identically to
 * the moat counter: log on hard-block, but the read already returned.
 * The decision is an alarm signal, not a circuit breaker at this
 * surface (the in-query `checkPIIRead` is the actual gate).
 */
// @ts-expect-error TS2589 -- same generic resolution depth as
// bumpUserCounter above (Convex internalMutation through api.d.ts).
export const bumpPIIReadCounter = internalMutation({
  args: {
    userId: v.id("users"),
  },
  // @ts-expect-error TS2589 -- returns validator depth, matches the
  // suppression pattern on bumpUserCounter's returns.
  returns: v.object({
    decision: v.union(
      v.literal("ok"),
      v.literal("soft_block"),
      v.literal("hard_block"),
    ),
  }),
  // @ts-expect-error TS2589 -- handler-arg inference depth, same root.
  handler: async (ctx, args): Promise<{ decision: BumpDecision }> => {
    const decision = await applyPIIBump(ctx, args.userId);
    return { decision };
  },
});
