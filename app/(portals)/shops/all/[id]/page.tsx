"use client";

// Shop Detail — /shops/all/:id (Shops Atlas T3, §4.2, tabs 1–6).
// Header card (name + health dot + quick stats) → tab strip → tab content.
// Tab 3 hosts the setLaborRate ceremony (>±15% moves require a co-signer,
// recorded in the audit detail). Tab 6 deep-links to Ops booking detail —
// booking truth lives in Ops, never rebuilt here.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { anyApi } from "convex/server";
import { usePortalSession, useCan } from "@/app/(portals)/portal-session";
import { Ceremony } from "@/components/portal/Ceremony";
import { AuditDrawer } from "@/components/portal/AuditDrawer";

const shopsDirectoryApi = anyApi.shopsDirectory;

// ---------------------------------------------------------------------------
// Types mirroring convex/shopsDirectory.ts return shapes (module is referenced
// via anyApi until codegen runs, so shapes are pinned locally).
// ---------------------------------------------------------------------------
type Profile = {
  id: string;
  name: string;
  slug: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  timezone: string | null;
  lat: number | null;
  lng: number | null;
  description: string | null;
  laborRate: number | null;
  rating: number | null;
  reviewCount: number;
  isActive: boolean;
  isVerified: boolean;
  stripeAccountId: string | null;
  stripeChargesEnabled: boolean;
  stripePayoutsEnabled: boolean;
  mechanicCount: number;
  createdAt: number;
  health: "green" | "amber";
  failingChecks: string[];
  owner: { id: string; name: string } | null;
} | null;

type HourRow = {
  id: string;
  dayOfWeek: number;
  dayName: string;
  openTime: string | null;
  closeTime: string | null;
  isClosed: boolean;
};

type ServicesResult = {
  laborRate: number | null;
  services: Array<{
    id: string;
    serviceId: string;
    name: string;
    category: string;
    isOffered: boolean;
    defaultLaborHours: number | null;
  }>;
} | null;

type MechanicRow = {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  photo: string | null;
  rating: number | null;
  reviewCount: number;
  isActive: boolean;
};

type CalendarResult = {
  mechanics: Array<{ id: string; name: string; isActive: boolean }>;
  slots: Array<{
    id: string;
    mechanicId: string;
    date: string;
    start: string;
    end: string;
    state: "available" | "booked" | "blocked";
    note: string | null;
    title: string | null;
  }>;
};

type BookingRow = {
  id: string;
  user: string;
  user_id: string;
  services: string[];
  status: string;
  date: string | null;
  time: string | null;
  total: number | null;
  createdAt: number;
};

type ShopInsights = {
  reviews: {
    id: string;
    rating: number;
    comment: string | null;
    reviewer: string | null;
    reviewerId: string;
    mechanic: string | null;
    hidden: boolean;
    at: number;
  }[];
  rateHistory: { actor: string; detail: string | null; at: number }[];
  fixedPrices: { service: string; tier: string; price: number }[];
  portfolio: { id: string; url: string; caption: string | null }[];
  stats: {
    total: number;
    completed: number;
    cancelled: number;
    noShow: number;
    cancelRate: number | null;
    noShowRate: number | null;
    disputeCount: number;
  };
};

const TABS = ["Profile", "Hours", "Services & Rate", "Mechanics", "Calendar", "Bookings", "Insights"] as const;
type Tab = (typeof TABS)[number];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function pill(status: string): string {
  const base = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
  if (["completed"].includes(status)) return `${base} bg-emerald-50 text-emerald-700`;
  if (["cancelled", "no_show"].includes(status)) return `${base} bg-red-50 text-red-700`;
  if (["pending", "pending_quote", "quotes_ready"].includes(status))
    return `${base} bg-amber-50 text-amber-700`;
  return `${base} bg-slate-100 text-slate-600`;
}

