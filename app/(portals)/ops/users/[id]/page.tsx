"use client";

// Ops · User Detail — /ops/users/[id] (Atlas T3).
// Zones: header card (name, badges, clerk id) → tab strip → tab panel.
// P0 tabs: Profile / Garage / Bookings / Money (spec lists 9 — remaining 5
// land post-P0). Read-only; deletion processing lives on the Deletion Queue.

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession } from "@/app/(portals)/portal-session";
import { AuditDrawer } from "@/components/portal/AuditDrawer";
import { CARD_STATIC as CARD, PILL, Skeleton } from "@/components/portal/ChartKit";

function fmtDate(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtDateTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}
function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${n.toFixed(2)}`;
}

function statusPill(status: string): string {
  const s = status.toLowerCase();
  if (["completed", "succeeded", "captured", "paid", "active"].includes(s)) return `${PILL} bg-emerald-50 text-emerald-700`;
  if (["pending", "pending_quote", "quotes_ready", "vehicle_at_shop", "requires_action", "hold"].includes(s)) return `${PILL} bg-amber-50 text-amber-700`;
  if (["cancelled", "no_show", "failed", "refunded", "removed", "disputed"].includes(s)) return `${PILL} bg-red-50 text-red-700`;
  return `${PILL} bg-slate-100 text-slate-600`;
}

const TABS = ["Profile", "Garage", "Bookings", "Money"] as const;
type Tab = (typeof TABS)[number];

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={`mt-0.5 text-[13px] text-slate-900 ${mono ? "font-mono text-[12px]" : ""}`}>
        {value ?? "—"}
      </div>
    </div>
  );
}

export default function OpsUserDetailPage() {
  const params = useParams<{ id: string }>();
  const userId = params.id as Id<"users">;
  const { token } = usePortalSession();
  const [tab, setTab] = useState<Tab>("Profile");
  const [auditOpen, setAuditOpen] = useState(false);

  const profile = useQuery(api.opsUsers.profile, { token, id: userId });

  if (profile === undefined) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (profile === null) {
    return (
      <div className="py-16 text-center text-sm text-slate-400">
        User not found.{" "}
        <Link href="/ops/users" className="text-slate-600 underline">Back to users</Link>
      </div>
    );
  }

  return (
    <div>
      {/* Header card */}
      <div className={CARD}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            {profile.photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={profile.photoUrl} alt="" className="h-16 w-16 rounded-full object-cover" />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-slate-100 text-lg font-semibold text-slate-500">
                {profile.name.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold text-slate-900">{profile.name}</h1>
                {profile.emailConfirmed && <span className={`${PILL} bg-emerald-50 text-emerald-700`}>Email ✓</span>}
                {profile.phoneVerified && <span className={`${PILL} bg-emerald-50 text-emerald-700`}>Phone ✓</span>}
                {profile.isPendingDeletion && <span className={`${PILL} bg-red-50 text-red-700`}>Pending deletion</span>}
              </div>
              <div className="mt-0.5 text-[13px] text-slate-500">
                {profile.username ? `@${profile.username} · ` : ""}
                {profile.email ?? "no email"}
              </div>
              <div className="mt-1 font-mono text-[12px] text-slate-400">
                {profile.clerkUserId}
                <button
                  onClick={() => navigator.clipboard?.writeText(profile.clerkUserId)}
                  className="ml-2 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-50"
                >
                  Copy
                </button>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link href="/ops/users" className="rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] text-slate-600 hover:bg-slate-50">
              ← Users
            </Link>
            <button
              onClick={() => setAuditOpen(true)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] text-slate-600 hover:bg-slate-50"
            >
              Audit
            </button>
          </div>
        </div>

        {/* Tab strip */}
        <div className="mt-5 flex gap-1 border-b border-slate-100">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium ${
                tab === t
                  ? "border-slate-900 text-slate-900"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        {tab === "Profile" && <ProfileTab profile={profile} />}
        {tab === "Garage" && <GarageTab userId={userId} />}
        {tab === "Bookings" && <BookingsTab userId={userId} />}
        {tab === "Money" && <MoneyTab userId={userId} />}
      </div>

      <AuditDrawer
        open={auditOpen}
        onOpenChange={setAuditOpen}
        entityType="user"
        entityId={String(userId)}
        title={`Audit — ${profile.name}`}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Profile tab
// ---------------------------------------------------------------------------
type Profile = NonNullable<FunctionReturnType<typeof api.opsUsers.profile>>;

function ProfileTab({ profile }: { profile: Profile }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className={CARD}>
        <h2 className="text-sm font-semibold text-slate-900">Identity</h2>
        <div className="mt-4 grid grid-cols-2 gap-4">
          <Field label="First name" value={profile.firstName ?? "—"} />
          <Field label="Last name" value={profile.lastName ?? "—"} />
          <Field label="Email" value={profile.email ?? "—"} />
          <Field label="Phone" value={profile.phone ?? "—"} />
          <Field label="Auth provider" value={profile.authProvider ?? "—"} />
          <Field label="Role" value={profile.role} />
          <Field label="Language" value={profile.language ?? "—"} />
          <Field label="Units" value={profile.units ?? "—"} />
          <Field label="Created" value={fmtDate(profile.created)} />
          <Field label="Last updated" value={fmtDate(profile.lastUpdated)} />
          <Field label="Clerk ID" value={profile.clerkUserId} mono />
          <Field label="Stripe customer" value={profile.stripeCustomerId ?? "—"} mono />
        </div>
      </div>

      <div className="space-y-4">
        <div className={CARD}>
          <h2 className="text-sm font-semibold text-slate-900">Onboarding</h2>
          <div className="mt-4 grid grid-cols-3 gap-4">
            <Field
              label="Essential"
              value={profile.essentialOnboardingCompleted ? "Done" : "Not done"}
            />
            <Field label="Tell-us-about" value={profile.tellUsAboutCompleted ? "Done" : "Not done"} />
            <Field label="Overall" value={profile.onboardingCompleted ? "Completed" : "In progress"} />
          </div>
        </div>

        {profile.isPendingDeletion ? (
          <div className="rounded-xl border border-red-200 bg-red-50 p-5">
            <h2 className="text-sm font-semibold text-red-800">Deletion requested</h2>
            <div className="mt-4 grid grid-cols-2 gap-4">
              <Field label="Requested" value={fmtDateTime(profile.deletionRequestedAt)} />
              <Field
                label="Survey response"
                value={
                  profile.deletionSurveySkipped
                    ? "Skipped"
                    : profile.deletionSurveyResponse ?? "—"
                }
              />
            </div>
            <p className="mt-3 text-[12px] text-red-700">
              Processing and restore happen on the{" "}
              <Link href="/ops/users/deletions" className="underline">Deletion Queue</Link>.
            </p>
          </div>
        ) : (
          <div className={CARD}>
            <h2 className="text-sm font-semibold text-slate-900">Deletion state</h2>
            <p className="mt-2 text-[13px] text-slate-500">No deletion request on file.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Garage tab
// ---------------------------------------------------------------------------
function GarageTab({ userId }: { userId: Id<"users"> }) {
  const { token } = usePortalSession();
  const rows: FunctionReturnType<typeof api.opsUsers.garage> | undefined =
    useQuery(api.opsUsers.garage, { token, id: userId });

  if (rows === undefined) return <div className="py-10 text-center text-sm text-slate-400">Loading garage…</div>;
  if (rows.length === 0) {
    return (
      <div className={CARD}>
        <div className="py-6 text-center text-sm text-slate-400">No vehicles in this user’s garage yet.</div>
      </div>
    );
  }

  const active = rows.filter((r) => r.status !== "removed");
  const removed = rows.filter((r) => r.status === "removed");

  const VehicleCard = ({ v }: { v: (typeof rows)[number] }) => (
    <div className={CARD}>
      <div className="flex items-start gap-4">
        {v.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={v.imageUrl} alt="" className="h-16 w-24 shrink-0 rounded-lg object-cover" />
        ) : (
          <div className="flex h-16 w-24 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-[11px] text-slate-400">
            No image
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-semibold text-slate-900">
              {v.nickname ?? v.ymm}
            </span>
            {v.isPrimary && <span className={`${PILL} bg-emerald-50 text-emerald-700`}>Primary</span>}
            <span className={statusPill(v.status)}>{v.status}</span>
            <Link
              href={`/director/data/vins/${v.vin}`}
              title="Open VIN in the data portal"
              className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-500 hover:bg-slate-200 hover:text-slate-700"
            >
              {v.vin}
            </Link>
          </div>
          <div className="mt-1 text-[13px] text-slate-500">
            {[v.ymm, v.trim, v.engine].filter(Boolean).join(" · ") || "Spec unresolved"}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field
              label="Mileage"
              value={v.mileage != null ? `${v.mileage.toLocaleString()} mi` : "—"}
            />
            <Field label="Health score" value={v.healthScore != null ? v.healthScore : "—"} />
            <Field label="Added" value={fmtDate(v.addedAt)} />
            <Field label={v.status === "removed" ? "Removed" : "Segment"} value={v.status === "removed" ? fmtDate(v.removedAt) : v.ownerSegment ?? "—"} />
          </div>
          {(v.avgMonthlyDriving || v.drivingConditions) && (
            <div className="mt-2 text-[12px] text-slate-500">
              Driving: {[v.avgMonthlyDriving, v.drivingConditions].filter(Boolean).join(" · ")}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      {active.map((v) => <VehicleCard key={v.ownerId} v={v} />)}
      {removed.length > 0 && (
        <>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Removed vehicles
          </div>
          {removed.map((v) => <VehicleCard key={v.ownerId} v={v} />)}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bookings tab
// ---------------------------------------------------------------------------
function BookingsTab({ userId }: { userId: Id<"users"> }) {
  const { token } = usePortalSession();
  const rows: FunctionReturnType<typeof api.opsUsers.bookings> | undefined =
    useQuery(api.opsUsers.bookings, { token, id: userId });

  if (rows === undefined) return <div className="py-10 text-center text-sm text-slate-400">Loading bookings…</div>;

  return (
    <div className={CARD}>
      {rows.length === 0 ? (
        <div className="py-6 text-center text-sm text-slate-400">No bookings for this user yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr>
                {["Status", "Shop", "Services", "Scheduled", "Created", "Total", ""].map((h, i) => (
                  <th
                    key={i}
                    className="border-b border-slate-200 pb-2 pr-4 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} className="border-b border-slate-50 hover:bg-slate-50">
                  <td className="py-2.5 pr-4">
                    <Link href={`/ops/bookings/${b.id}`}>
                      <span className={statusPill(b.status)}>{b.status}</span>
                    </Link>
                  </td>
                  <td className="py-2.5 pr-4 text-slate-700">
                    {b.shop_id ? (
                      <Link
                        href={`/shops/all/${b.shop_id}`}
                        className="hover:text-blue-700 hover:underline"
                      >
                        {b.shop}
                      </Link>
                    ) : (
                      b.shop
                    )}
                  </td>
                  <td className="py-2.5 pr-4 text-slate-600">
                    {b.services.length > 0 ? b.services.join(", ") : "—"}
                  </td>
                  <td className="py-2.5 pr-4 text-slate-500">{b.scheduledDate ?? "—"}</td>
                  <td className="py-2.5 pr-4 text-slate-500">{fmtDate(b.created)}</td>
                  <td className="py-2.5 pr-4 tabular-nums text-slate-700">{fmtMoney(b.total)}</td>
                  <td className="py-2.5 pr-4 text-right">
                    <Link
                      href={`/ops/bookings/${b.id}`}
                      className="text-[12px] font-medium text-blue-600 hover:underline"
                    >
                      Open booking →
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

// ---------------------------------------------------------------------------
// Money tab — payments table + user-facing transactions ledger
// ---------------------------------------------------------------------------
function MoneyTab({ userId }: { userId: Id<"users"> }) {
  const { token } = usePortalSession();
  const data: FunctionReturnType<typeof api.opsUsers.money> | undefined =
    useQuery(api.opsUsers.money, { token, id: userId });

  if (data === undefined) return <div className="py-10 text-center text-sm text-slate-400">Loading money…</div>;

  return (
    <div className="space-y-4">
      <div className={CARD}>
        <h2 className="text-sm font-semibold text-slate-900">Payments</h2>
        {data.payments.length === 0 ? (
          <div className="py-6 text-center text-sm text-slate-400">No payments for this user yet.</div>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr>
                  {["Date", "Amount", "Captured", "Status", "Method", "Invoice", "Links"].map((h) => (
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
                {data.payments.map((p) => (
                  <tr key={p.id} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="py-2.5 pr-4 text-slate-500">{fmtDate(p.created)}</td>
                    <td className="py-2.5 pr-4 tabular-nums text-slate-700">{fmtMoney(p.amount)}</td>
                    <td className="py-2.5 pr-4 tabular-nums text-slate-500">
                      {p.capturedAmountCents != null ? fmtMoney(p.capturedAmountCents / 100) : "—"}
                    </td>
                    <td className="py-2.5 pr-4"><span className={statusPill(p.status)}>{p.status}</span></td>
                    <td className="py-2.5 pr-4 text-slate-500">{p.origin ?? p.method ?? "—"}</td>
                    <td className="py-2.5 pr-4 font-mono text-[12px] text-slate-500">{p.invoiceNumber ?? "—"}</td>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-[12px]">
                      <Link href={`/ops/payments/${p.id}`} className="font-medium text-blue-600 hover:underline">
                        Payment
                      </Link>
                      <span className="mx-1 text-slate-300">·</span>
                      <Link href={`/ops/bookings/${p.bookingId}`} className="font-medium text-blue-600 hover:underline">
                        Booking
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className={CARD}>
        <h2 className="text-sm font-semibold text-slate-900">Transactions ledger</h2>
        <p className="mt-0.5 text-[12px] text-slate-400">
          Exactly what the user sees in-app.
        </p>
        {data.transactions.length === 0 ? (
          <div className="py-6 text-center text-sm text-slate-400">No transactions for this user yet.</div>
        ) : (
          <div className="mt-3">
            {data.transactions.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-3 border-b border-slate-50 py-2.5 last:border-0">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-slate-800">{t.description}</div>
                  <div className="text-[12px] text-slate-400">
                    {fmtDate(t.created)} · {t.type}
                    {t.subDescription ? ` · ${t.subDescription}` : ""}
                    {t.bookingId && (
                      <>
                        {" · "}
                        <Link
                          href={`/ops/bookings/${t.bookingId}`}
                          className="font-medium text-blue-600 hover:underline"
                        >
                          booking →
                        </Link>
                      </>
                    )}
                  </div>
                </div>
                <div
                  className={`shrink-0 tabular-nums text-[13px] font-semibold ${
                    t.amount < 0 ? "text-red-600" : "text-emerald-600"
                  }`}
                >
                  {t.amount < 0 ? "−" : "+"}{fmtMoney(Math.abs(t.amount))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
