import { action } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { scrapeSimpleTireBySize } from "./lib/simpleTireScraper";
import { scrapeWalmartBySize } from "./lib/walmartTireScraper";
import { scrapeTireRackBySize } from "./lib/tireRackScraper";
import { scrapeWheelSizeOptions } from "./vehicleEnrichment/utils/wheelSizeScraper";
import { slugify } from "./lib/tireBrands";

/** Returns tire models for a given size. Checks DB cache first; scrapes SimpleTire on miss. */
export const searchBySize = action({
  args: {
    size: v.string(),
    minLoadIndex: v.optional(v.number()),
    minSpeedRating: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    // Cache hit — return stored models (filters applied in JS)
    const cached: any = await ctx.runQuery(internal.tires_catalog.getTireSizeCache, { size: args.size });
    if (cached) {
      let models: any[] = await ctx.runQuery(internal.tires_catalog.getTireModelsBySize, { size: args.size });

      if (args.minLoadIndex !== undefined) {
        const min = args.minLoadIndex;
        models = models.filter((m: any) => m.load_index === undefined || m.load_index >= min);
      }
      if (args.minSpeedRating) {
        const RANK: Record<string, number> = { N:1, P:2, Q:3, R:4, S:5, T:6, H:7, V:8, W:9, Y:10, Z:11 };
        const minRank = RANK[args.minSpeedRating.toUpperCase()] ?? 0;
        models = models.filter((m: any) => !m.speed_rating || (RANK[m.speed_rating.toUpperCase()] ?? 0) >= minRank);
      }

      console.log(`[tires] Cache hit for ${args.size} — returning ${models.length} models`);
      return { size: args.size, tires: models, source_url: cached.source_url, total_count: cached.total_count, from_cache: true };
    }

    // Cache miss — fetch brand list from DB, then scrape all sources in parallel
    const brands: string[] = await ctx.runQuery(internal.tireBrands.getBrandNames);
    const [simpleTireResult, walmartResult, tireRackResult]: [any, any, any] = await Promise.all([
      scrapeSimpleTireBySize(args.size, brands),
      scrapeWalmartBySize(args.size, brands),
      scrapeTireRackBySize(args.size, brands),
    ]);

    if (!simpleTireResult) return null;

    // Write tire models, collect id map for pricing linkage.
    // Cache brand → tier lookups so we don't query the DB for the same brand twice.
    // `tire_brands.tier` can be "elite" | "select" | "standard" | "unlisted"; the
    // catalog validator on tire_models only accepts the first three, so callers
    // must SKIP the tire when this returns "unlisted" — we don't catalog
    // unlisted brands (and don't want to silently store them with null tier
    // either, since they're noise we explicitly demoted via tireBrands seeding).
    type StoredTier = "elite" | "select" | "standard" | "unlisted" | null;
    const tierCache = new Map<string, StoredTier>();
    async function getBrandTier(brand: string): Promise<StoredTier> {
      if (!tierCache.has(brand)) {
        const row = await ctx.runQuery(internal.tireBrands.getByBrand, { brand });
        const t = row?.tier;
        tierCache.set(
          brand,
          t === "elite" || t === "select" || t === "standard" || t === "unlisted"
            ? t
            : null,
        );
      }
      return tierCache.get(brand) ?? null;
    }
    /** True when the brand is explicitly tagged unlisted — skip cataloging. */
    function isUnlistedTier(t: StoredTier): boolean {
      return t === "unlisted";
    }
    /** Map StoredTier → upsert-validator-compatible value (drops "unlisted"). */
    function asUpsertTier(t: StoredTier): "elite" | "select" | "standard" | undefined {
      return t === "elite" || t === "select" || t === "standard" ? t : undefined;
    }

    const modelIdMap = new Map<string, Id<"tire_models">>();
    for (const tire of simpleTireResult.tires) {
      const tier = await getBrandTier(tire.brand);
      if (isUnlistedTier(tier)) continue; // skip unlisted brands entirely
      const id = await ctx.runMutation(internal.tires_catalog.upsertTireModel, {
        brand: tire.brand,
        model: tire.model,
        size: tire.size,
        tier: asUpsertTier(tier),
        tire_type: tire.tire_type,
        load_index: tire.load_index,
        speed_rating: tire.speed_rating,
        part_number: tire.part_number,
        source_url: simpleTireResult.source_url,
      });
      modelIdMap.set(`${tire.brand.toLowerCase()}|${slugify(tire.model)}`, id);
    }

    // Write SimpleTire pricing
    for (const price of simpleTireResult.pricing) {
      const modelId = modelIdMap.get(`${price.brand.toLowerCase()}|${slugify(price.model)}`);
      if (!modelId) continue;
      await ctx.runMutation(internal.tires_catalog.upsertTirePricing, {
        tire_model_id: modelId,
        source: "simpletire",
        source_url: price.source_url,
        price_per_tire: price.price_per_tire,
        regular_price: price.regular_price,
        has_deal: price.has_deal,
      });
    }

    // Write Walmart models + pricing
    if (walmartResult) {
      for (const price of walmartResult.pricing) {
        const key = `${price.brand.toLowerCase()}|${slugify(price.model)}`;
        let modelId = modelIdMap.get(key);
        if (!modelId) {
          if (!price.tire_type && price.load_index === undefined && !price.speed_rating) continue;
          const tier = await getBrandTier(price.brand);
          if (isUnlistedTier(tier)) continue; // skip unlisted brands entirely
          modelId = await ctx.runMutation(internal.tires_catalog.upsertTireModel, {
            brand: price.brand,
            model: price.model,
            size: price.size,
            tier: asUpsertTier(tier),
            tire_type: price.tire_type,
            load_index: price.load_index,
            speed_rating: price.speed_rating,
            source_url: price.source_url,
          });
          if (!modelId) continue;
          modelIdMap.set(key, modelId);
        }
        await ctx.runMutation(internal.tires_catalog.upsertTirePricing, {
          tire_model_id: modelId,
          source: "walmart",
          source_url: price.source_url,
          price_per_tire: price.price_per_tire,
          regular_price: price.regular_price,
          has_deal: price.has_deal,
        });
      }
    }

    // Write TireRack models + pricing (TireRack can introduce new models not found on SimpleTire)
    if (tireRackResult) {
      for (const price of tireRackResult.pricing) {
        const key = `${price.brand.toLowerCase()}|${slugify(price.model)}`;
        let modelId = modelIdMap.get(key);
        if (!modelId) {
          // Only create new model if we have enough spec data
          if (!price.tire_type && price.load_index === undefined && !price.speed_rating) continue;
          const tier = await getBrandTier(price.brand);
          if (isUnlistedTier(tier)) continue; // skip unlisted brands entirely
          modelId = await ctx.runMutation(internal.tires_catalog.upsertTireModel, {
            brand: price.brand,
            model: price.model,
            size: price.size,
            tier: asUpsertTier(tier),
            tire_type: price.tire_type,
            load_index: price.load_index,
            speed_rating: price.speed_rating,
            part_number: price.part_number,
            source_url: price.source_url,
          });
          if (!modelId) continue;
          modelIdMap.set(key, modelId);
        }
        await ctx.runMutation(internal.tires_catalog.upsertTirePricing, {
          tire_model_id: modelId,
          source: "tirerack",
          source_url: price.source_url,
          price_per_tire: price.price_per_tire,
          regular_price: price.regular_price,
          has_deal: price.regular_price !== undefined,
          in_stock: price.in_stock,
        });
      }
    }

    // Mark size as scraped so future calls hit the cache
    await ctx.runMutation(internal.tires_catalog.markTireSizeScraped, {
      size: args.size,
      total_count: simpleTireResult.total_count,
      source_url: simpleTireResult.source_url,
    });

    // Apply vehicle-specific filters before returning (cache stores all tires unfiltered)
    let tires: any[] = simpleTireResult.tires;
    if (args.minLoadIndex !== undefined) {
      const min = args.minLoadIndex;
      tires = tires.filter((t: any) => t.load_index === undefined || t.load_index >= min);
    }
    if (args.minSpeedRating) {
      const RANK: Record<string, number> = { N:1, P:2, Q:3, R:4, S:5, T:6, H:7, V:8, W:9, Y:10, Z:11 };
      const minRank = RANK[args.minSpeedRating.toUpperCase()] ?? 0;
      tires = tires.filter((t: any) => !t.speed_rating || (RANK[t.speed_rating.toUpperCase()] ?? 0) >= minRank);
    }

    return { ...simpleTireResult, tires, from_cache: false };
  },
});

