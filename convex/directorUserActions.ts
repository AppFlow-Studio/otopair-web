/**
 * directorUserActions — admin mutations + lookups for the User modal.
 *
 * Additive to existing director.ts (which already owns softDeleteUser).
 * Audit-logs every change. No Clerk calls happen here — Clerk
 * verification/password flows are surfaced via deep-link to Clerk's own
 * admin dashboard since Clerk owns those flows.
 */

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Read-side helper: exposes the Clerk + Stripe link IDs that userDetail
// (in director.ts) doesn't return today. Keeps director.ts untouched.
export const userExternalIds = query({
  args: { id: v.id("users") },
  handler: async (ctx, { id }) => {
    const u = await ctx.db.get(id);
    if (!u) return null;
    return {
      clerkUserId: u.clerkUserId ?? null,
      stripe_customer_id: u.stripe_customer_id ?? null,
    };
  },
});

// Update the editable profile fields. Email/phone are not synced to Clerk
// here — Clerk is the source of truth for auth identity. This patches the
// Convex mirror so director-side views show the corrected values.
export const updateUserBasics = mutation({
  args: {
    id: v.id("users"),
    first_name: v.optional(v.string()),
    last_name:  v.optional(v.string()),
    email:      v.optional(v.string()),
    phone:      v.optional(v.string()),
    actorName:  v.string(),
    actorId:    v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, first_name, last_name, email, phone, actorName, actorId }) => {
    const u = await ctx.db.get(id);
    if (!u) return { ok: false as const, reason: "user_not_found" };

    const patch: Record<string, unknown> = {};
    const changes: string[] = [];
    const noop = (cur: unknown, nxt: unknown) => {
      // Treat undefined / null / "" as equivalent so opening + saving without
      // typing doesn't produce phantom audit rows.
      const ce = cur == null || cur === "";
      const ne = nxt == null || nxt === "";
      if (ce && ne) return true;
      return cur === nxt;
    };
    if (first_name !== undefined && !noop(u.first_name, first_name)) {
      patch.first_name = first_name; changes.push(`first_name: ${u.first_name || "—"} → ${first_name || "—"}`);
    }
    if (last_name !== undefined && !noop(u.last_name, last_name)) {
      patch.last_name = last_name; changes.push(`last_name: ${u.last_name || "—"} → ${last_name || "—"}`);
    }
    if (email !== undefined && !noop(u.email, email)) {
      patch.email = email; changes.push(`email: ${u.email || "—"} → ${email || "—"}`);
    }
    if (phone !== undefined && !noop(u.phone, phone)) {
      patch.phone = phone; changes.push(`phone: ${u.phone || "—"} → ${phone || "—"}`);
    }
    if (Object.keys(patch).length === 0) return { ok: true as const, changes: 0 };

    await ctx.db.patch(id, patch);
    await ctx.db.insert("audit_log", {
      entity_type: "user",
      entity_id:   String(id),
      action:      "field_edit",
      actor:       actorName,
      actor_id:    actorId,
      detail:      `Profile updated · ${changes.join(", ")}`,
      created_at:  Date.now(),
    });

    return { ok: true as const, changes: Object.keys(patch).length };
  },
});

// ---------------------------------------------------------------------------
// restoreUser — undo soft-delete (sets isPendingDeletion=false)
// ---------------------------------------------------------------------------

export const restoreUser = mutation({
  args: {
    id:        v.id("users"),
    reason:    v.string(),
    actorName: v.string(),
    actorId:   v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, reason, actorName, actorId }) => {
    const u = await ctx.db.get(id);
    if (!u) return { ok: false as const, reason: "user_not_found" };
    await ctx.db.patch(id, {
      isPendingDeletion: false,
      deletionRequestedAt: undefined,
      deletionSurveyResponse: undefined,
    });
    await ctx.db.insert("audit_log", {
      entity_type: "user",
      entity_id:   String(id),
      action:      "status_change",
      actor:       actorName,
      actor_id:    actorId,
      detail:      `Account restored from pending deletion. Reason: ${reason}`,
      created_at:  Date.now(),
    });
    return { ok: true as const };
  },
});

// ---------------------------------------------------------------------------
// setUserRole — patch user.role (admin / user / etc.)
// ---------------------------------------------------------------------------

export const setUserRole = mutation({
  args: {
    id:        v.id("users"),
    role:      v.string(),
    actorName: v.string(),
    actorId:   v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, role, actorName, actorId }) => {
    const u = await ctx.db.get(id);
    if (!u) return { ok: false as const, reason: "user_not_found" };
    if ((u.role ?? "user") === role) return { ok: true as const, changes: 0 };
    await ctx.db.patch(id, { role });
    await ctx.db.insert("audit_log", {
      entity_type: "user",
      entity_id:   String(id),
      action:      "field_edit",
      actor:       actorName,
      actor_id:    actorId,
      detail:      `Role: ${u.role ?? "user"} → ${role}`,
      created_at:  Date.now(),
    });
    return { ok: true as const, changes: 1 };
  },
});

// ---------------------------------------------------------------------------
// grantCredit — director-issued manual credit. Inserts a transactions row.
// Positive amount = credit; negative = debit. Currency assumed USD.
// ---------------------------------------------------------------------------

export const grantCredit = mutation({
  args: {
    id:           v.id("users"),
    amount:       v.number(),
    description:  v.string(),
    actorName:    v.string(),
    actorId:      v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, amount, description, actorName, actorId }) => {
    const u = await ctx.db.get(id);
    if (!u) return { ok: false as const, reason: "user_not_found" };
    const now = Date.now();
    const txId = await ctx.db.insert("transactions", {
      user_id:           id,
      created_at:        now,
      description,
      sub_description:   `Issued by ${actorName} (director)`,
      amount,
      currency:          "USD",
      status:            "completed",
      transaction_type:  amount >= 0 ? "credit_grant" : "credit_debit",
      icon_type:         "credit",
    });
    await ctx.db.insert("audit_log", {
      entity_type: "user",
      entity_id:   String(id),
      action:      "field_edit",
      actor:       actorName,
      actor_id:    actorId,
      detail:      `Manual ${amount >= 0 ? "credit" : "debit"} of $${Math.abs(amount).toFixed(2)} · ${description}`,
      created_at:  now,
    });
    return { ok: true as const, transactionId: txId };
  },
});
