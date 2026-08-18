/**
 * shopCustomServices.ts — a shop's shortcuts for off-catalog work they've done
 * before (Off-Catalog Work spec, §3).
 *
 * Framed to the mechanic as "things you've typed before", never as "your
 * services": custom work is emergent, so this is autocomplete with a memory, not
 * a catalog. Nothing here is driver-facing, searchable, or bookable.
 *
 * The reason it's worth a table rather than a client-side recents list is
 * measurement. Pressing a button instead of retyping turns forty spellings into
 * one key pressed forty times — repeat counts become exact, labor times
 * accumulate per vehicle config, and the director view only has to fuzzy-match
 * across shops instead of within each shop's own repeats.
 *
 * Two consequences that shape the code below:
 *   1. Creating a shortcut whose name looks canonical raises an immediate alert
 *      rather than blocking — a mistake here is replayed on every press, so it's
 *      worth telling someone now, but not worth interrupting a mechanic mid-job
 *      to argue about their typing (see `create`).
 *   2. Shortcut drift is measured, not prevented (see `recordShortcutActual`).
 */

import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  normalizeServiceName,
  serviceMatchKey,
  matchServiceName,
  type MatchCandidateInput,
} from "./lib/serviceMatch";
import {
  requireCustomJobTaxonomy,
  normalizeCustomJobSystems,
} from "../lib/custom-job-taxonomy";

/**
 * How far actual minutes must diverge from a shortcut's own default before it
 * counts as a deviation. Generous — real work varies by car, and we want the
 * counter to mean "this button is being used for different jobs", not "cars
 * differ".
 */
const DEVIATION_RATIO = 0.5;

async function getCurrentUser(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) =>
      q.eq("clerkUserId", identity.subject),
    )
    .unique();
  if (!user) throw new Error("User not found");
  return user;
}

async function requireShopStaff(ctx: any, userId: any, shopId: any) {
  const shopUser = await ctx.db
    .query("shop_users")
    .withIndex("by_user_and_shop", (q: any) =>
      q.eq("user_id", userId).eq("shop_id", shopId),
    )
    .first();
  if (shopUser?.is_active) return shopUser;

  const owned = await ctx.db
    .query("shops")
    .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", userId))
    .filter((q: any) => q.eq(q.field("_id"), shopId))
    .first();
  if (owned) return { user_id: userId, shop_id: shopId, role: "owner" };

  throw new Error("Not authorized for this shop");
}

/** Catalog + aliases, shaped for the matcher. Mirrors serviceMatch.loadCatalog. */
async function loadCatalog(ctx: any): Promise<MatchCandidateInput[]> {
  const services = await ctx.db.query("services").collect();
  const aliases = await ctx.db.query("service_aliases").collect();
  const byService = new Map<string, string[]>();
  for (const row of aliases) {
    const key = String(row.service_id);
    const list = byService.get(key);
    if (list) list.push(row.alias);
    else byService.set(key, [row.alias]);
  }
  return services
    .filter((s: any) => s.is_bookable !== false)
    .map((s: any) => ({
      serviceId: String(s._id),
      name: s.name,
      slug: s.slug ?? null,
      aliases: byService.get(String(s._id)) ?? [],
    }));
}

/**
 * The shop's shortcut list, best-first. Retired shortcuts are excluded from the
 * picker but their rows survive so past custom_jobs still resolve.
 *
 * Ordered by recent use rather than alphabetically: a mechanic reaching for this
 * list is almost always reaching for what they did last week.
 */
