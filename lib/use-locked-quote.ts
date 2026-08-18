"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { JobActualPartPayload } from "@/lib/vehicle-passport";

/** The locked, customer-approved quote breakdown (cents) that drives the
 *  read-only post-job confirmation. Mirrors the `LockedQuote` prop shape on
 *  PostJobSurveyDialog. */
export type LockedQuoteValue = {
  partsCents: number;
  laborCents: number;
  taxCents: number;
  feeCents: number;
  totalCents: number;
  originalTotalCents: number | null;
  hasBreakdown: boolean;
};

type EffectiveQuote =
  | {
      cycle: string;
      totalCents: number;
      partsCents: number;
      laborCents: number;
      taxCents: number;
      feeCents: number;
      partsSnapshot: Array<{
        part_name: string;
        brand?: string | null;
        oem_number: string;
        cost: number;
        quantity?: number;
        supplied_by?: string;
        part_tier?: string;
        service_id?: string | null;
        source?: "catalog" | "manual";
        not_used?: boolean;
      }>;
    }
  | null
  | undefined;

/**
 * Resolves the customer-approved quote + the parts list to seed the locked
 * post-job "Confirm parts to use" dialog, from a `getJobDetail` result.
 *
 * SINGLE SOURCE OF TRUTH: both the owner's booking-detail-panel and the
 * mechanic's dashboard render the very same PostJobSurveyDialog, so they must
 * feed it identical props. This hook exists because they used to compute these
 * independently — and the mechanic dashboard simply forgot to, leaving the
 * locked confirmation to fall back to the pre-approval snapshot (stale $0 parts
 * + a $103 total instead of the agreed $726.69). Anything that needs the locked
 * quote should call this so the two surfaces can never drift again.
 *
 * `job` is the `api.bookings.getJobDetail` result (may be null/undefined while
 * the query resolves).
 */
