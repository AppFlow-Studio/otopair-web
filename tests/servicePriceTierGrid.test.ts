import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("service price-tier layout", () => {
  it("keeps all four vehicle groups in a two-by-two grid", () => {
    const source = readFileSync(
      resolve(process.cwd(), "components/shop/service-price-tier-strip.tsx"),
      "utf8",
    );

    expect(source).toContain('className="grid grid-cols-2 gap-3"');
  });
});
