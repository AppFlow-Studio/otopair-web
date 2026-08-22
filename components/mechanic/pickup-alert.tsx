"use client";

/**
 * MechanicPickupAlert — the "your customer wants their car" interrupt.
 *
 * A pickup request used to reach only the front desk feed, so a mechanic
 * mid-job never saw it. This is the can't-miss counterpart to the SMS: a
 * full-screen takeover the first time each request appears, collapsing to a
 * persistent red banner (floating above the Now-Working overlay) that stays
 * until the request is answered.
 *
 * Mechanic-scoped only — `getOpenPickupRequests` already returns just the
 * caller's own cars for a mechanic; owners/front-desk keep the alert island.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Car, CheckCircle2, Loader2 } from "lucide-react";

type PickupRequest = {
  bookingId: Id<"bookings">;
  customerName: string | null;
  mechanicName: string | null;
  vehicle: string | null;
  serviceSummary: string | null;
  requestedAtMs: number;
  reason: string | null;
};

const keyOf = (r: PickupRequest) => `${String(r.bookingId)}:${r.requestedAtMs}`;

export default function MechanicPickupAlert() {
  const header = useQuery(api.bookings.getActiveJobsForHeader);
  const isMechanic = header?.kind === "mechanic";
  const requests = useQuery(
    api.bookings.getOpenPickupRequests,
    isMechanic ? {} : "skip",
  ) as PickupRequest[] | undefined;
  const respond = useMutation(api.bookings.respondToPickupRequest);

  const open = useMemo(
    () => ((requests ?? []) as PickupRequest[]).filter(Boolean),
    [requests],
  );

  // One full-screen takeover per distinct request (bookingId + requestedAtMs),
  // per session. A re-request bumps requestedAtMs → new key → re-takeover.
  const seenRef = useRef<Set<string>>(new Set());
  const [takeoverKey, setTakeoverKey] = useState<string | null>(null);
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isMechanic) return;
    const fresh = open.find((r) => !seenRef.current.has(keyOf(r)));
    if (fresh) {
      seenRef.current.add(keyOf(fresh));
      setTakeoverKey(keyOf(fresh));
    }
  }, [open, isMechanic]);

  if (typeof document === "undefined") return null;
  if (!isMechanic || open.length === 0) return null;

  const takeover = takeoverKey
    ? open.find((r) => keyOf(r) === takeoverKey) ?? null
    : null;
  // With no takeover up, the persistent banner represents the oldest open
  // request; handling it advances to the next.
  const banner = !takeover ? open[0] : null;
  const extra = open.length - 1;
  const isSubmitting = (r: PickupRequest) => submittingKey === keyOf(r);

  async function act(
    r: PickupRequest,
    response: "acknowledged" | "bringing_out",
  ) {
    const k = keyOf(r);
    setSubmittingKey(k);
    setError(null);
    try {
      await respond({ bookingId: r.bookingId, response });
      setTakeoverKey((cur) => (cur === k ? null : cur));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Couldn't send that — try again.",
      );
    } finally {
      setSubmittingKey((cur) => (cur === k ? null : cur));
    }
  }

  return createPortal(
    <>
      {takeover ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-red-950/95 px-6 text-white">
          <div className="w-full max-w-md text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-500/20 ring-1 ring-red-400/40">
              <Car className="h-8 w-8 text-red-300" />
            </div>
            <p className="mt-5 text-xs font-semibold uppercase tracking-[0.24em] text-red-300/80">
              Customer wants their car
            </p>
            <h2 className="mt-2 text-2xl font-semibold">
              {takeover.vehicle ?? "Vehicle"}
            </h2>
            <p className="mt-1 text-sm text-red-100/80">
              {takeover.customerName ?? "A customer"} is asking for it back
              {takeover.serviceSummary ? ` · ${takeover.serviceSummary}` : ""}
            </p>
            {takeover.reason ? (
              <p className="mt-3 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm text-red-100">
                “{takeover.reason}”
              </p>
            ) : null}
            {error ? <p className="mt-3 text-sm text-amber-200">{error}</p> : null}
            <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
              <button
                type="button"
                disabled={isSubmitting(takeover)}
                onClick={() => act(takeover, "bringing_out")}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-5 py-3 text-sm font-semibold text-emerald-950 transition-colors hover:bg-emerald-400 disabled:opacity-60"
              >
                {isSubmitting(takeover) ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Car className="h-4 w-4" />
                )}
                Bringing it out
              </button>
              <button
                type="button"
                disabled={isSubmitting(takeover)}
                onClick={() => act(takeover, "acknowledged")}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/20 bg-white/5 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-white/10 disabled:opacity-60"
              >
                <CheckCircle2 className="h-4 w-4" /> On it
              </button>
            </div>
            <button
              type="button"
              onClick={() => setTakeoverKey(null)}
              className="mt-4 text-xs font-medium text-red-200/70 underline-offset-2 hover:underline"
            >
              Dismiss — keep as a banner
            </button>
          </div>
        </div>
      ) : banner ? (
        <div className="fixed left-1/2 top-4 z-[70] w-[min(92vw,30rem)] -translate-x-1/2">
          <div className="flex items-start gap-3 rounded-2xl border border-red-400/40 bg-red-600 px-4 py-3 text-white shadow-xl shadow-red-900/30">
            <span className="mt-0.5 inline-flex h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-white" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                Customer wants their car
                {extra > 0 ? ` · +${extra} more` : ""}
              </p>
              <p className="truncate text-xs text-red-50/90">
                {banner.vehicle ?? "Vehicle"}
                {banner.customerName ? ` · ${banner.customerName}` : ""}
              </p>
              {error ? (
                <p className="mt-1 text-xs text-amber-100">{error}</p>
              ) : null}
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={isSubmitting(banner)}
                  onClick={() => act(banner, "bringing_out")}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50 disabled:opacity-60"
                >
                  {isSubmitting(banner) ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Car className="h-3.5 w-3.5" />
                  )}
                  Bringing it out
                </button>
                <button
                  type="button"
                  disabled={isSubmitting(banner)}
                  onClick={() => act(banner, "acknowledged")}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/40 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-white/10 disabled:opacity-60"
                >
                  On it
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>,
    document.body,
  );
}
