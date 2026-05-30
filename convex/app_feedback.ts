import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * submit — consumer-side mutation for the "Give Us Feedback" modal in
 * Settings. Inserts a new row in `app_feedback` with status="new" so it
 * lands in the director-side review queue. No user_id linkage (the
 * app_feedback table is intentionally anonymous-friendly), but `source`
 * differentiates consumer_ios / consumer_android so the team can break
 * down feedback by platform.
 *
 * Title is auto-synthesized from the first ~80 chars of the text; full
 * text lives on `description`. Category defaults to "general" and
 * sentiment to "neutral" — director-side triage can re-classify.
 */
export const submit = mutation({
  args: {
    text: v.string(),
    source: v.optional(v.string()), // "consumer_ios" | "consumer_android"
  },
  handler: async (ctx, { text, source }) => {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Feedback text is required");
    const TITLE_MAX = 80;
    const title =
      trimmed.length <= TITLE_MAX
        ? trimmed
        : `${trimmed.slice(0, TITLE_MAX - 1)}…`;
    return await ctx.db.insert("app_feedback", {
      title,
      category: "general",
      sentiment: "neutral",
      source: source ?? "consumer_app",
      status: "new",
      description: trimmed,
      created_at: Date.now(),
    });
  },
});

export const getById = query({
  args: { id: v.id("app_feedback") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

export const listByStatus = query({
  args: { includeArchived: v.optional(v.boolean()) },
  handler: async (ctx, { includeArchived = false }) => {
    const all = await ctx.db.query("app_feedback").withIndex("by_created_at").order("desc").collect();
    const items = includeArchived ? all.filter(f => f.archived) : all.filter(f => !f.archived);
    const grouped: Record<string, typeof items> = {
      new: [], reviewed: [], triaged: [], planned: [], done: [], wontfix: [], duplicate: [],
    };
    for (const fb of items) {
      if (grouped[fb.status]) grouped[fb.status].push(fb);
    }
    return grouped;
  },
});

export const archive = mutation({
  args: { id: v.id("app_feedback"), archived: v.boolean(), actorName: v.string(), actorId: v.optional(v.id("director_users")) },
  handler: async (ctx, { id, archived, actorName, actorId }) => {
    const fb = await ctx.db.get(id);
    if (!fb) return;
    await ctx.db.patch(id, { archived, updated_at: Date.now() });
    await ctx.db.insert("audit_log", {
      entity_type: "feedback",
      entity_id: String(id),
      action: "status_change",
      actor: actorName,
      actor_id: actorId,
      detail: archived ? "Feedback archived" : "Feedback restored from archive",
      created_at: Date.now(),
    });
  },
});

export const updateStatus = mutation({
  args: { id: v.id("app_feedback"), status: v.string(), actorName: v.string(), actorId: v.optional(v.id("director_users")) },
  handler: async (ctx, { id, status, actorName, actorId }) => {
    const fb = await ctx.db.get(id);
    if (!fb || fb.status === status) return;
    await ctx.db.patch(id, { status, updated_at: Date.now() });
    await ctx.db.insert("audit_log", {
      entity_type: "feedback",
      entity_id: String(id),
      action: "status_change",
      actor: actorName,
      actor_id: actorId,
      detail: `${fb.status} → ${status}`,
      created_at: Date.now(),
    });
  },
});

export const updateFields = mutation({
  args: {
    id: v.id("app_feedback"),
    category: v.optional(v.union(
      v.literal("feature_request"), v.literal("ux"), v.literal("shop_quality"),
      v.literal("general"), v.literal("praise"),
    )),
    sentiment: v.optional(v.union(
      v.literal("positive"), v.literal("neutral"), v.literal("negative"),
    )),
    status: v.optional(v.string()),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, actorName, actorId, ...fields }) => {
    const fb = await ctx.db.get(id);
    const updates = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (Object.keys(updates).length === 0) return;
    await ctx.db.patch(id, { ...updates, updated_at: Date.now() });
    const parts: string[] = [];
    if (fields.status && fb?.status !== fields.status) parts.push(`status: ${fb?.status} → ${fields.status}`);
    if (fields.category && fb?.category !== fields.category) parts.push(`category → ${fields.category}`);
    if (fields.sentiment && fb?.sentiment !== fields.sentiment) parts.push(`sentiment → ${fields.sentiment}`);
    if (parts.length === 0) return;
    await ctx.db.insert("audit_log", {
      entity_type: "feedback",
      entity_id: String(id),
      action: fields.status && fb?.status !== fields.status ? "status_change" : "field_edit",
      actor: actorName,
      actor_id: actorId,
      detail: parts.join(", "),
      created_at: Date.now(),
    });
  },
});

// One-time seed — safe to call again (checks first).
export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("app_feedback").first();
    if (existing) return { seeded: false, reason: "already has data" };

    const now = Date.now();
    const items = [
      // new
      { title:"1-star review: \"Wait for quotes was way too long, gave up\"", category:"shop_quality"    as const, sentiment:"negative" as const, source:"rating_comment",   status:"new",       auto_ingested:true, rating_shop:"East Bay Diesel", created_at: now - 8*60*1000 },
      { title:"Add option to save preferred mechanic across bookings",        category:"feature_request" as const, sentiment:"positive" as const, source:"consumer_ios",     status:"new",       created_at: now - 34*60*1000 },
      { title:"Bookings tab tap target too small on small phones",            category:"ux"              as const, sentiment:"neutral"  as const, source:"consumer_ios",     status:"new",       created_at: now - 2*60*60*1000 },
      { title:"Love the live tracker — felt like Uber for my car",            category:"praise"          as const, sentiment:"positive" as const, source:"email",            status:"new",       created_at: now - 4*60*60*1000 },
      // reviewed
      { title:"Show estimated drop-off ETA in confirmation email",            category:"feature_request" as const, sentiment:"positive" as const, source:"consumer_android", status:"reviewed",  created_at: now - 24*60*60*1000 },
      { title:"Allow editing tire quantity after quote received",             category:"feature_request" as const, sentiment:"neutral"  as const, source:"consumer_ios",     status:"reviewed",  created_at: now - 25*60*60*1000 },
      // triaged
      { title:"Shop quality concern: cleanliness at Goldenrod Motors",       category:"shop_quality"    as const, sentiment:"negative" as const, source:"manual",           status:"triaged",   created_at: now - 2*24*60*60*1000 },
      // planned
      { title:"Multi-vehicle households: show garage on home screen",        category:"feature_request" as const, sentiment:"positive" as const, source:"consumer_ios",     status:"planned",   created_at: now - 4*24*60*60*1000 },
      { title:"Light/dark mode toggle in settings",                          category:"ux"              as const, sentiment:"neutral"  as const, source:"consumer_android", status:"planned",   created_at: now - 5*24*60*60*1000 },
      // done
      { title:"Quotes screen: side-by-side comparison was huge",             category:"praise"          as const, sentiment:"positive" as const, source:"rating_comment",   status:"done",      created_at: now - 9*24*60*60*1000 },
      // wontfix
      { title:"Add support for motorcycle tires",                            category:"feature_request" as const, sentiment:"neutral"  as const, source:"email",            status:"wontfix",   created_at: now - 14*24*60*60*1000 },
      // duplicate
      { title:"Reset password email never arrives",                          category:"general"         as const, sentiment:"negative" as const, source:"manual",           status:"duplicate", created_at: now - 14*24*60*60*1000 },
    ];

    for (const item of items) {
      await ctx.db.insert("app_feedback", item);
    }
    return { seeded: true, count: items.length };
  },
});
