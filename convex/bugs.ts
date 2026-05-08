import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

export const getById = query({
  args: { id: v.id("bugs") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

export const listByStatus = query({
  args: { includeArchived: v.optional(v.boolean()) },
  handler: async (ctx, { includeArchived = false }) => {
    const all = await ctx.db.query("bugs").withIndex("by_created_at").order("desc").collect();
    const items = includeArchived ? all.filter(b => b.archived) : all.filter(b => !b.archived);

    const assigneeIds = [...new Set(items.map(b => b.assignee).filter(Boolean))] as Id<"director_users">[];
    const assigneeMap = new Map<string, string>();
    for (const id of assigneeIds) {
      const u = await ctx.db.get(id);
      if (u) assigneeMap.set(String(id), u.name);
    }

    const enriched = items.map(b => ({
      ...b,
      assigneeName: b.assignee ? assigneeMap.get(String(b.assignee)) : undefined,
    }));

    const grouped: Record<string, typeof enriched> = {
      new: [], triaged: [], assigned: [], in_progress: [], done: [], verified: [],
    };
    for (const bug of enriched) {
      if (grouped[bug.status]) grouped[bug.status].push(bug);
    }
    return grouped;
  },
});

export const archive = mutation({
  args: { id: v.id("bugs"), archived: v.boolean(), actorName: v.string(), actorId: v.optional(v.id("director_users")) },
  handler: async (ctx, { id, archived, actorName, actorId }) => {
    const bug = await ctx.db.get(id);
    if (!bug) return;
    await ctx.db.patch(id, { archived, updated_at: Date.now() });
    await ctx.db.insert("audit_log", {
      entity_type: "bug",
      entity_id: String(id),
      action: "status_change",
      actor: actorName,
      actor_id: actorId,
      detail: archived ? "Bug archived" : "Bug restored from archive",
      created_at: Date.now(),
    });
  },
});

export const updateStatus = mutation({
  args: { id: v.id("bugs"), status: v.string(), actorName: v.string(), actorId: v.optional(v.id("director_users")) },
  handler: async (ctx, { id, status, actorName, actorId }) => {
    const bug = await ctx.db.get(id);
    if (!bug || bug.status === status) return;
    await ctx.db.patch(id, { status, updated_at: Date.now() });
    await ctx.db.insert("audit_log", {
      entity_type: "bug",
      entity_id: String(id),
      action: "status_change",
      actor: actorName,
      actor_id: actorId,
      detail: `${bug.status} → ${status}`,
      created_at: Date.now(),
    });
  },
});

export const updateAssignee = mutation({
  args: { id: v.id("bugs"), assignee: v.optional(v.id("director_users")), actorName: v.string(), actorId: v.optional(v.id("director_users")) },
  handler: async (ctx, { id, assignee, actorName, actorId }) => {
    const bug = await ctx.db.get(id);
    if (!bug || String(bug.assignee ?? '') === String(assignee ?? '')) return;
    await ctx.db.patch(id, { assignee, updated_at: Date.now() });
    const assigneeName = assignee ? (await ctx.db.get(assignee))?.name : null;
    await ctx.db.insert("audit_log", {
      entity_type: "bug",
      entity_id: String(id),
      action: "assignee_change",
      actor: actorName,
      actor_id: actorId,
      detail: assignee ? `Assigned to ${assigneeName ?? String(assignee)}` : "Unassigned",
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
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, { actorName, actorId, ...rest }) => {
    const id = await ctx.db.insert("bugs", {
      ...rest,
      status: "new",
      created_at: Date.now(),
    });
    await ctx.db.insert("audit_log", {
      entity_type: "bug",
      entity_id: String(id),
      action: "status_change",
      actor: actorName,
      actor_id: actorId,
      detail: "Bug created (new)",
      created_at: Date.now(),
    });
    return id;
  },
});