export function useLockedQuote(job: any) {
  const bookingId = (job?._id ?? null) as Id<"bookings"> | null;

  // Brake axle scope — keeps the snapshot-seeded parts list from listing an
  // axle the customer didn't book (older snapshots could freeze front pads
  // regardless of the chosen axle).
  const brakeScope = useQuery(
    api.serviceParts.getBrakeScopeForBooking,
    bookingId ? { bookingId } : "skip",
  );

  // The effective AGREED quote — the latest customer-approved mechanic
  // adjustment with its frozen breakdown. When present it's the single source
  // of truth for the locked post-job confirmation (parts + breakdown all
  // reconcile to its total). Null when the quote was never adjusted.
  const effectiveQuote = useQuery(
    (api as any).booking_approvals.getEffectiveQuoteForBooking,
    bookingId ? { bookingId } : "skip",
  ) as EffectiveQuote;

  // Parts ACTUALLY quoted on this booking, scoped to the booked axle. Seeds the
  // pre/post-job dialogs' editable cycle — what we quoted, not the catalog's
  // broader suggestions. Null when the booking has no snapshot (walk-ins) or
  // nothing survives the axle filter, so the dialog falls back to catalog prefill.
  const scopedQuotedParts = useMemo<JobActualPartPayload[] | null>(() => {
    const snapshot = job?.pricedPartsSnapshot;
    if (!snapshot || snapshot.length === 0) return null;
    const rows: JobActualPartPayload[] = snapshot
      .filter((p: any) => {
        if (!brakeScope?.hasBrakeWork) return true;
        if (brakeScope.front && brakeScope.rear) return true;
        const n = p.part_name.toLowerCase();
        const hasFront = /\bfront\b/.test(n);
        const hasRear = /\brear\b/.test(n);
        if (hasFront && !hasRear) return brakeScope.front;
        if (hasRear && !hasFront) return brakeScope.rear;
        return true;
      })
      .map((p: any) => ({
        part_name: p.part_name,
        brand: p.brand ?? null,
        oem_number: p.oem_number,
        cost: p.unit_price_cents / 100,
        quantity: p.quantity,
        supplied_by: "shop" as const,
        part_tier: p.part_tier ?? "oem",
        service_id: p.service_id ?? null,
        source: "catalog" as const,
      }));
    return rows.length > 0 ? rows : null;
  }, [job?.pricedPartsSnapshot, brakeScope]);

  // The locked, customer-approved quote breakdown (cents). An approved mechanic
  // adjustment wins (its frozen breakdown reconciles exactly); otherwise the
  // booking's original quote. originalTotalCents is set only when an adjustment
  // moved the price, so the confirmation can show original → new.
  const lockedQuote = useMemo<LockedQuoteValue | null>(() => {
    const APPROVED = new Set([
      "pre_job_approved",
      "mid_job_approved",
      "post_job_approved",
      "captured",
    ]);
    const originalCents =
      job?.quotedSetPriceDollars != null
        ? Math.round(job.quotedSetPriceDollars * 100)
        : job?.quotedBreakdown
          ? job.quotedBreakdown.parts_cents +
            job.quotedBreakdown.labor_cents +
            job.quotedBreakdown.tax_cents +
            job.quotedBreakdown.service_fee_cents
          : null;
    // 1. Approved adjustment WITH its frozen breakdown — reconciles exactly.
    if (effectiveQuote) {
      return {
        partsCents: effectiveQuote.partsCents,
        laborCents: effectiveQuote.laborCents,
        taxCents: effectiveQuote.taxCents,
        feeCents: effectiveQuote.feeCents,
        totalCents: effectiveQuote.totalCents,
        originalTotalCents:
          originalCents != null && originalCents !== effectiveQuote.totalCents
            ? originalCents
            : null,
        hasBreakdown: true,
      };
    }
    // 2. Robust fallback — the booking row itself records an approved
    //    adjustment (mechanic_set_price_cents). Surface the NEW total +
    //    original even when the detailed breakdown query isn't available;
    //    per-line breakdown is suppressed (hasBreakdown:false) since we can't
    //    reconcile it without the frozen approval row.
    const agreedCents = job?.mechanicSetPriceCents ?? null;
    if (
      !job?.isFixedPrice &&
      agreedCents != null &&
      APPROVED.has(job?.paymentApprovalState ?? "") &&
      originalCents != null &&
      agreedCents !== originalCents
    ) {
      return {
        partsCents: 0,
        laborCents: 0,
        taxCents: 0,
        feeCents: 0,
        totalCents: agreedCents,
        originalTotalCents: originalCents,
        hasBreakdown: false,
      };
    }
    // 3. No adjustment — original quote breakdown.
    const bd = job?.quotedBreakdown;
    if (!bd) return null;
    const sumCents =
      bd.parts_cents + bd.labor_cents + bd.tax_cents + bd.service_fee_cents;
    return {
      partsCents: bd.parts_cents,
      laborCents: bd.labor_cents,
      taxCents: bd.tax_cents,
      feeCents: bd.service_fee_cents,
      totalCents: originalCents ?? sumCents,
      originalTotalCents: null,
      hasBreakdown: true,
    };
  }, [
    job?.quotedBreakdown,
    job?.quotedSetPriceDollars,
    job?.mechanicSetPriceCents,
    job?.paymentApprovalState,
    job?.isFixedPrice,
    effectiveQuote,
  ]);

  // Parts shown in the locked confirmation. When an adjustment was approved,
  // these are its frozen parts_snapshot (matches the breakdown). Otherwise the
  // booking's original priced snapshot, UNSCOPED — so the rows reconcile with
  // the quote breakdown rather than mixing a scoped subset with the full total.
  const lockedQuoteParts = useMemo<JobActualPartPayload[] | null>(() => {
    if (effectiveQuote && effectiveQuote.partsSnapshot.length > 0) {
      return effectiveQuote.partsSnapshot.map((p) => ({
        part_name: p.part_name,
        brand: p.brand ?? null,
        oem_number: p.oem_number,
        cost: p.cost,
        quantity: p.quantity,
        supplied_by: p.supplied_by === "customer" ? "customer" : "shop",
        part_tier: p.part_tier ?? "oem",
        service_id: p.service_id ?? null,
        source: p.source ?? "catalog",
        // Preserve the mechanic's prior "Not used" flag so re-opening the
        // dialog (mid-job "Add unforeseen scope") doesn't revive a dropped
        // part as an active $0 line.
        not_used: (p as { not_used?: boolean }).not_used === true ? true : undefined,
      }));
    }
    const snapshot = job?.pricedPartsSnapshot;
    if (!snapshot || snapshot.length === 0) return null;
    return snapshot.map((p: any) => ({
      part_name: p.part_name,
      brand: p.brand ?? null,
      oem_number: p.oem_number,
      cost: p.unit_price_cents / 100,
      quantity: p.quantity,
      supplied_by: "shop" as const,
      part_tier: p.part_tier ?? "oem",
      service_id: p.service_id ?? null,
      source: "catalog" as const,
      not_used: (p as { not_used?: boolean }).not_used === true ? true : undefined,
    }));
  }, [effectiveQuote, job?.pricedPartsSnapshot]);

  // Walk-in bookings have no customer-approved quote — the mechanic gives a
  // verbal quote and manages parts directly. Billing is never "locked" for
  // them; the post-job parts step stays editable and shows no catalog pre-fill.
  const isWalkIn =
    job?.source === "mechanic_walk_in" || job?.source === "mechanic_backfill";

  return {
    brakeScope,
    effectiveQuote,
    scopedQuotedParts,
    lockedQuote,
    lockedQuoteParts,
    isWalkIn,
  };
}
