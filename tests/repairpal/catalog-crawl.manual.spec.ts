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