export const listForShop = query({
  args: { shopId: v.id("shops"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("shop_custom_services")
      .withIndex("by_shop", (q) => q.eq("shop_id", args.shopId))
      .collect();

    const active = rows.filter((r) => !r.retired_at);
    active.sort((a, b) => {
      if (b.use_count !== a.use_count) return b.use_count - a.use_count;
      return b.last_used_at - a.last_used_at;
    });

    return active.slice(0, args.limit ?? 12).map((r) => ({
      _id: r._id,
      name: r.name,
      system_tags: (r.system_tags ?? []) as string[],
      work_type: (r.work_type ?? null) as string | null,
      default_minutes: r.default_minutes ?? null,
      default_price_cents: r.default_price_cents ?? null,
      last_complaint: r.last_complaint ?? null,
      use_count: r.use_count,
      last_used_at: r.last_used_at,
    }));
  },
});

/**
 * Create a shortcut.
 *
 * Never blocks. Matching catalog services are shown live under the name field
 * (ServiceSuggestions) so the canonical option is visible and one tap away, and
 * what the mechanic typed is always a valid answer.
 *
 * A shortcut that's really a catalog service denies maintenance credit every time
 * it's pressed, so creating one still fires an immediate alert to the director
 * side — the signal survives, the interruption doesn't.
 *
 * Idempotent per (shop, match_key): re-creating an existing shortcut returns it
 * rather than making a duplicate, and revives it if it had been retired.
 */
export const create = mutation({
  args: {
    shopId: v.id("shops"),
    name: v.string(),
    // Carried onto every job the shortcut creates. Required, for the same
    // reason it's required on a one-off: a shortcut pressed forty times with no
    // taxonomy is forty untyped rows, not one.
    systemTags: v.optional(v.array(v.string())),
    workType: v.optional(v.string()),
    defaultMinutes: v.optional(v.number()),
    defaultPriceCents: v.optional(v.number()),
    lastComplaint: v.optional(v.string()),
    mechanicId: v.optional(v.id("mechanics")),
    /** Accepted and ignored. Kept so existing callers don't break; nothing
     *  blocks on it any more. */
    confirmedCustom: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    await requireShopStaff(ctx, user._id, args.shopId);

    const name = args.name.trim();
    if (!name) throw new Error("A name is required");

    const matchKey = serviceMatchKey(name);
    if (!matchKey) throw new Error("That name normalises to nothing");

    const taxonomy = requireCustomJobTaxonomy({
      system_tags: args.systemTags,
      work_type: args.workType,
      jobName: name,
    });

    // NOT a block. An earlier version refused to create a shortcut whose name
    // looked canonical until the mechanic re-confirmed, which meant interrupting
    // someone mid-job to answer a question about their own typing. Suggestions
    // are shown live under the name field instead (ServiceSuggestions), so the
    // canonical option is visible and one tap away — which is where the
    // protection actually came from.
    //
    // The signal is kept: creating a shortcut whose name looks like a service we
    // already carry still raises an immediate alert. Unlike a one-off mislabelled
    // line, this button will be pressed again tomorrow, and every press costs
    // another driver their maintenance credit — so it's worth telling someone
    // now rather than waiting for the daily digest.
    //
    // Deduped per (shop, match key) so re-creating the same shortcut doesn't page
    // anyone twice. Routed through the existing notification_outbox slack path.
    const verdict = matchServiceName(name, await loadCatalog(ctx));
    const looksCanonical =
      verdict.confidence === "exact" || verdict.confidence === "high";

    if (looksCanonical) {
      const dedupe_key = `custom_shortcut_override:${String(args.shopId)}:${serviceMatchKey(name)}`;
      const dup = await ctx.db
        .query("notification_outbox")
        .withIndex("by_dedupe_key", (q: any) => q.eq("dedupe_key", dedupe_key))
        .first();
      if (!dup) {
        await ctx.db.insert("notification_outbox", {
          shop_id: args.shopId,
          mechanic_id: args.mechanicId,
          channel: "slack",
          category: "custom_shortcut_override",
          status: "pending",
          dedupe_key,
          payload: {
            shortcut_name: name,
            looks_like: verdict.best?.name ?? null,
            service_id: verdict.best?.serviceId ?? null,
            confidence: verdict.confidence,
          },
          created_at: Date.now(),
        });
      }
    }

    const existing = await ctx.db
      .query("shop_custom_services")
      .withIndex("by_shop_and_match_key", (q) =>
        q.eq("shop_id", args.shopId).eq("match_key", matchKey),
      )
      .first();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        // Revive a retired shortcut rather than creating a second key for the
        // same work, which would split its history.
        retired_at: undefined,
        system_tags: taxonomy.system_tags,
        work_type: taxonomy.work_type,
        default_minutes: args.defaultMinutes ?? existing.default_minutes,
        default_price_cents:
          args.defaultPriceCents ?? existing.default_price_cents,
        updated_at: now,
      });
      return { ok: true as const, id: existing._id, created: false };
    }

    const id = await ctx.db.insert("shop_custom_services", {
      shop_id: args.shopId,
      name,
      normalized_name: normalizeServiceName(name),
      match_key: matchKey,
      system_tags: taxonomy.system_tags,
      work_type: taxonomy.work_type,
      default_minutes: args.defaultMinutes,
      default_price_cents: args.defaultPriceCents,
      last_complaint: args.lastComplaint?.trim() || undefined,
      use_count: 0,
      last_used_at: now,
      created_by_mechanic_id: args.mechanicId,
      created_at: now,
    });
    return { ok: true as const, id, created: true };
  },
});

/**
 * Edit the prefilled values. Name and match_key are intentionally absent —
 * renaming a shortcut that has history would retroactively change what past jobs
 * were called. Retire and recreate instead.
 */
