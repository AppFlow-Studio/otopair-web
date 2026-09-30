/**
 * The canonical money statement (convex/lib/bookingMoney.ts).
 *
 * Fixtures are the tester bookings from the bug tracker, with their real
 * numbers: the Sep 22 Jeep job (#334/#335/#350/#331), the Sep 27 brake job
 * (#417), Anesa's fixed-price Tire Rotation (#390) and the tire quote (#445).
 */
import { describe, expect, it } from "vitest";
import {
  buildBookingMoney,
  decomposeAllInCents,
  quoteAllInCents,
  quoteResponsePartLines,
  selectAgreedApproval,
  shopLineAllInCents,
  splitByWeights,
  storedMoneyForCreate,
  type BookingMoney,
  type MoneyInputs,
} from "../convex/lib/bookingMoney";
import { serviceMatchKey } from "../convex/lib/serviceMatch";

const HOUSTON = { state: "TX", zip: "77002", labor_rate: 150 };

function expectInvariants(m: BookingMoney) {
  const lines =
    m.parts.reduce((s, p) => s + p.lineCents, 0) +
    m.services.reduce((s, l) => s + l.amountCents, 0);
  expect(lines + m.totals.adjustmentCents).toBe(m.totals.subtotalCents);
  expect(m.totals.subtotalCents + m.totals.taxCents + m.totals.feeCents).toBe(
    m.totals.totalCents,
  );
  expect(m.counts.parts).toBe(m.parts.length + m.setPriceParts.length);
  expect(m.counts.services).toBe(m.services.length);
  for (const p of m.parts) expect(p.name.trim().length).toBeGreaterThan(0);
}

function inputs(over: Partial<MoneyInputs>): MoneyInputs {
  return {
    booking: {},
    approvals: [],
    customJobs: [],
    payments: [],
    shop: HOUSTON,
    baseServices: [],
    quote: null,
    ...over,
  };
}

// The Sep 22 Jeep Cherokee: booked at $163.61, pre-job estimate $111.76
// (auto-approved), then a Diagnostic Scan added mid-job and approved at $198.21.
function jeepSep22(): MoneyInputs {
  return inputs({
    booking: {
      _id: "b1",
      service_ids: ["oil"],
      custom_services: [{ name: "Diagnostic Scan", duration_minutes: 12 }],
      quoted_set_price_cents: 16361,
      created_at: 100,
      // Written at REQUEST time — must not drive anything.
      mechanic_set_price_cents: 19821,
      running_approved_ceiling_cents: 19821,
    },
    baseServices: [{ serviceId: "oil", name: "Oil Change", catalogHours: 0.5 }],
    customJobs: [
      {
        _id: "diag1",
        name: "Diagnostic Scan",
        match_key: serviceMatchKey("Diagnostic Scan"),
        status: "planned",
        created_at: 1500,
      },
    ],
    approvals: [
      {
        _id: "pre",
        cycle: "pre_job",
        decision: "auto_approved_within_range",
        decided_at_ms: 1000,
        submitted_at_ms: 1000,
        mechanic_set_price_cents: 11176,
        parts_subtotal_cents: 6697,
        labor_cents: 3000,
        tax_cents: 800,
        service_fee_cents: 679,
        labor_hours: 0.2,
        labor_rate_cents: 15000,
        parts_snapshot: [
          { part_name: "Engine Oil", oem_number: "5166241PC", cost: 10.72, quantity: 5 },
          { part_name: "Oil Filter", oem_number: "04892339BE", cost: 9.36, quantity: 1 },
          { part_name: "Drain-plug crush washer", oem_number: "X", cost: 4.0, quantity: 1 },
          { part_name: "test part", oem_number: "", cost: 0.01, quantity: 1 },
        ],
      },
      {
        _id: "mid",
        cycle: "mid_job",
        decision: "approved",
        decided_at_ms: 2000,
        submitted_at_ms: 1900,
        mechanic_set_price_cents: 19821,
        parts_subtotal_cents: 6698,
        labor_cents: 10500,
        tax_cents: 1419,
        service_fee_cents: 1204,
        labor_hours: 0.7,
        labor_rate_cents: 15000,
        // The per-line split the dialog sent sums to 0.6h, not the 0.7h billed.
        labor_allocations: [
          { line_key: "svc:oil", hours: 0.4 },
          { line_key: "job:diag1", hours: 0.2 },
        ],
        parts_snapshot: [
          { part_name: "Engine Oil", oem_number: "5166241PC", cost: 10.72, quantity: 5 },
          { part_name: "Oil Filter", oem_number: "04892339BE", cost: 9.36, quantity: 1 },
          { part_name: "Drain-plug crush washer", oem_number: "X", cost: 4.0, quantity: 1 },
          { part_name: "test part", oem_number: "", cost: 0.01, quantity: 1 },
          { part_name: "test part 2", oem_number: "", cost: 0.01, quantity: 1, custom_service_name: "Diagnostic Scan" },
        ],
      },
    ],
    payments: [
      {
        created_at: 50,
        status: "completed",
        amount: 163.61,
        hold_amount_cents: 2000,
        incremented_total_cents: 19821,
        captured_amount_cents: 11177,
        captured_at_ms: 3000,
        card_brand: "visa",
        card_last4: "4242",
      },
    ],
  });
}

