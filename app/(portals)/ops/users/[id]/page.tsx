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

const TABS = ["Profile", "Engagement", "Garage", "Bookings", "Money", "Footprint"] as const;
type Tab = (typeof TABS)[number];

// Human labels for raw auth-provider / acquisition-source strings (mirrors
// the users list). Keeps ops from staring at "oauth_google".
const PROVIDER_LABEL: Record<string, string> = {
  password: "Email + password",
  oauth_google: "Google",
  google: "Google",
  oauth_apple: "Apple",
  apple: "Apple",
  phone: "Phone",
};
const SOURCE_LABEL: Record<string, string> = {
  shop_portal_web: "Shop portal (web)",
  web_signup: "Web signup",
  ios_app: "iOS app",
  android_app: "Android app",
  referral: "Referral",
};
function providerLabel(p: string | null): string {
  if (!p) return "Unknown";
  return PROVIDER_LABEL[p] ?? p.replace(/_/g, " ");
}
function sourceLabel(s: string | null): string {
  if (!s) return "Unknown / direct";
  return SOURCE_LABEL[s] ?? s.replace(/_/g, " ");
}

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
        {tab === "Engagement" && <EngagementTab userId={userId} />}
        {tab === "Garage" && <GarageTab userId={userId} />}
        {tab === "Bookings" && <BookingsTab userId={userId} />}
        {tab === "Money" && <MoneyTab userId={userId} />}
        {tab === "Footprint" && <FootprintTab userId={userId} />}
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
          <Field label="Auth provider" value={providerLabel(profile.authProvider)} />
          <Field label="Acquisition source" value={sourceLabel(profile.acquisitionSource)} />
          <Field label="Role" value={profile.role} />
          <Field label="Language" value={profile.language ?? "—"} />
          <Field label="Units" value={profile.units ?? "—"} />
          <Field label="Created" value={fmtDate(profile.created)} />
          <Field label="Last active" value={fmtDate(profile.lastUpdated)} />
          {profile.walkInClaimedAt != null && (
            <Field label="Walk-in claimed" value={fmtDate(profile.walkInClaimedAt)} />
          )}
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
              <Link href="/ops/deletion-queue" className="underline">Deletion Queue</Link>.
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
// Recent Oto conversations — vehicle + what Oto did + booking outcome. Reuses
// the shared summarizer so this matches /ops/oto-ai exactly.
// ---------------------------------------------------------------------------
function OtoActivityCard({ userId }: { userId: Id<"users"> }) {
  const { token } = usePortalSession();
  const convos: FunctionReturnType<typeof api.opsUsers.otoConversations> | undefined =
    useQuery(api.opsUsers.otoConversations, { token, id: userId });

  if (convos === undefined)
    return <div className="py-6 text-center text-sm text-slate-400">Loading Oto activity…</div>;
  if (convos.length === 0)
    return <div className="py-6 text-center text-sm text-slate-400">No Oto conversations yet.</div>;

  return (
    <div className="mt-3 space-y-2">
      {convos.map((c) => (
        <div key={c.id} className="rounded-lg border border-slate-100 p-3">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-slate-500">
            <span className="font-medium text-slate-700">{c.vehicleYmm ?? "Vehicle —"}</span>
            <span>{fmtDate(c.started_at)}</span>
            {c.mood && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
                {c.mood}
              </span>
            )}
            {c.message_count != null && <span>{c.message_count} msgs</span>}
            {c.bookingOutcome.state === "created" && (
              <Link
                href={`/ops/bookings/${c.bookingOutcome.bookingId}`}
                className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 hover:underline"
              >
                → booking · {c.bookingOutcome.status.replace(/_/g, " ")}
              </Link>
            )}
            {c.bookingOutcome.state === "not_created" && (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                booking mentioned, none created
              </span>
            )}
          </div>
          {c.actions.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {c.actions.map((a, i) => (
                <li key={i} className="text-[12px] text-slate-600">
                  <span className="font-medium">{a.label}</span>
                  {a.detail ? <span className="text-slate-400"> — {a.detail}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Engagement tab — acquisition/referral attribution + notification prefs.
// ---------------------------------------------------------------------------
function EngagementTab({ userId }: { userId: Id<"users"> }) {
  const { token } = usePortalSession();
  const data: FunctionReturnType<typeof api.opsUsers.engagement> | undefined =
    useQuery(api.opsUsers.engagement, { token, id: userId });

  if (data === undefined)
    return <div className="py-10 text-center text-sm text-slate-400">Loading engagement…</div>;
  if (data === null)
    return <div className="py-10 text-center text-sm text-slate-400">User not found.</div>;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Recent Oto conversations — what Oto did + booking outcomes. */}
      <div className={`${CARD} lg:col-span-2`}>
        <h2 className="text-sm font-semibold text-slate-900">Recent Oto conversations</h2>
        <OtoActivityCard userId={userId} />
      </div>

      {/* Acquisition */}
      <div className={CARD}>
        <h2 className="text-sm font-semibold text-slate-900">Acquisition</h2>
        <div className="mt-4 grid grid-cols-2 gap-4">
          <Field label="Auth provider" value={providerLabel(data.authProvider)} />
          <Field label="Source" value={sourceLabel(data.acquisitionSource)} />
          {data.walkInClaimedAt != null && (
            <Field label="Walk-in claimed" value={fmtDate(data.walkInClaimedAt)} />
          )}
        </div>

        <div className="mt-5 border-t border-slate-100 pt-4">
          <div className="text-xs font-medium text-slate-500">Referred by</div>
          {data.referredBy ? (
            <div className="mt-1 text-[13px] text-slate-800">
              {data.referredBy.referrerId ? (
                <Link
                  href={`/ops/users/${data.referredBy.referrerId}`}
                  className="font-medium text-blue-600 hover:underline"
                >
                  {data.referredBy.referrerName ?? "Unknown referrer"}
                </Link>
              ) : (
                <span className="font-medium">{data.referredBy.referrerName ?? "Unknown referrer"}</span>
              )}
              <span className="ml-2">
                <span className={statusPill(data.referredBy.status)}>{data.referredBy.status}</span>
              </span>
              <div className="mt-0.5 text-[12px] text-slate-400">
                {data.referredBy.code ? `code ${data.referredBy.code} · ` : ""}
                {fmtDate(data.referredBy.createdAt)}
                {data.referredBy.creditedAt ? ` · credited ${fmtDate(data.referredBy.creditedAt)}` : ""}
              </div>
            </div>
          ) : (
            <div className="mt-1 text-[13px] text-slate-500">Not referred (direct signup).</div>
          )}
        </div>

        <div className="mt-4 border-t border-slate-100 pt-4">
          <div className="text-xs font-medium text-slate-500">Referrals made</div>
          <div className="mt-1 flex items-center gap-3 text-[13px]">
            <span className="font-semibold text-slate-900">{data.referralsMade.total}</span>
            <span className="text-slate-400">total</span>
            {data.referralsMade.credited > 0 && (
              <span className={`${PILL} bg-emerald-50 text-emerald-700`}>
                {data.referralsMade.credited} credited
              </span>
            )}
            {data.referralsMade.pending > 0 && (
              <span className={`${PILL} bg-amber-50 text-amber-700`}>
                {data.referralsMade.pending} pending
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Notifications */}
      <div className={CARD}>
        <h2 className="text-sm font-semibold text-slate-900">Notifications &amp; preferences</h2>
        <div className="mt-4 flex items-center gap-2">
          <span
            className={
              data.pushRegistered
                ? `${PILL} bg-emerald-50 text-emerald-700`
                : `${PILL} bg-slate-100 text-slate-500`
            }
          >
            {data.pushRegistered ? "Push registered" : "No push token"}
          </span>
          {data.pushTokenUpdatedAt != null && (
            <span className="text-[12px] text-slate-400">
              updated {fmtDate(data.pushTokenUpdatedAt)}
            </span>
          )}
        </div>

        <div className="mt-4 border-t border-slate-100 pt-4">
          {!data.notifications.hasPreferencesRow ? (
            <p className="text-[13px] text-slate-500">
              No preferences row — user hasn’t customized notifications (platform defaults apply).
            </p>
          ) : data.notifications.entries.length === 0 ? (
            <p className="text-[13px] text-slate-500">Preferences row exists but is empty.</p>
          ) : (
            <ul className="space-y-1.5">
              {data.notifications.entries.map((e) => (
                <li key={e.key} className="flex items-center justify-between text-[13px]">
                  <span className="text-slate-600">{e.key.replace(/_/g, " ")}</span>
                  {e.enabled != null ? (
                    <span
                      className={
                        e.enabled
                          ? `${PILL} bg-emerald-50 text-emerald-700`
                          : `${PILL} bg-slate-100 text-slate-500`
                      }
                    >
                      {e.enabled ? "On" : "Off"}
                    </span>
                  ) : (
                    <span className="text-slate-500">{e.value ?? "—"}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Saved addresses */}
      <div className={CARD}>
        <h2 className="text-sm font-semibold text-slate-900">Saved addresses</h2>
        {data.savedAddresses.length === 0 ? (
          <p className="mt-2 text-[13px] text-slate-500">No saved addresses.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {data.savedAddresses.map((a) => (
              <li key={a.id} className="text-[13px]">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-800">{a.label}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{a.type}</span>
                  {a.isPrimary && <span className={`${PILL} bg-emerald-50 text-emerald-700`}>primary</span>}
                </div>
                <div className="text-[12px] text-slate-500">{a.address}</div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Mechanic preferences + onboarding */}
      <div className={CARD}>
        <h2 className="text-sm font-semibold text-slate-900">Preferences</h2>
        <div className="mt-3 space-y-3">
          <div>
            <div className="text-xs font-medium text-slate-500">Mechanic preferences</div>
            {data.mechanicPreferences.length === 0 ? (
              <p className="mt-1 text-[13px] text-slate-500">None set.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {data.mechanicPreferences.map((m) => (
                  <li key={m.id} className="flex items-center gap-2 text-[13px]">
                    {m.mechanic && m.mechanicId ? (
                      <Link href={`/shops/mechanics/${m.mechanicId}`} className="text-blue-600 hover:underline">
                        {m.mechanic}
                      </Link>
                    ) : (
                      <span className="text-slate-700">{m.mechanic ?? "Unknown mechanic"}</span>
                    )}
                    {m.isFavorite && <span className={`${PILL} bg-amber-50 text-amber-700`}>★ favorite</span>}
                    {m.isHidden && <span className={`${PILL} bg-slate-100 text-slate-500`}>hidden</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="border-t border-slate-100 pt-3">
            <div className="text-xs font-medium text-slate-500">Onboarding</div>
            {data.onboarding ? (
              <div className="mt-1 text-[13px] text-slate-700">
                {data.onboarding.carKnowledgeLevel && (
                  <span className="mr-2">Car knowledge: <span className="font-medium">{data.onboarding.carKnowledgeLevel}</span></span>
                )}
                {data.onboarding.hasAnswers && <span className={`${PILL} bg-slate-100 text-slate-600`}>Q&amp;A on file</span>}
                {data.onboarding.hasIntentions && <span className={`${PILL} ml-1 bg-slate-100 text-slate-600`}>intent captured</span>}
                {data.onboarding.lastUpdated && (
                  <div className="mt-0.5 text-[11px] text-slate-400">updated {fmtDate(data.onboarding.lastUpdated)}</div>
                )}
              </div>
            ) : (
              <p className="mt-1 text-[13px] text-slate-500">No onboarding answers on file.</p>
            )}
          </div>
        </div>
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
      <VehicleRecordsPanel userId={userId} ownerId={v.ownerId} vin={v.vin} />
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

// Per-vehicle "records & history" — lazy-loaded on expand. Surfaces the
// maintenance / odometer / documents / inspections / health / classification /
// driving-profile / service-state / check-in data that was previously dark.
function VehicleRecordsPanel({
  userId,
  ownerId,
  vin,
}: {
  userId: Id<"users">;
  ownerId: Id<"vehicle_owners">;
  vin: string;
}) {
  const { token } = usePortalSession();
  const [open, setOpen] = useState(false);
  const data = useQuery(
    api.opsUsers.vehicleRecords,
    open ? { token, userId, ownerId, vin } : "skip",
  );

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-[12px] font-medium text-blue-600 hover:underline"
      >
        {open ? "▾ Hide records & history" : "▸ Records & history"}
      </button>
      {open && (
        <div className="mt-3">
          {data === undefined ? (
            <div className="h-16 animate-pulse rounded bg-slate-100" />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {/* Classification + driving profile */}
              {(data.classification || data.drivingProfile || data.healthPoints) && (
                <div className="rounded-lg bg-slate-50 p-3 text-[12px]">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Profile</div>
                  <div className="mt-1 space-y-0.5 text-slate-600">
                    {data.classification && (
                      <div>Mode: <span className="text-slate-800">{data.classification.vehicleMode}</span>{data.classification.ownerSegment ? ` · ${data.classification.ownerSegment}` : ""}{data.classification.annualMileage != null ? ` · ~${data.classification.annualMileage.toLocaleString()} mi/yr` : ""}</div>
                    )}
                    {data.drivingProfile && (
                      <div>{[data.drivingProfile.usagePattern, data.drivingProfile.annualMileageBand, data.drivingProfile.ownershipDuration].filter(Boolean).join(" · ") || "—"}</div>
                    )}
                    {data.healthPoints && <div>Health points: <span className="text-slate-800">{data.healthPoints.points}</span></div>}
                  </div>
                </div>
              )}

              {/* Maintenance records */}
              <div className="rounded-lg bg-slate-50 p-3 text-[12px]">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Maintenance ({data.maintenance.length})</div>
                {data.maintenance.length === 0 ? (
                  <p className="mt-1 text-slate-400">No records.</p>
                ) : (
                  <ul className="mt-1 space-y-0.5 text-slate-600">
                    {data.maintenance.slice(0, 6).map((m) => (
                      <li key={m.id}>
                        {m.type.replace(/_/g, " ")}
                        {m.lastServiceMileage != null ? ` · ${m.lastServiceMileage.toLocaleString()} mi` : ""}
                        {m.lastServiceDate ? ` · ${m.lastServiceDate}` : ""}
                        {m.confidence ? ` (${m.confidence})` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Odometer */}
              <div className="rounded-lg bg-slate-50 p-3 text-[12px]">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Odometer ({data.odometer.length})</div>
                {data.odometer.length === 0 ? (
                  <p className="mt-1 text-slate-400">No readings.</p>
                ) : (
                  <ul className="mt-1 space-y-0.5 text-slate-600">
                    {data.odometer.slice(0, 5).map((o) => (
                      <li key={o.id}>{o.distance.toLocaleString()} {o.unit} · {fmtDate(o.recordedAt)}</li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Documents */}
              <div className="rounded-lg bg-slate-50 p-3 text-[12px]">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Documents ({data.documents.length})</div>
                {data.documents.length === 0 ? (
                  <p className="mt-1 text-slate-400">No documents.</p>
                ) : (
                  <ul className="mt-1 space-y-0.5">
                    {data.documents.map((d) => (
                      <li key={d.id}>
                        {d.url ? (
                          <a href={d.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{d.filename}</a>
                        ) : (
                          <span className="text-slate-600">{d.filename}</span>
                        )}
                        <span className="text-slate-400"> · {d.source.replace(/_/g, " ")} · {d.parseStatus}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Inspections */}
              <div className="rounded-lg bg-slate-50 p-3 text-[12px]">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Inspections ({data.inspections.length})</div>
                {data.inspections.length === 0 ? (
                  <p className="mt-1 text-slate-400">No inspections.</p>
                ) : (
                  <ul className="mt-1 space-y-0.5 text-slate-600">
                    {data.inspections.slice(0, 6).map((i) => (
                      <li key={i.id}>
                        <Link href={`/ops/bookings/${i.bookingId}`} className="text-blue-600 hover:underline">{fmtDate(i.createdAt)}</Link>
                        <span className="text-slate-400"> · {i.attention} attention · {i.monitor} monitor</span>
                        {i.pdfUrl && <a href={i.pdfUrl} target="_blank" rel="noopener noreferrer" className="ml-1 text-blue-600 hover:underline">PDF</a>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Service states (due) */}
              <div className="rounded-lg bg-slate-50 p-3 text-[12px]">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Service states ({data.serviceStates.length})</div>
                {data.serviceStates.length === 0 ? (
                  <p className="mt-1 text-slate-400">None surfaced.</p>
                ) : (
                  <ul className="mt-1 space-y-0.5 text-slate-600">
                    {data.serviceStates.slice(0, 8).map((s, i) => (
                      <li key={i}>
                        {s.service}
                        {s.urgency ? ` · ${s.urgency}` : ""}
                        {s.dueAtMileage != null ? ` · due ${s.dueAtMileage.toLocaleString()} mi` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Check-ins */}
              <div className="rounded-lg bg-slate-50 p-3 text-[12px]">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Check-ins ({data.checkins.length})</div>
                {data.checkins.length === 0 ? (
                  <p className="mt-1 text-slate-400">No check-ins.</p>
                ) : (
                  <ul className="mt-1 space-y-0.5 text-slate-600">
                    {data.checkins.slice(0, 5).map((c) => (
                      <li key={c.id}>
                        {c.completedAt ? fmtDate(c.completedAt) : "in progress"}
                        {c.mileageReported != null ? ` · ${c.mileageReported.toLocaleString()} mi` : ""}
                        {c.symptoms ? ` · "${c.symptoms.slice(0, 40)}"` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
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
                {["Status", "Shop", "Vehicle", "Services", "Scheduled", "Created", "Total", ""].map((h, i) => (
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
                  <td className="py-2.5 pr-4 text-slate-600">{b.vehicleYmm ?? "—"}</td>
                  <td className="py-2.5 pr-4 text-slate-600">
                    {b.services.length > 0 ? b.services.join(", ") : "—"}
                  </td>
                  <td className="py-2.5 pr-4 text-slate-500">{b.scheduledDate ?? "—"}</td>
                  <td className="py-2.5 pr-4 text-slate-500">{fmtDate(b.created)}</td>
                  <td className="py-2.5 pr-4 tabular-nums text-slate-700">
                    {fmtMoney(b.total)}
                    {(b.laborCost != null || b.partsCost != null) && (
                      <div className="text-[11px] font-normal text-slate-400">
                        {[
                          b.laborCost != null ? `Labor ${fmtMoney(b.laborCost)}` : null,
                          b.partsCost != null ? `Parts ${fmtMoney(b.partsCost)}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    )}
                  </td>
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
      {/* Spend rollups */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className={CARD}>
          <div className="text-[11px] font-medium text-slate-500">Captured (lifetime)</div>
          <div className="mt-0.5 text-lg font-bold text-slate-900">{fmtMoney(data.rollups.capturedTotal)}</div>
        </div>
        <div className={CARD}>
          <div className="text-[11px] font-medium text-slate-500">Avg ticket</div>
          <div className="mt-0.5 text-lg font-bold text-slate-900">{fmtMoney(data.rollups.avgTicket)}</div>
        </div>
        <div className={CARD}>
          <div className="text-[11px] font-medium text-slate-500">Payments</div>
          <div className="mt-0.5 text-lg font-bold text-slate-900">{data.rollups.paymentCount}</div>
        </div>
        <div className={CARD}>
          <div className="text-[11px] font-medium text-slate-500">Refunded</div>
          <div className="mt-0.5 text-lg font-bold text-slate-900">
            {fmtMoney(data.rollups.refundTotal)}
            {data.rollups.refundRate != null && data.rollups.refundRate > 0 && (
              <span className="ml-1 text-[11px] font-normal text-red-500">
                {Math.round(data.rollups.refundRate * 100)}%
              </span>
            )}
          </div>
        </div>
      </div>

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

      {/* Loyalty / ownership-credit ledger */}
      <div className={CARD}>
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Loyalty credits</h2>
          <span className="text-[13px] font-semibold text-slate-800">
            Balance {fmtMoney(data.creditBalance)}
          </span>
        </div>
        {data.credits.length === 0 ? (
          <div className="py-4 text-center text-sm text-slate-400">No credit transactions.</div>
        ) : (
          <div className="mt-3">
            {data.credits.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 border-b border-slate-50 py-2 last:border-0">
                <div className="min-w-0">
                  <div className="truncate text-[13px] text-slate-800">{c.description ?? c.type.replace(/_/g, " ")}</div>
                  <div className="text-[11px] text-slate-400">
                    {fmtDate(c.created)} · {c.type.replace(/_/g, " ")}
                    {c.expiresAt ? ` · expires ${fmtDate(c.expiresAt)}` : ""}
                  </div>
                </div>
                <div className={`shrink-0 tabular-nums text-[13px] font-semibold ${c.amount < 0 ? "text-red-600" : "text-emerald-600"}`}>
                  {c.amount < 0 ? "−" : "+"}{fmtMoney(Math.abs(c.amount))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Footprint tab — reviews written + disputes filed by this user.
// ---------------------------------------------------------------------------
function FootprintTab({ userId }: { userId: Id<"users"> }) {
  const { token } = usePortalSession();
  const data: FunctionReturnType<typeof api.opsUsers.footprint> | undefined =
    useQuery(api.opsUsers.footprint, { token, id: userId });

  if (data === undefined) return <div className="py-10 text-center text-sm text-slate-400">Loading footprint…</div>;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className={CARD}>
        <h2 className="text-sm font-semibold text-slate-900">Reviews written ({data.reviews.length})</h2>
        {data.reviews.length === 0 ? (
          <p className="mt-2 text-[13px] text-slate-400">This user hasn’t written any reviews.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {data.reviews.map((r) => (
              <div key={r.id} className="border-b border-slate-50 pb-2 last:border-0">
                <div className="flex items-center gap-2">
                  <span style={{ color: "#F59E0B" }}>{"★".repeat(Math.round(r.rating))}</span>
                  {r.shop && r.shopId && (
                    <Link href={`/shops/all/${r.shopId}`} className="text-[12px] font-medium text-blue-600 hover:underline">
                      {r.shop}
                    </Link>
                  )}
                  {r.hidden && <span className={`${PILL} bg-slate-100 text-slate-500`}>hidden</span>}
                  <span className="ml-auto text-[11px] text-slate-400">{fmtDate(r.at)}</span>
                </div>
                {r.comment && <p className="mt-1 text-[12px] text-slate-600">{r.comment}</p>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={CARD}>
        <h2 className="text-sm font-semibold text-slate-900">Disputes filed ({data.disputes.length})</h2>
        {data.disputes.length === 0 ? (
          <p className="mt-2 text-[13px] text-slate-400">No disputes filed by this user.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {data.disputes.map((d) => (
              <div key={d.id} className="rounded-lg border border-red-100 bg-red-50/40 p-3 text-[12px]">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-800">{d.reason.replace(/_/g, " ")}</span>
                  <span className={statusPill(d.status)}>{d.status.replace(/_/g, " ")}</span>
                </div>
                <div className="mt-1 text-[11px] text-slate-400">
                  filed {fmtDate(d.filedAt)}
                  {d.resolvedAt && ` · resolved ${fmtDate(d.resolvedAt)}`}
                  {d.resolution && ` · ${d.resolution.replace(/_/g, " ")}`}
                  {d.refund != null && ` · refund ${fmtMoney(d.refund)}`}
                </div>
                <Link href={`/ops/bookings/${d.bookingId}`} className="mt-1 inline-block text-[12px] font-medium text-blue-600 hover:underline">
                  booking →
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
