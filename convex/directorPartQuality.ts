// =============================================================================
// Director · Part Data Quality — proactive, PROGRAMMATIC detection of two
// part-level defect classes review_queue's sanity_flags can't see (those only
// catch out-of-range VALUES; these catch wrong or unpriced PARTS):
//   - wrong-make / refuted parts: failed the I1 read guard (cross-make or
//     brand-signature mismatch, partSelector.ts — the same check that already
//     excludes these parts from quote-time selection) or were refute_flagged
//     by the adversarial fitment verifier but kept for multi-source safety
//     (batch-11: the Forester's wrong pads beat the correct ones this way).
//   - unpriced CORE parts: a part is fitted but carries no trusted price (no
//     part_prices row survives the poison/non-pooled/price-band filter), so
//     the service it belongs to can't actually be quoted.
// Both are bounded, capped scans — no precomputed table, consistent with
// getServiceGapsForConfig / getPriceGapsForConfig's per-config version of the
// same checks (serviceParts.ts). This is the cross-config "show me
// everything wrong right now" surface for the Needs Attention hub.
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";
import { passesI1ReadGuard } from "./partSelector";
import { carInfoFor } from "./dataOverview";
import { summarizePartPrices } from "./part_prices";

const SCAN_WINDOW = 800;
const MAX_FLAGS = 60;
// Wrong parts gets a wider scan + higher cap than unpriced parts — it's the
// one with a searchable/paginated table now, so a small 60-row cap would
// make the paging controls pointless.
const WRONG_SCAN_WINDOW = 1500;
const WRONG_MAX_FLAGS = 200;

export type WrongPartFlag = {
  fitmentId: string;
  configId: string;
  partId: string;
  oemNumber: string;
  partName: string;
  partMakeName: string | null;
  configMakeName: string | null;
  serviceType: string | null;
  reason: string;
  reasonKind: "cross_make" | "refuted";
  confidence: number | null;
  sourceDomains: string[];
  // When this fitment was last confirmed by the pipeline (no direct run_id
  // link on part_fitments — this is the closest "when did we find this"
  // timestamp we have).
  confirmedAt: number;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  vin: string | null;
  configKey: string | null;
};

export const scanWrongParts = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<{ flags: WrongPartFlag[]; truncated: boolean }> => {
    await requireDirector(ctx, token);
    const rows = await ctx.db.query("part_fitments").order("desc").take(WRONG_SCAN_WINDOW);
    const flags: WrongPartFlag[] = [];
    const seen = new Set<string>();
    for (const f of rows) {
      if (flags.length >= WRONG_MAX_FLAGS) break;
      if (f.package_code != null) continue;
      if (f.mechanic_verified) continue; // a human already confirmed this — trust it
      if (f.flag_dismissed_at != null) continue; // director already reviewed and dismissed
      const key = `${f.vehicle_config_id}:${f.part_id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const part = await ctx.db.get(f.part_id);
      if (!part) continue;
      const cfg = await ctx.db.get(f.vehicle_config_id);
      if (!cfg) continue;
      const configMake = cfg.make_id ? await ctx.db.get(cfg.make_id) : null;

      const guardOk = passesI1ReadGuard({
        partMakeId: part.make_id,
        configMakeId: cfg.make_id,
        oemPartNumber: part.oem_part_number,
        configMakeName: configMake?.name,
        mechanicVerified: false, // already excluded above; keep the guard strict here
      });
      const reasonKind: "cross_make" | "refuted" | null = !guardOk ? "cross_make" : f.refute_flagged ? "refuted" : null;
      if (!reasonKind) continue;
      const reason = reasonKind === "cross_make"
        ? "Cross-make: part make doesn't match this vehicle's make (or the OEM number carries another brand's pattern)"
        : `Refuted by the adversarial fitment verifier${f.refute_reason ? `: ${f.refute_reason}` : ""} — kept only because multiple sources attested it`;

      const partMake = part.make_id ? await ctx.db.get(part.make_id) : null;
      const car = await carInfoFor(ctx, "vehicle_config", String(f.vehicle_config_id));
      flags.push({
        fitmentId: String(f._id),
        configId: String(f.vehicle_config_id),
        partId: String(f.part_id),
        oemNumber: part.oem_part_number,
        partName: part.name,
        partMakeName: partMake?.name ?? null,
        configMakeName: configMake?.name ?? null,
        serviceType: f.service_type ?? null,
        reason,
        reasonKind,
        confidence: f.confidence ?? null,
        sourceDomains: f.source_domains ?? [],
        confirmedAt: f.last_confirmed_at ?? f.created_at ?? f._creationTime,
        year: car.year,
        make: car.make,
        model: car.model,
        trim: car.trim,
        vin: car.vin,
        configKey: car.configKey,
      });
    }
    return { flags, truncated: rows.length >= WRONG_SCAN_WINDOW };
  },
});

export type UnpricedPartFlag = {
  fitmentId: string;
  configId: string;
  partId: string;
  oemNumber: string;
  partName: string;
  serviceType: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  vin: string | null;
  configKey: string | null;
};

export const scanUnpricedParts = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<{ flags: UnpricedPartFlag[]; truncated: boolean }> => {
    await requireDirector(ctx, token);
    const rows = await ctx.db.query("part_fitments").order("desc").take(SCAN_WINDOW);
    const flags: UnpricedPartFlag[] = [];
    const seen = new Set<string>();
    for (const f of rows) {
      if (flags.length >= MAX_FLAGS) break;
      if (f.package_code != null) continue;
      // as_needed/kit roles are discovery items — not expected to always
      // carry a price the way a CORE (every-invoice) part must.
      if (f.service_role !== "core") continue;
      const key = `${f.vehicle_config_id}:${f.part_id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const summary = await summarizePartPrices(ctx, f.part_id);
      if (summary.sample_size > 0) continue;

      const part = await ctx.db.get(f.part_id);
      if (!part) continue;
      const car = await carInfoFor(ctx, "vehicle_config", String(f.vehicle_config_id));
      flags.push({
        fitmentId: String(f._id),
        configId: String(f.vehicle_config_id),
        partId: String(f.part_id),
        oemNumber: part.oem_part_number,
        partName: part.name,
        serviceType: f.service_type ?? null,
        year: car.year,
        make: car.make,
        model: car.model,
        trim: car.trim,
        vin: car.vin,
        configKey: car.configKey,
      });
    }
    return { flags, truncated: rows.length >= SCAN_WINDOW };
  },
});
