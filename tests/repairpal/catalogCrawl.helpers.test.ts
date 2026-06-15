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
