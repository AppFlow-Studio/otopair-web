import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ScheduleSidePanel } from "@/app/(portal)/schedule/schedule-side-panel";

describe("ScheduleSidePanel", () => {
  it("renders one stable child tree with both sidebar and bottom-sheet responsive styles", () => {
    const html = renderToStaticMarkup(
      createElement(
        ScheduleSidePanel,
        { open: true, onClose: () => {} },
        createElement("input", {
          "data-testid": "booking-draft",
          defaultValue: "Anesa",
        }),
      ),
    );

    expect(html).toContain("max-xl:fixed");
    expect(html).toContain("xl:w-[552px]");
    expect(html.match(/data-testid="booking-draft"/g)).toHaveLength(1);
  });
});