describe("selectAgreedApproval", () => {
  it("picks the newest AGREED row by decision time, not the cycle string", () => {
    const rows = [
      { cycle: "pre_job", decision: "auto_approved_within_range", decided_at_ms: 1000 },
      { cycle: "mid_job", decision: "approved", decided_at_ms: 2000 },
    ];
    expect(selectAgreedApproval(rows)?.cycle).toBe("mid_job");
  });

  it("ignores declined, expired, withdrawn and open rows", () => {
    const rows = [
      { cycle: "pre_job", decision: "approved", decided_at_ms: 1000 },
      { cycle: "mid_job", decision: "declined", decided_at_ms: 2000 },
      { cycle: "mid_job", decision: "sla_expired", decided_at_ms: 3000 },
      { cycle: "mid_job", decision: null, decided_at_ms: 4000 },
    ];
    expect(selectAgreedApproval(rows)?.decided_at_ms).toBe(1000);
  });
});

describe("the Sep 22 Jeep (#334 / #335 / #350 / #331)", () => {
  const m = buildBookingMoney(jeepSep22());

  it("the agreed total is the mid-job $198.21, not the pre-job $111.76", () => {
    expect(m.basis).toBe("approval");
    expect(m.agreedCycle).toBe("mid_job");
    expect(m.totals.totalCents).toBe(19821);
    expect(m.totals.taxCents).toBe(1419);
    expect(m.totals.feeCents).toBe(1204);
    expectInvariants(m);
  });

  it("labor lines add up to the billed 0.70h at the billed rate (#335)", () => {
    const labor = m.services.filter((s) => s.kind === "labor");
    expect(labor.map((l) => l.name)).toEqual(["Oil Change", "Diagnostic Scan"]);
    expect(labor.map((l) => l.minutes)).toEqual([28, 14]);
    expect(labor.map((l) => l.laborCents)).toEqual([7000, 3500]);
    expect(labor.every((l) => l.rateCents === 15000)).toBe(true);
    // minutes × rate reproduces every line
    for (const l of labor) {
      expect(Math.round((l.minutes! * l.rateCents!) / 60)).toBe(l.laborCents);
    }
    expect(m.totals.laborMinutes).toBe(42);
  });

  it("the 'before' is the last confirmed $111.76, the original quote stays labelled (#350)", () => {
    expect(m.previousAgreedTotalCents).toBe(11176);
    expect(m.previousAgreedKind).toBe("pre_job");
    expect(m.originalQuoteCents).toBe(16361);
    expect(m.history.map((h) => h.totalCents)).toEqual([16361, 11176, 19821]);
  });

  it("the part count is the billed lines, every line named (#331)", () => {
    expect(m.counts.parts).toBe(5);
    expect(m.totals.partsCents).toBe(6698);
  });

  it("reports what was actually captured, separately from the agreed total", () => {
    expect(m.payment.capturedCents).toBe(11177);
    expect(m.payment.cardLast4).toBe("4242");
    expect(m.holdTargetCents).toBe(19821);
  });
});

