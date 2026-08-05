import { describe, expect, it } from "vitest";
import {
  EXTRACTOR_ANTHROPIC,
  EXTRACTOR_REDUCTO,
  extractorForBytes,
  MANUAL_REJECTION_PREFIX,
  MAX_MANUAL_BYTES,
  MAX_STORED_MANUAL_BYTES,
  sha256Hex,
  shouldSkipManualLookup,
} from "../convex/vehicleEnrichment/manualLibrary";
import {
  buildReductoInstructions,
  buildReductoSpecsInstructions,
  extractReductoResult,
  REDUCTO_INTERVAL_SCHEMA,
  REDUCTO_SPECS_SCHEMA,
  unwrapReducto,
} from "../convex/vehicleEnrichment/manualReducto";
import {
  MANUAL_SPECS_ADAPTER,
  parseSpecPayload,
  SPECS_ADAPTER_REDUCTO,
  SPECS_ADAPTERS,
  SPEC_FIELD_KEYS,
} from "../convex/vehicleEnrichment/manualSpecs";

const MB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

describe("extractorForBytes — routing is decided once, from size", () => {
  it("sends anything the Messages API can hold to the Anthropic path", () => {
    // Preferred: it is the only extractor that returns page-level citations.
    expect(extractorForBytes(5 * MB)).toBe(EXTRACTOR_ANTHROPIC);
    expect(extractorForBytes(MAX_MANUAL_BYTES)).toBe(EXTRACTOR_ANTHROPIC);
  });

  it("routes real oversize manuals to Reducto instead of rejecting them", () => {
    // These are actual documents: the 2020 Accord OM is 38.7 MB and the 2017
    // Mazda3 is 57 MB. Both used to be recorded as `too_large_*` and never read.
    expect(extractorForBytes(38.7 * MB)).toBe(EXTRACTOR_REDUCTO);
    expect(extractorForBytes(57 * MB)).toBe(EXTRACTOR_REDUCTO);
  });

  it("still keeps a ceiling — above it a PDF is a bundle, not a manual", () => {
    expect(MAX_STORED_MANUAL_BYTES).toBeGreaterThan(MAX_MANUAL_BYTES);
    expect(57 * MB).toBeLessThan(MAX_STORED_MANUAL_BYTES);
  });
});

