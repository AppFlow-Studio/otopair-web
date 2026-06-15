# RepairPal Global ID Catalog Crawler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A headed Playwright crawler that enumerates RepairPal's complete global ID space (makes, base-vehicles, services) via in-page `fetch()` and writes it to CSV files in the user's Downloads.

**Architecture:** Pure helpers (CSV serialization, service extraction, dedup) are unit-tested with Vitest. The crawler is a Playwright `.manual.spec.ts` that establishes a real Chromium session (clearing Cloudflare), runs all `next-api/estimator-flow` calls in-page, writes CSVs incrementally (resumable), and self-validates with anchor assertions. The actual crawl is a user-run headed step.

**Tech Stack:** TypeScript, Playwright (`@playwright/test@1.59.1`), Vitest, Node `fs`.

**Reference:** Spec `docs/superpowers/specs/2026-06-15-repairpal-catalog-crawl-design.md`. Findings that motivated it: `docs/superpowers/reviews/2026-06-15-repairpal-minutes-spike-findings.md`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `tests/repairpal/catalogCrawl.helpers.ts` (create) | Pure helpers: `csvEscape`, `toCsvRow`, `toCsv`, `extractServices`, `dedupById`. No `fs`, no Playwright — edge-runtime-safe so Vitest can run them. |
| `tests/repairpal/catalogCrawl.helpers.test.ts` (create) | Vitest unit tests for the pure helpers. Matched by vitest `include: tests/**/*.test.ts`. |
| `tests/repairpal/catalog-crawl.manual.spec.ts` (create) | The Playwright crawler (orchestration + in-page fetch + CSV writing + anchor assertions). Run explicitly + headed; ignored by Vitest (not `*.test.ts`). |

**Conventions confirmed:**
- Vitest `include` is `tests/**/*.test.ts` only (`vitest.config.ts`), environment `edge-runtime`. So the helpers test runs in Vitest; the `.helpers.ts` and `.manual.spec.ts` do not.
- Playwright `testDir: ./tests`; existing `.spec.ts` precedent incl. `tests/late-start-review.manual.spec.ts`. Run the crawler by **explicit path** so it never sweeps other files.

**Commands:**
- Vitest one file: `npx vitest run tests/repairpal/catalogCrawl.helpers.test.ts`
- Typecheck: `npx tsc -p convex --noEmit` does NOT cover `tests/`. Use `npx tsc --noEmit` (root) OR `npx playwright test tests/repairpal/catalog-crawl.manual.spec.ts --list` to confirm the spec compiles/loads.
- The crawl (Task 5, user-run, headed): `npx playwright test tests/repairpal/catalog-crawl.manual.spec.ts --project=chromium --headed`

⚠️ **Commit hygiene (every task):** a pre-staged file `docs/superpowers/handoffs/2026-06-15-labor-sources-handoff.md` is staged but NOT ours. Commit ONLY with explicit pathspecs (`git commit <file1> <file2> -m ...`) — never a bare `git commit` — and verify with `git show --stat HEAD` that only your files are in the commit; if the handoff got swept in, `git reset --soft HEAD~1` and redo with pathspecs.

---

### Task 1: CSV serialization helpers (`csvEscape`, `toCsvRow`, `toCsv`)

**Files:**
- Create: `tests/repairpal/catalogCrawl.helpers.ts`
- Test: `tests/repairpal/catalogCrawl.helpers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/repairpal/catalogCrawl.helpers.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { csvEscape, toCsvRow, toCsv } from "./catalogCrawl.helpers";

describe("csvEscape", () => {
  it("passes through plain values, quotes only when needed", () => {
    expect(csvEscape("Civic")).toBe("Civic");
    expect(csvEscape(21446)).toBe("21446");
    expect(csvEscape("430i Gran Coupe")).toBe("430i Gran Coupe"); // space, no comma → no quotes
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });
});

describe("toCsvRow / toCsv", () => {
  it("joins a row and builds a full CSV with header + trailing newline", () => {
    expect(toCsvRow([21446, "Honda", "a,b"])).toBe('21446,Honda,"a,b"');
    expect(toCsv(["id", "name"], [[1, "Brakes"], [2, "x,y"]])).toBe('id,name\n1,Brakes\n2,"x,y"\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/repairpal/catalogCrawl.helpers.test.ts`
