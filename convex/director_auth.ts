import { action, mutation, query, internalQuery, internalMutation, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";

// ── TOTP (RFC 6238) via Web Crypto API ────────────────────────────────────

function base32Decode(str: string): Uint8Array {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const s = str.toUpperCase().replace(/=+$/, "");
  const out = new Uint8Array(Math.floor(s.length * 5 / 8));
  let bits = 0, val = 0, i = 0;
  for (const ch of s) {
    const idx = A.indexOf(ch);
    if (idx < 0) continue;
    val = (val << 5) | idx; bits += 5;
    if (bits >= 8) { out[i++] = (val >>> (bits - 8)) & 0xff; bits -= 8; }
  }
  return out;
}

function genBase32(): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let res = "", bits = 0, val = 0;
  for (const b of bytes) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { res += A[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) res += A[(val << (5 - bits)) & 31];
  return res;
}

async function hotp(secret: string, counter: number): Promise<string> {
  // Cast to any to work around overload resolution in the Convex TS environment
  const key = await (crypto.subtle as any).importKey(
    "raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  ) as CryptoKey;
  const cb = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { cb[i] = c & 0xff; c = Math.floor(c / 256); }
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, cb));
  const off = sig[19] & 0xf;
  const n = ((sig[off] & 0x7f) << 24) | (sig[off+1] << 16) | (sig[off+2] << 8) | sig[off+3];
  return String(n % 1_000_000).padStart(6, "0");
}

async function verifyTotp(secret: string, code: string): Promise<boolean> {
  const t = Math.floor(Date.now() / 1000 / 30);
  for (const d of [-1, 0, 1]) {
    if (await hotp(secret, t + d) === code.padStart(6, "0")) return true;
  }
  return false;
}

function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
}

// ── Public queries ────────────────────────────────────────────────────────

export const getUserPreview = query({
  args: { id: v.id("director_users") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

export const listUsers = query({
  args: {},
  handler: async (ctx) => {
    return (await ctx.db.query("director_users").collect()).map(u => ({
      _id: u._id, name: u.name, role: u.role,
      created_at: u.created_at, last_login: u.last_login,
    }));
  },
});

export const validateSession = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    if (!token) return null;
    const s = await ctx.db.query("director_sessions").withIndex("by_token", q => q.eq("token", token)).first();
    if (!s || s.expires_at < Date.now()) return null;
    const u = await ctx.db.get(s.user_id);
    if (!u) return null;
    return { userId: u._id, name: u.name, role: u.role };
  },
});

// ── Internal helpers ──────────────────────────────────────────────────────

