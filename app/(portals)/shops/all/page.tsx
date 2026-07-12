"use client";

// Shops Directory — /shops/all (Shops Atlas T2, §4.2).
// One row per shop: name + health dot (hover popover lists the exact failing
// checks, computed server-side), city/ZIP, $/hr, rating, mechanics, active,
// verified. Row click → Shop Detail.

import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { anyApi } from "convex/server";
import { usePortalSession } from "@/app/(portals)/portal-session";

const shopsDirectoryApi = anyApi.shopsDirectory;

type DirectoryRow = {
  id: string;
  name: string;
  city: string;
  zip: string;
  laborRate: number | null;
  rating: number | null;
  reviewCount: number;
  mechanics: number;
  isActive: boolean;
  isVerified: boolean;
  health: "green" | "amber";
  failingChecks: string[];
};

function HealthDot({ health, failingChecks }: { health: "green" | "amber"; failingChecks: string[] }) {
  return (
    <span className="group relative inline-flex items-center">
      <span
        className={`inline-block h-2.5 w-2.5 rounded-full ring-2 ring-white ${
          health === "green" ? "bg-emerald-500" : "bg-amber-500"
        }`}
      />
      <span className="pointer-events-none absolute left-4 top-1/2 z-20 hidden w-56 -translate-y-1/2 rounded-lg border border-slate-200 bg-white p-3 text-left shadow-lg group-hover:block">
        {health === "green" ? (
          <span className="text-[12px] text-emerald-700">All health checks passing.</span>
        ) : (
          <>
            <span className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Failing checks
            </span>
            <ul className="mt-1 space-y-0.5">
              {failingChecks.map((c) => (
                <li key={c} className="text-[12px] text-amber-700">
                  • {c}
                </li>
              ))}
            </ul>
          </>
        )}
      </span>
    </span>
  );
}

function BoolMark({ on }: { on: boolean }) {
  return on ? (
    <span className="font-semibold text-emerald-600">✓</span>
  ) : (
    <span className="text-slate-300">—</span>
  );
}

export default function ShopsDirectoryPage() {
  const { token } = usePortalSession();
  const router = useRouter();
  const rows = useQuery(shopsDirectoryApi.directoryList, { token }) as
    | DirectoryRow[]
    | undefined;

  return (
    <div>
      <div className="mb-5 flex items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Shops</h1>
        {rows !== undefined && (
          <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
            {rows.length}
          </span>
        )}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5">
        {rows === undefined && (
          <div className="py-10 text-center text-sm text-slate-400">Loading directory…</div>
        )}

        {rows !== undefined && rows.length === 0 && (
          <div className="py-10 text-center text-sm text-slate-500">
            No shops exist yet — new partners appear here once their shop row is created.
          </div>
        )}

        {rows !== undefined && rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="pb-2 pr-4">Shop</th>
                  <th className="pb-2 pr-4">City / ZIP</th>
                  <th className="pb-2 pr-4">$/hr</th>
                  <th className="pb-2 pr-4">Rating</th>
                  <th className="pb-2 pr-4">Mechanics</th>
                  <th className="pb-2 pr-4">Active</th>
                  <th className="pb-2 pr-4">Verified</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => router.push(`/shops/all/${r.id}`)}
                    className="cursor-pointer border-b border-slate-50 hover:bg-slate-50"
                  >
                    <td className="py-2.5 pr-4">
                      <span className="flex items-center gap-2">
                        <HealthDot health={r.health} failingChecks={r.failingChecks} />
                        <span className="font-medium text-slate-900">{r.name}</span>
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 text-slate-600">
                      {r.city}
                      {r.zip !== "—" && <span className="text-slate-400"> · {r.zip}</span>}
                    </td>
                    <td className="py-2.5 pr-4 text-slate-700">
                      {r.laborRate !== null ? `$${r.laborRate}/hr` : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="py-2.5 pr-4 text-slate-700">
                      {r.rating !== null ? (
                        <>
                          {r.rating.toFixed(1)}{" "}
                          <span className="text-[11px] text-slate-400">({r.reviewCount})</span>
                        </>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 text-slate-700">{r.mechanics}</td>
                    <td className="py-2.5 pr-4">
                      <BoolMark on={r.isActive} />
                    </td>
                    <td className="py-2.5 pr-4">
                      <BoolMark on={r.isVerified} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
