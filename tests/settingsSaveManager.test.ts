import { describe, expect, it } from "vitest";

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
});