Expected: FAIL — cannot resolve `./catalogCrawl.helpers`.

- [ ] **Step 3: Write minimal implementation**

Create `tests/repairpal/catalogCrawl.helpers.ts`:

```typescript
/**
 * Pure helpers for the RepairPal catalog crawler (tests/repairpal/catalog-crawl.manual.spec.ts).
 * NO fs / NO Playwright imports — kept edge-runtime-safe so Vitest can unit-test them.
 */

/** CSV-escape one value: quote + double-up quotes only when it contains , " CR or LF. */
export function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One CSV record (no trailing newline). */
export function toCsvRow(values: (string | number)[]): string {
  return values.map(csvEscape).join(",");
}

/** Full CSV: header row + data rows + trailing newline. */
export function toCsv(headers: string[], rows: (string | number)[][]): string {
  return [toCsvRow(headers), ...rows.map(toCsvRow)].join("\n") + "\n";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/repairpal/catalogCrawl.helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit tests/repairpal/catalogCrawl.helpers.ts tests/repairpal/catalogCrawl.helpers.test.ts -m "feat(repairpal-catalog): CSV serialization helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Verify with `git show --stat HEAD` (exactly 2 files).

---

### Task 2: `extractServices` (structural service extraction from page HTML)

Extracts service objects from the repair-services page's embedded flight data. Services are `…"id":N,"name":"…","emuOperationTaxonomyCategoryId":…` (in the raw HTML the quotes are backslash-escaped, e.g. `\"id\":30,…`). **Category** objects look similar but are followed by `"icon"`, so we anchor on the `emuOperationTaxonomyCategoryId` marker to extract services only and avoid the category/service id collision.

**Files:**
- Modify: `tests/repairpal/catalogCrawl.helpers.ts`
- Test: `tests/repairpal/catalogCrawl.helpers.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/repairpal/catalogCrawl.helpers.test.ts`:

```typescript
import { extractServices } from "./catalogCrawl.helpers";

// Mirrors the real escaped flight-data shape: a category (followed by "icon"),
// then a services array (each followed by "emuOperationTaxonomyCategoryId"),
// including a unicode-escaped (& = &) service name. In a TS string literal,
// `\\"` is a literal backslash+quote and `\\u0026` is a literal & sequence.
const FIXTURE =
  'x\\"id\\":1,\\"name\\":\\"Brakes\\",\\"icon\\":\\"$L31\\"}' +
  ',\\"services\\":[' +
  '{\\"id\\":1,\\"name\\":\\"AC Compressor Replacement\\",\\"emuOperationTaxonomyCategoryId\\":7,\\"popularityRank\\":null,\\"scheduled\\":false}' +
  ',{\\"id\\":30,\\"name\\":\\"Brake Pad Replacement\\",\\"emuOperationTaxonomyCategoryId\\":1}' +
  ',{\\"id\\":99,\\"name\\":\\"Heating \\u0026 AC Service\\",\\"emuOperationTaxonomyCategoryId\\":3}]';

