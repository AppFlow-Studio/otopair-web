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

## The agent is not written from here

`scripts/setup-oto-agent.mjs` owns the tools and the guidance block between its
`<<<OTOPAIR_GUIDANCE>>>` markers. It does **not** own the Personality, Goal and
Guardrails blocks — those were written in the ElevenLabs dashboard and cannot
be diffed from the repo. That split is how a repo scrubbed of the platform-fee
rate still shipped an agent that said it out loud in seven real conversations.
The script now refuses to be quiet about it: it greps the base prompt for a fee
rate and warns.

Run it with `--dry-run` first. It writes to the agent that serves real
visitors.
