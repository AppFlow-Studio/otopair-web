import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(currentDirectory, "android-app-signature.ts"), "utf8");

test("android app signature wrapper calls the native module on Android", () => {
  assert.match(source, /NativeModules\.AndroidAppSignature/);
  assert.match(source, /Platform\.OS !== "android"/);
  assert.match(source, /getSmsRetrieverHash\(\)/);
});
