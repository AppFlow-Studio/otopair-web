import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const sessionStateSource = readFileSync(join(currentDirectory, "session-state.ts"), "utf8");

test("clearing user-scoped state closes any in-memory Settings overlay", () => {
  assert.match(sessionStateSource, /useSettingsOverlayStore/);
  assert.match(sessionStateSource, /useSettingsOverlayStore\.getState\(\)\.reset\(\)/);
});