export const updateDefaults = mutation({
  args: {
    id: v.id("shop_custom_services"),
    systemTags: v.optional(v.array(v.string())),
    workType: v.optional(v.string()),
    defaultMinutes: v.optional(v.number()),
    defaultPriceCents: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const row = await ctx.db.get(args.id);
    if (!row) throw new Error("Shortcut not found");
    await requireShopStaff(ctx, user._id, row.shop_id);

    await ctx.db.patch(args.id, {
      system_tags: args.systemTags
        ? normalizeCustomJobSystems(args.systemTags)
        : row.system_tags,
      work_type: args.workType ?? row.work_type,
      default_minutes: args.defaultMinutes ?? row.default_minutes,
      default_price_cents: args.defaultPriceCents ?? row.default_price_cents,
      updated_at: Date.now(),
    });
    return { ok: true };
  },
});

/** Remove from the picker. History and key survive so past jobs still resolve. */
export const retire = mutation({
  args: { id: v.id("shop_custom_services") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const row = await ctx.db.get(args.id);
    if (!row) throw new Error("Shortcut not found");
    await requireShopStaff(ctx, user._id, row.shop_id);
    await ctx.db.patch(args.id, {
      retired_at: Date.now(),
      updated_at: Date.now(),
    });
    return { ok: true };
  },
});

/**
 * Called when a shortcut is used on a booking. Bumps the counters that make a
 * repeat exactly countable.
 *
 * Plain helper, not a mutation — it runs inside the booking-creation transaction
 * so a shortcut can never show a use it didn't get.
 */
export async function recordShortcutUse(
  ctx: any,
  args: {
    shortcutId: Id<"shop_custom_services">;
    complaint?: string | null;
    now: number;
  },
): Promise<void> {
  const row = await ctx.db.get(args.shortcutId);
  if (!row) return;
  await ctx.db.patch(args.shortcutId, {
    use_count: (row.use_count ?? 0) + 1,
    last_used_at: args.now,
    last_complaint: args.complaint?.trim() || row.last_complaint,
    updated_at: args.now,
  });
}

/**
 * Feed a completed job's actual minutes back into the shortcut's distribution.
 *
 * Running sums rather than a sample table: the director view needs mean and
 * variance, and storing every sample would grow without bound for a shortcut
 * pressed weekly for years.
 *
 * `deviation_count` is the drift signal. A shortcut whose actuals keep landing
 * far from its own default is either being pressed for several different jobs
 * (the failure mode from §3) or genuinely config-dependent — the complaint texts
 * on its custom_jobs rows are what tell those apart, which is why we flag rather
 * than guess.
 */
export async function recordShortcutActual(
  ctx: any,
  args: {
    shortcutId: Id<"shop_custom_services">;
    actualMinutes: number;
    now: number;
  },
): Promise<void> {
  const row = await ctx.db.get(args.shortcutId);
  if (!row) return;
  if (!Number.isFinite(args.actualMinutes) || args.actualMinutes <= 0) return;

  const samples = (row.minutes_samples ?? 0) + 1;
  const sum = (row.minutes_sum ?? 0) + args.actualMinutes;
  const sumSq = (row.minutes_sum_sq ?? 0) + args.actualMinutes ** 2;

  // Compare against the shortcut's own default when it has one, else against
  // its running mean — so drift is detectable even on a shortcut that never had
  // a default set.
  const reference =
    row.default_minutes && row.default_minutes > 0
      ? row.default_minutes
      : samples > 1
        ? (row.minutes_sum ?? 0) / (row.minutes_samples ?? 1)
        : null;
  const deviated =
    reference != null &&
    Math.abs(args.actualMinutes - reference) / reference > DEVIATION_RATIO;

  await ctx.db.patch(args.shortcutId, {
    minutes_samples: samples,
    minutes_sum: sum,
    minutes_sum_sq: sumSq,
    deviation_count: (row.deviation_count ?? 0) + (deviated ? 1 : 0),
    updated_at: args.now,
  });
}

/**
 * Mean and coefficient of variation for a shortcut's actual minutes. Exported so
 * the director view (§8) can rank the high-variance band without re-deriving the
 * maths. CV rather than raw stddev so a 3-hour job and a 20-minute job are
 * comparable.
 */
export function shortcutMinutesStats(row: {
  minutes_samples?: number;
  minutes_sum?: number;
  minutes_sum_sq?: number;
}): { samples: number; mean: number | null; cv: number | null } {
  const samples = row.minutes_samples ?? 0;
  if (samples === 0) return { samples: 0, mean: null, cv: null };
  const mean = (row.minutes_sum ?? 0) / samples;
  if (samples < 2 || mean <= 0) return { samples, mean, cv: null };
  const variance = Math.max(
    0,
    (row.minutes_sum_sq ?? 0) / samples - mean * mean,
  );
  return { samples, mean, cv: Math.sqrt(variance) / mean };
}
