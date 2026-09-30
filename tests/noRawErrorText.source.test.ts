import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

// Portal-wide guard: raw error text (Convex wrappers, stack frames, request
// ids, Stripe/Clerk internals) must never reach a person. Display sites go
// through `errorMessage(err, fallback)` from `@/lib/feedback` (client) or
// `formatBookingError(err, fallback)` from `@/convex/lib/bookingErrors`
// (anywhere, including server code). A site that only LOGS, rethrows or
// string-matches the raw text may keep it, but must say so on the same line:
//
//     console.error(err instanceof Error ? err.message : err); // raw-error-ok: logged only

const ROOT = process.cwd();
const SCAN_DIRS = ["app", "components", "lib"];
const SOURCE_EXT = /\.(ts|tsx)$/;
const TEST_FILE = /\.test\.tsx?$/;

const RAW_ERROR_PATTERNS: RegExp[] = [
  /instanceof Error \? *[A-Za-z_]+\.message/,
  /[A-Za-z_]+\?\.message *\?\?/,
  /\((e|err|error|ex)[a-zA-Z]* as Error\)\.message/,
];

const ALLOW_COMMENT = /\/\/ raw-error-ok: \S.*$/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(entry.name) && !TEST_FILE.test(entry.name)) out.push(full);
  }
  return out;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

const files = SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

describe("no raw error text reaches a person", () => {
  test("scans a non-trivial number of source files", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  test("every raw error read is formatted or marked raw-error-ok", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (!RAW_ERROR_PATTERNS.some((re) => re.test(line))) return;
        if (ALLOW_COMMENT.test(line)) return;
        offenders.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(
      offenders,
      "Use errorMessage(err, fallback) / formatBookingError(err, fallback), or end the line with `// raw-error-ok: <reason>` when the text is only logged, rethrown or matched",
    ).toEqual([]);
  });

  test("server code never imports the client feedback module", () => {
    // lib/feedback.ts imports sonner (client-only). Server code formats with
    // formatBookingError from @/convex/lib/bookingErrors instead.
    const serverFiles = files.filter((file) => {
      const r = rel(file);
      return r.startsWith("app/api/") || r === "lib/convex-server.ts";
    });
    expect(serverFiles.length).toBeGreaterThan(0);
    const importsFeedback = /from\s+["']@\/lib\/feedback["']|require\(\s*["']@\/lib\/feedback["']\s*\)/;
    const offenders = serverFiles
      .filter((file) => importsFeedback.test(fs.readFileSync(file, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
