/**
 * The screen half of the loop.
 *
 * Every component an Oto tool call can render is summoned in a real browser
 * and checked against one contract. This exists because the cards were built
 * across three files in three sittings and drifted: measured 2026-09-07 they
 * ran 241px to 549px inside a fixed 530px panel, three had lost their header
 * icon, one had no title at all, and the only card whose content the agent
 * composes at runtime had no height cap.
 *
 * It also regression-tests the canvas-ownership bug: pick a card, wait past
 * the connect-timeout fallback, and assert the panel still shows it.
 *
 *   node scripts/oto/ui.mjs [--base http://localhost:3000] [--keep-shots]
 *
 * Needs the dev server up. Returns skipped:true rather than failing if it
 * isn't, so the agent half of the loop can still run on its own.
 */

import { chromium } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fixture, ROOT } from "./lib.mjs";

/** True when this file was run directly (not imported by loop.mjs). */
const isMain = (url) => !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;

const argv = process.argv.slice(2);
const arg = (f, d) => {
  const i = argv.indexOf(f);
  return i === -1 ? d : argv[i + 1];
};
const BASE = arg("--base", process.env.PW_BASE || "http://localhost:3000");
const SHOTS = join(ROOT, ".agent", "pw", "out", "oto-loop");

const contract = fixture("ui-contract.json");
const { panelHeight, settleMs, ownershipWaitMs, cards } = contract;

async function reachable(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 4000);
    const r = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

