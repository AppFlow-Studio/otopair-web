"use client";

// Ops · Users list — /ops/users (Atlas T2).
// Zones: PageHeader → analytics (signup trend + stat tiles) → search/filter
// row → table. Read-only; row click → /ops/users/[id].

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "@/app/(portals)/portal-session";
import {
  CARD_STATIC,
  MICRO_H,
  PILL,
  PageHeader,
  StatTile,
  TrendBars,
  fmtNum,
} from "@/components/portal/ChartKit";

function fmtDate(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Human labels for the raw auth-provider / acquisition-source strings.
const PROVIDER_LABEL: Record<string, string> = {
  password: "Email + password",
  oauth_google: "Google",
  google: "Google",
  oauth_apple: "Apple",
  apple: "Apple",
  phone: "Phone",
};
const SOURCE_LABEL: Record<string, string> = {
  shop_portal_web: "Shop portal",
  web_signup: "Web",
  ios_app: "iOS app",
  android_app: "Android app",
  referral: "Referral",
};
function providerLabel(p: string | null): string {
  if (!p) return "Unknown";
  return PROVIDER_LABEL[p] ?? p.replace(/_/g, " ");
}
function sourceLabel(s: string | null): string | null {
  if (!s) return null;
  return SOURCE_LABEL[s] ?? s.replace(/_/g, " ");
}

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
  const daily = useQuery(api.portalSeries.usersDaily, { token, days: 30 });

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

  const new30d = daily?.reduce((s, d) => s + d.new_users, 0);
  const spark = daily?.map((d) => d.new_users);
  const pendingDeletion = users?.filter((u) => u.isPendingDeletion).length;
  const onboarded = users?.filter((u) => u.onboarding === "completed").length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Users"
        subtitle="Every consumer account — signups, onboarding state, and deletion flags."
      >
        {users !== undefined && (
          <span className={`${PILL} bg-slate-100 text-slate-600`}>{users.length} users</span>
        )}
      </PageHeader>

      {/* Analytics zone */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="New users · 30d"
          value={new30d == null ? "—" : fmtNum(new30d)}
          spark={spark}
        />
        <StatTile label="Total users (recent window)" value={users === undefined ? "—" : fmtNum(users.length)} />
        <StatTile
          label="Onboarding completed"
          value={onboarded == null ? "—" : fmtNum(onboarded)}
        />
        <StatTile
          label="Pending deletion"
          value={pendingDeletion == null ? "—" : fmtNum(pendingDeletion)}
          chip={
            pendingDeletion != null && pendingDeletion > 0 ? (
              <span className={`${PILL} bg-red-50 text-red-700`}>needs review</span>
            ) : undefined
          }
        />
      </div>
      <div className={CARD_STATIC}>
        <div className={MICRO_H}>New users per day · last 30 days</div>
        <div className="mt-3">
          <TrendBars data={daily} dataKey="new_users" name="New users" color="#93c5fd" height={150} />
        </div>
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-3">
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
      <div className={CARD_STATIC}>
        {filtered === undefined && (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded bg-slate-100" />
            ))}
          </div>
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
                  {["Name", "Email", "Phone", "Vehicles", "Bookings", "Spend", "Source", "Onboarding", "Created", "Last active", "Flags"].map((h) => (
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
                      <Link
                        href={`/ops/users/${u.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="font-medium text-slate-900 hover:underline"
                      >
                        {u.name}
                      </Link>
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
                    <td className="py-2.5 pr-4 text-slate-600">
                      <span className="tabular-nums">{u.vehicles}</span>
                      {u.primaryVehicle && (
                        <div className="text-[11px] text-slate-400">{u.primaryVehicle}</div>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 tabular-nums text-slate-600">{u.bookings}</td>
                    <td className="py-2.5 pr-4 tabular-nums text-slate-700">
                      {u.spend > 0 ? `$${Math.round(u.spend).toLocaleString()}` : "—"}
                    </td>
                    <td className="py-2.5 pr-4">
                      <span className="text-slate-700">{providerLabel(u.authProvider)}</span>
                      {sourceLabel(u.acquisitionSource) && (
                        <div className="text-[11px] text-slate-400">
                          via {sourceLabel(u.acquisitionSource)}
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 pr-4"><OnboardingPill state={u.onboarding} /></td>
                    <td className="py-2.5 pr-4 text-slate-500">{fmtDate(u.created)}</td>
                    <td className="py-2.5 pr-4 text-slate-500" title={u.lastActive ? new Date(u.lastActive).toLocaleString() : undefined}>
                      {fmtDate(u.lastActive)}
                    </td>
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
