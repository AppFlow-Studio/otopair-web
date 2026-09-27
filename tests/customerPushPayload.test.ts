import { describe, it, expect } from "vitest";
import { buildCustomerPushPayload } from "../convex/lib/notificationOutbox";

/**
 * buildCustomerPushPayload is the single shape a customer push must have:
 * `{ title, body, ...extra, data: { deepLink, bookingId, vehicleLabel, vin,
 * ...extra } }`. The Expo dispatcher only forwards title/body/data, so a missing
 * title = a blank "Otopair" banner and only `data` reaches the device.
 *
 * Every normalized emit point (schedule_courtesy_update, overrun_customer_
 * resolution, the reschedule/expiry family, the mechanic overrun, …) funnels
 * through this helper, so locking its contract here guards them all — in
 * particular the ADDITIVE rule (context fields kept top-level AND mirrored under
 * data), which the web feed relies on (components/customer-scheduling-alerts.tsx
 * reads payload.newEndTime at the top level).
 */
describe("buildCustomerPushPayload", () => {
  it("defaults the deep link to the booking base route", () => {
    const p = buildCustomerPushPayload({
      title: "T",
      body: "B",
      bookingId: "bk_123",
    });
    expect(p.title).toBe("T");
    expect(p.body).toBe("B");
    expect(p.data.deepLink).toBe("otopair://booking/bk_123");
    expect(p.data.bookingId).toBe("bk_123");
  });

  it("honors an explicit deepLink override (e.g. approve-estimate)", () => {
    const p = buildCustomerPushPayload({
      title: "T",
      body: "B",
      bookingId: "bk_1",
      deepLink: "otopair://booking/bk_1/approve-estimate",
    });
    expect(p.data.deepLink).toBe("otopair://booking/bk_1/approve-estimate");
  });

  it("mirrors extra fields BOTH top-level and under data (additive, never a move)", () => {
    const p = buildCustomerPushPayload({
      title: "Appointment updated",
      body: "…",
      bookingId: "bk_9",
      extra: { newEndTime: "4:30 PM", extensionMinutes: 30 },
    }) as any;
    // top-level preserved — the web feed reads these directly.
    expect(p.newEndTime).toBe("4:30 PM");
    expect(p.extensionMinutes).toBe(30);
    // and mirrored under data so the device (which only gets data) receives them.
    expect(p.data.newEndTime).toBe("4:30 PM");
    expect(p.data.extensionMinutes).toBe(30);
  });

  it("carries the resolved vehicle label + vin in data (name the car)", () => {
    const p = buildCustomerPushPayload({
      title: "T",
      body: "B",
      bookingId: "bk_2",
      vehicleLabel: "2021 Toyota Camry",
      vin: "VIN123",
    }) as any;
    expect(p.data.vehicleLabel).toBe("2021 Toyota Camry");
    expect(p.data.vin).toBe("VIN123");
  });

  it("omits vehicleLabel/vin when unresolved (null passes through cleanly)", () => {
    const p = buildCustomerPushPayload({
      title: "T",
      body: "B",
      bookingId: "bk_2",
      vehicleLabel: null,
      vin: null,
    }) as any;
    expect("vehicleLabel" in p.data).toBe(false);
    expect("vin" in p.data).toBe(false);
  });

  it("omits the deep link when neither deepLink nor bookingId is given", () => {
    const p = buildCustomerPushPayload({ title: "T", body: "B" }) as any;
    expect(p.data.deepLink).toBeUndefined();
    expect(p.data.bookingId).toBeUndefined();
  });

  it("coerces a non-string bookingId to a string in data and the deep link", () => {
    const p = buildCustomerPushPayload({
      title: "T",
      body: "B",
      bookingId: { toString: () => "bk_obj" } as any,
    }) as any;
    expect(p.data.bookingId).toBe("bk_obj");
    expect(p.data.deepLink).toBe("otopair://booking/bk_obj");
  });
});
