/**
 * devOnly/rockautoCatalogProbe.ts — run the real parsers against live pages.
 *
 * The assembly-rung lesson: validate the premise against the actual HTML
 * before wiring anything. This walks a vehicle end to end with the SAME
 * functions the adapter will use, so a parser that works here is a parser that
 * works there.
 *
 * Delete after the Aug 2026 validation.
 */
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { adapterFetch } from "../vehicleEnrichment/sourceAdapters/http";
import {
  buildCatalogPath,
  catalogUrl,
  parseCatalogNodes,
  parsePositionedListings,
  pickEngineNode,
  pickNodeByPatterns,
  positionOfRoleKey,
  rankInterchangeCandidates,
  ROCKAUTO_ROLE_LOCATION,
  type InterchangeSet,
} from "../vehicleEnrichment/sourceAdapters/rockautoCatalog";
import { parseInterchangeNumbers } from "../vehicleEnrichment/sourceAdapters/rockauto";

export const walkRole = internalAction({
  args: {
    make: v.string(),
    year: v.float64(),
    model: v.string(),
    displacementL: v.float64(),
    cylinders: v.optional(v.float64()),
    roleKey: v.string(),
    moreInfoBudget: v.optional(v.float64()),
  },
  handler: async (ctx, args): Promise<any> => {
    const trace: any = { steps: [] };
    const get = async (path: string) => {
      const r = await adapterFetch(`https://www.rockauto.com${path}`, { timeoutMs: 25_000 });
      await new Promise((x) => setTimeout(x, 300));
      return r;
    };

    // model → engines
    const modelPath = buildCatalogPath([args.make, args.year, args.model]);
    const modelRes = await get(modelPath);
    const engines = parseCatalogNodes(modelRes.body, modelPath);
    trace.steps.push({ step: "model", path: modelPath, status: modelRes.status, engines: engines.map((e) => `${e.segment}/${e.id}`) });

    const engine = pickEngineNode(engines, { displacementL: args.displacementL, cylinders: args.cylinders ?? null });
    if (!engine) return { ...trace, stopped: "no_engine_match" };
    trace.engine = { segment: engine.segment, carcode: engine.id, path: engine.path };

    // engine → categories
    const catRes = await get(engine.path);
    const categories = parseCatalogNodes(catRes.body, engine.path);
    const loc = ROCKAUTO_ROLE_LOCATION[args.roleKey];
    if (!loc) return { ...trace, stopped: `no_location_for_role:${args.roleKey}` };
    const category = pickNodeByPatterns(categories, loc.category);
    trace.steps.push({ step: "engine", status: catRes.status, categories: categories.length, picked: category?.segment ?? null });
    if (!category) return { ...trace, stopped: "no_category_match", sawCategories: categories.map((c) => c.segment).slice(0, 30) };

    // category → part types
    const ptRes = await get(category.path);
    const partTypes = parseCatalogNodes(ptRes.body, category.path);
    const partType = pickNodeByPatterns(partTypes, loc.partType);
    trace.steps.push({ step: "category", status: ptRes.status, partTypes: partTypes.length, picked: partType ? `${partType.segment}/${partType.id}` : null });
    if (!partType) return { ...trace, stopped: "no_part_type_match", sawPartTypes: partTypes.map((p) => p.segment).slice(0, 40) };

    // part type → listings
    const listRes = await get(partType.path);
    const all = parsePositionedListings(listRes.body);
    const wantPos = positionOfRoleKey(args.roleKey);
    const listings = wantPos ? all.filter((l) => l.position === wantPos) : all;
    trace.listings = {
      status: listRes.status,
      chars: listRes.body?.length ?? 0,
      total: all.length,
      wantPosition: wantPos,
      matching: listings.length,
      positionsSeen: [...new Set(all.map((l) => l.positionText))].slice(0, 8),
      sample: listings.slice(0, 6).map((l) => `${l.manufacturer} ${l.partNumber} [${l.position}]`),
    };
    if (listings.length === 0) return { ...trace, stopped: "no_positioned_listings" };

    // listings → interchange sets
    const budget = Math.max(1, Math.trunc(args.moreInfoBudget ?? 5));
    const sets: InterchangeSet[] = [];
    for (const l of listings.slice(0, budget)) {
      try {
        const r = await adapterFetch(l.moreInfoUrl, { timeoutMs: 25_000 });
        const numbers = parseInterchangeNumbers(r.body);
        sets.push({ brand: l.manufacturer, numbers });
        await new Promise((x) => setTimeout(x, 300));
      } catch { /* fail open per listing */ }
    }
    const ranked = rankInterchangeCandidates(sets);
    return {
      ...trace,
      interchange: {
        setsFetched: sets.length,
        perSet: sets.map((s) => `${s.brand}:${s.numbers.length}`),
        top: ranked.slice(0, 12).map((c) => `${c.oem} x${c.brandCount} [${c.brands.join("/")}]`),
      },
    };
  },
});