describe("#417 — tax and fee survive exactly as confirmed", () => {
  it("the Sep 27 brake job keeps tax $28.72 / fee $24.37", () => {
    const m = buildBookingMoney(
      inputs({
        booking: { service_ids: ["brake", "rot"] },
        baseServices: [
          { serviceId: "brake", name: "Brake Pad Replacement", catalogHours: 1.5 },
          { serviceId: "rot", name: "Tire Rotation", catalogHours: 0.4 },
        ],
        approvals: [
          {
            cycle: "pre_job",
            decision: "approved",
            decided_at_ms: 10,
            submitted_at_ms: 10,
            mechanic_set_price_cents: 40127,
            parts_subtotal_cents: 10818,
            labor_cents: 24000,
            tax_cents: 2872,
            service_fee_cents: 2437,
            labor_hours: 1.6,
            labor_rate_cents: 15000,
            labor_allocations: [
              { line_key: "svc:brake", hours: 1.5 },
              { line_key: "svc:rot", hours: 0.4 },
            ],
            parts_snapshot: [
              { part_name: "Front Brake Pads", oem_number: "68459898AB", cost: 66.18, quantity: 1 },
              { part_name: "Caliper / brake grease", oem_number: "G", cost: 12, quantity: 1 },
              { part_name: "test", oem_number: "", cost: 20, quantity: 1 },
              { part_name: "QA manual part", oem_number: "", cost: 10, quantity: 1 },
            ],
          },
        ],
      }),
    );
    expect(m.totals.taxCents).toBe(2872);
    expect(m.totals.feeCents).toBe(2437);
    expect(m.totals.totalCents).toBe(40127);
    const labor = m.services.filter((s) => s.kind === "labor");
    expect(labor.map((l) => l.minutes)).toEqual([76, 20]);
    expect(labor.map((l) => l.laborCents)).toEqual([19000, 5000]);
    expectInvariants(m);
  });
});

describe("#390 — a fixed-price booking is never $0", () => {
  it("renders the set price + tax + fee the customer saw", () => {
    const loc = { state: "TX", zip: "77002" };
    const allIn = shopLineAllInCents({ partsCents: 15000, shopState: loc.state, shopZip: loc.zip });
    const m = buildBookingMoney(
      inputs({
        booking: {
          service_ids: ["rot"],
          labor_cost: 0,
          parts_cost: 0,
          total_cost: 0,
          is_fixed_price: true,
          fixed_price_lines: [{ service_id: "rot", price_low_cents: 15000, price_high_cents: 15000 }],
          quoted_breakdown: {
            parts_cents: 15000,
            labor_cents: 0,
            tax_cents: allIn - 15000 - 1050,
            service_fee_cents: 1050,
          },
          quoted_set_price_cents: allIn,
          disclosed_range_low_cents: allIn,
          disclosed_range_high_cents: allIn,
        },
        baseServices: [{ serviceId: "rot", name: "Tire Rotation", catalogHours: 0.5 }],
      }),
    );
    expect(m.basis).toBe("estimate");
    expect(m.isShopSet).toBe(true);
    expect(m.services).toHaveLength(1);
    expect(m.services[0]).toMatchObject({ kind: "set_price", name: "Tire Rotation", setPriceCents: 15000 });
    expect(m.totals.totalCents).toBe(allIn);
    expect(m.totals.totalCents).toBeGreaterThan(0);
    expect(m.warnings).toEqual([]);
    expectInvariants(m);
  });

  it("an agreed shop-set estimate splits its all-in base forward, not as a tax plug", () => {
    const loc = { state: "TX", zip: "77002" };
    const baseAllIn = shopLineAllInCents({ partsCents: 15000, shopState: loc.state, shopZip: loc.zip });
    // On top: one added $20 part, no labor.
    const onTopTax = Math.round(20 * 0.0825 * 100);
    const onTopFee = 499; // $4.99 floor
    const m = buildBookingMoney(
      inputs({
        booking: {
          service_ids: ["rot"],
          fixed_price_lines: [{ service_id: "rot", price_low_cents: 15000, price_high_cents: 15000 }],
          fixed_contract_base_cents: baseAllIn,
        },
        baseServices: [{ serviceId: "rot", name: "Tire Rotation", catalogHours: 0.5 }],
        approvals: [
          {
            cycle: "pre_job",
            decision: "auto_approved_within_range",
            decided_at_ms: 5,
            submitted_at_ms: 5,
            mechanic_set_price_cents: baseAllIn + 2000 + onTopTax + onTopFee,
            parts_subtotal_cents: 2000,
            labor_cents: 0,
            tax_cents: onTopTax,
            service_fee_cents: onTopFee,
            labor_rate_cents: 15000,
            parts_snapshot: [
              { part_name: "Valve stem", oem_number: "VS", cost: 20, quantity: 1, custom_service_name: "" },
            ],
          },
        ],
      }),
    );
    expect(m.isShopSet).toBe(true);
    const set = m.services.find((s) => s.kind === "set_price")!;
    expect(set.name).toBe("Tire Rotation");
    expect(set.setPriceCents).toBe(15000);
    expect(m.totals.partsCents).toBe(2000);
    const base = decomposeAllInCents(baseAllIn, loc);
    expect(m.totals.taxCents).toBe(onTopTax + base.taxCents);
    expect(m.totals.feeCents).toBe(onTopFee + base.feeCents);
    expect(m.totals.totalCents).toBe(baseAllIn + 2000 + onTopTax + onTopFee);
    expect(m.totals.adjustmentCents).toBe(0);
    expectInvariants(m);
  });
});