describe("sha256Hex", () => {
  it("produces lowercase hex for known input", async () => {
    // Vector for the empty string.
    expect(await sha256Hex(new Uint8Array([]))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("is stable and differs for different bytes", async () => {
    const a = await sha256Hex(new Uint8Array([1, 2, 3]));
    expect(a).toBe(await sha256Hex(new Uint8Array([1, 2, 3])));
    expect(a).not.toBe(await sha256Hex(new Uint8Array([1, 2, 4])));
  });
});

describe("shouldSkipManualLookup — stored bytes make a row resolved", () => {
  const now = Date.now();

  it("treats a row with only stored bytes as resolved (the oversize case)", () => {
    // An oversize manual never gets a file_id; without this it would be
    // re-discovered on every single run.
    expect(shouldSkipManualLookup({ storage_id: "kg2", fetched_at: now }, now)).toMatchObject({
      skip: true,
      reason: "fresh_manual_stored",
    });
  });

  it("does NOT re-discover when the Files entry expired but we hold the bytes", () => {
    // The document did not expire; the upload did. A re-upload is one call,
    // versus a search plus a multi-MB download plus another roll of the
    // wrong-document dice.
    expect(
      shouldSkipManualLookup(
        { file_id: "file_1", storage_id: "kg2", fetched_at: now - 400 * DAY, expires_at: now - DAY },
        now,
      ),
    ).toMatchObject({ skip: true, reason: "fresh_manual_stored" });
  });

  it("still re-discovers an expired row we have NO bytes for", () => {
    expect(
      shouldSkipManualLookup({ file_id: "file_1", fetched_at: now - DAY, expires_at: now - 1 }, now),
    ).toMatchObject({ skip: false, reason: "manual_expired" });
  });

  it("still re-discovers a stale row we have no bytes for", () => {
    expect(shouldSkipManualLookup({ file_id: "file_1", fetched_at: now - 400 * DAY }, now)).toMatchObject({
      skip: false,
      reason: "manual_stale",
    });
  });

  it("does NOT let stored bytes resurrect a REJECTED document", () => {
    // The regression this guards: rejectManualRow clears file_id to force a
    // different candidate. If stored bytes counted as "resolved", a document
    // the extractor already identified as the wrong vehicle would read as a
    // fresh manual forever and the self-correcting loop would never run.
    expect(
      shouldSkipManualLookup(
        {
          storage_id: "kg2",
          failure_reason: `${MANUAL_REJECTION_PREFIX}: BRZ quick guide`,
          rejected_urls: ["u1"],
          fetched_at: now,
        },
        now,
      ),
    ).toMatchObject({ skip: false, reason: "retry_after_rejection" });
  });

  it("does not let stored bytes bypass the negative cache either", () => {
    expect(
      shouldSkipManualLookup({ storage_id: "kg2", failure_reason: "download_404", fetched_at: now }, now),
    ).toMatchObject({ skip: true, reason: "negative_cache" });
  });

  it("leaves the failure and rejection paths untouched", () => {
    expect(shouldSkipManualLookup({ failure_reason: "download_404", fetched_at: now }, now)).toMatchObject({
      skip: true,
      reason: "negative_cache",
    });
    expect(
      shouldSkipManualLookup(
        { failure_reason: `${MANUAL_REJECTION_PREFIX}: wrong doc`, rejected_urls: ["u"], fetched_at: now },
        now,
      ),
    ).toMatchObject({ skip: false, reason: "retry_after_rejection" });
    expect(shouldSkipManualLookup(null, now)).toMatchObject({ skip: false, reason: "no_row" });
  });
});

describe("Reducto SPECS route", () => {
  it("asks for every field the Anthropic specs pass asks for", () => {
    // Same contract, different instrument — a field the oversize route cannot
    // request is a field oversize vehicles can never have.
    const enumVals = REDUCTO_SPECS_SCHEMA.properties.specs.items.properties.field_key.enum;
    expect([...enumVals].sort()).toEqual([...SPEC_FIELD_KEYS].sort());
  });

  it("carries the identity guard and requires a quote per value", () => {
    expect(REDUCTO_SPECS_SCHEMA.required).toContain("document_matches_vehicle");
    expect(REDUCTO_SPECS_SCHEMA.properties.specs.items.required).toContain("quoted_text");
  });

  it("asks for `value` as a string on every field, numeric ones included", () => {
    // A number|string union is what a JSON Schema consumer is most likely to
    // mishandle, and normalizeSpecValue parses strings on both branches — so
    // one consistent type removes the risk for nothing.
    expect(REDUCTO_SPECS_SCHEMA.properties.specs.items.properties.value.type).toBe("string");
  });

  it("produces a payload manualSpecs' own parser accepts end-to-end", () => {
    // The real integration check: a Reducto-shaped response (citation-wrapped,
    // string values) must survive unwrap → parseSpecPayload with the values
    // normalized identically to the Anthropic path.
    const wrapped = {
      result: {
        document_matches_vehicle: { value: true, citations: [] },
        document_vehicle_text: { value: "2020 Accord Owner's Manual", citations: [] },
        specs: [
          {
            field_key: { value: "oil_capacity_qts", citations: [] },
            value: { value: "4.80", citations: [] },
            unit_as_printed: { value: "US qts", citations: [] },
            quoted_text: { value: "4.8 US qts with filter", citations: [] },
            page_number: { value: 552, citations: [] },
          },
          {
            field_key: { value: "oil_viscosity", citations: [] },
            value: { value: "0w-20", citations: [] },
            quoted_text: { value: "SAE 0W-20", citations: [] },
          },
        ],
      },
    };
    const payload = extractReductoResult(wrapped);
    const parsed = parseSpecPayload(payload, { code: "K20C4", displacement_l: 1.5 });
    expect(parsed.rejected).toBeNull();
    expect(parsed.specs.map((s) => [s.field_key, s.value])).toEqual([
      ["oil_capacity_qts", "4.8"],
      ["oil_viscosity", "0W-20"],
    ]);
    // Byte-identical to what AMSOIL emits, so the ledger clusters them.
    expect(parsed.specs[0].value).toBe("4.8");
  });

  it("inherits the identity guard — a wrong document emits nothing", () => {
    const payload = extractReductoResult({
      result: {
        document_matches_vehicle: { value: false, citations: [] },
        document_vehicle_text: { value: "2019 Subaru BRZ Quick Guide", citations: [] },
        specs: [
          {
            field_key: { value: "oil_capacity_qts", citations: [] },
            value: { value: "5.1", citations: [] },
            quoted_text: { value: "5.1 qts", citations: [] },
          },
        ],
      },
    });
    const parsed = parseSpecPayload(payload, null);
    expect(parsed.specs).toHaveLength(0);
    expect(parsed.rejected).toMatch(/^document_vehicle_mismatch/);
  });

  it("names the vehicle and the drain-and-refill rule in the instructions", () => {
    const p = buildReductoSpecsInstructions({
      year: 2020,
      make: "Honda",
      model: "Accord",
      engine_label: "K20C4",
    });
    expect(p).toContain("2020 Honda Accord");
    expect(p).toContain("K20C4");
    expect(p).toContain("DRAIN AND REFILL WITH FILTER CHANGE");
  });

  it("keeps a distinct adapter id so either extractor can be retracted alone", () => {
    expect(SPECS_ADAPTER_REDUCTO).not.toBe(MANUAL_SPECS_ADAPTER);
    expect(SPECS_ADAPTERS).toEqual([MANUAL_SPECS_ADAPTER, SPECS_ADAPTER_REDUCTO]);
  });
});

describe("Reducto schema + instructions", () => {
  it("carries the identity guard and the interval enum", () => {
    expect(REDUCTO_INTERVAL_SCHEMA.required).toContain("document_matches_vehicle");
    const enumVals = REDUCTO_INTERVAL_SCHEMA.properties.services.items.properties.service_key.enum;
    expect(enumVals).toContain("oil_change");
    // brake_pads is absent by design — a manual's pad text is inspection
    // guidance, and stamping it oem_manual would launder a wear estimate.
    expect(enumVals).not.toContain("brake_pads");
  });

  it("names the vehicle in the instructions so the guard is answerable", () => {
    const p = buildReductoInstructions({ year: 2019, make: "Honda", model: "Accord" });
    expect(p).toContain("2019 Honda Accord");
    expect(p.toLowerCase()).toContain("recurrence");
  });
});

describe("unwrapReducto — the citation envelope", () => {
  it("unwraps {value, citations} leaves at any depth", () => {
    // With citations enabled every leaf arrives wrapped; handing that straight
    // to the parser yields objects where numbers were expected.
    const raw = {
      schedule_found: { value: true, citations: [] },
      services: [
        {
          service_key: { value: "oil_change", citations: [{ page: 5 }] },
          interval_miles: { value: 10000, citations: [] },
        },
      ],
    };
    expect(unwrapReducto(raw)).toEqual({
      schedule_found: true,
      services: [{ service_key: "oil_change", interval_miles: 10000 }],
    });
  });

  it("passes through already-bare values and primitives", () => {
    expect(unwrapReducto({ a: 1, b: "x", c: null })).toEqual({ a: 1, b: "x", c: null });
    expect(unwrapReducto([1, 2])).toEqual([1, 2]);
  });
});

describe("extractReductoResult", () => {
  it("accepts both the object and array result shapes", () => {
    const obj = { result: { schedule_found: { value: true, citations: [] } } };
    const arr = { result: [{ schedule_found: { value: true, citations: [] } }] };
    expect(extractReductoResult(obj)).toEqual({ schedule_found: true });
    expect(extractReductoResult(arr)).toEqual({ schedule_found: true });
  });

  it("returns null on a missing or malformed result rather than throwing", () => {
    for (const bad of [null, undefined, {}, { result: null }, { result: [] }, { result: 5 }]) {
      expect(() => extractReductoResult(bad)).not.toThrow();
      expect(extractReductoResult(bad)).toBeNull();
    }
  });
});
