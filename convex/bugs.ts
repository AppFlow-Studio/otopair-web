import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const listByStatus = query({
  args: { includeArchived: v.optional(v.boolean()) },
  handler: async (ctx, { includeArchived = false }) => {
    const all = await ctx.db.query("bugs").withIndex("by_created_at").order("desc").collect();
    const items = includeArchived ? all.filter(b => b.archived) : all.filter(b => !b.archived);
    const grouped: Record<string, typeof items> = {
      new: [], triaged: [], assigned: [], in_progress: [], done: [], verified: [],
    };
    for (const bug of items) {
      if (grouped[bug.status]) grouped[bug.status].push(bug);
    }
    return grouped;
  },
});

export const archive = mutation({
  args: { id: v.id("bugs"), archived: v.boolean() },
  handler: async (ctx, { id, archived }) => {
    const bug = await ctx.db.get(id);
    if (!bug) return;
    await ctx.db.patch(id, { archived, updated_at: Date.now() });
    await ctx.db.insert("audit_log", {
      entity_type: "bug",
      entity_id: String(id),
      action: "status_change",
      actor: "Director",
      detail: archived ? "Bug archived" : "Bug restored from archive",
      created_at: Date.now(),
    });
  },
});

export const updateStatus = mutation({
  args: { id: v.id("bugs"), status: v.string() },
  handler: async (ctx, { id, status }) => {
    const bug = await ctx.db.get(id);
    if (!bug || bug.status === status) return;
    await ctx.db.patch(id, { status, updated_at: Date.now() });
    await ctx.db.insert("audit_log", {
      entity_type: "bug",
      entity_id: String(id),
      action: "status_change",
      actor: "Director",
      detail: `${bug.status} → ${status}`,
      created_at: Date.now(),
    });
  },
});

export const updateAssignee = mutation({
  args: { id: v.id("bugs"), assignee: v.optional(v.string()) },
  handler: async (ctx, { id, assignee }) => {
    const bug = await ctx.db.get(id);
    if (!bug || bug.assignee === assignee) return;
    await ctx.db.patch(id, { assignee, updated_at: Date.now() });
    await ctx.db.insert("audit_log", {
      entity_type: "bug",
      entity_id: String(id),
      action: "assignee_change",
      actor: "Director",
      detail: assignee ? `Assigned to ${assignee}` : "Unassigned",
      created_at: Date.now(),
    });
  },
});

export const create = mutation({
  args: {
    title: v.string(),
    source: v.union(
      v.literal("consumer_ios"),
      v.literal("consumer_android"),
      v.literal("shop_web"),
      v.literal("manual"),
    ),
    version: v.optional(v.string()),
    device: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("bugs", {
      ...args,
      status: "new",
      created_at: Date.now(),
    });
    await ctx.db.insert("audit_log", {
      entity_type: "bug",
      entity_id: String(id),
      action: "status_change",
      actor: "Director",
      detail: "Bug created (new)",
      created_at: Date.now(),
    });
    return id;
  },
});

// One-time seed — run once to populate from mock data. Safe to call again (checks first).
export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("bugs").first();
    if (existing) return { seeded: false, reason: "already has data" };

    const now = Date.now();
    const bugs = [
      // new
      { title:"Map markers stutter when zooming out past city level",         source:"consumer_ios"     as const, status:"new",         version:"iOS 2.4.1",     device:"iPhone 14 Pro", created_at: now - 12*60*1000 },
      { title:"Booking confirmation push not received after stripe payment",   source:"consumer_android" as const, status:"new",         version:"Android 2.3.8", device:"Pixel 8",       created_at: now - 47*60*1000 },
      { title:"Quote countdown timer resets on app background → foreground",  source:"consumer_ios"     as const, status:"new",         version:"iOS 2.4.1",     device:"iPhone 15",     created_at: now - 60*60*1000 },
      { title:"Shop dashboard: 'Pending acceptance' count off by one",        source:"shop_web"         as const, status:"new",         version:"web 1.12.0",    device:"Chrome 124",    created_at: now - 2*60*60*1000 },
      // triaged
      { title:"Notifications don't fire for same-day rescheduled bookings",   source:"consumer_ios"     as const, status:"triaged",     version:"iOS 2.4.1",     device:"iPhone 14",     created_at: now - 3*60*60*1000 },
      { title:"Chat bubble overlaps CTA button on SE screen size",            source:"consumer_ios"     as const, status:"triaged",     version:"iOS 2.4.0",     device:"iPhone SE",     created_at: now - 4*60*60*1000 },
      { title:"VIN scanner crashes on glare from windshield",                 source:"consumer_ios"     as const, status:"triaged",     version:"iOS 2.4.0",     device:"iPhone 13",     created_at: now - 5*60*60*1000 },
      { title:"Email receipt missing line item for shop tip",                  source:"manual"           as const, status:"triaged",     version:undefined,       device:undefined,       created_at: now - 8*60*60*1000 },
      // assigned
      { title:"Tire size selector doubles up on rapid taps",                  source:"consumer_android" as const, status:"assigned",    version:"Android 2.3.7", device:"Samsung S23",   assignee:"Priya",   created_at: now - 24*60*60*1000 },
      { title:"Settings → Add Card flow loops back to home unexpectedly",     source:"consumer_ios"     as const, status:"assigned",    version:"iOS 2.4.0",     device:"iPhone 12",     assignee:"Marcus",  created_at: now - 25*60*60*1000 },
      // in_progress
      { title:"Shop CRM: bookings list pagination breaks at page 4+",         source:"shop_web"         as const, status:"in_progress", version:"web 1.11.4",    device:"Safari 17",     assignee:"Daniel",  created_at: now - 2*24*60*60*1000 },
      { title:"Apple Pay button shows briefly then disappears at checkout",    source:"consumer_ios"     as const, status:"in_progress", version:"iOS 2.4.0",     device:"iPhone 15 Pro", assignee:"Waleed",  created_at: now - 2*24*60*60*1000 },
      { title:"Address autocomplete returns no results for some Oakland zips", source:"consumer_android" as const, status:"in_progress", version:"Android 2.3.7", device:"Pixel 7a",      assignee:"Priya",   created_at: now - 3*24*60*60*1000 },
      { title:"Refund confirmation email goes to spam (Gmail)",                source:"manual"           as const, status:"in_progress", version:undefined,       device:undefined,       assignee:"Marcus",  created_at: now - 3*24*60*60*1000 },
      // done
      { title:"Map pin label overlaps shop rating stars",                     source:"consumer_ios"     as const, status:"done",        version:"iOS 2.3.9",     device:"iPhone 14",     assignee:"Waleed",  created_at: now - 5*24*60*60*1000 },
      { title:"Quote expiration time off by timezone for non-PST users",      source:"consumer_android" as const, status:"done",        version:"Android 2.3.6", device:"Pixel 8",       assignee:"Priya",   created_at: now - 6*24*60*60*1000 },
      // verified
      { title:"Booking history sort defaults to oldest-first",                 source:"consumer_ios"     as const, status:"verified",    version:"iOS 2.3.9",     device:"iPhone 13 mini",assignee:"Daniel",  created_at: now - 8*24*60*60*1000 },
      { title:"Stripe webhook retry storm during outage on Apr 18",           source:"manual"           as const, status:"verified",    version:undefined,       device:undefined,       assignee:"Marcus",  created_at: now - 10*24*60*60*1000 },
    ];

    for (const bug of bugs) {
      await ctx.db.insert("bugs", bug);
    }
    return { seeded: true, count: bugs.length };
  },
});