/** DEBUG — inspect SimpleTire JSON API response shape. Remove when done. */
export const dumpSimpleTire = action({
  args: { size: v.string() },
  handler: async (_ctx, { size }) => {
    const slug = size.replace("/", "-").toLowerCase();
    const url = `https://simpletire.com/api/products-tire-size-classic?size=${slug}&skipGroups=true&page=1&curationLimit=1&limit=3&userZip=10001`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    });
    const json = await res.json();
    const catalog = json?.siteCatalogProducts;
    const total = catalog?.listResultMetadata?.pagination?.total;
    const first = catalog?.siteCatalogProductsResultList?.[0];
    return {
      status: res.status,
      total,
      first_product_keys: first ? Object.keys(first) : [],
      first_product: first,
    };
  },
});

/** DEBUG — dump raw TireRack HTML from Firecrawl. Remove when done. */
export const dumpTireRack = action({
  args: { size: v.string() },
  handler: async (_ctx, { size }) => {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) return { error: "FIRECRAWL_API_KEY not set" };

    const match = size.match(/^(\d{3})\/(\d{2})Z?R(\d{2})$/i);
    if (!match) return { error: "invalid size" };
    const [, width, ratio, diameter] = match;
    const url = `https://www.tirerack.com/tires/TireSearchResults.jsp?width=${width}%2F&ratio=${ratio}&diameter=${diameter}&quantity=4&filterByVehicle=false`;

    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ url, formats: ["rawHtml"], onlyMainContent: false, waitFor: 6000 }),
    });
    const data = await res.json();
    const html: string = data.data?.rawHtml ?? "";

    const extractParts = (h: string) => {
      const re = /partNumber:\s*'([^']+)'/g;
      const parts: string[] = [];
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(h)) !== null) parts.push(mm[1]);
      return parts;
    };

    const page1Parts = new Set(extractParts(html));

    // Fetch startIndex=20 page and compare partNumbers
    const url2 = url + "&startIndex=20";
    const res2 = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ url: url2, formats: ["rawHtml"], onlyMainContent: false, waitFor: 6000 }),
    });
    const data2 = await res2.json();
    const html2: string = data2.data?.rawHtml ?? "";
    const page2Parts = extractParts(html2);
    const newOnPage2 = page2Parts.filter((p) => !page1Parts.has(p));

    return {
      url,
      page1_partNumbers: page1Parts.size,
      page2_partNumbers: page2Parts.length,
      new_on_page2: newOnPage2.length,
      new_on_page2_sample: newOnPage2.slice(0, 5),
    };
  },
});

