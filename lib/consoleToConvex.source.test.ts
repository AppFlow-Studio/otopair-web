import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const consoleToConvexSource = readFileSync(join(currentDirectory, "consoleToConvex.ts"), "utf8");
const useConsoleToConvexSource = readFileSync(join(currentDirectory, "../hooks/useConsoleToConvex.ts"), "utf8");

test("console forwarding returns a cleanup function that restores original console methods", () => {
  assert.match(consoleToConvexSource, /export function setupConsoleToConvex/);
  assert.match(consoleToConvexSource, /return \(\) => \{/);
  assert.match(consoleToConvexSource, /console\.error = originalError/);
  assert.match(consoleToConvexSource, /console\.warn = originalWarn/);
  assert.match(consoleToConvexSource, /console\.log = originalLog/);
});

test("console forwarding hook cleans up the installed interceptor on unmount", () => {
  assert.match(useConsoleToConvexSource, /const cleanup = setupConsoleToConvex\(logMutation\)/);
  assert.match(useConsoleToConvexSource, /return cleanup/);
});

