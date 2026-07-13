"use client";

// Ops · Users list — /ops/users (Atlas T2).
// Zones: header (title + count pill) → search/filter row → table.
// Read-only; row click → /ops/users/[id].

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "@/app/(portals)/portal-session";

function fmtDate(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const PILL = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";

function OnboardingPill({ state }: { state: string }) {
  if (state === "completed") return <span className={`${PILL} bg-emerald-50 text-emerald-700`}>Completed</span>;
  if (state === "tell_us_pending") return <span className={`${PILL} bg-amber-50 text-amber-700`}>Tell-us pending</span>;
  return <span className={`${PILL} bg-slate-100 text-slate-600`}>In progress</span>;
}

export default function OpsUsersPage() {
  const { token } = usePortalSession();
  const router = useRouter();
  const users: FunctionReturnType<typeof api.opsUsers.list> | undefined =
    useQuery(api.opsUsers.list, { token });

  const [search, setSearch] = useState("");
  const [pendingOnly, setPendingOnly] = useState(false);

  const filtered = useMemo(() => {
    if (!users) return undefined;
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      if (pendingOnly && !u.isPendingDeletion) return false;
      if (!q) return true;
      return [u.name, u.username, u.email, u.phone]
        .some((f) => f != null && f.toLowerCase().includes(q));
    });
  }, [users, search, pendingOnly]);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Users</h1>
        {users !== undefined && (
          <span className={`${PILL} bg-slate-100 text-slate-600`}>{users.length}</span>
        )}
      </div>

      {/* Filter row */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name / email / phone / username…"
          className="w-80 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[13px] text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
        />
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-slate-600">
          <input
            type="checkbox"
            checked={pendingOnly}
            onChange={(e) => setPendingOnly(e.target.checked)}
            className="h-3.5 w-3.5 accent-red-600"
          />
          Pending deletion only
        </label>
        {filtered !== undefined && users !== undefined && filtered.length !== users.length && (
          <span className="text-[12px] text-slate-400">
            {filtered.length} of {users.length} shown
          </span>
        )}
      </div>

      {/* Table */}
      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-5">
        {filtered === undefined && (
          <div className="py-10 text-center text-sm text-slate-400">Loading users…</div>
        )}
        {filtered !== undefined && filtered.length === 0 && (
          <div className="py-10 text-center text-sm text-slate-400">
            {search || pendingOnly
              ? "No users match the current search or filters."
              : "No users yet — signups will appear here."}
          </div>
        )}
        {filtered !== undefined && filtered.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr>
                  {["Name", "Email", "Phone", "Vehicles", "Bookings", "Onboarding", "Created", "Flags"].map((h) => (
                    <th
                      key={h}
                      className="border-b border-slate-200 pb-2 pr-4 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => (
                  <tr
                    key={u.id}
                    onClick={() => router.push(`/ops/users/${u.id}`)}
                    className="cursor-pointer border-b border-slate-50 hover:bg-slate-50"
                  >
                    <td className="py-2.5 pr-4">
                      <div className="font-medium text-slate-900">{u.name}</div>
                      {u.username && <div className="text-[11px] text-slate-400">@{u.username}</div>}
                    </td>
                    <td className="py-2.5 pr-4 text-slate-600">
                      {u.email ?? "—"}
                      {u.email && u.emailConfirmed && <span className="ml-1 text-emerald-600" title="Email confirmed">✓</span>}
                    </td>
                    <td className="py-2.5 pr-4 text-slate-600">
                      {u.phone ?? "—"}
                      {u.phone && u.phoneVerified && <span className="ml-1 text-emerald-600" title="Phone verified">✓</span>}
                    </td>
                    <td className="py-2.5 pr-4 tabular-nums text-slate-600">{u.vehicles}</td>
                    <td className="py-2.5 pr-4 tabular-nums text-slate-600">{u.bookings}</td>
                    <td className="py-2.5 pr-4"><OnboardingPill state={u.onboarding} /></td>
                    <td className="py-2.5 pr-4 text-slate-500">{fmtDate(u.created)}</td>
                    <td className="py-2.5 pr-4">
                      {u.isPendingDeletion ? (
                        <span className={`${PILL} bg-red-50 text-red-700`}>Pending deletion</span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
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