describe("extractServices", () => {
  it("extracts services (not categories) and decodes unicode names", () => {
    expect(extractServices(FIXTURE)).toEqual([
      { service_id: 1, service_name: "AC Compressor Replacement" },
      { service_id: 30, service_name: "Brake Pad Replacement" },
      { service_id: 99, service_name: "Heating & AC Service" },
    ]);
  });
  it("excludes the category object (followed by icon, not emuOperationTaxonomyCategoryId)", () => {
    expect(extractServices(FIXTURE).some((s) => s.service_name === "Brakes")).toBe(false);
  });
  it("returns [] when nothing matches", () => {
    expect(extractServices("no services here")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/repairpal/catalogCrawl.helpers.test.ts`
Expected: FAIL — `extractServices` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `tests/repairpal/catalogCrawl.helpers.ts`:

```typescript
/** Decode a JSON string body (handles \uXXXX, \\, \" …). Falls back to a manual
 *  unescape if the captured fragment isn't a clean JSON string body. */
function decodeJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw
      .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\(.)/g, "$1");
  }
}

/** Extract RepairPal service objects from a repair-services page's HTML.
 *  Anchors on the `emuOperationTaxonomyCategoryId` field that follows each service's
 *  name — categories (followed by `icon`) are NOT matched, avoiding the id collision. */
export function extractServices(html: string): Array<{ service_id: number; service_name: string }> {
  // Name body `(?:[^\\]|\\(?!"))*?` treats \" as a hard terminator (so a category,
  // lacking the emuOperationTaxonomyCategoryId tail, can't bleed into the next service)
  // while still allowing \uXXXX escapes. Assumes service names contain no embedded quote.
  const re = /\\"id\\":(\d+),\\"name\\":\\"((?:[^\\]|\\(?!"))*?)\\",\\"emuOperationTaxonomyCategoryId\\"/g;
  const out: Array<{ service_id: number; service_name: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push({ service_id: Number(m[1]), service_name: decodeJsonString(m[2]) });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/repairpal/catalogCrawl.helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit tests/repairpal/catalogCrawl.helpers.ts tests/repairpal/catalogCrawl.helpers.test.ts -m "feat(repairpal-catalog): structural service extraction from page HTML

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Verify `git show --stat HEAD` (exactly 2 files).

---

### Task 3: `dedupById`

**Files:**
- Modify: `tests/repairpal/catalogCrawl.helpers.ts`
- Test: `tests/repairpal/catalogCrawl.helpers.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/repairpal/catalogCrawl.helpers.test.ts`:

```typescript
import { dedupById } from "./catalogCrawl.helpers";

describe("dedupById", () => {
  it("keeps the first occurrence per id, preserves order", () => {
    const items = [
      { service_id: 30, service_name: "Brake Pad Replacement" },
      { service_id: 128, service_name: "Spark Plug Replacement" },
      { service_id: 30, service_name: "Brake Pad Replacement (dup)" },
    ];
    expect(dedupById(items, "service_id")).toEqual([
      { service_id: 30, service_name: "Brake Pad Replacement" },
      { service_id: 128, service_name: "Spark Plug Replacement" },
    ]);
  });
  it("handles empty input", () => {
    expect(dedupById([], "service_id")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/repairpal/catalogCrawl.helpers.test.ts`
Expected: FAIL — `dedupById` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `tests/repairpal/catalogCrawl.helpers.ts`:

```typescript
/** Dedupe by a key field, keeping the first occurrence and preserving order. */
export function dedupById<T extends Record<string, any>>(items: T[], idKey: keyof T): T[] {
  const seen = new Map<any, T>();
  for (const it of items) {
    if (!seen.has(it[idKey])) seen.set(it[idKey], it);
  }
  return [...seen.values()];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/repairpal/catalogCrawl.helpers.test.ts`
Expected: PASS (all helper tests green).

- [ ] **Step 5: Commit**

```bash
git commit tests/repairpal/catalogCrawl.helpers.ts tests/repairpal/catalogCrawl.helpers.test.ts -m "feat(repairpal-catalog): dedupById helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The Playwright crawler spec

Builds the full crawler. Not unit-tested (live browser + external site); validated by compile/list here and the live run in Task 5. Uses the helpers from Tasks 1–3.

**Files:**
- Create: `tests/repairpal/catalog-crawl.manual.spec.ts`

- [ ] **Step 1: Write the crawler**

Create `tests/repairpal/catalog-crawl.manual.spec.ts`:

```typescript
/**
 * RepairPal global ID catalog crawler — MANUAL, headed, one-off.
 * Run: npx playwright test tests/repairpal/catalog-crawl.manual.spec.ts --project=chromium --headed
 * Writes CSVs to OUT_DIR (default: the user's Downloads). Resumable; re-running
 * continues base_vehicles from where it left off. Read-only against RepairPal.
 *
 * See docs/superpowers/specs/2026-06-15-repairpal-catalog-crawl-design.md
 */
import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { toCsv, toCsvRow, extractServices, dedupById } from "./catalogCrawl.helpers";

const ZIP = "10001";
const START_YEAR = 2000;
const DELAY_MS = Number(process.env.DELAY_MS ?? 200);
const API = "https://repairpal.com/next-api/estimator-flow";
const OUT_DIR = process.env.OUT_DIR ?? "C:\\Users\\manso\\Downloads";

// Diverse probe vehicles whose repair-services pages are unioned for the full
// service catalog: sedan / older-V6 / truck / luxury-Euro / EV (resolved 2026-06-15).
const SERVICE_PROBE_IDS = [21446, 27442, 76380, 77615, 77342];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("crawl RepairPal global ID catalog", async ({ page }) => {
  test.setTimeout(45 * 60 * 1000); // 45 minutes
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // In-page fetch (same-origin, carries the cleared CF session). Retries 3x with
  // backoff; returns parsed JSON or null.
  async function fetchJson(url: string): Promise<any> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await page.evaluate(async (u) => {
          const r = await fetch(u, { headers: { accept: "application/json" } });
          return { status: r.status, ct: r.headers.get("content-type") ?? "", body: await r.text() };
        }, url);
        if (res.status === 200 && res.ct.includes("json")) {
          try {
            return JSON.parse(res.body);
          } catch {
            /* not JSON (challenge?) — fall through to retry */
          }
        }
      } catch {
        /* evaluate threw — retry */
      }
      await sleep(1000 * Math.pow(3, attempt));
    }
    return null;
  }

  // 1. Establish session; clear the Cloudflare "Just a moment..." interstitial.
  await page.goto(`https://repairpal.com/estimator/car-selector?zipCode=${ZIP}`, {
    waitUntil: "domcontentloaded",
  });
  await expect
    .poll(async () => await page.title(), { timeout: 120000, intervals: [2000] })
    .not.toContain("Just a moment");

  // 2. Discover valid years + global makes.
  const thisYear = new Date().getFullYear();
  const makesById = new Map<number, string>();
  const validYears: number[] = [];
  const yearMakes: Array<{ year: number; makeId: number }> = [];
  for (let y = START_YEAR; y <= thisYear + 1; y++) {
    const makes = await fetchJson(`${API}/makes?year=${y}`);
    await sleep(DELAY_MS);
    if (!Array.isArray(makes) || makes.length === 0) continue;
    validYears.push(y);
    for (const m of makes) {
      makesById.set(Number(m.id), String(m.name));
      yearMakes.push({ year: y, makeId: Number(m.id) });
    }
  }
  console.log(`[catalog] valid years: ${validYears.length}, makes: ${makesById.size}, pairs: ${yearMakes.length}`);

  // 3. Resume: read any existing base_vehicles.csv to skip completed (year,makeId).
  //    Model names contain no commas, so the first three numeric columns are split-safe.
  const bvPath = path.join(OUT_DIR, "repairpal_base_vehicles.csv");
  const BV_HEADER = "base_vehicle_id,year,make_id,make_name,model_id,model_name,slug";
  const done = new Set<string>();
  if (fs.existsSync(bvPath)) {
    const lines = fs.readFileSync(bvPath, "utf8").split(/\r?\n/).slice(1);
    for (const ln of lines) {
      if (!ln) continue;
      const cols = ln.split(",");
      if (cols.length >= 3) done.add(`${cols[1]}:${cols[2]}`);
    }
  } else {
    fs.writeFileSync(bvPath, BV_HEADER + "\n");
  }

  // 4. Crawl base-vehicles, appending after each completed (year,make).
  const failures: Array<{ stage: string; year: number; makeId: number }> = [];
  let pairsDone = 0;
  for (const { year, makeId } of yearMakes) {
    if (done.has(`${year}:${makeId}`)) continue;
    const bvs = await fetchJson(`${API}/base-vehicles?year=${year}&makeId=${makeId}`);
    await sleep(DELAY_MS);
    if (!Array.isArray(bvs)) {
      failures.push({ stage: "base_vehicles", year, makeId });
      continue;
    }
    const rows = bvs.map((b: any) => [
      Number(b.id),
      year,
      makeId,
      makesById.get(makeId) ?? String(b.makeName ?? ""),
      Number(b.modelId ?? 0),
      String(b.modelName ?? ""),
      String(b.slug ?? ""),
    ]);
    if (rows.length) fs.appendFileSync(bvPath, rows.map((r) => toCsvRow(r)).join("\n") + "\n");
    done.add(`${year}:${makeId}`);
    if (++pairsDone % 50 === 0) console.log(`[catalog] base-vehicles pairs done: ${pairsDone}`);
  }

  // 5. makes.csv
  fs.writeFileSync(
    path.join(OUT_DIR, "repairpal_makes.csv"),
    toCsv(["make_id", "make_name"], [...makesById].map(([id, name]) => [id, name])),
  );

  // 6. Services: union the embedded catalog across the diverse probe vehicles.
  const services: Array<{ service_id: number; service_name: string }> = [];
  for (const id of SERVICE_PROBE_IDS) {
    await page.goto(`https://repairpal.com/estimator/repair-services?zipCode=${ZIP}&baseVehicleId=${id}`, {
      waitUntil: "domcontentloaded",
    });
    await sleep(DELAY_MS);
    services.push(...extractServices(await page.content()));
  }
  const uniqServices = dedupById(services, "service_id");
  fs.writeFileSync(
    path.join(OUT_DIR, "repairpal_services.csv"),
    toCsv(["service_id", "service_name"], uniqServices.map((s) => [s.service_id, s.service_name])),
  );

  // 7. Manifest + anchor self-checks.
  const bvText = fs.readFileSync(bvPath, "utf8");
  const anchors = {
    civic_2015_21446: /(^|\n)21446,2015,/.test(bvText),
    camry_2005_27442: /(^|\n)27442,2005,/.test(bvText),
    service_brake_30: uniqServices.some((s) => s.service_id === 30),
    service_spark_128: uniqServices.some((s) => s.service_id === 128),
    service_oil_107: uniqServices.some((s) => s.service_id === 107),
  };
  fs.writeFileSync(
    path.join(OUT_DIR, "repairpal_catalog_manifest.json"),
    JSON.stringify(
      {
        crawled_at: new Date().toISOString(),
        zip_code: ZIP,
        start_year: START_YEAR,
        end_year: thisYear + 1,
        valid_years: validYears,
        counts: {
          makes: makesById.size,
          base_vehicles: bvText.trim().split("\n").length - 1,
          services: uniqServices.length,
        },
        failures,
        anchor_checks: anchors,
      },
      null,
      2,
    ),
  );
  console.log(`[catalog] DONE — out: ${OUT_DIR}`, anchors);

  // 8. Validate (fail the run if the catalog is untrustworthy).
  expect(makesById.size).toBeGreaterThanOrEqual(30);
  expect(uniqServices.length).toBeGreaterThanOrEqual(150);
  expect(bvText.trim().split("\n").length - 1).toBeGreaterThanOrEqual(5000);
  expect(anchors.civic_2015_21446).toBe(true);
  expect(anchors.camry_2005_27442).toBe(true);
  expect(anchors.service_brake_30).toBe(true);
  expect(anchors.service_spark_128).toBe(true);
});
```

- [ ] **Step 2: Confirm it compiles / Playwright discovers it (no live run yet)**

Run: `npx playwright test tests/repairpal/catalog-crawl.manual.spec.ts --list`
Expected: lists one test (`crawl RepairPal global ID catalog`) with no TypeScript/syntax errors. (If Playwright browsers aren't installed yet, `--list` still works — it only parses.)

- [ ] **Step 3: Confirm Vitest still ignores the spec and the suite is green**

Run: `npx vitest run tests/repairpal/catalogCrawl.helpers.test.ts`
Expected: PASS, and the `.manual.spec.ts` is NOT collected by Vitest (only `*.test.ts` is).

- [ ] **Step 4: Commit**

```bash
git commit tests/repairpal/catalog-crawl.manual.spec.ts -m "feat(repairpal-catalog): headed Playwright catalog crawler

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Verify `git show --stat HEAD` (exactly 1 file).

