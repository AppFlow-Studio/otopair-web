/**
 * Drives Oto through the real website chat on a running dev server: the
 * surface visitors actually use, with the site's own cards, safety net and
 * private-agent session. Shared by qa.mjs (one question per conversation) and
 * chat-sim.mjs (multi-turn scenarios).
 *
 * Nothing a test types reaches an inbox or the shared database. The
 * launch-list POST is answered in the browser: the real route saves the
 * sign-up as a Convex user AND emails the visitor and the team. Any Convex
 * pre-signup mutation sent from the page itself is refused too. Oto's
 * save_presignup tool still runs end to end against those stand-ins.
 */

import { chromium } from "@playwright/test";
import { API_KEY } from "./lib.mjs";

export const GREETING = /^Hi, I'?m Oto from Otopair/i;

/**
 * Stop before a run when the ElevenLabs account has no credits left. Every
 * conversation here spends real credits (a full run is ~100 conversations),
 * and an exhausted account doesn't fail loudly: sessions are refused and the
 * site answers with its scripted demo instead (2026-09-15: the Starter plan's
 * 30,000 monthly credits ran out mid-run).
 */
export async function checkCredits() {
  if (!API_KEY) return;
  const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": API_KEY } }).catch(() => null);
  if (!res?.ok) return;
  const s = await res.json();
  const left = (s.character_limit ?? 0) - (s.character_count ?? 0);
  const reset = s.next_character_count_reset_unix ? new Date(s.next_character_count_reset_unix * 1000).toISOString().slice(0, 10) : "unknown";
  console.log(`ElevenLabs credits: ${left.toLocaleString()} of ${(s.character_limit ?? 0).toLocaleString()} left (${s.tier} plan, resets ${reset})`);
  if (left <= 0) {
    console.error("✖ No ElevenLabs credits left — every conversation would be refused. Add credits or wait for the reset.");
    process.exit(1);
  }
}
const OTO_BUBBLES = ".lg\\:order-1 div.flex.justify-start > p";
const CARD_TITLE = ".order-3 div.rounded-\\[20px\\] h3";
const INPUT = 'input[aria-label="Message Oto"]:visible, textarea[aria-label="Message Oto"]:visible';

export const launchBrowser = () => chromium.launch();

/**
 * Open the home page in a fresh context (so a fresh conversation) and return a
 * handle for talking to Oto.
 */