/** Monday of the week containing `d`, as a local Date. */
function mondayOf(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = out.getDay(); // 0 = Sun
  out.setDate(out.getDate() - ((dow + 6) % 7));
  return out;
}

function isoDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function weekDates(monday: Date): string[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    return isoDate(d);
  });
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md ${className}`}
    >
      {children}
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return <div className="py-10 text-center text-sm text-slate-400">Loading {label}…</div>;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function ShopDetailPage() {
  const params = useParams<{ id: string }>();
  const shopId = params.id;
  const { token } = usePortalSession();
  const canWriteShops = useCan("shops.write");

  const [tab, setTab] = useState<Tab>("Profile");
  const [auditOpen, setAuditOpen] = useState(false);

  const profile = useQuery(shopsDirectoryApi.shopProfile, { token, id: shopId }) as
    | Profile
    | undefined;

  const hours = useQuery(
    shopsDirectoryApi.shopHours,
    tab === "Hours" ? { token, id: shopId } : "skip",
  ) as HourRow[] | undefined;

  const servicesResult = useQuery(
    shopsDirectoryApi.shopServicesList,
    tab === "Services & Rate" ? { token, id: shopId } : "skip",
  ) as ServicesResult | undefined;

  const mechanics = useQuery(
    shopsDirectoryApi.shopMechanics,
    tab === "Mechanics" ? { token, id: shopId } : "skip",
  ) as MechanicRow[] | undefined;

  const bookings = useQuery(
    shopsDirectoryApi.shopBookings,
    tab === "Bookings" ? { token, id: shopId } : "skip",
  ) as BookingRow[] | undefined;

  // Calendar week selection
  const [weekMonday, setWeekMonday] = useState(() => mondayOf(new Date()));
  const dates = useMemo(() => weekDates(weekMonday), [weekMonday]);
  const calendar = useQuery(
    shopsDirectoryApi.shopCalendarWeek,
    tab === "Calendar" ? { token, id: shopId, dates } : "skip",
  ) as CalendarResult | undefined;
  const insights = useQuery(
    shopsDirectoryApi.shopInsights,
    tab === "Insights" ? { token, id: shopId } : "skip",
  ) as ShopInsights | undefined;

  // Rate-change ceremony state (tab 3)
  const setLaborRate = useMutation(shopsDirectoryApi.setLaborRate);
  const [rateInput, setRateInput] = useState("");
  const [coSignName, setCoSignName] = useState("");
  const [rateCeremonyOpen, setRateCeremonyOpen] = useState(false);
  const [rateError, setRateError] = useState("");

  if (profile === undefined) {
    return <Loading label="shop" />;
  }
  if (profile === null) {
    return (
      <Card>
        <div className="py-8 text-center text-sm text-slate-500">
          This shop no longer exists.{" "}
          <Link href="/shops/all" className="font-medium text-blue-600 hover:underline">
            Back to the directory
          </Link>
        </div>
      </Card>
    );
  }

  const currentRate = servicesResult?.laborRate ?? profile.laborRate;
  const parsedRate = Number(rateInput);
  const rateValid = Number.isFinite(parsedRate) && parsedRate > 0;
  const bigMove =
    rateValid && currentRate !== null && currentRate > 0
      ? Math.abs(parsedRate - currentRate) / currentRate > 0.15
      : false;

  const openRateCeremony = () => {
    setRateError("");
    if (!rateValid) {
      setRateError("Enter a valid positive hourly rate.");
      return;
    }
    if (bigMove && coSignName.trim().length === 0) {
      setRateError("This move is more than ±15% — a co-signer name is required.");
      return;
    }
    setRateCeremonyOpen(true);
  };

  return (
    <div>
      {/* ---- Breadcrumb ---------------------------------------------------- */}
      <div className="mb-3 flex items-center gap-1.5 text-[12px] text-slate-500">
        <Link href="/shops/all" className="font-medium text-slate-600 hover:underline">
          Shops Directory
        </Link>
        <span className="text-slate-300">/</span>
        <span className="text-slate-700">{profile.name}</span>
      </div>

      {/* ---- Header card -------------------------------------------------- */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5">
              <span
                className={`inline-block h-2.5 w-2.5 rounded-full ${
                  profile.health === "green" ? "bg-emerald-500" : "bg-amber-500"
                }`}
                title={
                  profile.health === "green"
                    ? "All health checks passing"
                    : profile.failingChecks.join(" · ")
                }
              />
              <h1 className="text-xl font-semibold text-slate-900">{profile.name}</h1>
              {!profile.isActive && (
                <span className="inline-flex rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700">
                  inactive
                </span>
              )}
              {profile.isVerified && (
                <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                  verified
                </span>
              )}
            </div>
            <div className="mt-1 text-[13px] text-slate-500">
              {[profile.address, profile.city, profile.state, profile.zip].filter(Boolean).join(", ") ||
                "No address on file"}
            </div>
            {profile.health === "amber" && (
              <div className="mt-1.5 text-[12px] text-amber-700">
                {profile.failingChecks.join(" · ")}
              </div>
            )}
          </div>
          <div className="flex items-center gap-4">
            <div className="flex gap-5 text-right">
              <div>
                <div className="text-2xl font-bold text-slate-900">
                  {profile.laborRate !== null ? `$${profile.laborRate}` : "—"}
                </div>
                <div className="text-xs font-medium text-slate-500">$/hr</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-slate-900">
                  {profile.rating !== null ? profile.rating.toFixed(1) : "—"}
                </div>
                <div className="text-xs font-medium text-slate-500">rating ({profile.reviewCount})</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-slate-900">{profile.mechanicCount}</div>
                <div className="text-xs font-medium text-slate-500">mechanics</div>
              </div>
            </div>
            <button
              onClick={() => setAuditOpen(true)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] font-medium text-slate-600 hover:bg-slate-50"
            >
              Audit
            </button>
          </div>
        </div>
      </Card>

      {/* ---- Tab strip ---------------------------------------------------- */}
      <div className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium ${
              tab === t
                ? "border-blue-600 text-blue-700"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ---- Tab 1 · Profile ---------------------------------------------- */}
      {tab === "Profile" && (
        <Card>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              ["Name", profile.name],
              ["Slug", profile.slug ?? "—"],
              ["Address", profile.address ?? "—"],
              ["City / State / ZIP", [profile.city, profile.state, profile.zip].filter(Boolean).join(", ") || "—"],
              [
                "Phone",
                profile.phone ? (
                  <a href={`tel:${profile.phone}`} className="text-blue-600 hover:underline">
                    {profile.phone}
                  </a>
                ) : (
                  "—"
                ),
              ],
              [
                "Email",
                profile.email ? (
                  <a href={`mailto:${profile.email}`} className="text-blue-600 hover:underline">
                    {profile.email}
                  </a>
                ) : (
                  "—"
                ),
              ],
              [
                "Owner",
                profile.owner ? (
                  <Link
                    href={`/ops/users/${profile.owner.id}`}
                    className="font-medium text-blue-600 hover:underline"
                  >
                    {profile.owner.name}
                  </Link>
                ) : (
                  "—"
                ),
              ],
              [
                "Website",
                profile.website ? (
                  <a
                    href={profile.website.startsWith("http") ? profile.website : `https://${profile.website}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    {profile.website}
                  </a>
                ) : (
                  "—"
                ),
              ],
              ["Timezone", profile.timezone ?? "—"],
              [
                "Coordinates",
                profile.lat != null && profile.lng != null ? (
                  <a
                    href={`https://www.openstreetmap.org/?mlat=${profile.lat}&mlon=${profile.lng}#map=16/${profile.lat}/${profile.lng}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[12px] text-blue-600 hover:underline"
                  >
                    {profile.lat.toFixed(5)}, {profile.lng.toFixed(5)}
                  </a>
                ) : (
                  <span className="text-amber-600" title="Missing from the network map">not geocoded</span>
                ),
              ],
              ["Labor rate", profile.laborRate !== null ? `$${profile.laborRate}/hr` : "—"],
              ["Active", profile.isActive ? "Yes" : "No"],
              ["Verified", profile.isVerified ? "Yes" : "No"],
              [
                "Stripe",
                profile.stripeAccountId
                  ? `${profile.stripeAccountId} · charges ${profile.stripeChargesEnabled ? "✓" : "✗"} · payouts ${profile.stripePayoutsEnabled ? "✓" : "✗"}`
                  : "Not connected",
              ],
              ["Created", new Date(profile.createdAt).toLocaleDateString()],
            ].map(([label, value]) => (
              <div key={label as string}>
                <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</dt>
                <dd className="mt-0.5 text-[13px] text-slate-800">{value}</dd>
              </div>
            ))}
          </dl>
          {profile.description && (
            <div className="mt-4 border-t border-slate-100 pt-3">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Description</div>
              <p className="mt-0.5 text-[13px] text-slate-700">{profile.description}</p>
            </div>
          )}
        </Card>
      )}

      {/* ---- Tab 2 · Hours -------------------------------------------------- */}
      {tab === "Hours" && (
        <Card>
          {hours === undefined && <Loading label="hours" />}
          {hours !== undefined && hours.length === 0 && (
            <div className="py-8 text-center text-sm text-slate-500">
              No hours configured yet — this shop cannot generate slots until its week is set.
            </div>
          )}
          {hours !== undefined && hours.length > 0 && (
            <div>
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    <th className="pb-2 pr-4">Day</th>
                    <th className="pb-2 pr-4">Open</th>
                    <th className="pb-2 pr-4">Close</th>
                    <th className="pb-2 pr-4">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {hours.map((h) => (
                    <tr key={h.id} className="border-b border-slate-50">
                      <td className="py-2.5 pr-4 font-medium text-slate-800">{h.dayName}</td>
                      <td className="py-2.5 pr-4 text-slate-600">{h.isClosed ? "—" : h.openTime ?? "—"}</td>
                      <td className="py-2.5 pr-4 text-slate-600">{h.isClosed ? "—" : h.closeTime ?? "—"}</td>
                      <td className="py-2.5 pr-4">
                        {h.isClosed ? (
                          <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                            Closed
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                            Open
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {hours.length < 7 && (
                <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[12px] font-medium text-amber-700">
                  Only {hours.length}/7 days configured — missing days block slot generation.
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* ---- Tab 3 · Services & Rate ---------------------------------------- */}
      {tab === "Services & Rate" && (
        <div className="space-y-4">
          <Card>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="text-xs font-medium text-slate-500">Current labor rate</div>
                <div className="text-2xl font-bold text-slate-900">
                  {currentRate !== null && currentRate !== undefined ? `$${currentRate}/hr` : "Not set"}
                </div>
                <div className="mt-1 text-[12px] text-slate-500">
                  Moves greater than ±15% require a co-signer, recorded in the audit log.
                </div>
              </div>
              {canWriteShops && (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      New rate ($/hr)
                    </span>
                    <input
                      value={rateInput}
                      onChange={(e) => setRateInput(e.target.value)}
                      inputMode="decimal"
                      placeholder={currentRate !== null && currentRate !== undefined ? String(currentRate) : "e.g. 120"}
                      className="mt-1 block w-32 rounded-lg border-[1.5px] border-slate-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500"
                    />
                  </label>
                  {bigMove && (
                    <label className="block">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-600">
                        Co-signer name (required, ±15%+)
                      </span>
                      <input
                        value={coSignName}
                        onChange={(e) => setCoSignName(e.target.value)}
                        placeholder="Second approver"
                        className="mt-1 block w-44 rounded-lg border-[1.5px] border-amber-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-amber-500"
                      />
                    </label>
                  )}
                  <button
                    onClick={openRateCeremony}
                    className="rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-blue-700"
                  >
                    Change rate
                  </button>
                </div>
              )}
            </div>
            {rateError && <div className="mt-2 text-[13px] font-medium text-red-600">{rateError}</div>}
            {!canWriteShops && (
              <div className="mt-2 text-[12px] text-slate-400">
                Your role cannot change rates (requires shops.write).
              </div>
            )}
          </Card>

          <Card>
            {servicesResult === undefined && <Loading label="services" />}
            {servicesResult !== undefined && (servicesResult === null || servicesResult.services.length === 0) && (
              <div className="py-8 text-center text-sm text-slate-500">
                No services configured for this shop yet.
              </div>
            )}
            {servicesResult != null && servicesResult.services.length > 0 && (
              <div className="space-y-5">
                {Array.from(new Set(servicesResult.services.map((s) => s.category))).map((cat) => (
                  <div key={cat}>
                    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      {cat}
                    </div>
                    <table className="w-full text-[13px]">
                      <tbody>
                        {servicesResult.services
                          .filter((s) => s.category === cat)
                          .map((s) => (
                            <tr key={s.id} className="border-b border-slate-50">
                              <td className="py-2 pr-4 font-medium text-slate-800">{s.name}</td>
                              <td className="py-2 pr-4">
                                {s.isOffered ? (
                                  <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                                    Offered
                                  </span>
                                ) : (
                                  <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                                    Not offered
                                  </span>
                                )}
                              </td>
                              <td className="py-2 pr-4 text-[12px] text-slate-500">
                                {s.defaultLaborHours !== null && currentRate != null
                                  ? `≈ $${Math.round(s.defaultLaborHours * currentRate)} labor at this rate (${s.defaultLaborHours}h)`
                                  : "—"}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                ))}
                <div className="text-[11px] font-semibold text-red-600">
                  INTERNAL ONLY — pricing construction is never exported.
                </div>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ---- Tab 4 · Mechanics ---------------------------------------------- */}
      {tab === "Mechanics" && (
        <div>
          {mechanics === undefined && (
            <Card>
              <Loading label="mechanics" />
            </Card>
          )}
          {mechanics !== undefined && mechanics.length === 0 && (
            <Card>
              <div className="py-8 text-center text-sm text-slate-500">
                No mechanics on this shop's roster yet.
              </div>
            </Card>
          )}
          {mechanics !== undefined && mechanics.length > 0 && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {mechanics.map((m) => (
                <Card key={m.id}>
                  <div className="flex items-center gap-3">
                    {m.photo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={m.photo} alt={m.name} className="h-12 w-12 rounded-full object-cover" />
                    ) : (
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-500">
                        {m.name
                          .split(" ")
                          .map((p) => p[0])
                          .slice(0, 2)
                          .join("")}
                      </div>
                    )}
                    <div>
                      <Link
                        href={`/shops/mechanics/${m.id}`}
                        className="text-[15px] font-semibold text-slate-900 hover:underline"
                      >
                        {m.name}
                      </Link>
                      <div className="text-[12px] text-slate-500">{m.title ?? profile.name}</div>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-3 text-[12px] text-slate-600">
                    <span>
                      {m.rating !== null ? `★ ${m.rating.toFixed(1)} (${m.reviewCount})` : "No reviews yet"}
                    </span>
                    {m.isActive ? (
                      <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                        Inactive
                      </span>
                    )}
                  </div>
                  {m.email && <div className="mt-1.5 text-[12px] text-slate-400">{m.email}</div>}
                  <Link
                    href={`/shops/mechanics/${m.id}`}
                    className="mt-2 inline-block text-[12px] font-medium text-blue-600 hover:underline"
                  >
                    Open mechanic →
                  </Link>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---- Tab 5 · Calendar ------------------------------------------------ */}
      {tab === "Calendar" && (
        <Card>
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                onClick={() =>
                  setWeekMonday((m) => {
                    const d = new Date(m);
                    d.setDate(d.getDate() - 7);
                    return d;
                  })
                }
                className="rounded-lg border border-slate-200 px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50"
              >
                ‹
              </button>
              <span className="text-[13px] font-medium text-slate-700">
                Week of {dates[0]} – {dates[6]}
              </span>
              <button
                onClick={() =>
                  setWeekMonday((m) => {
                    const d = new Date(m);
                    d.setDate(d.getDate() + 7);
                    return d;
                  })
                }
                className="rounded-lg border border-slate-200 px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50"
              >
                ›
              </button>
              <button
                onClick={() => setWeekMonday(mondayOf(new Date()))}
                className="ml-1 rounded-lg border border-slate-200 px-2.5 py-1 text-[12px] text-slate-500 hover:bg-slate-50"
              >
                Today
              </button>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-slate-500">
              <span className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-100 ring-1 ring-emerald-300" /> available
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-sm bg-white ring-1 ring-slate-300" /> booked
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-100 ring-1 ring-amber-300" /> blocked
              </span>
            </div>
          </div>
          <p className="mb-3 text-[11px] text-slate-400">
            Availability is derived live from shop hours minus bookings and blocks — open windows are computed, not pre-generated.
          </p>

          {calendar === undefined && <Loading label="calendar" />}
          {calendar !== undefined && calendar.mechanics.length === 0 && (
            <div className="py-8 text-center text-sm text-slate-500">
              No mechanics — no bays to schedule. Add a mechanic first.
            </div>
          )}
          {calendar !== undefined && calendar.mechanics.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    <th className="pb-2 pr-4">Day</th>
                    {calendar.mechanics.map((m) => (
                      <th key={m.id} className="pb-2 pr-4">
                        {m.name}
                        {!m.isActive && <span className="ml-1 font-normal text-slate-300">(inactive)</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dates.map((date) => (
                    <tr key={date} className="border-b border-slate-50 align-top">
                      <td className="py-2.5 pr-4 font-medium text-slate-700">
                        {new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
                          weekday: "short",
                          month: "numeric",
                          day: "numeric",
                        })}
                      </td>
                      {calendar.mechanics.map((m) => {
                        const cellSlots = calendar.slots
                          .filter((s) => s.date === date && s.mechanicId === m.id)
                          .sort((a, b) => a.start.localeCompare(b.start));
                        return (
                          <td key={m.id} className="py-2 pr-4">
                            {cellSlots.length === 0 ? (
                              <span className="text-[11px] text-slate-300">no slots</span>
                            ) : (
                              <div className="flex flex-wrap gap-1">
                                {cellSlots.map((s) => (
                                  <span
                                    key={s.id}
                                    title={`${s.start}–${s.end}${s.title ? ` · ${s.title}` : ""}${s.note ? ` · ${s.note}` : ""}`}
                                    className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ${
                                      s.state === "available"
                                        ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                                        : s.state === "blocked"
                                          ? "bg-amber-50 text-amber-700 ring-amber-200"
                                          : "bg-white text-slate-600 ring-slate-200"
                                    }`}
                                  >
                                    {/* Open windows show their range; booked/blocked show start + label. */}
                                    {s.state === "available"
                                      ? `${s.start}–${s.end}`
                                      : `${s.start} ${s.note ?? s.title ?? ""}`.trim()}
                                  </span>
                                ))}
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* ---- Tab 6 · Bookings ------------------------------------------------ */}
      {tab === "Bookings" && (
        <Card>
          {bookings === undefined && <Loading label="bookings" />}
          {bookings !== undefined && bookings.length === 0 && (
            <div className="py-8 text-center text-sm text-slate-500">
              No bookings for this shop yet.
            </div>
          )}
          {bookings !== undefined && bookings.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    <th className="pb-2 pr-4">Booking</th>
                    <th className="pb-2 pr-4">Customer</th>
                    <th className="pb-2 pr-4">Services</th>
                    <th className="pb-2 pr-4">Scheduled</th>
                    <th className="pb-2 pr-4">Status</th>
                    <th className="pb-2 pr-4">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {bookings.map((b) => (
                    <tr key={b.id} className="border-b border-slate-50 hover:bg-slate-50">
                      <td className="py-2.5 pr-4">
                        <Link
                          href={`/ops/bookings/${b.id}`}
                          className="inline-flex rounded-full bg-blue-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-blue-700 hover:bg-blue-100"
                        >
                          …{b.id.slice(-6)}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-4 text-slate-800">
                        <Link
                          href={`/ops/users/${b.user_id}`}
                          className="hover:text-blue-700 hover:underline"
                        >
                          {b.user}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-4 text-slate-600">{b.services.join(", ") || "—"}</td>
                      <td className="py-2.5 pr-4 text-slate-600">
                        {b.date ?? "—"}
                        {b.time ? ` ${b.time}` : ""}
                      </td>
                      <td className="py-2.5 pr-4">
                        <span className={pill(b.status)}>{b.status}</span>
                      </td>
                      <td className="py-2.5 pr-4 text-slate-700">
                        {b.total !== null ? `$${b.total.toFixed(2)}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-2 text-[11px] text-slate-400">
                Showing the 50 most recent. Booking detail lives in Ops — chips deep-link there.
              </div>
            </div>
          )}
        </Card>
      )}

      {/* ---- Tab 7 · Insights ----------------------------------------------- */}
      {tab === "Insights" && (
        <div className="space-y-4">
          {insights === undefined ? (
            <Loading label="insights" />
          ) : (
            <>
              {/* Quality rates */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Card>
                  <div className="text-[11px] font-medium text-slate-500">Completed</div>
                  <div className="mt-0.5 text-lg font-bold text-slate-900">{insights.stats.completed}</div>
                  <div className="text-[11px] text-slate-400">of {insights.stats.total}</div>
                </Card>
                <Card>
                  <div className="text-[11px] font-medium text-slate-500">Cancellation rate</div>
                  <div className="mt-0.5 text-lg font-bold text-slate-900">
                    {insights.stats.cancelRate != null ? `${Math.round(insights.stats.cancelRate * 100)}%` : "—"}
                  </div>
                  <div className="text-[11px] text-slate-400">{insights.stats.cancelled} cancelled</div>
                </Card>
                <Card>
                  <div className="text-[11px] font-medium text-slate-500">No-show rate</div>
                  <div className="mt-0.5 text-lg font-bold text-slate-900">
                    {insights.stats.noShowRate != null ? `${Math.round(insights.stats.noShowRate * 100)}%` : "—"}
                  </div>
                  <div className="text-[11px] text-slate-400">{insights.stats.noShow} no-shows</div>
                </Card>
                <Card>
                  <div className="text-[11px] font-medium text-slate-500">Stripe disputes</div>
                  <div className="mt-0.5 text-lg font-bold text-slate-900">{insights.stats.disputeCount}</div>
                </Card>
              </div>

              {/* Portfolio gallery */}
              {insights.portfolio.length > 0 && (
                <Card>
                  <h2 className="text-sm font-semibold text-slate-900">Portfolio ({insights.portfolio.length})</h2>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {insights.portfolio.map((p) => (
                      <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer" title={p.caption ?? undefined}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={p.url} alt={p.caption ?? "portfolio"} className="h-24 w-32 rounded-lg object-cover ring-1 ring-slate-200 hover:ring-slate-400" />
                      </a>
                    ))}
                  </div>
                </Card>
              )}

              <div className="grid gap-4 lg:grid-cols-2">
                {/* Reviews */}
                <Card>
                  <h2 className="text-sm font-semibold text-slate-900">Reviews ({insights.reviews.length})</h2>
                  {insights.reviews.length === 0 ? (
                    <p className="mt-2 text-[13px] text-slate-400">No reviews for this shop yet.</p>
                  ) : (
                    <div className="mt-3 max-h-96 space-y-2 overflow-auto">
                      {insights.reviews.map((r) => (
                        <div key={r.id} className={`border-b border-slate-50 pb-2 last:border-0 ${r.hidden ? "opacity-50" : ""}`}>
                          <div className="flex items-center gap-2">
                            <span style={{ color: "#F59E0B" }}>{"★".repeat(Math.round(r.rating))}</span>
                            {r.reviewer && (
                              <Link href={`/ops/users/${r.reviewerId}`} className="text-[12px] font-medium text-blue-600 hover:underline">
                                {r.reviewer}
                              </Link>
                            )}
                            {r.mechanic && <span className="text-[11px] text-slate-400">· {r.mechanic}</span>}
                            {r.hidden && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">hidden</span>}
                            <span className="ml-auto text-[11px] text-slate-400">
                              {new Date(r.at).toLocaleDateString()}
                            </span>
                          </div>
                          {r.comment && <p className="mt-1 text-[12px] text-slate-600">{r.comment}</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </Card>

                <div className="space-y-4">
                  {/* Rate history */}
                  <Card>
                    <h2 className="text-sm font-semibold text-slate-900">Labor-rate history</h2>
                    {insights.rateHistory.length === 0 ? (
                      <p className="mt-2 text-[13px] text-slate-400">No rate changes recorded.</p>
                    ) : (
                      <ol className="mt-3 space-y-2">
                        {insights.rateHistory.map((h, i) => (
                          <li key={i} className="text-[12px]">
                            <div className="text-slate-700">{h.detail ?? "rate changed"}</div>
                            <div className="text-[11px] text-slate-400">
                              {new Date(h.at).toLocaleString()} · {h.actor}
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </Card>

                  {/* Fixed-price overrides */}
                  <Card>
                    <h2 className="text-sm font-semibold text-slate-900">Fixed-price overrides</h2>
                    {insights.fixedPrices.length === 0 ? (
                      <p className="mt-2 text-[13px] text-slate-400">No per-service flat prices set.</p>
                    ) : (
                      <div className="mt-3 space-y-1">
                        {insights.fixedPrices.map((f, i) => (
                          <div key={i} className="flex items-center justify-between text-[12px]">
                            <span className="text-slate-700">
                              {f.service} <span className="text-slate-400">· {f.tier}</span>
                            </span>
                            <span className="font-semibold text-slate-800">${f.price.toFixed(2)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ---- Rate-change ceremony -------------------------------------------- */}
      <Ceremony
        open={rateCeremonyOpen}
        onOpenChange={setRateCeremonyOpen}
        title="Change labor rate"
        summary={
          <span>
            {profile.name}: labor rate{" "}
            <strong>{currentRate != null ? `$${currentRate}/hr` : "unset"}</strong> →{" "}
            <strong>${rateInput}/hr</strong>
            {bigMove && (
              <>
                {" "}
                — a &gt;±15% move, co-signed by <strong>{coSignName.trim()}</strong>.
              </>
            )}
          </span>
        }
        onConfirm={async (reason) => {
          await setLaborRate({
            token,
            reason,
            shopId,
            newRate: parsedRate,
            co_sign_name: bigMove ? coSignName.trim() : undefined,
          });
          setRateInput("");
          setCoSignName("");
        }}
      />

      <AuditDrawer
        open={auditOpen}
        onOpenChange={setAuditOpen}
        entityType="shops"
        entityId={shopId}
        title={`Audit — ${profile.name}`}
      />
    </div>
  );
}