---

### Task 5: Live headed crawl run (user-executed)

Produces the actual CSVs. Headed so the operator can watch and clear any Cloudflare challenge. Run from a machine with a display (the user's), not the sandbox/deployment.

**Files:** none (runtime only; output → `C:\Users\manso\Downloads`).

- [ ] **Step 1: Ensure the Chromium browser is installed**

Run: `npx playwright install chromium`
Expected: chromium present (downloads it if missing).

- [ ] **Step 2: (Optional) fast smoke before the full crawl**

Temporarily narrow the run by setting a single year via env is not wired; instead trust Task 4's `--list` + helper unit tests. If you want a live smoke, run the full command and watch the first `[catalog] valid years…` log line appear within ~30s (confirms the CF clear + in-page fetch works), then let it finish or Ctrl-C and resume later (it's resumable).

- [ ] **Step 3: Run the full headed crawl**

Run: `npx playwright test tests/repairpal/catalog-crawl.manual.spec.ts --project=chromium --headed`
Expected: a Chromium window opens, the run logs `[catalog] valid years…`, then periodic `base-vehicles pairs done: N`, finishing in ~8–15 min with `[catalog] DONE` and all anchor assertions passing (test reports PASS). If a Cloudflare "Just a moment…" page appears, solve it in the window; the crawler waits up to 120s for the title to clear.

