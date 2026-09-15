# The Oto improvement loop

```bash
npm run oto:loop                # both halves, scored against the last run
npm run oto:loop -- --sim       # the agent only
npm run oto:loop -- --ui        # the screen only (needs `npm run dev`)
npm run oto:loop -- --baseline  # record a run without judging it a regression
npm run oto:loop -- --repeat 3  # run each persona 3x (agent output varies)
```

Every run lands in `docs/oto/runs/` and is compared against the previous one.
A pass rate that drops, a newly-violated copy lock, a tool assertion that
starts failing, or a new UI contract breach all exit non-zero. That is what
makes it a loop and not a report.

## Why there are two halves

Oto is two things and they fail differently.

**The agent** (`sim.mjs`) is judged by running the personas in
`fixtures/personas.json` against the live agent through ElevenLabs'
simulate-conversation API. It scores three ways:

| what | how | why |
|---|---|---|
| `criteria` | an LLM judge | only judgement can answer "did it ask for the car?" |
| tool assertions | exact match on the transcript's tool calls | free, and never drifts between runs |
| `absolutes` | literal patterns | an LLM judge drifts; a copy lock must not |

Tool calls are mocked so `decode_vin` doesn't hang waiting for a browser that
isn't there. The mock's *return* value is not reliably plumbed through, which
is exactly why the scoring asserts on the call rather than the response.

**The screen** (`ui.mjs`) drives a real browser through the dev trigger panel
and checks every card a tool call can render against one contract. It also
regression-tests the canvas-ownership bug: send a message, pick a different
card inside the connect-timeout window, and assert the panel still shows what
it was told to.

## The fixtures are the point

The three files in `fixtures/` are the actual subject matter. The scripts are
plumbing.

- **`personas.json`** — visitors, as data. Add one whenever a real
  conversation surprises you. That is how the set is meant to grow.
- **`criteria.json`** — what "good" means, split into the funnel (did Oto do
  the job), helpfulness (was it still worth talking to) and guardrails (things
  it must never do). The helpfulness group is not padding: a run that lifts
  capture while dropping it is a regression, because the free diagnosis is the
  only reason anyone talks to Oto at all.
- **`ui-contract.json`** — the card rules, every one of which was actually
  broken on 2026-09-07 rather than aspirational. A card may declare an
  exception (`allowTitlePx`) but only here and only with a reason: an
  exception in the fixture is a decision, one in the component is drift.

Keep `criteria.json` in step with the agent's own evaluation criteria in the
ElevenLabs dashboard, so a simulated score and a production score mean the
same thing.

## What it found on the first run

Baseline `2026-09-07_13-30-55`, screen half: 26 breaches — 23 cards floating
at their own height in a fixed 530px panel (240–549px), one card overhanging
it, one hiding 583px of content with no visible fade, and the canvas silently
reverting to an earlier card eight seconds after an unrelated message.

Run `13-44-56` after the fixes: 30 cards, 0 breaches, every height 530.

## Adding to it

- A new card: add it to `debug-triggers.tsx` and to `ui-contract.json`. It is
  under test from the next run.
- A new behaviour worth protecting: add a criterion, or better an absolute if
  it is a hard rule.
- A new failure mode you saw for real: add a persona.

## Live checks through the site chat

The loop above tests the agent through ElevenLabs' simulator and the cards
through the dev trigger panel. Two more scripts drive the real website chat on
`npm run dev`, with the site's own session route, safety net and cards:

```bash
node scripts/oto/qa.mjs --questions questions.json --out results.json   # one question per conversation
node scripts/oto/chat-sim.mjs                                           # multi-turn visitors
node scripts/oto/chat-sim.mjs --only safety-and-crisis,adversarial
```

- **`chat-sim.mjs`** plays each visitor in `fixtures/chat-scenarios.json` turn
  by turn. Every Oto turn must keep the rules at the top of the script: no fee
  percentage, no dollar figure but the $20 hold, no "vetted", no guarantee, no
  "book it today", no sample booking passed off as real, no bubble shown twice,
  and the conversation stays open. Each turn's `all` / `any` / `never` patterns
  are hard checks too. `card` and `tools` are warnings, because the agent's
  choice of card varies between runs. It writes `results.json` and a
  `transcript.md` to read, and exits non-zero on a hard failure.
- **`qa.mjs`** asks single questions, typically written from the site's pages,
  and records the answer, the card, the tools the agent called, whether the
  agent answered twice (the chat merges that on screen), and reply latency.

Both go through `site-chat.mjs`, which keeps test sign-ups in the browser: the
launch-list POST is answered locally (the real route emails the visitor and the
team) and the Convex mutation that saves a pre-signup is refused before it
leaves the page.

## The agent is written from here

`scripts/setup-oto-agent.mjs` owns the whole agent: the base prompt
(`base-prompt.md`), the guidance block between its `<<<OTOPAIR_GUIDANCE>>>`
markers, the first message, the tools, the knowledge base
(`docs/oto/knowledge-base/`), the model, guardrails, call limits and
private-agent auth. Dashboard edits are overwritten on the next run. It
refuses to push a fee rate from any of them, refuses a model the account can't
use, and warns when the model is being retired.

Run it with `--dry-run` first. It writes to the live agent.
