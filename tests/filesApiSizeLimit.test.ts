import { describe, it, expect } from "vitest";
import { isFilesApiSizeLimit } from "../convex/vehicleEnrichment/manualLibrary";

// The classifier both manual passes route on. It used to exist only in the
// interval pass, so a 395-page manual reached Reducto for its schedule and died
// with a raw messages_400 for its 18 spec fields — same limit, same document,
// two behaviours. One definition now, and these are its edges.

describe("isFilesApiSizeLimit", () => {
  it("recognises the page-cap rejection", () => {
    expect(
      isFilesApiSizeLimit(
        400,
        '{"type":"error","error":{"type":"invalid_request_error","message":"The request exceeds the maximum of 600 PDF pages"}}',
      ),
    ).toBe(true);
  });

  it("recognises the token-cap rejection — the one our manuals actually hit", () => {
    // The message SHAPE Anthropic returns. The exact token figures below are
    // illustrative: our own log line truncates the body at 80 chars, so the
    // real counts from the Aug 14 runs were never captured. What is confirmed
    // is that all four manuals failed on this message, not the page cap.
    expect(
      isFilesApiSizeLimit(
        400,
        '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1054982 tokens > 1048576 maximum"}}',
      ),
    ).toBe(true);
  });

  it("is case-insensitive on the message text", () => {
    expect(isFilesApiSizeLimit(400, "Prompt Is Too Long")).toBe(true);
    expect(isFilesApiSizeLimit(400, "MAXIMUM OF 600 PDF PAGES")).toBe(true);
  });

  it("does NOT reroute an ordinary 400", () => {
    // A malformed request is not a size problem. Retrying it on a second
    // extractor would only burn that credit too.
    expect(isFilesApiSizeLimit(400, "invalid_request_error: missing field `model`")).toBe(false);
    expect(isFilesApiSizeLimit(400, "")).toBe(false);
  });

  it("does not fire on other statuses, whatever the body says", () => {
    // A 429 or 529 carrying similar prose is a retry, not a reroute.
    for (const s of [401, 413, 429, 500, 529]) {
      expect(isFilesApiSizeLimit(s, "prompt is too long"), String(s)).toBe(false);
    }
  });
});
