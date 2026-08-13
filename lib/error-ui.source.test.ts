import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const errorUiSource = readFileSync(join(currentDirectory, "error-ui.tsx"), "utf8");

test("app error boundary stops rendering children after catching an error", () => {
  assert.match(errorUiSource, /if \(this\.state\.err\)/);
  assert.match(errorUiSource, /return null/);
  assert.match(errorUiSource, /return this\.props\.children/);
});

