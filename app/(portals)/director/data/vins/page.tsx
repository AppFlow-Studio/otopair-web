"use client";

// Data · VIN Explorer (list) — /data/vins (Data spec §4B).
// Every decoded vehicle: VIN mono, YMMT chips, engine code, image ✓, owner
// count, and the pinned "missing links" filter (trim/engine FK null = decode
// gap, amber rows). Filter applies within the loaded window — honest note in
// the UI (no null-FK index exists, and one isn't justified yet).

import { useState } from "react";
import Link from "next/link";
import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "@/app/(portals)/portal-session";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";

type VinListRow = {
  id: string;
  vin: string;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  engine_code: string | null;
  has_image: boolean;
  owners: number;
  missing_links: boolean;
};

export default function VinExplorerPage() {
  const { token } = usePortalSession();
  const [missingOnly, setMissingOnly] = useState(false);

  const { results, status, loadMore } = usePaginatedQuery(
    api.dataVins.listVehicles,
    { token, missingLinksOnly: missingOnly },
    { initialNumItems: 50 },
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">VIN Explorer</h1>
        <label className="ml-auto flex items-center gap-2 text-[13px] font-medium text-slate-600">
          <input
            type="checkbox"
            checked={missingOnly}
            onChange={(e) => setMissingOnly(e.target.checked)}
          />
          Missing links only (decode gaps)
        </label>
      </div>
      {missingOnly && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-[12px] font-medium text-amber-800">
          Filter applies within the loaded window — load more to sweep further back. A
          row is a decode gap when trim or engine failed to link.
        </div>
      )}

      {status === "LoadingFirstPage" ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-11 animate-pulse rounded-lg bg-slate-100" />
          ))}
        </div>
      ) : results.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          {missingOnly
            ? "No decode gaps in the loaded window."
            : "No decoded vehicles on this deployment yet."}
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2">VIN</th>
                <th className="px-2 py-2">Year</th>
                <th className="px-2 py-2">Make / Model / Trim</th>
                <th className="px-2 py-2">Engine</th>
                <th className="px-2 py-2">Image</th>
                <th className="px-2 py-2">Owners</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {(results as VinListRow[]).map((r) => (
                <tr
                  key={r.id}
                  className={`border-b border-slate-50 ${r.missing_links ? "bg-amber-50/50" : ""}`}
                >
                  <td className="px-4 py-2 font-mono text-[12px] text-slate-800">{r.vin}</td>
                  <td className="px-2 py-2 text-slate-600">{r.year ?? "—"}</td>
                  <td className="px-2 py-2">
                    <span className="text-slate-700">
                      {[r.make, r.model, r.trim].filter(Boolean).join(" · ") || "—"}
                    </span>
                    {r.missing_links && (
                      <span className={`${pill} ml-2 bg-amber-100 text-amber-800`}>
                        missing links
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 font-mono text-[12px] text-slate-600">
                    {r.engine_code ?? "—"}
                  </td>
                  <td className="px-2 py-2">{r.has_image ? "✓" : "—"}</td>
                  <td className="px-2 py-2 text-slate-600">{r.owners}</td>
                  <td className="px-2 py-2">
                    <Link
                      href={`/director/data/vins/${r.vin}`}
                      className="rounded-md px-2 py-1 text-[12px] font-medium text-blue-600 hover:bg-blue-50"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {status === "CanLoadMore" && (
        <button
          onClick={() => loadMore(50)}
          className="w-full rounded-lg border border-slate-200 bg-white py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          Load more
        </button>
      )}
    </div>
  );
}