describe("#445 — a tire quote counts the tires it bills", () => {
  const booking = {
    _id: "q1",
    status: "confirmed",
    service_ids: ["tire"],
    tire_specs: { quantity: 2, size: "225/55R18" },
  };
  const response = {
    tire_brand: "All-Season",
    tire_model: "Standard",
    per_tire_price: 60,
    quantity: 2,
    labor_cost: 30,
    total: 150,
    estimated_duration_minutes: 30,
  };
  const m = buildBookingMoney(
    inputs({
      booking,
      baseServices: [{ serviceId: "tire", name: "Tire Replacement", catalogHours: 1 }],
      quote: {
        kind: "tire",
        laborCents: 3000,
        totalCents: 15000,
        durationMinutes: 30,
        serviceName: "Tire Replacement",
        partLines: quoteResponsePartLines({ kind: "tire", response, booking, serviceId: "tire" }),
      },
    }),
  );

  it("2 tire lines, $120 of parts, and the Review & Pay total", () => {
    expect(m.basis).toBe("quote");
    expect(m.counts.parts).toBe(2);
    expect(m.totals.partsCents).toBe(12000);
    expect(m.totals.laborCents).toBe(3000);
    // Review & Pay: Taxes & Fees $22.88, Total $172.88
    expect(m.totals.taxCents + m.totals.feeCents).toBe(2288);
    expect(m.totals.totalCents).toBe(17288);
    expectInvariants(m);
  });

  it("quoteAllInCents matches the phone's formula", () => {
    expect(
      quoteAllInCents({
        laborCents: 3000,
        partsCents: 12000,
        quoteTotalCents: 15000,
        loc: { state: "TX", zip: "77002" },
      }),
    ).toEqual({ taxCents: 1238, feeCents: 1050, totalCents: 17288 });
  });
});

describe("legacy rows", () => {
  it("a pre-Sep-24 approval that billed a blank-named part still reconciles, named", () => {
    const m = buildBookingMoney(
      inputs({
        booking: { service_ids: ["oil"] },
        baseServices: [{ serviceId: "oil", name: "Oil Change", catalogHours: 0.5 }],
        approvals: [
          {
            cycle: "pre_job",
            decision: "approved",
            decided_at_ms: 1,
            submitted_at_ms: 1,
            mechanic_set_price_cents: 1001 + 3000 + 330 + 499,
            parts_subtotal_cents: 1001,
            labor_cents: 3000,
            tax_cents: 330,
            service_fee_cents: 499,
            labor_hours: 0.2,
            labor_rate_cents: 15000,
            parts_snapshot: [
              { part_name: "Oil", oem_number: "O", cost: 10, quantity: 1 },
              { part_name: "", oem_number: "", cost: 0.01, quantity: 1 },
            ],
          },
        ],
      }),
    );
    expect(m.totals.partsCents).toBe(1001);
    expect(m.parts.map((p) => p.name)).toEqual(["Oil", "Unnamed part"]);
    expect(m.counts.parts).toBe(2);
    expect(m.totals.adjustmentCents).toBe(0);
    expectInvariants(m);
  });

  it("a declined mid-job request never becomes the price", () => {
    const m = buildBookingMoney(
      inputs({
        booking: { service_ids: ["oil"], mechanic_set_price_cents: 99999 },
        baseServices: [{ serviceId: "oil", name: "Oil Change", catalogHours: 0.5 }],
        approvals: [
          {
            cycle: "pre_job",
            decision: "approved",
            decided_at_ms: 1,
            submitted_at_ms: 1,
            mechanic_set_price_cents: 3000 + 248 + 499,
            parts_subtotal_cents: 0,
            labor_cents: 3000,
            tax_cents: 248,
            service_fee_cents: 499,
            labor_hours: 0.2,
            labor_rate_cents: 15000,
            parts_snapshot: [],
          },
          {
            cycle: "mid_job",
            decision: "declined",
            decided_at_ms: 2,
            submitted_at_ms: 2,
            mechanic_set_price_cents: 99999,
            parts_subtotal_cents: 90000,
            labor_cents: 3000,
            tax_cents: 0,
            service_fee_cents: 0,
            parts_snapshot: [],
          },
        ],
      }),
    );
    expect(m.totals.totalCents).toBe(3747);
    expect(m.agreedCycle).toBe("pre_job");
    expectInvariants(m);
  });
});

