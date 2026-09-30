/**
 * Every money surface renders the same statement (convex/lib/bookingMoney.ts):
 * the PDF / web receipt (#417), the phone receipt (#335), the card-hold (#331)
 * and the shop Timeline (#334) — all on the Sep 22 Jeep.
 */
import { describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { identityFor, makeT } from "./helpers";
import { seedJeepSep22 } from "./helpers/moneyFixtures";

describe("the invoice / PDF data (#417)", () => {
  it("prints the confirmed tax and fee, and labor lines that multiply out", async () => {
    const t = makeT();
    const { bookingId } = await seedJeepSep22(t, { capturedCents: 19821 });
    const data: any = await t.query(internal.invoices._assembleInvoiceData, { bookingId });
    expect(data.taxCents).toBe(1419);
    expect(data.platformFeeCents).toBe(1204);
    expect(data.totalCents).toBe(19821);
    expect(data.adjustmentCents).toBe(0);
    expect(data.serviceLines.map((s: any) => [s.name, s.minutes, s.amountCents])).toEqual([
      ["Oil Change", 28, 7000],
      ["Diagnostic Scan", 14, 3500],
    ]);
    expect(data.parts).toHaveLength(5);
    expect(data.parts.every((p: any) => p.name.trim().length > 0)).toBe(true);
    expect(data.subtotalCents + data.taxCents + data.platformFeeCents).toBe(data.totalCents);
  });

  it("an under-capture shows as an explicit adjustment, never a smaller 'tax'", async () => {
    const t = makeT();
    const { bookingId } = await seedJeepSep22(t, { capturedCents: 11177 });
    const data: any = await t.query(internal.invoices._assembleInvoiceData, { bookingId });
    expect(data.totalCents).toBe(11177);
    expect(data.taxCents).toBe(1419);
    expect(data.platformFeeCents).toBe(1204);
    expect(data.adjustmentCents).toBe(11177 - 19821);
    expect(data.subtotalCents + data.taxCents + data.platformFeeCents).toBe(11177);
  });
});

describe("the phone receipt (bookings.getReceipt)", () => {
  it("totals are the agreed statement; labor lines carry billed minutes + rate", async () => {
    const t = makeT();
    const seed = await seedJeepSep22(t, { capturedCents: 19821 });
    const r: any = await t
      .withIdentity(identityFor(seed.clerkUserId))
      .query(api.bookings.getReceipt, { bookingId: seed.bookingId });
    expect(r.totals.total).toBeCloseTo(198.21, 2);
    expect(r.totals.tax).toBeCloseTo(14.19, 2);
    expect(r.totals.platform_fee).toBeCloseTo(12.04, 2);
    expect(r.totals.labor_subtotal).toBeCloseTo(105, 2);
    expect(r.totals.parts_subtotal).toBeCloseTo(66.98, 2);
    const services = r.line_items.filter((l: any) => l.type === "service");
    expect(services.map((s: any) => s.labor_minutes)).toEqual([28, 14]);
    expect(services.map((s: any) => s.labor_cost)).toEqual([70, 35]);
    expect(r.shop.labor_rate).toBe(150);
    expect(r.payment.amount).toBeCloseTo(198.21, 2);
    const parts = r.line_items.filter((l: any) => l.type === "part");
    expect(parts).toHaveLength(5);
    expect(parts.every((p: any) => p.name.trim().length > 0)).toBe(true);
  });
});

describe("the card-hold (getReauthBreakdownForBooking)", () => {
  it("shows the agreed total and exactly what the hold will authorize", async () => {
    const t = makeT();
    const seed = await seedJeepSep22(t, { status: "in_progress", capturedCents: null });
    const r: any = await t
      .withIdentity(identityFor(seed.clerkUserId))
      .query(api.booking_approvals.getReauthBreakdownForBooking, {
        bookingId: seed.bookingId,
      });
    expect(r.source).toBe("approved");
    expect(r.cycle).toBe("mid_job");
    expect(r.totalCents).toBe(19821);
    expect(r.holdTargetCents).toBe(19821);
    expect(r.partsCents + r.laborCents + r.taxCents + r.feeCents).toBe(r.totalCents);
    expect(r.parts).toHaveLength(5);
    expect(r.parts.every((p: any) => p.part_name.trim().length > 0)).toBe(true);
  });
});

describe("the shop Timeline (#334)", () => {
  it("states a short capture against the agreed total", async () => {
    const t = makeT();
    const seed = await seedJeepSep22(t, { capturedCents: 11177 });
    const events: any[] = await t
      .withIdentity(identityFor(seed.clerkUserId))
      .query(api.booking_activity.getBookingActivityLog, { bookingId: seed.bookingId });
    const pay = events.find((e) => e.type === "payment_captured");
    expect(pay.data).toMatchObject({
      amountCents: 11177,
      agreedCents: 19821,
      shortfallCents: 8644,
      kind: "service",
      last4: "4242",
    });
  });

  it("no shortfall when the capture matches", async () => {
    const t = makeT();
    const seed = await seedJeepSep22(t, { capturedCents: 19821 });
    const events: any[] = await t
      .withIdentity(identityFor(seed.clerkUserId))
      .query(api.booking_activity.getBookingActivityLog, { bookingId: seed.bookingId });
    const pay = events.find((e) => e.type === "payment_captured");
    expect(pay.data.amountCents).toBe(19821);
    expect(pay.data.shortfallCents).toBeNull();
  });
});
