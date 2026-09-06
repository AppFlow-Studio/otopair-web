# Design pass to 10/10 — plan for the next session (written 2026-09-05)

Owner: Waleed. Branch: `waleed-design-feedback`. Everything from the SEO build is
**uncommitted** (56 new files, 35 modified, 13 deleted). Do not commit unless asked.

## 0. Why this plan exists

The user graded the rebuilt `/partner-with-us` and `/contact` as not good enough and
asked for every page I made to be audited, remade, and brought to 10/10. Five design
skills are installed and must be used (see §2). This file is the hand-off across a
context reset: read it first, then `DESIGN.md`, then the skills.

## 1. State you inherit

- Dev server: launch.json `otopair-web` (port 3000). **Restart it whenever a NEW file
  introduces Tailwind arbitrary classes** — Turbopack's CSS scan misses new files
  (seen twice; symptom = unstyled page, classes present in HTML but not in the CSS).
- "Before" checkout for screenshots: `../otopair-before` worktree, launch.json
  `otopair-before` (port 3001, `--webpack`). Before-captures already exist in
  `.agent/pw/out/seo-doc/before/`.
- Screenshot harness: `ROUTES='[["/x","x",{"full":true}]]' node .agent/pw/seo-before-after.mjs <label>`
  writes `.agent/pw/out/seo-doc/<label>/`. Browser-pane screenshots are broken; use this.
- Docs (republish same paths to keep URLs):
  - Before/After artifact `5df710cc-…` ← `python .agent/pw/seo-doc-build.py`
  - Change Set artifact `36d6455d-…` ← `python .agent/pw/seo-changeset-build.py`
  - Both builders' data tables live in the scripts; add rows there.
- Playwright CLI: `playwright-cli open <url>` → `snapshot` (refs look like
  `textbox "Your name" [ref=e58]:`) → `fill e58 "…"` → `click e69`.
- Contact form e2e without sending mail: set the honeypot
  `document.querySelector('input[name=company]').value='x'` before submit.
- Production build works (`npx next build`, EXIT 0); shop/service routes are dynamic
  by design (fetchQuery is no-store).
- Already created but **not yet used**: `components/flagship/pill-button.tsx`
  (PillLink / PillAnchor / PillButton / TextLink with the nested-icon hover physics).

## 2. Skills and how each is applied (all in `.claude/skills/`)

| Skill | Use it for | Limits |
| --- | --- | --- |
| `design-taste-frontend` | Design read + dials before each page; §4.7 layout hard rules; §9 AI-tell bans; §14 pre-flight as the 10/10 checklist | Its serif/Inter bans are overridden by the brand (§0.A.5, §11.C: existing brand tokens win) |
| `redesign-existing-projects` | The audit list (typography, color, layout, states, content, components) and fix priority order | Same brand override |
| `high-end-visual-design` | Double-bezel containers, button-in-button CTAs, expo easing `cubic-bezier(0.32,0.72,0,1)`, tinted shadows, py-24+ rhythm | Ignore its font/icon bans (Petrona + Inter + lucide are the project's) and its dark "Ethereal Glass" archetype; ours is "Soft Structuralism" on the sky wash |
| `web-design-guidelines` | Run on every touched file at the end (fetch rules from the URL in the skill) | — |
| `playwright-cli` | e2e checks of forms/nav after rebuilds | — |
| `image-to-code`, `imagegen-*` | Skip: no image-generation tool in this environment | — |

Brand tokens are in `DESIGN.md` (repo root). Never invent a second blue; never use
`#5299fe` on the web; no em-dashes in visible copy (taste §9.G); zero fee rate,
vendor names, price ranges (see memory `seo-audit-phase1` locked rules).

## 3. The design read (declare it at the top of the next session)

"Reading this as: redesign-preserve of a trust-first local marketplace (drivers +
repair shops, Staten Island), soft-structural language on a sky wash with a light
display serif, leaning toward asymmetric split heroes with real product imagery,
bezel-framed surfaces, and restrained spring motion."
Dials: **VARIANCE 6, MOTION 4, DENSITY 3.** Legal/help documents may keep the
centered manifesto hero (taste §4.3 override).

