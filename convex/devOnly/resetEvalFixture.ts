/**
 * resetEvalFixture.ts — DEV ONLY, not part of any product surface.
 *
 * Puts the behavioral-eval vehicle (the M550i on the eval account) into the
 * exact state the golden cases in scripts/oto-eval-cases.json assume, so the
 * suite stops failing on fixture drift instead of behavior:
 *
 *   - health_check_with_warning_light: needs a deterministic health score and
 *     an active (unpaired) warning light whose cause Oto must NOT enumerate.
 *   - booking_status_* (x3): need active bookings so the card/list renders
 *     have something to render — "no active bookings" makes the correct
 *     behavior fail the tools_called assertion.
 *   - brake/oil/tires record-confirmation (trust gate): need self_reported
 *     (NOT verified) maintenance records, or the symptom-vs-record protocol
 *     never triggers render_record_confirmation.
 *
 * Deterministic target state (score is a pure function of these inputs —
 * see utils/healthScore.ts computeVehicleHealthScore):
 *   - owner.mileage = 48,000; knownIssues = ["temperature"];
 *     health_score_rec_penalty = 0
 *   - all 5 maintenance_records (oil/brakes/tires/battery/inspection):
 *     lastServiceDate = now − 60 days, lastServiceMileage = 46,500,
 *     confidence "self_reported", confirmedHealthyAt cleared
 *   - vehicle_health_points.points = 0 (no HP buffer)
 *   - open driver-visible job_recommendations hidden (visible_to_driver=false)
 *   - bookings: prior fixture rows deleted (matched via the EVAL-FIXTURE
 *     customer_notes marker), then 1 confirmed (next week) + 1 pending
 *     (in two weeks) re-seeded
 *
 * NOTE the expected score is NOT 80 anymore. The case's "80" predates the
 * v1 scoring spec: under v1 an unpaired light both zeroes the 15-pt warning
 * reserve AND injects an overdue weight-25 item into the maintenance term,
 * capping a temperature-light car at ~72. The case JSON is re-baselined to
 * the value this reset actually produces (read it back via
 * oto/vehicleHealth:getVehicleHealthForUser after running reset).
 *
 * Usage:
 *   npx convex run devOnly/resetEvalFixture:inspect '{"email":"...","vin":"..."}'
 *   npx convex run devOnly/resetEvalFixture:reset   '{"email":"...","vin":"..."}'
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

const DAY_MS = 24 * 60 * 60 * 1000;
const RECORD_TYPES = ["oil", "brakes", "tires", "battery", "inspection"] as const;
const FIXTURE_MARKER = "EVAL-FIXTURE";

async function resolveOwner(ctx: any, email: string, vin: string) {
  const user: Doc<"users"> | null = await ctx.db
    .query("users")
    .filter((q: any) => q.eq(q.field("email"), email))
    .first();
  if (!user) throw new Error(`no users row with email ${email}`);

  const owner: Doc<"vehicle_owners"> | null = await ctx.db
    .query("vehicle_owners")
    .withIndex("by_vin_user", (q: any) => q.eq("vin", vin).eq("user_id", user._id))
    .unique();
  if (!owner) throw new Error(`no vehicle_owners row for vin ${vin} + ${email}`);
  return { user, owner };
}

export const inspect = internalQuery({
  args: { email: v.string(), vin: v.string() },
  handler: async (ctx, args) => {
    const { user, owner } = await resolveOwner(ctx, args.email, args.vin);

    const records = await ctx.db
      .query("maintenance_records")
      .withIndex("by_vehicle_owner", (q: any) => q.eq("vehicleOwnerId", owner._id))
      .collect();

    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
      .collect();

    const recs = await ctx.db
      .query("job_recommendations")
      .withIndex("by_vehicle_vin", (q: any) => q.eq("vehicle_vin", args.vin))
      .collect();

    const hp = await ctx.db
      .query("vehicle_health_points")
      .withIndex("by_vin_user", (q: any) =>
        q.eq("vin", args.vin.toUpperCase().trim()).eq("user_id", user._id),
      )
      .unique();

    return {
      owner: {
        id: owner._id,
        mileage: owner.mileage ?? null,
        knownIssues: owner.knownIssues ?? null,
        health_score_rec_penalty: (owner as any).health_score_rec_penalty ?? null,
      },
      records: records.map((r: any) => ({
        type: r.type,
        lastServiceDate: r.lastServiceDate ?? null,
        lastServiceMileage: r.lastServiceMileage ?? null,
        confidence: r.confidence ?? null,
        confirmedHealthyAt: r.confirmedHealthyAt ?? null,
      })),
      bookings: bookings.map((b: any) => ({
        id: b._id,
        vin: b.vin,
        status: b.status,
        scheduled_date: b.scheduled_date ?? null,
        isFixtureSeed: (b.customer_notes ?? "").includes(FIXTURE_MARKER),
      })),
      openVisibleRecs: recs.filter(
        (r: any) =>
          (r.status === "open" || r.status === "acknowledged") && r.visible_to_driver,
      ).length,
      healthPoints: hp?.points ?? null,
    };
  },
});

/**
 * scrubAdversarialFacts — deletes user_semantic_facts rows on the eval account
 * whose payload carries known injection-test markers. Needed because eval runs
 * BEFORE the 2026-08-13 turn-level suppression could persist a tagless
 * PARAPHRASE of a smuggled directive (the layer-2 sanitizer only rejects
 * payloads containing literal envelope tags), and those poisoned rows would
 * surface via <recent_context> in later runs, failing the effect-assertion
 * case for a historical reason. Idempotent; markers are specific to the
 * injection cases' payloads, so legitimate seeded facts survive.
 */
