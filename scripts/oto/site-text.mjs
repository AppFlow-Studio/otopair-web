/**
 * Snapshot the visible text of every page in the sitemap — the input for
 * checking that Oto (the site's marketing agent) says what the site says.
 *
 *   node scripts/oto/site-text.mjs --out <dir> [--base http://localhost:3000] [--concurrency 4]
 *
 * Writes <dir>/pages/<slug>.txt (title, description, main text) and
 * <dir>/index.json. Needs the dev server (npm run dev).
 */

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = arg("base", "http://localhost:3000");
const OUT = arg("out", null);
const CONCURRENCY = Number(arg("concurrency", "4"));
if (!OUT) {
  console.error("usage: node scripts/oto/site-text.mjs --out <dir> [--base URL] [--concurrency N]");
  process.exit(1);
}
mkdirSync(join(OUT, "pages"), { recursive: true });

const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
const paths = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
  .map((m) => new URL(m[1]).pathname)
  .filter((p, i, all) => all.indexOf(p) === i)
  .sort();

const slugOf = (p) => (p === "/" ? "home" : p.slice(1).replace(/\//g, "__"));

const browser = await chromium.launch();
const index = [];
let next = 0;

async function worker() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  while (next < paths.length) {
    const path = paths[next++];
    try {
      await page.goto(`${BASE}${path}`, { waitUntil: "load", timeout: 180_000 });
      // Walk the page so scroll-revealed sections mount, then read.
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 700) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 60));
        }
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(800);
      const data = await page.evaluate(() => {
        const main = document.querySelector("main") ?? document.body;
        // Nav, footer and the dev-only debug panel repeat on every page.
        const clone = main.cloneNode(true);
        clone.querySelectorAll("nav, footer, script, style, noscript, [aria-hidden='true']").forEach((el) => el.remove());
        return {
          title: document.title,
          description: document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "",
          h1: document.querySelector("h1")?.textContent?.trim() ?? "",
          text: (clone.innerText || clone.textContent || "").replace(/\n{3,}/g, "\n\n").trim(),
        };
      });
      const file = `${slugOf(path)}.txt`;
      writeFileSync(
        join(OUT, "pages", file),
        `URL: ${path}\nTITLE: ${data.title}\nDESCRIPTION: ${data.description}\nH1: ${data.h1}\n\n${data.text}\n`
      );
      index.push({ path, file, title: data.title, words: data.text.split(/\s+/).length });
      console.log(`✓ ${path} (${data.text.split(/\s+/).length} words)`);
    } catch (e) {
      index.push({ path, error: String(e.message ?? e).slice(0, 200) });
      console.log(`✖ ${path}: ${String(e.message ?? e).slice(0, 120)}`);
    }
  }
  await context.close();
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await browser.close();
index.sort((a, b) => a.path.localeCompare(b.path));
writeFileSync(join(OUT, "index.json"), JSON.stringify(index, null, 2));
const failed = index.filter((p) => p.error).length;
console.log(`\n${index.length - failed}/${index.length} pages captured → ${OUT}`);
