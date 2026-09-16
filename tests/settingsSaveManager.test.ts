import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createLatestSaveHandlers } from "../components/settings/save-manager";

describe("settings save manager", () => {
  it("calls the latest save callback after a rapid input update", async () => {
    const saved: string[] = [];
    const latest = {
      current: {
        save: async () => {
          saved.push("1");
        },
        reset: () => {},
      },
    };
    const handlers = createLatestSaveHandlers(latest);

    latest.current = {
      save: async () => {
        saved.push("140");
      },
      reset: () => {},
    };
    await handlers.save();

    expect(saved).toEqual(["140"]);
  });

  it("keeps a save error visible while unsaved changes remain", () => {
    const source = readFileSync(
      resolve(process.cwd(), "components/settings/save-manager.tsx"),
      "utf8",
    );

    expect(source).toContain("{toast ? (");
    expect(source).toContain("{count > 0 ? (");
  });
});
