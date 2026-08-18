/**
 * serviceMatch.ts — the custom-job match gate (Off-Catalog Work spec, §2 Leak 2).
 *
 * Every place a mechanic can type a service name that ISN'T picked from the
 * canonical catalog scores it here, and matching services surface as options
 * under the field (ServiceSuggestions). It never asks and never blocks — what
 * they typed is always a valid answer.
 *
 * The reason it exists at all: once a custom job or freeform rec is created it
 * can never write a maintenance anchor, so a mechanic who types a name we already
 * carry silently costs the driver credit for work they actually had done. The
 * protection is the canonical option being visible and one tap away.
 *
 * The scoring itself lives in convex/lib/serviceMatch.ts as pure functions so
 * it can be unit-tested without a database (tests/serviceMatchGate.test.ts).
 */

import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireDirector, logAudit } from "./directorGate";
import {
  matchServiceName,
  serviceMatchKey,
  type MatchCandidateInput,
} from "./lib/serviceMatch";

/**
 * Load the catalog once per call: every bookable service plus the aliases
 * pointing at it. The services table is small (tens of rows) and aliases are
 * hand-written, so a full collect is cheaper than maintaining a search index
 * that would still need the fuzzy pass afterwards.
 */
async function loadCatalog(
  ctx: any,
): Promise<{ catalog: MatchCandidateInput[]; docs: Map<string, any> }> {
  const services = await ctx.db.query("services").collect();
  const aliases = await ctx.db.query("service_aliases").collect();

  const aliasesByService = new Map<string, string[]>();
  for (const row of aliases) {
    const key = String(row.service_id);
    const list = aliasesByService.get(key);
    if (list) list.push(row.alias);
    else aliasesByService.set(key, [row.alias]);
  }

  const docs = new Map<string, any>();
  const catalog: MatchCandidateInput[] = [];
  for (const s of services) {
    // Dataset-only services can't be booked, so proposing one as a match would
    // send the mechanic to a service they can't actually select.
    if (s.is_bookable === false) continue;
    docs.set(String(s._id), s);
    catalog.push({
      serviceId: String(s._id),
      name: s.name,
      slug: s.slug ?? null,
      aliases: aliasesByService.get(String(s._id)) ?? [],
    });
  }
  return { catalog, docs };
}

/**
 * The gate. Returns what the typed name probably is, so the UI can decide
 * whether to pre-select a canonical service (high/exact), ask (medium), or get
 * out of the way (none).
 *
 * Deliberately cheap and read-only — it runs on every keystroke-debounce in the
 * service picker, and it must never be the thing that stops a mechanic working.
 * A caller that gets an error here should fall through to the custom path
 * rather than blocking.
 */
export const matchCustomName = query({
  args: {
    name: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const typed = args.name.trim();
    if (typed.length < 2) {
      return { confidence: "none" as const, best: null, candidates: [] };
    }

    const { catalog, docs } = await loadCatalog(ctx);
    const verdict = matchServiceName(typed, catalog);
    const limit = args.limit ?? 3;

    // Hydrate with the fields the picker needs to actually select the service,
    // so accepting a suggestion is one tap and not a second round-trip.
    const candidates = verdict.candidates.slice(0, limit).map((c) => {
      const doc = docs.get(c.serviceId);
      return {
        serviceId: c.serviceId,
        name: c.name,
        score: c.score,
        via: c.via,
        slug: doc?.slug ?? null,
        has_options: Boolean(doc?.has_options),
      };
    });

    return {
      confidence: verdict.confidence,
      best: candidates[0] ?? null,
      candidates,
    };
  },
});

/**
 * Director-side cleanup: record that `alias` is really `serviceId`.
 *
 * This is the only write that feeds the gate. Idempotent on the normalised key
 * so clearing the same cluster twice is harmless — a second call pointing at a
 * DIFFERENT service repoints the existing row rather than leaving two aliases
 * fighting over one name.
 */
export const linkAlias = mutation({
  args: {
    token: v.string(),
    alias: v.string(),
    serviceId: v.id("services"),
  },
  handler: async (ctx, args) => {
    const actor = await requireDirector(ctx, args.token, "data.write");

    const alias = args.alias.trim();
    if (!alias) throw new Error("alias is required");

    const service = await ctx.db.get(args.serviceId);
    if (!service) throw new Error("Service not found");

    const normalized = serviceMatchKey(alias);
    if (!normalized) throw new Error("alias normalises to nothing");

    const existing = await ctx.db
      .query("service_aliases")
      .withIndex("by_normalized_alias", (q) =>
        q.eq("normalized_alias", normalized),
      )
      .first();

    if (existing) {
      if (String(existing.service_id) === String(args.serviceId)) {
        return { ok: true, aliasId: existing._id, created: false };
      }
      await ctx.db.patch(existing._id, {
        service_id: args.serviceId,
        alias,
        source: "director_link",
        created_by_user_id: undefined,
        created_at: Date.now(),
      });
      await logAudit(ctx, actor, {
        entity_type: "service_alias",
        entity_id: String(existing._id),
        action: "repoint",
        detail: `"${alias}" → ${service.name}`,
      });
      return { ok: true, aliasId: existing._id, created: false };
    }

    const aliasId = await ctx.db.insert("service_aliases", {
      alias,
      normalized_alias: normalized,
      service_id: args.serviceId,
      source: "director_link",
      created_at: Date.now(),
    });
    await logAudit(ctx, actor, {
      entity_type: "service_alias",
      entity_id: String(aliasId),
      action: "create",
      detail: `"${alias}" → ${service.name}`,
    });
    return { ok: true, aliasId, created: true };
  },
});