export const _getUser = internalQuery({
  args: { id: v.id("director_users") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

export const _createSession = internalMutation({
  args: { userId: v.id("director_users"), token: v.string(), name: v.string() },
  handler: async (ctx, { userId, token, name }) => {
    await ctx.db.patch(userId, { last_login: Date.now() });
    await ctx.db.insert("director_sessions", {
      user_id: userId, token,
      created_at: Date.now(),
      expires_at: Date.now() + 8 * 3_600_000,
    });
    await ctx.db.insert("audit_log", {
      entity_type: "director", entity_id: String(userId),
      action: "login", actor: name, actor_id: userId, detail: "Director login via 2FA",
      created_at: Date.now(),
    });
  },
});

export const _insertUser = internalMutation({
  args: {
    name: v.string(),
    role: v.union(v.literal("superadmin"), v.literal("admin"), v.literal("viewer")),
    totp_secret: v.string(),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, { name, role, totp_secret, actorName, actorId }) => {
    const id = await ctx.db.insert("director_users", { name, role, totp_secret, created_at: Date.now() });
    await ctx.db.insert("audit_log", {
      entity_type: "director", entity_id: String(id),
      action: "field_edit", actor: actorName, actor_id: actorId,
      detail: `Director user added: ${name} (${role})`,
      created_at: Date.now(),
    });
    return id;
  },
});

export const _patchSecret = internalMutation({
  args: { id: v.id("director_users"), totp_secret: v.string(), actorName: v.string(), actorId: v.optional(v.id("director_users")) },
  handler: async (ctx, { id, totp_secret, actorName, actorId }) => {
    const u = await ctx.db.get(id);
    if (!u) return;
    await ctx.db.patch(id, { totp_secret });
    await ctx.db.insert("audit_log", {
      entity_type: "director", entity_id: String(id),
      action: "field_edit", actor: actorName, actor_id: actorId,
      detail: `TOTP secret regenerated for: ${u.name}`,
      created_at: Date.now(),
    });
  },
});

// ── Public mutations ──────────────────────────────────────────────────────

export const logout = mutation({
  args: { token: v.string(), actorName: v.optional(v.string()), actorId: v.optional(v.id("director_users")) },
  handler: async (ctx, { token, actorName, actorId }) => {
    const s = await ctx.db.query("director_sessions").withIndex("by_token", q => q.eq("token", token)).first();
    if (!s) return;
    await ctx.db.delete(s._id);
    await ctx.db.insert("audit_log", {
      entity_type: "director", entity_id: String(s.user_id),
      action: "logout", actor: actorName ?? "Director", actor_id: actorId,
      detail: "Director session ended",
      created_at: Date.now(),
    });
  },
});

export const removeUser = mutation({
  args: { id: v.id("director_users"), actorName: v.string(), actorId: v.optional(v.id("director_users")) },
  handler: async (ctx, { id, actorName, actorId }) => {
    const u = await ctx.db.get(id);
    if (!u) return;
    const sessions = await ctx.db.query("director_sessions").withIndex("by_user_id", q => q.eq("user_id", id)).collect();
    for (const s of sessions) await ctx.db.delete(s._id);
    await ctx.db.delete(id);
    await ctx.db.insert("audit_log", {
      entity_type: "director", entity_id: String(id),
      action: "field_edit", actor: actorName, actor_id: actorId,
      detail: `Director user removed: ${u.name}`,
      created_at: Date.now(),
    });
  },
});

// ── Public actions ────────────────────────────────────────────────────────

export const verifyAndLogin = action({
  args: { userId: v.id("director_users"), code: v.string() },
  handler: async (ctx, { userId, code }) => {
    const user = await ctx.runQuery(internal.director_auth._getUser, { id: userId });
    if (!user) return { success: false as const, error: "User not found" };
    if (!(await verifyTotp(user.totp_secret, code))) return { success: false as const, error: "Invalid code" };
    const token = randomToken();
    await ctx.runMutation(internal.director_auth._createSession, { userId, token, name: user.name });
    return { success: true as const, token };
  },
});

export const addUser = action({
  args: {
    name: v.string(),
    role: v.union(v.literal("superadmin"), v.literal("admin"), v.literal("viewer")),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, { name, role, actorName, actorId }): Promise<{ id: string; totp_secret: string }> => {
    const secret = genBase32();
    const id = await ctx.runMutation(internal.director_auth._insertUser, { name, role, totp_secret: secret, actorName, actorId });
    return { id: String(id), totp_secret: secret };
  },
});

export const regenerateSecret = action({
  args: { id: v.id("director_users"), actorName: v.string(), actorId: v.optional(v.id("director_users")) },
  handler: async (ctx, { id, actorName, actorId }): Promise<{ totp_secret: string }> => {
    const secret = genBase32();
    await ctx.runMutation(internal.director_auth._patchSecret, { id, totp_secret: secret, actorName, actorId });
    return { totp_secret: secret };
  },
});

// ── Bootstrap (run from Convex dashboard, not the web UI) ────────────────
// Creates a single "Bootstrap" superadmin account and returns its TOTP secret.
// Only works when no director accounts exist. Run once, log in, then add real
// accounts from the Settings panel and delete Bootstrap.
export const bootstrap = action({
  args: {},
  handler: async (ctx): Promise<
    { ok: false; reason: string } | { ok: true; name: string; totp_secret: string }
  > => {
    const existing = await ctx.runQuery(api.director_auth.listUsers, {});
    if (existing.length > 0) return { ok: false, reason: "Director accounts already exist. Use Settings to add more." };
    const secret = genBase32();
    await ctx.runMutation(internal.director_auth._insertUser, {
      name: "Bootstrap", role: "superadmin", totp_secret: secret, actorName: "System",
    });
    return { ok: true, name: "Bootstrap", totp_secret: secret };
  },
});

// Recovery (Convex dashboard only — not callable from the browser SDK)
// Regenerates the TOTP secret for a single user by name.
// Returns the new secret so the user can re-configure their authenticator.
export const resetUserSecret = internalAction({
  args: { name: v.string() },
  handler: async (ctx, { name }): Promise<
    { ok: false; reason: string } | { ok: true; name: string; totp_secret: string }
  > => {
    const users = await ctx.runQuery(api.director_auth.listUsers, {});
    const user = users.find((u: { name: string; _id: string }) => u.name === name);
    if (!user) return { ok: false, reason: `No director account found with name: ${name}` };
    const secret = genBase32();
    await ctx.runMutation(internal.director_auth._patchSecret, {
      id: user._id, totp_secret: secret, actorName: "Recovery",
    });
    return { ok: true, name: user.name, totp_secret: secret };
  },
});
