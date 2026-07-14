"use client";

// Data · Parts (list) — /data/parts (Data spec §4B).
// OEM# mono · name · category pill · fitment count · hygiene filters
// (Unnamed, Unfitted orphans) · exact OEM lookup box.

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../../portal-session";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";

type PartListRow = {
  id: string;
  oem_part_number: string;
  name: string;
  category: string | null;
  subcategory: string | null;
  fitment_count: number;
  fitment_count_capped: boolean;
  unnamed: boolean;
  unfitted: boolean;
};

export default function PartsPage() {
  const { token } = usePortalSession();
  const router = useRouter();
  const [hygiene, setHygiene] = useState<"all" | "unnamed" | "unfitted">("all");
  const [oemSearch, setOemSearch] = useState("");
  const [lookupArmed, setLookupArmed] = useState(false);

  const { results, status, loadMore } = usePaginatedQuery(
    api.dataParts.listParts,
    { token },
    { initialNumItems: 25 },
  );
  const lookup = useQuery(
    api.dataParts.oemLookup,
    lookupArmed && oemSearch.trim() ? { token, oem: oemSearch.trim() } : "skip",
  );

  const filtered = (results as PartListRow[]).filter((r) =>
    hygiene === "all" ? true : hygiene === "unnamed" ? r.unnamed : r.unfitted,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Parts</h1>
        <div className="ml-auto flex items-center gap-2">
          <input
            value={oemSearch}
            onChange={(e) => {
              setOemSearch(e.target.value);
              setLookupArmed(false);
            }}
            onKeyDown={(e) => e.key === "Enter" && setLookupArmed(true)}
            placeholder="Exact OEM lookup — e.g. 04152-YZZA1"
            className="w-64 rounded-lg border-[1.5px] border-slate-200 px-3 py-1.5 font-mono text-[13px] outline-none focus:border-blue-500"
          />
          <button
            onClick={() => setLookupArmed(true)}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-700"
          >
            Find
          </button>
        </div>
      </div>

      {lookupArmed &&
        (lookup === undefined ? (
          <div className="h-10 animate-pulse rounded-lg bg-slate-100" />
        ) : lookup === null ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-[13px] text-amber-800">
            No part matches that OEM number (normalized match attempted).
          </div>
        ) : (
          <button
            onClick={() => router.push(`/data/parts/${lookup.id}`)}
            className="block w-full rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-left text-[13px] text-emerald-800 hover:bg-emerald-100"
          >
            <span className="font-mono">{lookup.oem_part_number}</span> · {lookup.name} — open →
          </button>
        ))}

      <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1">
        {(["all", "unnamed", "unfitted"] as const).map((h) => (
          <button
            key={h}
            onClick={() => setHygiene(h)}
            className={`rounded-md px-3.5 py-1.5 text-sm font-medium capitalize ${
              hygiene === h ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {h === "all" ? "All" : h === "unnamed" ? "Unnamed" : "Unfitted (orphans)"}
          </button>
        ))}
        <span className="ml-auto self-center pr-2 text-[12px] text-slate-400">
          hygiene filters apply within the loaded window
        </span>
      </div>

      {status === "LoadingFirstPage" ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-11 animate-pulse rounded-lg bg-slate-100" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          {hygiene === "all"
            ? "No parts on this deployment."
            : `No ${hygiene} parts in the loaded window.`}
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2">OEM #</th>
                <th className="px-2 py-2">Name</th>
                <th className="px-2 py-2">Category</th>
                <th className="px-2 py-2">Fitments</th>
                <th className="px-2 py-2">Flags</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-b border-slate-50">
                  <td className="px-4 py-2 font-mono text-[12px] text-slate-800">
                    {r.oem_part_number}
                  </td>
                  <td className="px-2 py-2 text-slate-700">{r.name || "—"}</td>
                  <td className="px-2 py-2">
                    {r.category ? (
                      <span className={`${pill} bg-slate-100 text-slate-600`}>
                        {r.category}
                        {r.subcategory ? ` / ${r.subcategory}` : ""}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-2 py-2 text-slate-600">
                    {r.fitment_count}
                    {r.fitment_count_capped ? "+" : ""}
                  </td>
                  <td className="px-2 py-2">
                    {r.unnamed && (
                      <span className={`${pill} mr-1 bg-amber-50 text-amber-700`}>unnamed</span>
                    )}
                    {r.unfitted && (
                      <span className={`${pill} bg-red-50 text-red-700`}>unfitted</span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <Link
                      href={`/data/parts/${r.id}`}
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
          onClick={() => loadMore(25)}
          className="w-full rounded-lg border border-slate-200 bg-white py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          Load more
        </button>
      )}
    </div>
  );
}
