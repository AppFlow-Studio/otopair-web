// =============================================================================
// Data portal · Coverage & Quality — /data/coverage (Data spec §10.4).
// Make × year-band matrix over vehicle_configs (384 — live query is fine at
// this size) with applicability-aware fill; field-family bars read the DAY
// stat data.coverage.field_families via portalStats.getStats.
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";

// --- Authored return types (see dataOverview.ts header) -----------------------

export type MatrixCellData = {
  make: string;
  band: string;
  configs: number;
  avg_fill: number | null;
  avg_applicable_fill: number | null;
};
export type LaunchMakeChip = { make: string; configs: number; avg_fill: number | null };
export type CoverageMatrixResult = {
  makes: string[];
  bands: string[];
  cells: MatrixCellData[];
  launch_makes: LaunchMakeChip[];
  configs_total: number;
  truncated: boolean;
};

function yearBand(year: number): string {
  // 4-year bands keep the matrix readable at today's spread.
  const start = Math.floor(year / 4) * 4;
  return `${start}–${(start + 3) % 100}`;
}

export const matrix = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<CoverageMatrixResult> => {
    await requireDirector(ctx, token);
    const configs = await ctx.db.query("vehicle_configs").take(500);
    const makeName = new Map<string, string>();
    type Acc = { configs: number; fillSum: number; fillN: number; aFillSum: number; aFillN: number };
    const cellAcc = new Map<string, Acc>();
    const makeAcc = new Map<string, Acc>();

    for (const c of configs) {
      const mid = String(c.make_id);
      if (!makeName.has(mid)) {
        const m = await ctx.db.get(c.make_id);
        makeName.set(mid, m ? ((m as { name?: string }).name ?? "Unknown") : "Unknown");
      }
      const make = makeName.get(mid)!;
      const band = yearBand(c.year);
      const key = `${make}|${band}`;
      for (const [map, k] of [
        [cellAcc, key],
        [makeAcc, make],
      ] as const) {
        const acc = map.get(k) ?? { configs: 0, fillSum: 0, fillN: 0, aFillSum: 0, aFillN: 0 };
        acc.configs++;
        if (c.fill_rate != null) {
          acc.fillSum += c.fill_rate;
          acc.fillN++;
        }
        // Latest-run applicable fill is stamped back onto runs, not configs;
        // fill_rate remains the comparable config-level number. Applicable
        // fill arrives via the coverage DAY stat.
        map.set(k, acc);
      }
    }

    const makes = [...makeAcc.keys()].sort(
      (a, b) => (makeAcc.get(b)?.configs ?? 0) - (makeAcc.get(a)?.configs ?? 0),
    );
    const bands = [...new Set([...cellAcc.keys()].map((k) => k.split("|")[1]))].sort();
    const cells: MatrixCellData[] = [];
    for (const [key, acc] of cellAcc) {
      const [make, band] = key.split("|");
      cells.push({
        make,
        band,
        configs: acc.configs,
        avg_fill: acc.fillN > 0 ? acc.fillSum / acc.fillN / 100 : null,
        avg_applicable_fill: null,
      });
    }
    const launchMakes: LaunchMakeChip[] = makes.slice(0, 12).map((make) => {
      const acc = makeAcc.get(make)!;
      return {
        make,
        configs: acc.configs,
        avg_fill: acc.fillN > 0 ? acc.fillSum / acc.fillN / 100 : null,
      };
    });

    return {
      makes,
      bands,
      cells,
      launch_makes: launchMakes,
      configs_total: configs.length,
      truncated: configs.length === 500,
    };
  },
});
