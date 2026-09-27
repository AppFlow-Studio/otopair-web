/**
 * Shared plumbing for the Oto improvement loop.
 *
 * The loop has two halves that answer two different questions:
 *   sim.mjs — does the AGENT do its job? (conversation, funnel, guardrails)
 *   ui.mjs  — does the SCREEN do its job? (the cards its tool calls render)
 * loop.mjs runs both, diffs against the last stored run, and fails on
 * regression. Runs are committed under docs/oto/runs so the baseline travels
 * with the repo instead of living on one machine.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const FIXTURES = join(HERE, "fixtures");
export const RUNS = join(ROOT, "docs", "oto", "runs");

/* ---------------- env ---------------- */

export function loadEnv() {
  let raw = "";
  try {
    raw = readFileSync(join(ROOT, ".env.local"), "utf8");
  } catch {
    return {};
  }
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trimStart().startsWith("#")) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = loadEnv();
export const API_KEY = env.ELEVENLABS_API_KEY;
export const AGENT_ID = env.ELEVENLABS_AGENT_ID || env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID;

/** ElevenLabs REST call. Never logs the key. */
export async function el(path, init = {}) {
  if (!API_KEY) throw new Error("ELEVENLABS_API_KEY missing from .env.local");
  const res = await fetch(`https://api.elevenlabs.io${path}`, {
    ...init,
    headers: { "xi-api-key": API_KEY, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
  }
  return body;
}

/* ---------------- credits ---------------- */

/**
 * The agent half is NOT free: every persona is a full multi-turn LLM
 * conversation billed to the ElevenLabs account, and the account this repo
 * points at is on a plan with a hard monthly character allowance. Running the
 * loop a few times can exhaust it — and when it is exhausted the LIVE SITE
 * stops reaching the agent and silently falls back to the scripted demo, with
 * no indication to the visitor. That happened on 2026-09-07.
 *
 * So the loop asks before it spends.
 */
export async function credits() {
  try {
    const s = await el("/v1/user/subscription");
    const limit = s.character_limit ?? 0;
    const used = s.character_count ?? 0;
    return {
      tier: s.tier,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      resets: s.next_character_count_reset_unix
        ? new Date(s.next_character_count_reset_unix * 1000).toISOString().slice(0, 16).replace("T", " ")
        : null,
    };
  } catch {
    return null;
  }
}

/* ---------------- fixtures ---------------- */

export const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

/* ---------------- run storage ---------------- */

export function listRuns() {
  if (!existsSync(RUNS)) return [];
  return readdirSync(RUNS)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

export function latestRun(excludeFile) {
  const files = listRuns().filter((f) => f !== excludeFile);
  if (!files.length) return null;
  const f = files[files.length - 1];
  return { file: f, data: JSON.parse(readFileSync(join(RUNS, f), "utf8")) };
}

export function saveRun(run, stamp) {
  mkdirSync(RUNS, { recursive: true });
  const file = `${stamp}.json`;
  writeFileSync(join(RUNS, file), JSON.stringify(run, null, 2));
  return file;
}

/* ---------------- text helpers ---------------- */

/** Strip ElevenLabs voice-direction tags so scoring reads what a visitor reads. */
export const clean = (s) =>
  (s ?? "")
    .replace(/\[[a-zA-Z][a-zA-Z ]{0,24}\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

/**
 * The absolutes: things that must NEVER appear in an agent turn, checked by
 * literal pattern rather than by an LLM judge. Judges drift between runs and
 * cost a call each; these do not. A judge decides whether Oto asked for the
 * car; a regex decides whether it said the fee rate.
 */
export function checkAbsolutes(absolutes, turns) {
  const hits = [];
  for (const a of absolutes) {
    const re = new RegExp(a.pattern, a.flags || "i");
    for (const t of turns) {
      if (t.role !== "agent" || !t.text) continue;
      const m = t.text.match(re);
      if (m) hits.push({ id: a.id, desc: a.desc, match: m[0], turn: t.text.slice(0, 180) });
    }
  }
  return hits;
}

/* ---------------- formatting ---------------- */

export const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

export function bar(passed, total, width = 12) {
  const filled = total ? Math.round((passed / total) * width) : 0;
  return "█".repeat(filled) + "·".repeat(width - filled);
}

/** `+2` / `-1` / `  ` against a previous value. */
export function delta(now, before) {
  if (before === undefined || before === null) return "   new";
  const d = now - before;
  if (d === 0) return "     =";
  return (d > 0 ? "  +" : "  ") + d;
}

export const stamp = (d) =>
  d.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
