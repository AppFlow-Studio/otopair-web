"use client";

/**
 * ExtraWorkStatus — the shop-side view of mid-job "extra work" requests.
 *
 * Before this, the only signal that a mechanic had added work mid-job and sent
 * it for the customer's confirmation was the booking total quietly changing.
 * This panel makes each request's state explicit — waiting on the customer,
 * approved, auto-confirmed (within the approved range), or declined/expired
 * (kept for the record, never charged) — and is rendered in both the mechanic's
 * active-job overlay (dark) and the owner's booking drawer (light).
 *
 * Data comes from `booking_approvals.getMidJobScopeChanges`, which is
 * staff-gated and returns one entry per mid-job cycle.
 */

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { CheckCircle2, Clock, Wrench, XCircle } from "lucide-react";

type Variant = "dark" | "light";

type ScopePart = {
  part_name: string;
  oem_number: string | null;
  quantity: number;
  unit_price_cents?: number | null;
  line_total_cents: number | null;
};

type ScopeChange = {
  approvalId: string;
  state: "pending" | "accepted" | "auto_confirmed" | "declined";
  addedServiceNames: string[];
  totalCents: number;
  deltaPriceCents: number;
  notes: string | null;
  sla_expires_at_ms: number | null;
  submitted_at_ms: number | null;
  decided_at_ms: number | null;
  /** Parts on the added lines — populated for every state now. Optional so a
   *  pre-deploy backend (declined-only `deniedParts`) still type-checks. */
  parts?: ScopePart[];
  partsSubtotalCents?: number;
  laborCents?: number | null;
  laborMinutes?: number | null;
  /** Back-compat: equals `parts` when declined, empty otherwise. */
  deniedParts?: ScopePart[];
};

