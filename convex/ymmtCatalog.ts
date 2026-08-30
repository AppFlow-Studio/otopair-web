/**
 * ymmtCatalog.ts — Year/Make/Model/Trim cascading lookups for the booking UI.
 *
 * Strategy: lazy-cache from NHTSA vPIC into the existing makes / models / trims
 * tables. A `model_year_cache` row marks a (make, year) pair as already fetched
 * so the action becomes a no-op on repeat calls.
 */

import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { fetchYmmTrimsFromProviders } from "./lib/ymmTrims";

const NHTSA_BASE = "https://vpic.nhtsa.dot.gov/api/vehicles";

function normalizeName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s\-_/]+/g, " ");
}

function titleCase(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/* -------------------------- Makes -------------------------- */

export const listMakes = query({
  args: {},
  handler: async (ctx) => {
    const makes = await ctx.db.query("makes").collect();
    return makes
      .map((m) => ({ _id: m._id, name: m.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

/* ----------------------- Models ----------------------- */

export const listModelsForMakeYear = query({
  args: { makeId: v.id("makes"), year: v.number() },
  handler: async (ctx, { makeId, year }) => {
    const cache = await ctx.db
      .query("model_year_cache")
      .withIndex("by_make_year", (q) => q.eq("make_id", makeId).eq("year", year))
      .first();

    if (!cache) return null;

    const models = await ctx.db
      .query("models")
      .withIndex("by_make_id", (q) => q.eq("make_id", makeId))
      .collect();

    return models
      .map((m) => ({ _id: m._id, name: m.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const _getMakeForCatalog = internalQuery({
  args: { makeId: v.id("makes") },
  handler: async (ctx, { makeId }) => {
    const make = await ctx.db.get(makeId);
    if (!make) return null;
    return { _id: make._id, name: make.name };
  },
});

export const _readModelCache = internalQuery({
  args: { makeId: v.id("makes"), year: v.number() },
  handler: async (ctx, { makeId, year }) => {
    const cache = await ctx.db
      .query("model_year_cache")
      .withIndex("by_make_year", (q) => q.eq("make_id", makeId).eq("year", year))
      .first();
    return cache ? true : false;
  },
});

export const _upsertModels = internalMutation({
  args: {
    makeId: v.id("makes"),
    year: v.number(),
    names: v.array(v.string()),
  },
  handler: async (ctx, { makeId, year, names }) => {
    const existing = await ctx.db
      .query("models")
      .withIndex("by_make_id", (q) => q.eq("make_id", makeId))
      .collect();

    const existingByNorm = new Map(
      existing.map((m) => [normalizeName(m.name), m])
    );

    for (const raw of names) {
      const norm = normalizeName(raw);
      if (!norm) continue;
      if (existingByNorm.has(norm)) continue;
      await ctx.db.insert("models", {
        make_id: makeId,
        name: titleCase(raw),
        created_at: Date.now(),
      });
    }

    const cacheRow = await ctx.db
      .query("model_year_cache")
      .withIndex("by_make_year", (q) => q.eq("make_id", makeId).eq("year", year))
      .first();
    if (!cacheRow) {
      await ctx.db.insert("model_year_cache", {
        make_id: makeId,
        year,
        fetched_at: Date.now(),
      });
    } else {
      await ctx.db.patch(cacheRow._id, { fetched_at: Date.now() });
    }
  },
});

export const ensureModelsForMakeYear = action({
  args: { makeId: v.id("makes"), year: v.number() },
  handler: async (ctx, { makeId, year }): Promise<void> => {
    const cached = await ctx.runQuery(internal.ymmtCatalog._readModelCache, {
      makeId,
      year,
    });
    if (cached) return;

    const make = await ctx.runQuery(internal.ymmtCatalog._getMakeForCatalog, {
      makeId,
    });
    if (!make) throw new Error("Make not found");

    const url = `${NHTSA_BASE}/GetModelsForMakeYear/make/${encodeURIComponent(
      make.name
    )}/modelyear/${year}?format=json`;

    let names: string[] = [];
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const rows: Array<{ Model_Name?: string }> = data?.Results ?? [];
        names = rows
          .map((r) => (r?.Model_Name ?? "").trim())
          .filter((n) => n.length > 0);
      }
    } catch {
      // swallow — we still write a cache row so we don't hammer on every keystroke
    }

    await ctx.runMutation(internal.ymmtCatalog._upsertModels, {
      makeId,
      year,
      names,
    });
  },
});

/* ----------------------- Trims ----------------------- */

export const listTrimsForModelYear = query({
  args: { modelId: v.id("models"), year: v.number() },
  handler: async (ctx, { modelId, year }) => {
    const cache = await ctx.db
      .query("trim_year_cache")
      .withIndex("by_model_year", (q) =>
        q.eq("model_id", modelId).eq("year", year)
      )
      .first();

    if (!cache) return null;

    const trims = await ctx.db
      .query("trims")
      .withIndex("by_model_id", (q) => q.eq("model_id", modelId))
      .collect();

    return trims
      .filter((t) => {
        const start = t.year_start ?? 0;
        const end = t.year_end ?? 9999;
        return year >= start && year <= end;
      })
      .map((t) => ({ _id: t._id, name: t.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const _getModelForCatalog = internalQuery({
  args: { modelId: v.id("models") },
  handler: async (ctx, { modelId }) => {
    const model = await ctx.db.get(modelId);
    if (!model) return null;
    const make = await ctx.db.get(model.make_id);
    return { _id: model._id, name: model.name, makeName: make?.name ?? "" };
  },
});

export const _readTrimCache = internalQuery({
  args: { modelId: v.id("models"), year: v.number() },
  handler: async (ctx, { modelId, year }) => {
    const cache = await ctx.db
      .query("trim_year_cache")
      .withIndex("by_model_year", (q) =>
        q.eq("model_id", modelId).eq("year", year)
      )
      .first();
    return cache ? true : false;
  },
});

export const _upsertTrims = internalMutation({
  args: {
    modelId: v.id("models"),
    year: v.number(),
    names: v.array(v.string()),
  },
  handler: async (ctx, { modelId, year, names }) => {
    const existing = await ctx.db
      .query("trims")
      .withIndex("by_model_id", (q) => q.eq("model_id", modelId))
      .collect();

    const existingByNorm = new Map(
      existing.map((t) => [normalizeName(t.name), t])
    );
    // Tracks norms inserted during THIS call — existingByNorm only reflects the
    // pre-call DB snapshot, so without this a duplicate inside `names` would
    // insert a second row for the same trim.
    const insertedNorms = new Set<string>();

    for (const raw of names) {
      const norm = normalizeName(raw);
      if (!norm || insertedNorms.has(norm)) continue;
      const found = existingByNorm.get(norm);
      if (found) {
        const start = Math.min(found.year_start ?? year, year);
        const end = Math.max(found.year_end ?? year, year);
        if (start !== found.year_start || end !== found.year_end) {
          await ctx.db.patch(found._id, { year_start: start, year_end: end });
        }
        continue;
      }
      await ctx.db.insert("trims", {
        model_id: modelId,
        // Stored verbatim — the provider trims arrive already clean
        // ("EX-L", "XSE"); titleCase would mangle acronym/hyphen trims.
        name: raw.trim(),
        year_start: year,
        year_end: year,
      });
      insertedNorms.add(norm);
    }

    const cacheRow = await ctx.db
      .query("trim_year_cache")
      .withIndex("by_model_year", (q) =>
        q.eq("model_id", modelId).eq("year", year)
      )
      .first();
    if (!cacheRow) {
      await ctx.db.insert("trim_year_cache", {
        model_id: modelId,
        year,
        fetched_at: Date.now(),
      });
    } else {
      await ctx.db.patch(cacheRow._id, { fetched_at: Date.now() });
    }
  },
});

export const ensureTrimsForModelYear = action({
  args: { modelId: v.id("models"), year: v.number() },
  handler: async (ctx, { modelId, year }): Promise<void> => {
    const cached = await ctx.runQuery(internal.ymmtCatalog._readTrimCache, {
      modelId,
      year,
    });
    if (cached) return;

    const model = await ctx.runQuery(internal.ymmtCatalog._getModelForCatalog, {
      modelId,
    });
    if (!model) throw new Error("Model not found");
    if (!model.makeName) {
      await ctx.runMutation(internal.ymmtCatalog._upsertTrims, {
        modelId,
        year,
        names: [],
      });
      return;
    }

    // Trims come from the premium Car API (/trims/v2) + MarketCheck facets —
    // NHTSA doesn't expose trims without VIN context, and VDB is being dropped
    // for trims. Best-effort: on total failure we cache an empty list so the UI
    // falls back to free-text entry rather than re-hitting the APIs per keystroke.
    let names: string[] = [];
    try {
      names = await fetchYmmTrimsFromProviders({
        year,
        make: model.makeName,
        model: model.name,
      });
    } catch {
      // ignore — cache empty
    }

    await ctx.runMutation(internal.ymmtCatalog._upsertTrims, {
      modelId,
      year,
      names,
    });
  },
});

/**
 * Public string-in trim lookup for the mobile "add vehicle" flow (which holds
 * only make/model strings, e.g. after a VIN decode). Returns the freshly
 * merged Car API + MarketCheck trims (with family-name expansion for makes that
 * split variants into separate models, e.g. Mercedes GLE → GLE 350/450/63 S).
 *
 * Deliberately does NOT read back the shared `trims` catalog table: that table
 * is also written by the enrichment / VIN-decode paths and can carry duplicate
 * or family-mismatched rows under a family model_id (that read-back was the
 * "4× identical AMG GLE 63 S" bug). Providers are the source of truth here.
 */
export const resolveTrimsForYmm = action({
  args: { year: v.number(), make: v.string(), model: v.string() },
  handler: async (
    ctx,
    { year, make, model },
  ): Promise<{ trims: string[] }> => {
    if (!year || !make.trim() || !model.trim()) return { trims: [] };
    let trims: string[] = [];
    try {
      trims = await fetchYmmTrimsFromProviders({ year, make, model });
    } catch {
      trims = [];
    }
    return { trims };
  },
});
