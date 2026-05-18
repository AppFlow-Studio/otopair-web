/**
 * vehicleEnrichment/marketplaceScraper.ts — Marketplace VIN Discovery Pipeline
 *
 * Scrapes CarGurus, Cars.com, and AutoTrader search results to discover VINs
 * for vehicles 2018+. Extracted VINs are deduped and queued for enrichment.
 *
 * Architecture:
 *   1. scrapeMarketplace (action) — Searches a marketplace for a given make/year range,
 *      extracts VINs from listing pages, writes new ones to vin_queue.
 *   2. processVinQueue (action) — Picks up pending VINs, dedupes against vehicles table,
 *      triggers enrichment for new ones (batch-limited to control cost).
 *   3. Crons call these on schedule.
 *
 * Cost controls:
 *   - BATCH_SIZE limits how many VINs get enriched per processor run
 *   - MIN_YEAR filters out anything before 2018
 *   - Dedup against vehicles.by_vin prevents re-enriching known VINs
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { api, internal } from "../_generated/api";
import Anthropic from "@anthropic-ai/sdk";

// ─── Config ─────────────────────────────────────────────────────

const MIN_YEAR = 2018;
const MAX_YEAR = new Date().getFullYear() + 1; // include next model year
const ENRICHMENT_BATCH_SIZE = 1500; // daily cap on enrichments (1 car/min target × ~24h)
const MAX_CONCURRENT = 10; // max simultaneous enrichments (rate limit safety)
const STAGGER_DELAY_MS = 6_000; // 6s between each enrichment start (10 over 60s)
const MODEL_HAIKU = "claude-haiku-4-5-20251001";

// VIN regex: 17 alphanumeric chars, no I/O/Q
const VIN_REGEX = /\b[A-HJ-NPR-Z0-9]{17}\b/g;

// CarGurus search URL patterns by make
const CARGURUS_MAKE_SLUGS: Record<string, string> = {
  "bmw": "m7",
  "toyota": "m25",
  "honda": "m14",
  "hyundai": "m15",
  "kia": "m17",
  "mercedes-benz": "m19",
  "audi": "m4",
  "volkswagen": "m27",
  "ford": "m11",
  "chevrolet": "m8",
  "gmc": "m13",
  "cadillac": "m6",
  "chrysler": "m9",
  "dodge": "m10",
  "jeep": "m16",
  "ram": "m55",
  "subaru": "m24",
  "nissan": "m20",
  "mazda": "m18",
  "volvo": "m28",
  "porsche": "m22",
  "lexus": "m18052",
  "land-rover": "m30",
  "infiniti": "m18051",
  "genesis": "m59",
  "lincoln": "m18",
  "acura": "m3",
};

// ─── Queries ────────────────────────────────────────────────────

/**
 * Check if a VIN already exists in vin_queue or vehicles.
 */
export const checkVinExists = internalQuery({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const inQueue = await ctx.db
      .query("vin_queue")
      .withIndex("by_vin", (q) => q.eq("vin", args.vin))
      .first();
    if (inQueue) return { exists: true, where: "vin_queue", status: inQueue.status };

    const inVehicles = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", args.vin))
      .first();
    if (inVehicles) return { exists: true, where: "vehicles" };

    return { exists: false };
  },
});

/**
 * Get all seeded makes for building search queries.
 */
export const getAllMakes = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("makes").collect();
  },
});

/**
 * Get next batch of pending VINs to process.
 */
export const getPendingVins = internalQuery({
  args: { limit: v.float64() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("vin_queue")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(args.limit);
  },
});

/**
 * Count VINs currently in "enriching" status (concurrency guard).
 */
export const countCurrentlyEnriching = internalQuery({
  args: {},
  handler: async (ctx) => {
    const enriching = await ctx.db
      .query("vin_queue")
      .withIndex("by_status", (q) => q.eq("status", "enriching"))
      .collect();
    return enriching.length;
  },
});

/**
 * Count VINs enriched today (cost control).
 */
export const countTodayEnrichments = internalQuery({
  args: {},
  handler: async (ctx) => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayStart = startOfDay.getTime();

    const recent = await ctx.db
      .query("vin_queue")
      .withIndex("by_status", (q) => q.eq("status", "enriching"))
      .collect();

    const enrichingToday = await ctx.db
      .query("vin_queue")
      .withIndex("by_status", (q) => q.eq("status", "complete"))
      .collect();

    const todayCount = [...recent, ...enrichingToday]
      .filter((v) => (v.processed_at ?? 0) >= todayStart)
      .length;

    return todayCount;
  },
});