function formatMinutes(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function money(cents: number | null | undefined) {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

/** Live-ish current time so pending SLA countdowns tick without a page refresh. */
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function formatRemaining(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "expiring now";
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 1) return `${h}h ${m}m left`;
  return `${m}m left`;
}

export default function ExtraWorkStatus({
  bookingId,
  variant = "light",
  showWhenEmpty = false,
  className = "",
}: {
  bookingId: Id<"bookings">;
  variant?: Variant;
  /** When true, render an empty-state card instead of nothing. Used in the
   *  active-job overlay so the reserved right-hand space still reads clearly. */
  showWhenEmpty?: boolean;
  className?: string;
}) {
  const changes = useQuery(api.booking_approvals.getMidJobScopeChanges, {
    bookingId,
  }) as ScopeChange[] | undefined;
  const now = useNow();

  const dark = variant === "dark";
  const cardClass = dark
    ? "rounded-2xl border border-white/10 bg-white/[0.03] p-5"
    : "rounded-2xl border border-border bg-card p-5";
  const headingClass = dark
    ? "text-xs font-semibold uppercase tracking-wider text-slate-400"
    : "text-xs font-semibold uppercase tracking-wider text-muted-foreground";
  const mutedText = dark ? "text-slate-400" : "text-muted-foreground";
  const strongText = dark ? "text-slate-100" : "text-foreground";

  if (changes === undefined) {
    if (!showWhenEmpty) return null;
    return (
      <section className={`${cardClass} ${className}`}>
        <h3 className={headingClass}>Extra work</h3>
        <p className={`mt-3 text-sm ${mutedText}`}>Loading…</p>
      </section>
    );
  }

  if (changes.length === 0) {
    if (!showWhenEmpty) return null;
    return (
      <section className={`${cardClass} ${className}`}>
        <h3 className={headingClass}>Extra work</h3>
        <p className={`mt-3 text-sm ${mutedText}`}>
          Nothing added yet. Use “Flag issue → Extra work needed now” to add work
          and send it to the customer for confirmation.
        </p>
      </section>
    );
  }

  return (
    <section className={`${cardClass} ${className}`}>
      <h3 className={headingClass}>Extra work</h3>
      <ul className="mt-3 space-y-3">
        {changes.map((c) => (
          <ExtraWorkRow key={c.approvalId} change={c} dark={dark} now={now} strongText={strongText} mutedText={mutedText} />
        ))}
      </ul>
    </section>
  );
}

function ExtraWorkRow({
  change,
  dark,
  now,
  strongText,
  mutedText,
}: {
  change: ScopeChange;
  dark: boolean;
  now: number;
  strongText: string;
  mutedText: string;
}) {
  const title =
    change.addedServiceNames.length > 0
      ? change.addedServiceNames.join(", ")
      : "Added work";
  const delta =
    change.deltaPriceCents > 0 ? `+${money(change.deltaPriceCents)}` : null;
  const declined = change.state === "declined";
  // Defensive against an older backend that predates the parts payload — falls
  // back to the legacy declined-only `deniedParts` so nothing throws mid-deploy.
  const parts = change.parts ?? change.deniedParts ?? [];
  const hasBreakdown = parts.length > 0 || change.laborCents != null;

  // Per-state chrome. Amber = waiting, green = agreed, red = declined.
  const chrome = {
    pending: {
      wrap: dark
        ? "border-amber-400/30 bg-amber-400/10"
        : "border-amber-300 bg-amber-50",
      label: dark ? "text-amber-200" : "text-amber-700",
      Icon: Clock,
      text: "Waiting for customer",
    },
    accepted: {
      wrap: dark
        ? "border-emerald-400/30 bg-emerald-400/10"
        : "border-emerald-300 bg-emerald-50",
      label: dark ? "text-emerald-200" : "text-emerald-700",
      Icon: CheckCircle2,
      text: "Customer approved",
    },
    auto_confirmed: {
      wrap: dark
        ? "border-emerald-400/20 bg-emerald-400/[0.06]"
        : "border-emerald-200 bg-emerald-50/60",
      label: dark ? "text-emerald-200/90" : "text-emerald-700",
      Icon: CheckCircle2,
      text: "Auto-confirmed (within approved range)",
    },
    declined: {
      wrap: dark ? "border-red-400/30 bg-red-400/10" : "border-red-300 bg-red-50",
      label: dark ? "text-red-200" : "text-red-700",
      Icon: XCircle,
      text: "Declined — not charged",
    },
  }[change.state];

  const Icon = chrome.Icon;

  return (
    <li className={`rounded-xl border px-4 py-3 ${chrome.wrap}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <Wrench className={`mt-0.5 h-4 w-4 shrink-0 ${mutedText}`} />
          <div className="min-w-0">
            <p className={`truncate text-sm font-semibold ${strongText}`}>
              {title}
            </p>
            <p className={`mt-0.5 inline-flex items-center gap-1.5 text-[13px] font-medium ${chrome.label}`}>
              <Icon className="h-3.5 w-3.5" />
              {chrome.text}
              {change.state === "pending" && change.sla_expires_at_ms != null ? (
                <span className={`font-normal ${mutedText}`}>
                  · {formatRemaining(change.sla_expires_at_ms, now)}
                </span>
              ) : null}
            </p>
          </div>
        </div>
        {/* When the breakdown renders it carries a contextualized "Added to
            total"; showing the same delta here too would just duplicate it. */}
        {delta && !hasBreakdown ? (
          <p className={`shrink-0 text-sm font-semibold ${strongText}`}>{delta}</p>
        ) : null}
      </div>

      {change.notes ? (
        <p className={`mt-2 text-[13px] leading-relaxed ${mutedText}`}>
          “{change.notes}”
        </p>
      ) : null}

      {hasBreakdown ? (
        <div
          className={`mt-2.5 rounded-lg border px-3 py-2.5 ${
            declined
              ? dark
                ? "border-red-400/20 bg-red-400/[0.04]"
                : "border-red-200 bg-red-50/60"
              : dark
                ? "border-white/10 bg-white/[0.02]"
                : "border-border bg-muted/40"
          }`}
        >
          <p
            className={`text-[11px] font-semibold uppercase tracking-wider ${mutedText}`}
          >
            {declined ? "Declined — would have added" : "What the customer is confirming"}
          </p>
          <ul className="mt-1.5 space-y-1">
            {parts.map((p, i) => (
              <li
                key={`${p.part_name}-${i}`}
                className={`flex items-baseline justify-between gap-3 text-[13px] ${strongText}`}
              >
                <span className={`min-w-0 truncate ${declined ? "line-through" : ""}`}>
                  {p.quantity > 1 ? `${p.quantity} × ` : ""}
                  {p.part_name}
                  {p.oem_number ? (
                    <span className={`ml-1.5 text-[11px] ${mutedText}`}>
                      {p.oem_number}
                    </span>
                  ) : null}
                </span>
                {p.line_total_cents != null ? (
                  <span
                    className={`shrink-0 tabular-nums ${mutedText} ${
                      declined ? "line-through" : ""
                    }`}
                  >
                    {money(p.line_total_cents)}
                  </span>
                ) : null}
              </li>
            ))}
            {change.laborCents != null ? (
              <li
                className={`flex items-baseline justify-between gap-3 text-[13px] ${strongText}`}
              >
                <span className={declined ? "line-through" : ""}>
                  Labor
                  {change.laborMinutes != null ? (
                    <span className={`ml-1.5 text-[11px] ${mutedText}`}>
                      {formatMinutes(change.laborMinutes)}
                    </span>
                  ) : null}
                </span>
                <span
                  className={`shrink-0 tabular-nums ${mutedText} ${
                    declined ? "line-through" : ""
                  }`}
                >
                  {money(change.laborCents)}
                </span>
              </li>
            ) : null}
          </ul>
          <div
            className={`mt-2 flex items-baseline justify-between gap-3 border-t pt-2 text-[13px] font-semibold ${
              dark ? "border-white/10" : "border-border"
            } ${strongText}`}
          >
            <span>{declined ? "Not charged" : "Added to total"}</span>
            <span className={`tabular-nums ${declined ? "line-through" : ""}`}>
              {money(
                change.deltaPriceCents > 0
                  ? change.deltaPriceCents
                  : change.totalCents,
              )}
            </span>
          </div>
        </div>
      ) : null}
    </li>
  );
}
