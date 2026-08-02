import { describe, it, expect } from "vitest";
import { csvEscape, toCsvRow, toCsv } from "./catalogCrawl.helpers";

describe("csvEscape", () => {
  it("passes through plain values, quotes only when needed", () => {
    expect(csvEscape("Civic")).toBe("Civic");
    expect(csvEscape(21446)).toBe("21446");
    expect(csvEscape("430i Gran Coupe")).toBe("430i Gran Coupe"); // space, no comma → no quotes
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });
});

describe("toCsvRow / toCsv", () => {
  it("joins a row and builds a full CSV with header + trailing newline", () => {
    expect(toCsvRow([21446, "Honda", "a,b"])).toBe('21446,Honda,"a,b"');
    expect(toCsv(["id", "name"], [[1, "Brakes"], [2, "x,y"]])).toBe('id,name\n1,Brakes\n2,"x,y"\n');
  });
});

import { extractServices } from "./catalogCrawl.helpers";

// Mirrors the real escaped flight-data shape: a category (followed by "icon"),
// then a services array (each followed by "emuOperationTaxonomyCategoryId"),
// including a unicode-escaped (& = &) service name. In a TS string literal,
// `\\"` is a literal backslash+quote and `\\u0026` is a literal & sequence.
const FIXTURE =
  'x\\"id\\":1,\\"name\\":\\"Brakes\\",\\"icon\\":\\"$L31\\"}' +
  ',\\"services\\":[' +
  '{\\"id\\":1,\\"name\\":\\"AC Compressor Replacement\\",\\"emuOperationTaxonomyCategoryId\\":7,\\"popularityRank\\":null,\\"scheduled\\":false}' +
  ',{\\"id\\":30,\\"name\\":\\"Brake Pad Replacement\\",\\"emuOperationTaxonomyCategoryId\\":1}' +
  ',{\\"id\\":99,\\"name\\":\\"Heating \\u0026 AC Service\\",\\"emuOperationTaxonomyCategoryId\\":3}]';

describe("extractServices", () => {
  it("extracts services (not categories) and decodes unicode names", () => {
    expect(extractServices(FIXTURE)).toEqual([
      { service_id: 1, service_name: "AC Compressor Replacement" },
      { service_id: 30, service_name: "Brake Pad Replacement" },
      { service_id: 99, service_name: "Heating & AC Service" },
    ]);
  });
  it("excludes the category object (followed by icon, not emuOperationTaxonomyCategoryId)", () => {
    expect(extractServices(FIXTURE).some((s) => s.service_name === "Brakes")).toBe(false);
  });
  it("returns [] when nothing matches", () => {
    expect(extractServices("no services here")).toEqual([]);
  });
});

import { dedupById } from "./catalogCrawl.helpers";

describe("dedupById", () => {
  it("keeps the first occurrence per id, preserves order", () => {
    const items = [
      { service_id: 30, service_name: "Brake Pad Replacement" },
      { service_id: 128, service_name: "Spark Plug Replacement" },
      { service_id: 30, service_name: "Brake Pad Replacement (dup)" },
    ];
    expect(dedupById(items, "service_id")).toEqual([
      { service_id: 30, service_name: "Brake Pad Replacement" },
      { service_id: 128, service_name: "Spark Plug Replacement" },
    ]);
  });
  it("handles empty input", () => {
    expect(dedupById([], "service_id")).toEqual([]);
  });
});
