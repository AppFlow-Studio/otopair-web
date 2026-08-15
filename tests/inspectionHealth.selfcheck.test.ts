import { describe, it } from "vitest";
import { __selfCheck } from "../convex/lib/inspectionHealth";

describe("inspectionHealth self-check", () => {
  it("passes deriveCoreGrades' internal assertions", () => {
    __selfCheck();
  });
});