/** Normalizes sizes like "245/40ZR19" → "245/40R19" for scraper compatibility. */
function normalizeSize(raw: string): string {
  return raw.replace(/(\d{2,3}\/\d{2})Z(R\d{2})/i, "$1$2").toUpperCase();
}

/**
 * Full tire pipeline for a vehicle.
 * 1. Fetches OEM fitments from wheel-size.com.
 * 2. For each unique size, runs searchBySize (cache-first, scrape on miss).
 * Scheduled automatically when a vehicle is confirmed; can also be called directly.
 */
export const scrapeVehicleTires = action({
  args: {
    year: v.number(),
    make: v.string(),
    model: v.string(),
    trim: v.optional(v.string()),
    displacementL: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const wheelResult = await scrapeWheelSizeOptions(
      args.year, args.make, args.model, args.trim, args.displacementL,
    );

    if (!wheelResult || wheelResult.tireOptions.length === 0) {
      console.log(`[tires] No wheel size data for ${args.year} ${args.make} ${args.model}`);
      return { scraped: 0, total: 0 };
    }

    console.log(`[tires] ${wheelResult.tireOptions.length} fitment options found`);

    // Collect unique sizes; track minimum load index + speed rating per size
    const sizeMap = new Map<string, { minLoadIndex?: number; minSpeedRating?: string }>();

    function addSize(raw: string, li?: number, sr?: string) {
      const size = normalizeSize(raw);
      if (!size.match(/^\d{3}\/\d{2}R\d{2}$/i)) return;
      const existing = sizeMap.get(size);
      if (!existing) {
        sizeMap.set(size, { minLoadIndex: li, minSpeedRating: sr });
      } else if (li !== undefined && (existing.minLoadIndex === undefined || li < existing.minLoadIndex)) {
        existing.minLoadIndex = li;
      }
    }

    for (const opt of wheelResult.tireOptions) {
      if (opt.size_front) addSize(opt.size_front, opt.load_index, opt.speed_rating);
      if (opt.size_rear)  addSize(opt.size_rear,  opt.load_index_rear, opt.speed_rating_rear);
    }

    console.log(`[tires] Scraping ${sizeMap.size} unique sizes`);
    let scraped = 0;

    for (const [size, specs] of sizeMap) {
      try {
        await ctx.runAction(api.tires.searchBySize, {
          size,
          minLoadIndex: specs.minLoadIndex,
          minSpeedRating: specs.minSpeedRating,
        });
        scraped++;
        console.log(`[tires] ✓ ${size}`);
      } catch (e) {
        console.warn(`[tires] Failed to scrape ${size}:`, e);
      }
    }

    return { scraped, total: sizeMap.size };
  },
});

/** Returns OEM tire fitment options for a vehicle from wheel-size.com. */
export const scrapeWheelSize = action({
  args: {
    year: v.number(),
    make: v.string(),
    model: v.string(),
    trim: v.optional(v.string()),
    displacementL: v.optional(v.number()),
  },
  handler: async (_ctx, args) => {
    return await scrapeWheelSizeOptions(
      args.year, args.make, args.model, args.trim, args.displacementL
    );
  },
});