export async function openChat(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const t0 = Date.now();
  const since = () => Date.now() - t0;
  const log = {
    credentialStatus: null,
    events: [], // { t, kind: "tool" | "agent" | "user", name?, params?, text? }
    socketClosedAt: null,
    blockedWrites: 0,
    mockedLaunchList: 0,
  };

  await page.route("**/api/waitlist", (route) => {
    log.mockedLaunchList++;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, message: "Successfully joined waitlist!", saved: true }),
    });
  });
  await page.routeWebSocket(/\.convex\.cloud\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (typeof message === "string" && message.includes('"Mutation"')) {
        let m = null;
        try {
          m = JSON.parse(message);
        } catch {}
        if (m?.type === "Mutation" && /createStub/.test(m.udfPath ?? "")) {
          log.blockedWrites++;
          ws.send(
            JSON.stringify({
              type: "MutationResponse",
              requestId: m.requestId,
              success: false,
              result: "Blocked by the Oto simulation: nothing was written.",
              logLines: [],
            })
          );
          return;
        }
      }
      server.send(message);
    });
  });

  page.on("response", (r) => {
    if (r.url().includes("/api/elevenlabs/signed-url")) log.credentialStatus = r.status();
  });
  page.on("websocket", (ws) => {
    if (!ws.url().includes("elevenlabs")) return;
    ws.on("framereceived", ({ payload }) => {
      let m = null;
      try {
        m = JSON.parse(String(payload));
      } catch {
        return;
      }
      if (m.type === "client_tool_call") {
        log.events.push({ t: since(), kind: "tool", name: m.client_tool_call?.tool_name, params: m.client_tool_call?.parameters ?? {} });
      } else if (m.type === "agent_tool_response") {
        // Every tool the agent ran, system tools included (end_call, etc.).
        const r = m.agent_tool_response ?? {};
        log.events.push({ t: since(), kind: "tool_response", name: r.tool_name, toolType: r.tool_type, isError: r.is_error });
      } else if (m.type === "agent_response") {
        log.events.push({ t: since(), kind: "agent", text: String(m.agent_response_event?.agent_response ?? "") });
      }
    });
    ws.on("close", () => {
      log.socketClosedAt ??= since();
    });
  });

  await page.goto(`${base}/`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForLoadState("load").catch(() => {});
  await page.waitForTimeout(1500);

  const otoBubbles = () =>
    page.evaluate(
      (sel) => [...document.querySelectorAll(sel)].map((p) => p.textContent.trim()).filter(Boolean),
      OTO_BUBBLES
    );

  /**
   * Type a message, send it, and wait until Oto's reply stops changing.
   * Returns the new Oto bubbles, the card on screen, and what the agent did
   * on its socket during the turn.
   */
  async function say(text, { timeoutMs = 60_000, settleMs = 5_000 } = {}) {
    const bubblesBefore = (await otoBubbles()).length;
    const eventsBefore = log.events.length;
    const input = page.locator(INPUT).first();
    await input.click();
    await input.fill(text);
    const sentAt = since();
    await page.getByRole("button", { name: "Send" }).first().click();

    let bubbles = [];
    let last = "";
    let stableSince = 0;
    while (since() - sentAt < timeoutMs) {
      await page.waitForTimeout(1000);
      const fresh = (await otoBubbles()).slice(bubblesBefore).filter((t) => !GREETING.test(t));
      const joined = fresh.join("\n");
      if (joined && joined === last) {
        stableSince ||= Date.now();
        if (Date.now() - stableSince >= settleMs) break;
      } else {
        stableSince = 0;
        last = joined;
        bubbles = fresh;
      }
    }

    const card = await page
      .locator(CARD_TITLE)
      .first()
      .textContent({ timeout: 1500 })
      .catch(() => null);
    const turn = log.events.slice(eventsBefore);
    const agentTexts = turn.filter((e) => e.kind === "agent" && !GREETING.test(e.text)).map((e) => e.text);
    const firstAgent = turn.find((e) => e.kind === "agent" && !GREETING.test(e.text));
    const firstTool = turn.find((e) => e.kind === "tool");
    return {
      bubbles,
      answer: bubbles.join("\n"),
      card: card?.trim() ?? null,
      tools: turn.filter((e) => e.kind === "tool").map((e) => ({ name: e.name, params: e.params })),
      systemTools: turn.filter((e) => e.kind === "tool_response" && e.toolType === "system").map((e) => e.name),
      agentTexts,
      firstReplyMs: firstAgent ? firstAgent.t - sentAt : null,
      firstToolMs: firstTool ? firstTool.t - sentAt : null,
      seconds: Math.round((since() - sentAt) / 1000),
    };
  }

  return { page, context, log, say, close: () => context.close() };
}

/** True when a bubble repeats the one before it word for word (or extends it). */
export function repeatsVerbatim(bubbles) {
  return bubbles.some((b, i) => i > 0 && b && bubbles[i - 1] && b.startsWith(bubbles[i - 1]));
}

// A plain-JS copy of restates() in components/flagship/oto-chat-text.ts, which
// the chat uses to merge a reworded repeat on screen. The harness applies it to
// the agent's raw socket messages instead, to report how often the MODEL still
// answers twice. Keep the two in step.
const STOPWORDS = new Set(
  (
    "a an the and or but if so to of in on at for with is are be was it its this that you your we our " +
    "they their them can will not no do does as by from about after again also because been before being " +
    "both could doing done each even every have having here into just like made make many more most much " +
    "must only other over really same should since some such than then there these those through very " +
    "want were what when where which while would i i'm me my you'll you're you'd it's that's there's " +
    "don't doesn't isn't won't can't"
  ).split(" ")
);
const tokens = (text) => (text.toLowerCase().match(/[a-z0-9$']+/g) ?? []).filter((w) => !STOPWORDS.has(w));
const containment = (part, whole) => {
  let shared = 0;
  for (const x of part) if (whole.has(x)) shared++;
  return part.size ? shared / part.size : 0;
};
export function restates(a, b) {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const s = tokens(shorter);
  const l = tokens(longer);
  const words = (t) => new Set(t.filter((w) => w.length > 3));
  const phrases = (t) => new Set(t.slice(1).map((w, i) => `${t[i]} ${w}`));
  const sWords = words(s);
  const sPhrases = phrases(s);
  if (sWords.size < 5 || sPhrases.size < 4) return false;
  return containment(sWords, words(l)) >= 0.5 && containment(sPhrases, phrases(l)) >= 0.25;
}

/** True when any two of the agent's messages in one turn say the same thing. */
export function agentRepeated(texts) {
  return texts.some((t, i) => texts.slice(0, i).some((u) => u.startsWith(t) || t.startsWith(u) || restates(u, t)));
}