describe("a fixed-price booking made before its fixed lines were stored", () => {
  it("prices the booked service at the quoted flat price, parts included in it", () => {
    // Real dev row: is_fixed_price, no fixed_price_lines; the $60 flat price is
    // in quoted_breakdown.parts_cents while the snapshot holds the $70.34 of
    // parts it covers.
    const m = buildBookingMoney(
      inputs({
        booking: {
          service_ids: ["oil"],
          is_fixed_price: true,
          quoted_breakdown: { parts_cents: 6000, labor_cents: 0, tax_cents: 532, service_fee_cents: 499 },
          quoted_set_price_cents: 7031,
          priced_parts_snapshot: [
            { part_name: "Engine oil 0W-20", quantity: 5, unit_price_cents: 1050, line_total_cents: 5250, service_id: "oil" },
            { part_name: "Oil Filter", quantity: 1, unit_price_cents: 717, line_total_cents: 717, service_id: "oil" },
            { part_name: "Oil Drain Plug Gasket", quantity: 1, unit_price_cents: 258, line_total_cents: 258, service_id: "oil" },
            { part_name: "Oil Filter Housing Cap O-Ring", quantity: 1, unit_price_cents: 809, line_total_cents: 809, service_id: "oil" },
          ],
        },
        baseServices: [{ serviceId: "oil", name: "Oil Change", catalogHours: 0.5 }],
      }),
    );
    expect(m.isShopSet).toBe(true);
    expect(m.services).toEqual([
      expect.objectContaining({ kind: "set_price", name: "Oil Change", setPriceCents: 6000 }),
    ]);
    expect(m.parts).toHaveLength(0);
    expect(m.setPriceParts).toHaveLength(4);
    expect(m.totals.adjustmentCents).toBe(0);
    expect(m.totals.totalCents).toBe(7031);
    expect(m.warnings).toEqual([]);
    expectInvariants(m);
  });
});

describe("#390 — what a new booking stores", () => {
  const loc = { state: "TX", zip: "77002" };

  it("a fixed-price service stores the shop's all-in price, not the phone's $0", () => {
    const stored = storedMoneyForCreate({
      services: [{ service_id: "rot", labor_cost: 0, parts_cost: 0 }],
      fixedPriceLines: [{ service_id: "rot", price_low_cents: 15000, price_high_cents: 15000 }],
      loc,
    })!;
    expect(stored.laborCost).toBe(0);
    expect(stored.partsCost).toBe(150);
    // Identical to the all-in the disclosed band and quoted_set_price use.
    expect(Math.round(stored.totalCost * 100)).toBe(
      shopLineAllInCents({ partsCents: 15000, shopState: "TX", shopZip: "77002" }),
    );
  });

  it("a mixed booking keeps the client values for its dynamic services", () => {
    const stored = storedMoneyForCreate({
      services: [
        { service_id: "rot", labor_cost: 0, parts_cost: 0 },
        { service_id: "oil", labor_cost: 60, parts_cost: 45.5 },
      ],
      fixedPriceLines: [{ service_id: "rot", price_low_cents: 8000, price_high_cents: 10000 }],
      loc,
    })!;
    expect(stored.laborCost).toBe(60);
    expect(stored.partsCost).toBe(135.5);
    expect(stored.totalCost).toBeGreaterThan(195.5);
  });

  it("nothing shop-priced → null (the caller stores the client sums as before)", () => {
    expect(
      storedMoneyForCreate({
        services: [{ service_id: "oil", labor_cost: 60, parts_cost: 45 }],
        fixedPriceLines: [],
        loc,
      }),
    ).toBeNull();
  });
});

describe("helpers", () => {
  it("splitByWeights sums exactly and follows the weights", () => {
    expect(splitByWeights(10500, [28, 14])).toEqual([7000, 3500]);
    expect(splitByWeights(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(splitByWeights(7, [0, 0])).toEqual([4, 3]);
    expect(splitByWeights(0, [1, 2])).toEqual([0, 0]);
    expect(splitByWeights(10, [])).toEqual([]);
  });

  it("decomposeAllInCents inverts the forward all-in function", () => {
    const loc = { state: "TX", zip: "77002" };
    for (const price of [1, 499, 7129, 15000, 123456]) {
      const allIn = shopLineAllInCents({ partsCents: price, shopState: loc.state, shopZip: loc.zip });
      const d = decomposeAllInCents(allIn, loc);
      expect(d.priceCents + d.taxCents + d.feeCents).toBe(allIn);
      expect(d.priceCents).toBe(price);
    }
    // A chosen all-in inside a band that no price hits exactly still sums.
    const d = decomposeAllInCents(16951, loc);
    expect(d.priceCents + d.taxCents + d.feeCents).toBe(16951);
  });
});
