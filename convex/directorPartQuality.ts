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
  reasonKind: "cross_make" | "refuted" | "role_identity";
  confidence: number | null;
  sourceDomains: string[];
  /** Round 12: the source page's own listing title (oem_parts.scraped_name) —
   *  the evidence a human needs to spot a wrong-component part ("84257919 —
   *  Battery" reads fine until you see it was listed as "Battery Cable /
   *  Ground Extension"). */
  scrapedName: string | null;
  // When this fitment was last (re-)confirmed by the pipeline.
  confirmedAt: number;
  // When it first appeared — the "created at" a director actually wants for
  // triage (how long has this been sitting flagged?).
  firstSeenAt: number;
  // Best-effort pointer for "what run do I investigate": part_fitments
  // carries no run_id of its own, so this is the LATEST enrichment_run for
  // the vehicle, not necessarily the exact run that wrote this fitment.
  runId: string | null;
  runStatus: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  vin: string | null;
  configKey: string | null;
};

/** Best-effort "what run do I investigate" pointer for a fitment-scan flag —
 *  part_fitments has no run_id of its own, so this is the LATEST
 *  enrichment_run for the vehicle (same index-backed lookup Deep-Dive itself
 *  falls back to when opened without an explicit runId). */
async function latestRunFor(
  ctx: { db: any },
  vehicleConfigId: any,
): Promise<{ runId: string | null; runStatus: string | null }> {
  const run = await ctx.db
    .query("enrichment_runs")
    .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", vehicleConfigId))
    .order("desc")
    .first();
  return { runId: run ? String(run._id) : null, runStatus: run?.status ?? null };
}

export const scanWrongParts = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<{ flags: WrongPartFlag[]; truncated: boolean }> => {
    await requireDirector(ctx, token);
    const rows = await ctx.db.query("part_fitments").order("desc").take(WRONG_SCAN_WINDOW);

    // Cheap in-memory filtering + dedup first, so the DB round-trips below
    // only run once per candidate row instead of once per raw row.
    const seen = new Set<string>();
    const candidates = rows.filter((f) => {
      if (f.package_code != null) return false;
      if (f.mechanic_verified) return false; // a human already confirmed this — trust it
      if (f.flag_dismissed_at != null) return false; // director already reviewed and dismissed
      const key = `${f.vehicle_config_id}:${f.part_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Batch the two independent lookups every candidate needs across ALL
    // candidates at once (Promise.all), instead of a sequential per-row
    // await chain — with up to WRONG_SCAN_WINDOW candidates, sequential
    // part→cfg→configMake round-trips were enough dependent awaits to trip
    // Convex's "too many system operations" limit before a single flag was
    // even found.
    const [parts, cfgs] = await Promise.all([
      Promise.all(candidates.map((f) => ctx.db.get(f.part_id))),
      Promise.all(candidates.map((f) => ctx.db.get(f.vehicle_config_id))),
    ]);
    const configMakes = await Promise.all(
      cfgs.map((cfg) => (cfg?.make_id ? ctx.db.get(cfg.make_id) : null)),
    );

    const flags: WrongPartFlag[] = [];
    for (let i = 0; i < candidates.length; i++) {
      if (flags.length >= WRONG_MAX_FLAGS) break;
      const f = candidates[i];
      const part = parts[i];
      if (!part) continue;
      const cfg = cfgs[i];
      if (!cfg) continue;
      const configMake = configMakes[i];

      const guardOk = passesI1ReadGuard({
        partMakeId: part.make_id,
        configMakeId: cfg.make_id,
        oemPartNumber: part.oem_part_number,
        configMakeName: configMake?.name,
        mechanicVerified: false, // already excluded above; keep the guard strict here
      });
      // Round 12: component-identity refutes carry the machine-readable
      // "role_identity: " reason prefix (written by the fitment verifier's
      // component-type clause and the roleIdentityAudit sweep) — split them
      // out of the generic refuted bucket so a fitment-correct wrong-component
      // part (the Equinox battery CABLE) gets its own triage chip.
      const isRoleIdentity =
        !!f.refute_flagged && String(f.refute_reason ?? "").startsWith("role_identity");
      const reasonKind: "cross_make" | "refuted" | "role_identity" | null = !guardOk
        ? "cross_make"
        : isRoleIdentity
          ? "role_identity"
          : f.refute_flagged
            ? "refuted"
            : null;
      if (!reasonKind) continue;
      const reason =
        reasonKind === "cross_make"
          ? "Cross-make: part make doesn't match this vehicle's make (or the OEM number carries another brand's pattern)"
          : reasonKind === "role_identity"
            ? `Wrong component for its role${f.refute_reason ? `: ${f.refute_reason}` : ""} — a real, fitment-correct part, but not the ${f.service_type ?? "service"} component`
            : `Refuted by the adversarial fitment verifier${f.refute_reason ? `: ${f.refute_reason}` : ""} — kept only because multiple sources attested it`;

      const partMake = part.make_id ? await ctx.db.get(part.make_id) : null;
      const car = await carInfoFor(ctx, "vehicle_config", String(f.vehicle_config_id));
      const { runId, runStatus } = await latestRunFor(ctx, f.vehicle_config_id);
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
        scrapedName: (part as any).scraped_name ?? null,
        confirmedAt: f.last_confirmed_at ?? f.created_at ?? f._creationTime,
        firstSeenAt: f.first_confirmed_at ?? f.created_at ?? f._creationTime,
        runId,
        runStatus,
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
  /** Round 12: observed listing title — see WrongPartFlag.scrapedName. */
  scrapedName: string | null;
  serviceType: string | null;
  // When this fitment first appeared unpriced.
  firstSeenAt: number;
  // Best-effort pointer for investigation — see latestRunFor's doc comment.
  runId: string | null;
  runStatus: string | null;
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

    const seen = new Set<string>();
    const candidates = rows.filter((f) => {
      if (f.package_code != null) return false;
      // as_needed/kit roles are discovery items — not expected to always
      // carry a price the way a CORE (every-invoice) part must.
      if (f.service_role !== "core") return false;
      const key = `${f.vehicle_config_id}:${f.part_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Batched (Promise.all), not a sequential per-row await chain — same
    // "too many system operations" risk as scanWrongParts at this scan size.
    const summaries = await Promise.all(candidates.map((f) => summarizePartPrices(ctx, f.part_id)));

    const flags: UnpricedPartFlag[] = [];
    for (let i = 0; i < candidates.length; i++) {
      if (flags.length >= MAX_FLAGS) break;
      const f = candidates[i];
      if (summaries[i].sample_size > 0) continue;

      const part = await ctx.db.get(f.part_id);
      if (!part) continue;
      const car = await carInfoFor(ctx, "vehicle_config", String(f.vehicle_config_id));
      const { runId, runStatus } = await latestRunFor(ctx, f.vehicle_config_id);
      flags.push({
        fitmentId: String(f._id),
        configId: String(f.vehicle_config_id),
        partId: String(f.part_id),
        oemNumber: part.oem_part_number,
        partName: part.name,
        scrapedName: (part as any).scraped_name ?? null,
        serviceType: f.service_type ?? null,
        firstSeenAt: f.first_confirmed_at ?? f.created_at ?? f._creationTime,
        runId,
        runStatus,
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
