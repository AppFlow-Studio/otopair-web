/**
 * directorShopActions — admin mutations for the Shop modal Save Changes.
 *
 * Existing director.ts owns setShopActive / setShopVerified — this file
 * adds the editable basics (phone, email, address, website, labor_rate).
 * Audit-logs every change.
 */

import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const updateShopBasics = mutation({
  args: {
    id:         v.id("shops"),
    phone:      v.optional(v.string()),
    email:      v.optional(v.string()),
    address:    v.optional(v.string()),
    website:    v.optional(v.string()),
    labor_rate: v.optional(v.number()),
    actorName:  v.string(),
    actorId:    v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, phone, email, address, website, labor_rate, actorName, actorId }) => {
    const s = await ctx.db.get(id);
    if (!s) return { ok: false as const, reason: "shop_not_found" };

    const patch: Record<string, unknown> = {};
    const changes: string[] = [];

    const tryPatch = <K extends keyof typeof s>(
      key: K, nextVal: unknown, label: string,
    ) => {
      if (nextVal === undefined) return;
      // Treat "" and null/undefined as the same "empty" state — don't
      // generate spurious change rows when the user opens the modal and
      // hits Save without touching the field.
      const cur = s[key];
      const curIsEmpty  = cur == null || cur === "";
      const nextIsEmpty = nextVal == null || nextVal === "";
      if (curIsEmpty && nextIsEmpty) return;
      if (nextVal !== (cur as unknown)) {
        (patch as any)[key] = nextVal;
        const before = curIsEmpty ? "—" : String(cur);
        const after  = nextIsEmpty ? "—" : String(nextVal);
        changes.push(`${label}: ${before} → ${after}`);
      }
    };

    tryPatch("phone",      phone,      "phone");
    tryPatch("email",      email,      "email");
    tryPatch("address",    address,    "address");
    tryPatch("website",    website,    "website");
    tryPatch("labor_rate", labor_rate, "labor_rate");

    if (Object.keys(patch).length === 0) return { ok: true as const, changes: 0 };

    await ctx.db.patch(id, patch);
    await ctx.db.insert("audit_log", {
      entity_type: "shop",
      entity_id:   String(id),
      action:      "field_edit",
      actor:       actorName,
      actor_id:    actorId,
      detail:      `Shop updated · ${changes.join(", ")}`,
      created_at:  Date.now(),
    });

    return { ok: true as const, changes: Object.keys(patch).length };
  },
});