export async function runUi({ log = console.log, keepShots = false } = {}) {
  if (!(await reachable(BASE))) {
    log(`  dev server not reachable at ${BASE} — skipping the screen half`);
    return { skipped: true, reason: `no dev server at ${BASE}` };
  }
  if (keepShots) mkdirSync(SHOTS, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message.split("\n")[0]));

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => {});
  await page.waitForTimeout(2500);

  // Wake the hero so the canvas panel mounts, then wait out the connect-timeout
  // fallback before measuring anything — it replays the opening message and
  // overwrites the canvas, which silently corrupted an earlier audit.
  await page.getByRole("button", { name: /What can you do/i }).click().catch(() => {});
  await page.waitForTimeout(ownershipWaitMs);

  const trigger = (label) => page.locator("div.fixed button").filter({ hasText: label }).first();
  const cardEl = () => page.locator(".order-3 div.rounded-\\[20px\\]").first();

  const findings = [];
  const measured = [];

  for (const c of cards) {
    const btn = trigger(c.trigger);
    if (!(await btn.count())) {
      findings.push({ card: c.id, rule: "renders", detail: `dev trigger "${c.trigger}" not found` });
      continue;
    }
    await btn.click();
    if (c.slow) await page.waitForTimeout(4000);
    await page.waitForTimeout(settleMs);

    const box = await cardEl().boundingBox().catch(() => null);
    if (!box) {
      findings.push({ card: c.id, rule: "renders", detail: "no card rendered in the panel" });
      continue;
    }

    const m = await cardEl().evaluate((el, ph) => {
      const head = el.querySelector("h3");
      const icon = el.querySelector("svg");
      const r = el.getBoundingClientRect();
      const panel = el.closest(".order-3");
      // Any descendant that scrolls, and whether it fades its cut edge.
      const scrollers = [...el.querySelectorAll("*")]
        .filter((n) => n.scrollHeight > n.clientHeight + 2 && n.clientHeight > 40)
        .map((n) => {
          const cs = getComputedStyle(n);
          const mask = cs.maskImage || cs.webkitMaskImage || "none";
          return {
            hidden: n.scrollHeight - n.clientHeight,
            total: n.scrollHeight,
            faded: mask !== "none" && mask !== "",
            isBody: n.parentElement === el,
          };
        });
      return {
        h: Math.round(r.height),
        panelH: panel ? Math.round(panel.getBoundingClientRect().height) : null,
        title: head ? head.textContent.trim() : null,
        titlePx: head ? parseFloat(getComputedStyle(head).fontSize) : null,
        hasIcon: !!icon,
        pad: getComputedStyle(el).paddingTop,
        radius: getComputedStyle(el).borderTopLeftRadius,
        scrollers,
        panelHeight: ph,
      };
    }, panelHeight);

    measured.push({ card: c.id, ...m });

    if (keepShots) {
      await page.screenshot({
        path: join(SHOTS, c.id + ".png"),
        clip: {
          x: Math.max(0, box.x - 12),
          y: Math.max(0, box.y - 12),
          width: Math.min(box.width + 24, 1440 - Math.max(0, box.x - 12)),
          height: Math.min(box.height + 24, 1000 - Math.max(0, box.y - 12)),
        },
      }).catch(() => {});
    }

    const panelH = m.panelH ?? panelHeight;
    // 1. fills the panel — this is what stops the canvas jumping on every swap
    if (Math.abs(m.h - panelH) > 2) {
      findings.push({
        card: c.id,
        rule: "fills_panel",
        detail: `${m.h}px in a ${panelH}px panel (${m.h > panelH ? "overhangs" : `${panelH - m.h}px of dead air`})`,
      });
    }
    // 2. announces itself
    if (!m.title) findings.push({ card: c.id, rule: "has_title", detail: "no heading element" });
    if (!m.hasIcon) findings.push({ card: c.id, rule: "has_icon", detail: "no header icon" });
    // A card may declare a different title size, but only in the contract and
    // only with a reason — an exception that lives in the fixture is a
    // decision; one that lives only in the component is drift.
    const wantTitle = c.allowTitlePx ?? contract.titlePx;
    if (m.titlePx && Math.abs(m.titlePx - wantTitle) > 0.6) {
      findings.push({ card: c.id, rule: "title_size", detail: `${m.titlePx}px, expected ${wantTitle}px` });
    }
    // 3. never hides content without saying so
    for (const s of m.scrollers) {
      if (!s.faded) {
        findings.push({
          card: c.id,
          rule: "no_silent_clip",
          detail: `${s.hidden}px of ${s.total}px hidden with no fade`,
        });
      }
    }
  }

  // 4. The canvas holds what it was told to show.
  //
  // Regression test for the connect-timeout fallback: sending a message arms a
  // timer that replays that message through the keyword matcher and writes to
  // the canvas when it fires. Anything shown in between gets overwritten. So
  // the test has to send a FRESH message to arm a new timer, pick a different
  // card inside the window, and then wait past it — measuring after a window
  // that has already elapsed proves nothing.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => {});
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /What can you do/i }).click().catch(() => {});
  await page.waitForTimeout(600); // still well inside the window
  await trigger("trust").click();
  await page.waitForTimeout(settleMs);
  const before = await page.locator(".order-3 h3").first().textContent().catch(() => null);
  await page.waitForTimeout(ownershipWaitMs);
  const after = await page.locator(".order-3 h3").first().textContent().catch(() => null);
  if (before !== after) {
    findings.push({
      card: "(canvas)",
      rule: "holds_selection",
      detail: `showed "${before}", became "${after}" ${ownershipWaitMs}ms later with no further input`,
    });
  }

  await browser.close();

  const byRule = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] || 0) + 1;

  return {
    skipped: false,
    cards: cards.length,
    checked: measured.length,
    findings,
    byRule,
    measured,
    pageErrors: [...new Set(pageErrors)],
    heights: measured.length
      ? {
          min: Math.min(...measured.map((m) => m.h)),
          max: Math.max(...measured.map((m) => m.h)),
          spread: Math.max(...measured.map((m) => m.h)) - Math.min(...measured.map((m) => m.h)),
        }
      : null,
  };
}

if (isMain(import.meta.url)) {
  const out = await runUi({ keepShots: argv.includes("--keep-shots") });
  if (out.skipped) {
    console.log("skipped:", out.reason);
    process.exit(0);
  }
  console.log(`\nchecked ${out.checked}/${out.cards} cards`);
  if (out.heights) console.log(`heights min=${out.heights.min} max=${out.heights.max} spread=${out.heights.spread}px`);
  console.log("\n--- contract findings ---");
  if (!out.findings.length) console.log("  none — every card holds the contract");
  for (const f of out.findings) console.log(`  ${f.rule.padEnd(16)} ${f.card.padEnd(18)} ${f.detail}`);
  if (out.pageErrors.length) console.log("\npage errors:", out.pageErrors.join(" | "));
}
