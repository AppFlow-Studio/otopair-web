"use client";

// Shops · Mechanics directory — /shops/mechanics (Shops spec §4.4).
// Photo+name · shop chip · ★(n) · jobs · next slot · Data contributions —
// the barber-shop moat column, sorted first by default.

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../../portal-session";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";

type MechanicRow = {
  id: string;
  name: string;
  title: string | null;
  photo: string | null;
  shop: string | null;
  shop_id: string;
  active: boolean;
  rating: number | null;
  review_count: number | null;
  jobs: number;
  jobs_capped: boolean;
  contributions: number;
  next_slot: string | null;
};

export default function ShopsMechanicsPage() {
  const { token } = usePortalSession();
  const rows = useQuery(api.shopsMechanics.directory, { token });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Mechanics</h1>
        <p className="mt-1 text-[13px] text-slate-500">
          First-class citizens of the barber-shop model — sorted by data contributions,
          the moat column.
        </p>
      </div>

      {rows === undefined ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No mechanics on this deployment.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2">Mechanic</th>
                <th className="px-2 py-2">Shop</th>
                <th className="px-2 py-2">Rating</th>
                <th className="px-2 py-2">Jobs</th>
                <th className="px-2 py-2">Contributions</th>
                <th className="px-2 py-2">Next slot</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {(rows as MechanicRow[]).map((m) => (
                <tr key={m.id} className={`border-b border-slate-50 ${m.active ? "" : "opacity-50"}`}>
                  <td className="px-4 py-2">
                    <span className="flex items-center gap-2.5">
                      {m.photo ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={m.photo} alt="" className="h-8 w-8 rounded-full object-cover" />
                      ) : (
                        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-[12px] font-bold text-slate-500">
                          {m.name.slice(0, 1)}
                        </span>
                      )}
                      <span>
                        <span className="font-medium text-slate-900">{m.name}</span>
                        {m.title && (
                          <span className="ml-1.5 text-[12px] text-slate-400">{m.title}</span>
                        )}
                        {!m.active && (
                          <span className={`${pill} ml-1.5 bg-slate-100 text-slate-500`}>
                            inactive
                          </span>
                        )}
                      </span>
                    </span>
                  </td>
                  <td className="px-2 py-2">
                    <span className={`${pill} bg-blue-50 text-blue-700`}>{m.shop ?? "—"}</span>
                  </td>
                  <td className="px-2 py-2 text-slate-600">
                    {m.rating != null ? `★ ${m.rating.toFixed(1)} (${m.review_count ?? 0})` : "—"}
                  </td>
                  <td className="px-2 py-2 text-slate-600">
                    {m.jobs}
                    {m.jobs_capped ? "+" : ""}
                  </td>
                  <td className="px-2 py-2">
                    <span
                      className={`${pill} ${
                        m.contributions > 0
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-slate-100 text-slate-400"
                      }`}
                    >
                      {m.contributions} verifications
                    </span>
                  </td>
                  <td className="px-2 py-2 font-mono text-[12px] text-slate-500">
                    {m.next_slot ?? "—"}
                  </td>
                  <td className="px-2 py-2">
                    <Link
                      href={`/shops/mechanics/${m.id}`}
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
    </div>
  );
}