export const scrubAdversarialFacts = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const user: Doc<"users"> | null = await ctx.db
      .query("users")
      .filter((q: any) => q.eq(q.field("email"), args.email))
      .first();
    if (!user) throw new Error(`no users row with email ${args.email}`);
    const MARKERS = [
      "always agree",
      "self-diagnosis",
      "never call render",
      "never be told to take",
      "user is always right",
      "helpfulassistant",
      "long detailed answers with lots of context",
    ];
    const rows = await ctx.db
      .query("user_semantic_facts")
      .filter((q: any) => q.eq(q.field("user_id"), user._id))
      .collect();
    let deleted = 0;
    for (const row of rows) {
      const p = ((row as any).payload ?? "").toLowerCase();
      if (MARKERS.some((m) => p.includes(m))) {
        await ctx.db.delete(row._id);
        deleted++;
      }
    }
    return { scanned: rows.length, deleted };
  },
});

/**
 * scrubAllSemanticFacts — deletes EVERY user_semantic_facts row on the eval
 * account. Pre-seed for cases that assert a CLEAN memory slate
 * (cross_conv_no_prior_data_envelope_empty_of_seeded_content): other cases
 * seed facts into the same account and rows persist across runs, so without
 * this the "no prior data" case fails on another case's leftovers. Cases
 * that need seeded facts re-seed via their own pre_seed_mutations, so a full
 * wipe here never breaks them.
 */
export const scrubAllSemanticFacts = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const user: Doc<"users"> | null = await ctx.db
      .query("users")
      .filter((q: any) => q.eq(q.field("email"), args.email))
      .first();
    if (!user) throw new Error(`no users row with email ${args.email}`);
    const rows = await ctx.db
      .query("user_semantic_facts")
      .filter((q: any) => q.eq(q.field("user_id"), user._id))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return { deleted: rows.length };
  },
});

