/**
 * Which approval counts as "the latest".
 *
 * `by_booking_and_cycle` is ["booking_id", "cycle"], so `.order("desc")` sorts
 * by the CYCLE STRING, not by recency:
 *
 *     "pre_job"  >  "post_job"  >  "mid_job"
 *
 * Three reads took the first row as "latest" and therefore always got the
 * PRE-JOB approval. The visible symptom: a mechanic opened "Confirm parts to
 * use" after a customer had approved extra work and saw the original two parts
 * and the original total, while the booking itself carried the higher agreed
 * figure. Two numbers for one job, with the wrong one in front of the person
 * signing it off — and the same row fed the customer's own receipt.
 */
import { describe, it, expect } from "vitest";

/** Mirrors approvalsNewestFirst in convex/booking_approvals.ts. */
function approvalsNewestFirst<
  T extends { decided_at_ms?: number; _creationTime?: number },
>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      (b.decided_at_ms ?? b._creationTime ?? 0) -
      (a.decided_at_ms ?? a._creationTime ?? 0),
  );
}

const APPROVED = new Set(["approved", "auto_approved_within_range"]);
const pickEffective = (rows: any[]) =>
  approvalsNewestFirst(rows).find(
    (r: any) =>
      APPROVED.has(r.decision ?? "") &&
      r.parts_subtotal_cents != null &&
      r.labor_cents != null,
  );

describe("effective quote ordering", () => {
  it("picks the mid-job approval over the earlier pre-job one", () => {
    // Deliberately in the order the broken index scan produced: cycle-desc
    // puts pre_job first even though mid_job was decided two hours later.
    const rows = [
      {
        cycle: "pre_job",
        decision: "approved",
        decided_at_ms: 1_000,
        parts_subtotal_cents: 6565,
        labor_cents: 15500,
      },
      {
        cycle: "mid_job",
        decision: "approved",
        decided_at_ms: 8_000,
        parts_subtotal_cents: 14565,
        labor_cents: 28417,
      },
    ];
    expect(pickEffective(rows)!.parts_subtotal_cents).toBe(14565);
  });

  it("ignores rows the customer declined or hasn't answered", () => {
    const rows = [
      {
        cycle: "mid_job",
        decision: null,
        decided_at_ms: 9_000,
        parts_subtotal_cents: 99999,
        labor_cents: 1,
      },
      {
        cycle: "mid_job",
        decision: "declined",
        decided_at_ms: 8_000,
        parts_subtotal_cents: 88888,
        labor_cents: 1,
      },
      {
        cycle: "pre_job",
        decision: "approved",
        decided_at_ms: 1_000,
        parts_subtotal_cents: 6565,
        labor_cents: 15500,
      },
    ];
    // An unanswered or refused change is not what the customer agreed to pay.
    expect(pickEffective(rows)!.parts_subtotal_cents).toBe(6565);
  });

  it("falls back to _creationTime on rows written before decided_at_ms", () => {
    const rows = [
      {
        cycle: "pre_job",
        decision: "approved",
        _creationTime: 1_000,
        parts_subtotal_cents: 6565,
        labor_cents: 15500,
      },
      {
        cycle: "mid_job",
        decision: "auto_approved_within_range",
        _creationTime: 5_000,
        parts_subtotal_cents: 14565,
        labor_cents: 28417,
      },
    ];
    expect(pickEffective(rows)!.parts_subtotal_cents).toBe(14565);
  });

  it("returns nothing when no approval was ever completed", () => {
    expect(
      pickEffective([{ cycle: "pre_job", decision: null, decided_at_ms: 1 }]),
    ).toBeUndefined();
  });
});