## 4. Real assets to use (the pages fail "real images" today)

| Asset | Shows | Use on |
| --- | --- | --- |
| `/landing/story-health.png` (1024²) | mechanic with tablet, Maintenance Tracker | `/for-shops`, `/partner-with-us` hero, `/how-shops-are-verified` |
| `/landing/story-booking.png` (1336×662) | hand + phone map over Brooklyn Bridge | `/how-it-works`, `/staten-island` hero |
| `/landing/oto-listens-dash.png` (2574×1380) | driver holding phone, "Oto scanning" | `/download`, `/oto` support image |
| `/images/landing/health-phone.png` (498×880) | phone with 87% health ring | `/vehicle-health-score` hero |
| `/images/landing/nyc-map-3d.jpg` (1760×975) | 3D city render | `/coverage` hero, borough pages (vary object-position) |
| `/oto-orb.png`, `/pin-logo-3d.png` | brand orb / 3D pin | `/oto` hero, `/about`, `/press` |
| `/images/landing/app/*.png` | service icons (oil, tires, brakes, battery, engine, inspection) | `/services` bento, service page headers |
| `/landing/oto-listens-driver.png` | blurred driver | low-opacity background texture (careers) |
| Live `NetworkMap` | real pins | `/shops` hero, `/contact` "where" section |

## 5. Phase A — shared system (lifts ~25 shell pages at once)

Files: `components/flagship/page-shell.tsx`, `components/seo/faq.tsx`,
`app/globals.css`, `components/flagship/pill-button.tsx` (exists), new
`components/flagship/bezel.tsx`.

1. `globals.css`: `--ease-expo: cubic-bezier(0.32,0.72,0,1)`; tinted shadow tokens
   (`--shadow-card: 0 1px 2px rgba(26,26,26,.04)`, `--shadow-lift: 0 18px 40px -20px rgba(75,130,165,.35)`).
2. `Bezel` component (double-bezel): outer `rounded-[28px] bg-[#1a1a1a]/[0.035] p-1.5 ring-1 ring-[#1a1a1a]/[0.06]`,
   inner `rounded-[22px] bg-white shadow-[inset_0_1px_0_rgba(255,255,255,.8)]`; used for
   hero visuals, cards, summary panels, form card.
3. `Card` → bezel + hover lift (`-translate-y-0.5`, `--shadow-lift`, 500ms expo).
4. `Summary` → bezel panel.
5. `PageShell` gains `visual?: ReactNode`: when present, hero is an asymmetric split at
   `lg` (text 6/12 left, visual 6/12 right in a Bezel, one soft radial sky glow behind
   it); hero stack stays ≤ 4 text elements; secondary action is `TextLink`.
6. `FaqSection` → two-column editorial at ≥tab (question in serif left, answer right,
   hairline between items). Keep `<dl>`.
7. Section rhythm: `py-12 tab:py-16`; H2 `text-wrap:balance tracking-[-0.01em]`.
8. All CTAs sitewide → `PillLink`/`PillButton` (partner, contact form, 404, borough
   waitlist button, download, press, footer action).
9. Restart the dev server, screenshot `/privacy` and `/help/how-the-20-dollar-hold-works`
   to confirm the shell.

## 6. Phase B — per-page passes (order = user priority, then traffic)

For each: design read → audit against taste §14 + redesign checklist → rebuild →
screenshot 1440 + 390 → self-grade; ship only at 10/10 (every §14 box ticked).

1. **/partner-with-us** (`partner-client.tsx`). Split hero: text left, `story-health.png`
   in a Bezel right. Remove the proof chips from the hero (taste bans trust strips in
   heroes) — fold the facts into PayoutSection. Dashboard grid → asymmetric bento with
   2 tinted cells (sky tint / photo). Ladder + live map stays. Verification ladder stays.
   FAQ two-col. FooterCta with Apply pill. Eyebrows: hero + one more max.