// ─── Mutations ──────────────────────────────────────────────────

/**
 * Batch insert discovered VINs into the queue.
 */
export const insertVinBatch = internalMutation({
  args: {
    vins: v.array(v.object({
      vin: v.string(),
      source: v.string(),
      source_url: v.optional(v.string()),
      year: v.float64(),
      make: v.string(),
      model: v.string(),
      trim: v.optional(v.string()),
      price: v.optional(v.float64()),
      mileage: v.optional(v.float64()),
      location: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    let inserted = 0;

    for (const entry of args.vins) {
      // Skip if already in queue
      const existing = await ctx.db
        .query("vin_queue")
        .withIndex("by_vin", (q) => q.eq("vin", entry.vin))
        .first();
      if (existing) continue;

      // Skip if already in vehicles table
      const inVehicles = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", entry.vin))
        .first();
      if (inVehicles) continue;

      await ctx.db.insert("vin_queue", {
        ...entry,
        status: "pending",
        queued_at: now,
      });
      inserted++;
    }

    return { inserted, total: args.vins.length };
  },
});

/**
 * Create a scrape job record.
 */
export const createScrapeJob = internalMutation({
  args: {
    source: v.string(),
    search_params: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("scrape_jobs", {
      source: args.source,
      search_params: args.search_params,
      status: "running",
      listings_found: 0,
      vins_extracted: 0,
      new_vins: 0,
      errors: [],
      started_at: now,
      created_at: now,
    });
  },
});

/**
 * Complete a scrape job with results.
 */
export const completeScrapeJob = internalMutation({
  args: {
    job_id: v.id("scrape_jobs"),
    listings_found: v.float64(),
    vins_extracted: v.float64(),
    new_vins: v.float64(),
    errors: v.array(v.string()),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const job = await ctx.db.get(args.job_id);
    if (!job) return;

    await ctx.db.patch(args.job_id, {
      listings_found: args.listings_found,
      vins_extracted: args.vins_extracted,
      new_vins: args.new_vins,
      errors: args.errors,
      status: args.status,
      completed_at: now,
      duration_ms: now - job.started_at,
    });
  },
});

/**
 * Mark a vin_queue entry as enriching/complete/failed.
 */
export const updateVinStatus = internalMutation({
  args: {
    vin_id: v.id("vin_queue"),
    status: v.string(),
    error: v.optional(v.string()),
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {
      status: args.status,
      processed_at: Date.now(),
    };
    if (args.error) patch.error = args.error;
    if (args.vehicle_config_id) patch.vehicle_config_id = args.vehicle_config_id;
    await ctx.db.patch(args.vin_id, patch);
  },
});

// ─── Scraper Action ─────────────────────────────────────────────

/**
 * Scrape a marketplace for VINs. Uses Haiku with web_search to find
 * listings for a specific make, extracts VINs from the results.
 *
 * Strategy: Ask Haiku to search for "{make} cars for sale near me {year range}"
 * on CarGurus/Cars.com, then extract VINs from the search results.
 */
export const scrapeMarketplace = internalAction({
  args: {
    source: v.string(),      // "cargurus" | "carscom"
    make_slug: v.string(),   // e.g. "bmw", "toyota"
    make_name: v.string(),   // e.g. "BMW", "Toyota"
    year_start: v.optional(v.float64()),
    year_end: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const yearStart = args.year_start ?? MIN_YEAR;
    const yearEnd = args.year_end ?? MAX_YEAR;

    const jobId = await ctx.runMutation(
      internal.vehicleEnrichment.marketplaceScraper.createScrapeJob,
      {
        source: args.source,
        search_params: JSON.stringify({
          make: args.make_name,
          year_start: yearStart,
          year_end: yearEnd,
        }),
      }
    );

    const errors: string[] = [];
    let listingsFound = 0;
    let vinsExtracted = 0;
    let newVins = 0;

    try {
      const client = new Anthropic();

      // Build search query based on source
      let searchQuery: string;
      if (args.source === "cargurus") {
        searchQuery = `site:cargurus.com ${args.make_name} for sale ${yearStart}-${yearEnd} VIN listing details`;
      } else if (args.source === "carscom") {
        searchQuery = `site:cars.com ${args.make_name} for sale ${yearStart}-${yearEnd} VIN vehicle details`;
      } else {
        searchQuery = `${args.source}.com ${args.make_name} for sale ${yearStart}-${yearEnd} VIN`;
      }

      const response = await client.messages.create({
        model: MODEL_HAIKU,
        max_tokens: 8192,
        temperature: 0,
        tools: [{ type: "web_search_20250305" as any, name: "web_search", max_uses: 10 } as any],
        system: `You are a vehicle listing data extractor. Your job is to search marketplace websites and extract VINs (Vehicle Identification Numbers) from car listings.

A valid VIN is exactly 17 characters long, contains only letters (except I, O, Q) and digits.

For each VIN you find, also extract whatever listing data is available:
- Year, Make, Model, Trim
- Price
- Mileage
- Location (city/state)
- Listing URL

Return your findings as a JSON array. Example:
[
  {"vin": "WBAPH5C55BA123456", "year": 2022, "make": "BMW", "model": "5 Series", "trim": "530i", "price": 42500, "mileage": 28000, "location": "Houston, TX", "source_url": "https://..."}
]

If you cannot find VINs, return an empty array [].
Return ONLY the JSON array, no other text.`,
        messages: [
          {
            role: "user",
            content: `Search for ${args.make_name} vehicles for sale (years ${yearStart}-${yearEnd}) on ${args.source === "cargurus" ? "CarGurus" : args.source === "carscom" ? "Cars.com" : args.source}. Find as many listings with VINs as possible. Extract the VIN and listing details from each result.`,
          },
        ],
      });

      // Extract text response
      let responseText = "";
      for (const block of response.content) {
        if (block.type === "text") {
          responseText += block.text;
        }
      }

      // Parse JSON from response
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        errors.push("No JSON array found in response");
      } else {
        let listings: any[];
        try {
          listings = JSON.parse(jsonMatch[0]);
        } catch {
          errors.push("Failed to parse JSON response");
          listings = [];
        }

        listingsFound = listings.length;

        // Validate and collect VINs
        const validVins: Array<{
          vin: string;
          source: string;
          source_url?: string;
          year: number;
          make: string;
          model: string;
          trim?: string;
          price?: number;
          mileage?: number;
          location?: string;
        }> = [];

        for (const listing of listings) {
          const vin = String(listing.vin ?? "").toUpperCase().trim();
          if (!vin.match(/^[A-HJ-NPR-Z0-9]{17}$/)) continue;

          const year = Number(listing.year);
          if (isNaN(year) || year < MIN_YEAR || year > MAX_YEAR) continue;

          vinsExtracted++;
          validVins.push({
            vin,
            source: args.source,
            source_url: listing.source_url || undefined,
            year,
            make: listing.make ?? args.make_name,
            model: listing.model ?? "Unknown",
            trim: listing.trim || undefined,
            price: listing.price ? Number(listing.price) : undefined,
            mileage: listing.mileage ? Number(listing.mileage) : undefined,
            location: listing.location || undefined,
          });
        }

        // Batch insert into vin_queue
        if (validVins.length > 0) {
          const result = await ctx.runMutation(
            internal.vehicleEnrichment.marketplaceScraper.insertVinBatch,
            { vins: validVins }
          ) as { inserted: number; total: number };
          newVins = result.inserted;
        }
      }

      console.log(
        `[scraper] ${args.source}/${args.make_name}: ${listingsFound} listings, ` +
        `${vinsExtracted} valid VINs, ${newVins} new`
      );
    } catch (e: any) {
      errors.push(e.message ?? String(e));
      console.error(`[scraper] ${args.source}/${args.make_name} failed:`, e);
    }

    // Complete the job
    await ctx.runMutation(
      internal.vehicleEnrichment.marketplaceScraper.completeScrapeJob,
      {
        job_id: jobId,
        listings_found: listingsFound,
        vins_extracted: vinsExtracted,
        new_vins: newVins,
        errors,
        status: errors.length > 0 && vinsExtracted === 0 ? "failed" : "complete",
      }
    );

    return {
      source: args.source,
      make: args.make_name,
      listings_found: listingsFound,
      vins_extracted: vinsExtracted,
      new_vins: newVins,
      errors,
    };
  },
});

// ─── Queue Processor ────────────────────────────────────────────

/**
 * Processes pending VINs from the queue. Dedupes against existing vehicles,
 * then triggers enrichment for new ones up to the batch limit.
 */
export const processVinQueue = internalAction({
  args: {},
  handler: async (ctx) => {
    // Kill-switch: pause enrichment without redeploying.
    // Toggle via: npx convex env set --prod ENRICHMENT_PAUSED true|false
    if (process.env.ENRICHMENT_PAUSED === "true") {
      console.log("[queue] ENRICHMENT_PAUSED — skipping run");
      return { processed: 0, enriched: 0, skipped: 0, reason: "paused" };
    }

    // Check daily budget
    const todayCount = await ctx.runQuery(
      internal.vehicleEnrichment.marketplaceScraper.countTodayEnrichments,
      {}
    ) as number;

    const remaining = Math.max(0, ENRICHMENT_BATCH_SIZE - todayCount);
    if (remaining === 0) {
      console.log(`[queue] Daily enrichment limit reached (${ENRICHMENT_BATCH_SIZE}). Skipping.`);
      return { processed: 0, enriched: 0, skipped: 0, reason: "daily_limit" };
    }

    // Get pending VINs
    const pending = await ctx.runQuery(
      internal.vehicleEnrichment.marketplaceScraper.getPendingVins,
      { limit: remaining }
    ) as any[];

    if (pending.length === 0) {
      console.log("[queue] No pending VINs to process.");
      return { processed: 0, enriched: 0, skipped: 0 };
    }

    let enriched = 0;
    let skipped = 0;
    let failed = 0;

    // Check how many are currently enriching (concurrency guard)
    const currentlyEnriching = await ctx.runQuery(
      internal.vehicleEnrichment.marketplaceScraper.countCurrentlyEnriching,
      {}
    ) as number;

    const slotsAvailable = Math.max(0, MAX_CONCURRENT - currentlyEnriching);
    if (slotsAvailable === 0) {
      console.log(`[queue] ${currentlyEnriching} already enriching (max ${MAX_CONCURRENT}). Waiting.`);
      return { processed: 0, enriched: 0, skipped: 0, reason: "concurrency_limit" };
    }

    // Only take as many as we have slots for
    const toProcess = pending.slice(0, slotsAvailable);

    for (let i = 0; i < toProcess.length; i++) {
      const entry = toProcess[i];

      // Final dedup check (may have been enriched by another path since queuing)
      const check = await ctx.runQuery(
        internal.vehicleEnrichment.marketplaceScraper.checkVinExists,
        { vin: entry.vin }
      ) as { exists: boolean; where?: string };

      if (check.exists && check.where === "vehicles") {
        await ctx.runMutation(
          internal.vehicleEnrichment.marketplaceScraper.updateVinStatus,
          { vin_id: entry._id, status: "skipped", error: "Already exists in vehicles table" }
        );
        skipped++;
        continue;
      }

      // Mark as enriching
      await ctx.runMutation(
        internal.vehicleEnrichment.marketplaceScraper.updateVinStatus,
        { vin_id: entry._id, status: "enriching" }
      );

      // Stagger enrichments — each one starts STAGGER_DELAY_MS apart
      // so we don't slam the Claude API with 10 concurrent requests
      try {
        const delay = i * STAGGER_DELAY_MS; // 0s, 30s, 60s, 90s...
        await ctx.scheduler.runAfter(
          delay,
          internal.vehicleEnrichment.marketplaceScraper.enrichAndTrack,
          { vin: entry.vin, vin_queue_id: entry._id }
        );
        enriched++;
      } catch (e: any) {
        await ctx.runMutation(
          internal.vehicleEnrichment.marketplaceScraper.updateVinStatus,
          { vin_id: entry._id, status: "failed", error: e.message ?? String(e) }
        );
        failed++;
      }
    }

    console.log(
      `[queue] Processed ${pending.length}: ${enriched} enriching, ${skipped} skipped, ${failed} failed`
    );

    return { processed: pending.length, enriched, skipped, failed };
  },
});

/**
 * Enrich a single VIN and track the result back to vin_queue.
 */
export const enrichAndTrack = internalAction({
  args: {
    vin: v.string(),
    vin_queue_id: v.id("vin_queue"),
  },
  handler: async (ctx, args) => {
    // Concurrency gate — if too many are already running, re-queue with delay
    const currentlyEnriching = await ctx.runQuery(
      internal.vehicleEnrichment.marketplaceScraper.countCurrentlyEnriching,
      {}
    ) as number;

    if (currentlyEnriching > MAX_CONCURRENT) {
      console.log(`[queue] Concurrency cap hit (${currentlyEnriching}/${MAX_CONCURRENT}). Re-queuing ${args.vin} with 60s delay.`);
      await ctx.scheduler.runAfter(
        60_000,
        internal.vehicleEnrichment.marketplaceScraper.enrichAndTrack,
        { vin: args.vin, vin_queue_id: args.vin_queue_id }
      );
      return;
    }

    try {
      // Step 1: Decode VIN via NHTSA + AI normalization
      const decoded = await ctx.runAction(
        internal.vehicle_pipeline.processVin,
        { vin: args.vin }
      ) as any;

      if (!decoded) {
        await ctx.runMutation(
          internal.vehicleEnrichment.marketplaceScraper.updateVinStatus,
          { vin_id: args.vin_queue_id, status: "failed", error: "VIN decode failed" }
        );
        return;
      }

      // Step 2: Create/upsert vehicle record (same as runPublic:go)
      const vehicle = await ctx.runMutation(api.vehicles.upsertVehicle, {
        vin: args.vin,
        trim_id: decoded.trimId,
        engine_id: decoded.engineId,
        transmission_id: decoded.transmissionId ?? undefined,
        year: decoded.year,
      });

      if (!vehicle?._id) {
        await ctx.runMutation(
          internal.vehicleEnrichment.marketplaceScraper.updateVinStatus,
          { vin_id: args.vin_queue_id, status: "failed", error: "Vehicle upsert failed" }
        );
        return;
      }

      // Step 3: Trigger the full enrichment pipeline
      if (decoded.engineCode) {
        await ctx.scheduler.runAfter(
          0,
          internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3,
          {
            vehicleId: vehicle._id,
            year: decoded.year,
            make: decoded.make,
            model: decoded.model,
            trim: decoded.trim ?? "",
            engineCode: decoded.engineCode,
            displacement: decoded.displacement ?? "",
            drivetrain: decoded.drivetrain ?? undefined,
            nhtsaVinKey: decoded.nhtsaVinKey ?? undefined,
          }
        );
      }

      // Mark as complete — the enrichment runs async from here
      await ctx.runMutation(
        internal.vehicleEnrichment.marketplaceScraper.updateVinStatus,
        { vin_id: args.vin_queue_id, status: "complete" }
      );

      console.log(`[queue] Enrichment triggered for ${args.vin} (${decoded.year} ${decoded.make} ${decoded.model})`);
    } catch (e: any) {
      await ctx.runMutation(
        internal.vehicleEnrichment.marketplaceScraper.updateVinStatus,
        { vin_id: args.vin_queue_id, status: "failed", error: e.message ?? String(e) }
      );
      console.error(`[queue] Enrichment failed for ${args.vin}:`, e);
    }
  },
});

// ─── Orchestrator ───────────────────────────────────────────────

/**
 * Master scrape action — cycles through makes and scrapes one marketplace.
 * Called by cron. Each run picks a different make to scrape (round-robin).
 */
export const runScheduledScrape = internalAction({
  args: {
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Kill-switch: pause marketplace scraping without redeploying.
    // Toggle via: npx convex env set --prod ENRICHMENT_PAUSED true|false
    if (process.env.ENRICHMENT_PAUSED === "true") {
      console.log("[scraper] ENRICHMENT_PAUSED — skipping scheduled scrape");
      return { skipped: true, reason: "paused" };
    }

    const source = args.source ?? "cargurus";

    const makes = await ctx.runQuery(
      internal.vehicleEnrichment.marketplaceScraper.getAllMakes,
      {}
    ) as any[];

    // Pick which make to scrape based on day of month (round-robin)
    const dayOfMonth = new Date().getDate();
    const makeIndex = dayOfMonth % makes.length;
    const make = makes[makeIndex];

    if (!make?.slug) {
      console.log("[scraper] No make to scrape");
      return;
    }

    console.log(`[scraper] Scheduled scrape: ${source}/${make.name} (day ${dayOfMonth}, index ${makeIndex})`);

    const result = await ctx.runAction(
      internal.vehicleEnrichment.marketplaceScraper.scrapeMarketplace,
      {
        source,
        make_slug: make.slug,
        make_name: make.name,
      }
    );

    // Also process the queue after scraping
    await ctx.runAction(
      internal.vehicleEnrichment.marketplaceScraper.processVinQueue,
      {}
    );

    return result;
  },
});
