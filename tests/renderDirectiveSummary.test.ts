import { describe, it, expect } from "vitest";
import { summarizeRenderDirectives } from "../app/(director-panel)/director/components/tabs/renderDirectiveSummary";

// =============================================================================
// summarizeRenderDirectives — director Oto-Sim render-directive display
// =============================================================================
//
// The sim used to drop every render directive (it only showed text +
// quickReplies), so when Oto fired a render tool the director saw "Oto says
// it's doing X" with no component — looking like nothing happened. This helper
// maps a turn result's render fields → human-readable rows the sim shows as
// cards. Pure, so it's unit-testable in isolation.
// =============================================================================

describe("summarizeRenderDirectives", () => {
  it("returns no rows for an empty / text-only result", () => {
    expect(summarizeRenderDirectives(null)).toEqual([]);
    expect(summarizeRenderDirectives(undefined)).toEqual([]);
    expect(summarizeRenderDirectives({ text: "hello" })).toEqual([]);
    // quickReplies are rendered separately as chips — not summarized here.
    expect(summarizeRenderDirectives({ text: "hi", quickReplies: [{ text: "Yes" }] })).toEqual([]);
  });

  it("summarizes a vehicle-update card (mileage + fault lights)", () => {
    const rows = summarizeRenderDirectives({
      text: "Updating your mileage.",
      showVehicleUpdate: { mileage: 52000, fault_lights: ["check_engine"] },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("showVehicleUpdate");
    expect(rows[0].label).toBe("Vehicle update card");
    expect(rows[0].detail).toContain("mileage 52000");
    expect(rows[0].detail).toContain("check_engine");
    // Raw payload is carried so the interactive card can apply it verbatim.
    expect(rows[0].payload).toEqual({ mileage: 52000, fault_lights: ["check_engine"] });
  });

  it("summarizes a record-confirmation card", () => {
    const rows = summarizeRenderDirectives({
      showRecordConfirmation: { vehicle_id: "v1", maintenance_type: "brakes" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("showRecordConfirmation");
    expect(rows[0].detail).toContain("brakes");
  });

  it("summarizes a booking flow with services + diagnostic system", () => {
    const rows = summarizeRenderDirectives({
      bookService: { service_slugs: ["brake_pad_replacement"], diagnostic_system: "brakes" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("bookService");
    expect(rows[0].detail).toContain("brake_pad_replacement");
    expect(rows[0].detail).toContain("brakes");
  });

  it("summarizes a link button and booking card/list", () => {
    expect(
      summarizeRenderDirectives({ linkButton: { destination: "customer_support" } })[0].detail,
    ).toContain("customer_support");
    expect(
      summarizeRenderDirectives({ bookingCard: { booking_id: "bk_1" } })[0].detail,
    ).toContain("bk_1");
    expect(
      summarizeRenderDirectives({ bookingsList: { booking_ids: ["a", "b", "c"] } })[0].detail,
    ).toContain("3");
  });

  it("summarizes reasoning + sources", () => {
    expect(summarizeRenderDirectives({ reasoning: ["a", "b"] })[0].key).toBe("reasoning");
    expect(summarizeRenderDirectives({ sources: [{ url: "x" }, { url: "y" }] })[0].detail).toContain("2");
  });

  it("covers every render directive the result contract carries", () => {
    const full = {
      text: "hi",
      bookService: { service_slugs: ["oil_change"] },
      showRecordConfirmation: { vehicle_id: "v", maintenance_type: "oil" },
      showVehicleUpdate: { mileage: 1 },
      linkButton: { destination: "settings" },
      bookingCard: { booking_id: "b1" },
      bookingsList: { booking_ids: ["b1"] },
      reasoning: ["step"],
      sources: [{ url: "u" }],
    };
    const keys = summarizeRenderDirectives(full).map((r) => r.key).sort();
    expect(keys).toEqual([
      "bookService", "bookingCard", "bookingsList", "linkButton",
      "reasoning", "showRecordConfirmation", "showVehicleUpdate", "sources",
    ]);
  });

  it("catch-all surfaces an unknown/future render directive instead of dropping it", () => {
    const rows = summarizeRenderDirectives({ text: "hi", someFutureCard: { foo: 1 } });
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("someFutureCard");
    expect(rows[0].label).toBe("Render: someFutureCard");
    expect(rows[0].payload).toEqual({ foo: 1 });
  });

  it("never surfaces non-render result fields (text / error_kind / trace / quickReplies)", () => {
    expect(
      summarizeRenderDirectives({ text: "hi", error_kind: "overloaded", trace: {}, quickReplies: [{ text: "Yes" }] }),
    ).toEqual([]);
  });

  it("summarizes multiple directives present on one turn", () => {
    const rows = summarizeRenderDirectives({
      text: "ok",
      showVehicleUpdate: { mileage: 60000 },
      bookService: { service_slugs: ["oil_change"] },
    });
    const keys = rows.map((r) => r.key);
    expect(keys).toContain("showVehicleUpdate");
    expect(keys).toContain("bookService");
  });
});