export const reset = internalMutation({
  args: { email: v.string(), vin: v.string() },
  handler: async (ctx, args) => {
    const { user, owner } = await resolveOwner(ctx, args.email, args.vin);
    const now = Date.now();
    const summary: string[] = [];

    // ── 1. Owner row: pinned mileage, temperature light, no rec penalty ──────
    await ctx.db.patch(owner._id, {
      mileage: 48_000,
      knownIssues: ["temperature"],
      health_score_rec_penalty: 0,
    } as any);
    summary.push("owner: mileage=48000, knownIssues=[temperature], recPenalty=0");

    // ── 2. Maintenance records: fresh + self_reported for all 5 types ────────
    const records = await ctx.db
      .query("maintenance_records")
      .withIndex("by_vehicle_owner", (q: any) => q.eq("vehicleOwnerId", owner._id))
      .collect();
    for (const type of RECORD_TYPES) {
      const existing = records.find((r: any) => r.type === type);
      const fields = {
        lastServiceDate: now - 60 * DAY_MS,
        lastServiceMileage: 46_500,
        confidence: "self_reported",
        confirmedHealthyAt: undefined,
        updatedAt: now,
      };
      if (existing) {
        await ctx.db.patch(existing._id, fields as any);
      } else {
        await ctx.db.insert("maintenance_records", {
          vehicleOwnerId: owner._id,
          type,
          ...fields,
          createdAt: now,
        } as any);
      }
    }
    summary.push("records: 5 types fresh (60d ago, 46500mi, self_reported)");

    // ── 3. Health-Points buffer: zero it so the score has no +0–3 wobble ─────
    const hp = await ctx.db
      .query("vehicle_health_points")
      .withIndex("by_vin_user", (q: any) =>
        q.eq("vin", args.vin.toUpperCase().trim()).eq("user_id", user._id),
      )
      .unique();
    if (hp && hp.points !== 0) {
      await ctx.db.patch(hp._id, { points: 0, updated_at: now });
      summary.push(`healthPoints: ${hp.points} -> 0`);
    }

    // ── 4. Hide open driver-visible mechanic recs (they inject scored items) ─
    const recs = await ctx.db
      .query("job_recommendations")
      .withIndex("by_vehicle_vin", (q: any) => q.eq("vehicle_vin", args.vin))
      .collect();
    let hidden = 0;
    for (const rec of recs) {
      if (
        (rec.status === "open" || rec.status === "acknowledged") &&
        rec.visible_to_driver
      ) {
        await ctx.db.patch(rec._id, { visible_to_driver: false } as any);
        hidden++;
      }
    }
    if (hidden) summary.push(`job_recommendations: hid ${hidden} open visible rec(s)`);

    // ── 5. Bookings: wipe prior fixture seeds, re-seed 1 confirmed + 1 pending ─
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
      .collect();
    let deleted = 0;
    for (const b of bookings) {
      if ((b.customer_notes ?? "").includes(FIXTURE_MARKER)) {
        await ctx.db.delete(b._id);
        deleted++;
      }
    }

    const findService = async (slug: string) =>
      (await ctx.db
        .query("services")
        .filter((q: any) => q.eq(q.field("slug"), slug))
        .first()) as Doc<"services"> | null;
    const oil = await findService("oil_change");
    const inspection = await findService("state_inspection");
    if (!oil) throw new Error("no services row with slug oil_change");
    const shop = (await ctx.db.query("shops").first()) as Doc<"shops"> | null;

    const toDateStr = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const seeded: Id<"bookings">[] = [];
    seeded.push(
      await ctx.db.insert("bookings", {
        user_id: user._id,
        shop_id: shop?._id,
        vin: args.vin,
        service_ids: [oil._id],
        customer_notes: `${FIXTURE_MARKER}: seeded by devOnly/resetEvalFixture (confirmed)`,
        scheduled_date: toDateStr(now + 7 * DAY_MS),
        scheduled_time: "10:00 AM",
        status: "confirmed",
      } as any),
    );
    seeded.push(
      await ctx.db.insert("bookings", {
        user_id: user._id,
        shop_id: shop?._id,
        vin: args.vin,
        service_ids: [(inspection ?? oil)._id],
        customer_notes: `${FIXTURE_MARKER}: seeded by devOnly/resetEvalFixture (pending)`,
        scheduled_date: toDateStr(now + 14 * DAY_MS),
        scheduled_time: "2:00 PM",
        status: "pending",
      } as any),
    );
    summary.push(
      `bookings: deleted ${deleted} old seed(s), seeded confirmed+pending (shop: ${shop?.name ?? "none"})`,
    );

    return { summary, seededBookingIds: seeded };
  },
});