- [ ] **Step 4: Verify the output**

Check `C:\Users\manso\Downloads` for:
- `repairpal_makes.csv` (≥ 30 rows)
- `repairpal_base_vehicles.csv` (thousands of rows; contains `21446,2015,…,Civic,…` and `27442,2005,…,Camry,…`)
- `repairpal_services.csv` (≥ 150 rows; contains `30,Brake Pad Replacement` and `128,Spark Plug Replacement`)
- `repairpal_catalog_manifest.json` (counts + `anchor_checks` all true, `failures` empty or few)

Confirm the BMW trim-as-model fix: `repairpal_base_vehicles.csv` rows for 2019 BMW include `330i`, `M340i` etc. (the case that motivated this).

No commit — the CSVs are the user's working artifact, not committed.

---

## Self-Review

**1. Spec coverage:**
- §3 mechanism (headed Playwright, in-page fetch, CF clear) → Task 4 (goto + `expect.poll` title clear + `page.evaluate` fetch). ✓
- §4.1 years (probe 2000→now) → Task 4 step 2. ✓
- §4.2 makes / §4.3 base-vehicles → Task 4 steps 2 & 4. ✓
- §4.4 services (structural extraction, union across probe vehicles) → Task 2 (`extractServices`) + Task 4 step 6. ✓
- §5 outputs (3 CSVs + manifest to Downloads) → Task 4 steps 4–7; schemas match. ✓
- §6 politeness/resume/retry → Task 4 (`DELAY_MS`, resume via `done` set, `fetchJson` 3× backoff, `failures`). ✓
- §7 probe vehicles → concrete `SERVICE_PROBE_IDS` (Task 4). ✓
- §8 validation anchors → Task 4 step 7–8 + Task 5 step 4. ✓
- §9 location/run + vitest separation → File Structure + Task 4 steps 2–3. ✓
- §10 caveats (scale, CF) → handled by resume + the title-clear wait. ✓
- §2 non-goals (no matcher/variants/integration; no Convex/schema changes) → only the 3 new files; nothing in `convex/`. ✓

**2. Placeholder scan:** No TBD/TODO; full code in every code step; commands have expected output; `SERVICE_PROBE_IDS` are concrete resolved IDs, not placeholders. ✓

**3. Type consistency:** helpers `extractServices`/`dedupById` return `{service_id, service_name}`; the crawler consumes those exact keys (`s.service_id`, `s.service_name`) and dedups on `"service_id"`. `toCsvRow`/`toCsv` signatures match their call sites. ✓

---

## Notes for the implementer

- The crawler is intentionally one cohesive spec (orchestration that can't be meaningfully unit-tested); all pure logic lives in the tested helpers. Don't try to TDD the browser flow.
- `expect.poll(...).not.toContain(...)` is valid Playwright assertion API; if your Playwright version rejects the form, use a manual loop polling `page.title()` until it lacks "Just a moment" or 120s elapses.
- Root `npx tsc --noEmit` may surface unrelated pre-existing errors in the repo; prefer `npx playwright test … --list` to confirm THIS spec compiles in isolation.
- Task 5 is user-run (headed, needs a display). During subagent execution, stop after Task 4 and hand Task 5 to the user with the exact command, unless a headed display is available.
