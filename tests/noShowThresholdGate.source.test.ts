import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// Bug #437: the booking panel's ⋯ menu offered "Mark no-show" before the
// shop's no-show threshold, and the server's rejection surfaced as a raw error
// toast. The web build ignores type errors, so pin the wiring here: the panel
// gates on getJobDetail's `noShowAvailableAtMs`, keeps its clock current, and
// treats NO_SHOW_TOO_EARLY as information, not a failure.

const source = readFileSync(
  join(process.cwd(), "components", "booking-detail-panel.tsx"),
  "utf8",
);

function block(pattern: RegExp): string {
  const match = source.match(pattern)?.[0];
  expect(match, String(pattern)).toBeTruthy();
  return match ?? "";
}

describe("booking panel no-show threshold gate (bug #437)", () => {
  test("reads the server's availability, falling back to the active monitor", () => {
    expect(source).toMatch(
      /job\?\.noShowAvailableAtMs \?\? job\?\.customerLateMonitor\?\.thresholdDueAtMs \?\? null/,
    );
    expect(source).toMatch(
      /const noShowOpen = noShowAvailableAtMs == null \|\| nowMs >= noShowAvailableAtMs;/,
    );
  });

  test("resyncs the clock per booking and wakes at the threshold", () => {
    const effect = block(
      /useEffect\(\(\) => \{\s*setNowMs\(Date\.now\(\)\);[\s\S]*?\}, \[job\?\._id, job\?\.status, noShowAvailableAtMs\]\);/,
    );
    expect(effect).toContain("window.setTimeout");
    expect(effect).toContain("2 ** 31 - 1");
    // A timer that slept through the threshold catches up on return, and the
    // listeners go away with the effect.
    expect(effect).toContain('document.addEventListener("visibilitychange", onVisibilityChange)');
    expect(effect).toContain('document.removeEventListener("visibilitychange", onVisibilityChange)');
    expect(effect).toContain('window.addEventListener("focus", wake)');
    expect(effect).toContain('window.removeEventListener("focus", wake)');
    expect(effect).toMatch(/document\.visibilityState === "visible"\) wake\(\)/);
    // The ⋯ menu re-reads the clock whenever it opens.
    expect(source).toMatch(/onOpenChange=\{\(open\) => \{[\s\S]*?if \(open\) setNowMs\(Date\.now\(\)\);/);
  });

  test("the Cancel dialog re-reads the clock when it opens, the 'c' hotkey included", () => {
    const effect = block(
      /useEffect\(\(\) => \{\s*if \(!showCancelConfirm\) \{[\s\S]*?\}, \[showCancelConfirm\]\);/,
    );
    expect(effect).toMatch(/return;\s*\}[\s\S]*?setNowMs\(Date\.now\(\)\);/);
    // The hotkey handle opens it through that same state, so the effect runs.
    expect(source).toMatch(/showCancelJob: \(\) => setShowCancelConfirm\(true\)/);
  });

  test("the ⋯ item stays listed but disabled, saying when it opens", () => {
    const push = block(/overflow\.push\(\{\s*key: "no-show",[\s\S]*?\}\);/);
    expect(push).toContain("disabled: !noShowOpen");
    expect(push).toContain("available ${noShowOpensAt}");
    expect(source).toMatch(/<DropdownMenuItem[\s\S]*?disabled=\{item\.disabled\}/);
  });

  test("names the day when the threshold is on a later shop-local day", () => {
    const helper = block(/function describeNoShowOpensAt\([\s\S]*?\n\}\n/);
    // getJobDetail's shop-local pieces; "later day" = before that day starts.
    expect(helper).toContain("nowMs < job.noShowAvailableAtDayStartMs");
    expect(helper).toContain("job.noShowAvailableAtLabel");
    expect(helper).toContain("job.noShowAvailableAtDateLabel");
    expect(helper).toMatch(/return `at \$\{time\}`/);
    expect(helper).toMatch(/return `\$\{day\} at \$\{time\}`/);
    expect(source).toContain("describeNoShowOpensAt(job, noShowAvailableAtMs, nowMs)");
  });

  test("Mark no-show treats a too-early rejection as information", () => {
    const handler = block(/async function handlePostThresholdNoShow\(\) \{[\s\S]*?\n {4}\}\n/);
    expect(handler).toMatch(
      /errorCode\(err\) === "NO_SHOW_TOO_EARLY" \|\| isStaleStateError\(err\)[\s\S]*?notify\.info\(readBookingError\(err\)!\.message\)/,
    );
    expect(handler).toContain('errorMessage(err, "Could not mark no-show.")');
  });

  test("the cancel dialog's Customer no-show follows the same gate", () => {
    expect(source).toMatch(
      /status === "confirmed" && noShowOpen \? \["Customer no-show"\] : \[\]/,
    );
    expect(source).toContain("getCancelReasons(job?.status, noShowOpen)");
    const cancel = block(/async function handleCancelJob\(\) \{[\s\S]*?\n {4}\}\n/);
    expect(cancel).toMatch(/errorCode\(err\) === "NO_SHOW_TOO_EARLY"/);
  });
});