2. **/contact** (`contact-client.tsx`). Drop the hero `<dl>` (support address appears
   3×). Hero: headline + one sentence + form card in a Bezel. Lanes rows stay (rename H2
   to "Pick a lane"). Replace the static Mapbox image with `NetworkMap` (real pins).
   FAQ full-width two-col, aligned to the 1190 grid.
3. **/how-it-works**: hero visual `story-booking.png`; seven steps as a numbered
   ladder with one supporting image; FAQ.
4. **/for-shops**: hero visual `story-health.png`; PayoutSection; dashboard bento
   (reuse partner's); FAQ.
5. **/pricing**: manifesto hero (message is the design); the mechanism as a
   four-row ladder; no numbers except $20 and 24h.
6. **/oto**: hero visual = `oto-orb.png` in a Bezel with glow (the only-Otopair
   detail); can/never lists as two columns; FAQ.
7. **/vehicle-health-score**: hero visual `health-phone.png`; point-split as a
   three-tile bento; FAQ.
8. **/coverage**: hero visual `nyc-map-3d.jpg`; ladder cards → one horizontal
   five-step ladder; live map below.
9. **/staten-island**: hero visual `story-booking.png`; shops grid; neighborhood chips.
10. **/shops** + **/shops/[slug]**: hero visual = `NetworkMap`; profile page: hours as
    a compact 7-day strip, services grouped, photos bento.
11. **/services** + **/services/[slug]** + **/staten-island/[service]**: hero bento
    of the six service icons; per-service header uses its icon.
12. **/download**: hero visual `oto-listens-dash.png`; badges honest.
13. **/about**, **/press**, **/careers**: brand-asset heroes; careers keeps manifesto.
14. **Borough pages** (`borough-page.tsx`): `nyc-map-3d.jpg` hero with per-borough
    `object-position`; waitlist pill.
15. **/help**, **/guides**, legal + policy pages: shell only (Phase A) + spot check.
16. **404**: pill button; bezel cards.

## 7. Phase C — audit, verify, document

1. `web-design-guidelines` pass on every touched file (fetch rules; fix `file:line`).
2. Forbidden-string scan (the grep from the SEO session: fee rate, vendors, ranges,
   "24 hours" payouts, two-way, vetted, June 1, em-dashes `—`).
3. Playwright CLI: contact form (honeypot), borough waitlist, pill nav on mobile.
4. `npx tsc --noEmit` filtered to touched files; `npx next build`.
5. Screenshots of every route (`ROUTES` from `.agent/pw/seo-after-routes.json`),
   copy into `.agent/pw/out/seo-doc/after/`, rebuild both docs, republish both
   artifacts, add a "Design pass" group to the change set.
6. Update memory (`seo-audit-phase1`, `design-skills-installed`).

## 8. What 10/10 means here (the grading rubric)

- Taste §14 pre-flight: every box ticked, mechanically (eyebrow count, CTA intent
  count, zigzag cap, em-dash grep = 0).
- Every page has at least one real image or live component in the hero or first
  section; no page is text-only.
- One accent, one radius system (pills full, panels 28/22 bezel, chips full).
- Motion: entrance reveals present, hover physics on pills and cards, everything
  collapses under reduced motion; no `window.scroll` listeners.
- Forms: labels, autocomplete, inline errors, focus-first-error, aria-live.
- Mobile: single column, 27px gutters, no horizontal scroll, hero fits.
- Copy: answer-first, no filler verbs, no em-dashes, no invented facts.
- Guidelines pass clean; build passes; screenshots reviewed by eye at both widths.

## 9. Not to change (settled)

Home page design and H1; the Listens section's three variants; Figma tokens;
map + logos; route slugs and nav labels; anything under `convex/`.
