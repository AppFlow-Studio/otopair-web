# The app, up close: a playbook for product pages built from the real product

How the six Otopair product pages were rebuilt on 2026-09-05, written so the
same method can be run on another product with another codebase. The method
is what transfers; the Otopair specifics are examples.

## 0. The result, in one paragraph

Six marketing pages (how it works, pricing, the AI assistant, a proprietary
score, a partner pitch, a product tour) were rebuilt so that every section is
the real product shown up close: phone screens drawn from the mobile app's
source at the phone's own logical size, the web dashboard in a browser
window, and one object per section lifted out of the device and enlarged so
it reads across the room. The pages sit on the visual language of the
finished home page, each with its own composition, and they were verified at
desktop and phone widths with a headless browser before a proof board was
published. Three earlier attempts (editorial lists, gradient "stage" cards,
line-art scenes) were rejected by the client; this one was accepted.

## 1. Why the earlier attempts failed

Read these before starting, because they are the default failure modes.

| Attempt | What it was | Why it was rejected |
| --- | --- | --- |
| Editorial | Headline + definition lists + FAQ | "Components glued together." No product on the page. |
| Stages | Glass cards on blue gradient plates | "Same thing six times." Safe container, no spin per page. |
| Drawn scenes | Line-art car, lift, island, price tag with leader-line callouts | Reads as a sketch, not a product. Nothing on it looks like the app. |

The common cause: the pages illustrated the product instead of showing it. A
designer's earlier review had already said it plainly: "the website doesn't
look like the app." That sentence is the brief.

## 2. How the plan was made (the creative process, in order)

This is the part that transfers to any project. Each step took minutes; the
order is what mattered.

1. **Look at the current pages cold, next to the finished surface.** Full-
   page captures of the home page and of every page to be redone, side by
   side. Do not read the code first; the code explains, it does not judge.
   Here the home page had glass, gradient plates and real phone screens with
   story loops; the product pages had line drawings floating on white with
   tiny blue callouts. The gap was visible in one screen.
2. **Name the failure in one sentence, in the client's words.** The
   designer's review from three weeks earlier already said it: "the website
   doesn't look like the app." Every prior attempt had illustrated the
   product. The sentence became the thesis: show the product, up close.
3. **Calibrate against production, briefly.** Ten minutes on Mobbin's "How
   It Works" and "Features" sections for web. What the best pages share: the
   real UI at large scale in a device, confident crops, and one object lifted
   out and enlarged beside it. Also what they avoid: icon-card grids,
   diagrams, eyebrows. That is calibration, not a mood board; do not copy a
   layout.
4. **Find what already exists that is faithful.** The home page's phone
   panels were drawn from the app's source in July. So the vocabulary was
   proven; only the scale and the per-page compositions were missing. This
   also answered a later question (which version is the unified one).
5. **Decide the invariant and the variable.** Invariant: the page module
   (hero, three or four sections of short H2 + one sentence + a plate, FAQ)
   and the material (real screens on the home page's plates). Variable: the
   composition inside each plate. "Same thing six times" is what happens
   when the variable is left at its default.
6. **Write the composition matrix before writing code.** One row per page:
   which device (phone, two phones, browser window, no device), which object
   is pulled out, and whether the section moves (pinned scroll, loop,
   crossfade). Rewrite any row that looks like another row. This table is
   the design; the code implements it.
7. **Choose fidelity deliberately.** Screens drawn at the phone's own
   logical size with the app's real values, then zoomed, rather than the
   home page's tiny 232px panels enlarged. Reason: exact numbers can be
   copied from the app's stylesheets without conversion, and zoom keeps type
   crisp at any size.
8. **Build order: system, lab, pages, verification, proof.** The screen
   library first, because every page is assembled from it and one bug fixed
   there is fixed everywhere. A throwaway lab route to look at every screen
   before any page exists. Then pages in the order of most to least
   compositional risk (the pinned walkthrough first). Verification passes
   were decided before building so they would be bounded, not a loop.
9. **Run a parallel draft to check the direction, not to replace the work.**
   Claude Design received the same brief and produced 19 artboards. Where it
   agreed (two-phone assistant section, answer beside fanned sources, the
   pinned walkthrough) that was cheap confirmation. Where it added something
   not in the real app (a "What happens next" list on Review & Pay) it was
   declined, because faithfulness to the product is the whole point.
10. **Keep the copy locks in view the entire time.** Which numbers may be
    printed, which phrases are canonical, which punctuation is banned. A
    beautiful page that prints the fee rate is a failed page.

The skills that shaped the taste calls: impeccable's craft floor (no
eyebrows, no icon-card scaffolds, real depth, one authored motion moment),
Emil Kowalski's motion rules (full transform strings, springs only for
things that should feel alive, exponential ease-out, reduced motion holds the
final frame), and the taste skill's dials (no duplicate CTA intent, cards
only for peers). They were read once at the start and then obeyed, not
re-run as checklists.

## 3. Inputs to gather before drawing anything

1. **The finished reference surface.** Here, the home page. Capture it full
   length at desktop width and crop it into four or five reference images.
   It settles mood, palette, type, button shapes, plate shapes and footer.
2. **The design tokens file.** Here `DESIGN.md` at the repo root (palette,
   type scale, components, layout rules, do's and don'ts). If none exists,
   write one from the reference surface first.
3. **The product's source code**, not screenshots of it. For a React Native
   app: the theme file (colors, font families, spacing, radii), the tab bar,
   the components each screen is made of, and the strings they render. Lift
   exact numbers: bubble radius 18, padding 10/16, type 15/22, progress
   segments 4px on a 4px gap, banner radius 18 with a 4px rail, and so on.
4. **The product's own copy and constraints.** Which numbers may be printed
   (here: the $20 hold and the 24-hour window), which never (fee rate, price
   ranges), house phrases ("through Stripe on Stripe's payout schedule"),
   punctuation rules (no em dashes).
5. **Production references.** Mobbin's "How It Works" and "Features"
   sections for web (Mercury, Superpower, Linear, Ada): real UI at scale,
   stepped layouts, one enlarged object beside a device. Ten minutes is
   enough; the point is calibration, not copying.
6. **A parallel draft from Claude Design** (optional but useful). One brief,
   with the reference crops attached and any stale design system detached,
   asking for all pages as tall desktop artboards. It produced 19 artboards
   here and landed on the same beats independently, which is a cheap
   confirmation that the direction is right. Its canvas cannot be scrolled by
   automation; open `?file=<Name>.dc.html&present=1` in a tab and page with
   the space bar. Treat it as a sketch to check against, not as frames to
   port.

## 4. The brief (reusable template)

The brief given to Claude Design doubled as the working brief for the code.
Its shape:

- Ignore any attached design system; the attached screenshots of the
  finished HOME PAGE are the source of truth.
- The pages must LOOK LIKE THE APP: every page built around large, faithful
  screens of the real product, the way Mercury / Superpower / Linear product
  pages show real UI. Bans: line-art illustrations, leader-line callouts,
  icon + heading + text card grids, eyebrows above headings, dark sections,
  gradient text.
- WHAT THE PRODUCT IS: five sentences, every mechanism named.
- VISUAL SYSTEM: the tokens, stated as hex and px.
- THE APP'S OWN LOOK (inside device screens only): its palette and type, then
  a lettered list of the real screens with their real strings.
- THE PAGES: one line per page with its H1 and the composition you want.
- HARD RULES ON COPY.

Write it so the model could not produce a generic page even if it tried.

## 5. Operating Claude Design from Claude Code

Claude Design is a separate product at claude.ai/design. It was driven
through the Chrome extension in the user's own browser. The steps that
worked:

1. Open claude.ai/design in a Chrome tab (the account is already signed in).
   Check the Design system chip on the Make box: if it names a design system
   the client says is stale, open the chip and use "Clear selection" so it
   reads "None". A stale system silently overrides the brief.
2. Prepare reference images locally: full-page captures of the finished
   surface cropped into four or five pieces, plus one native-resolution crop
   of a real app screen. Keep each under 400 KB.
3. Attach them with the page's hidden file input (`find` the file input,
   then `file_upload` with the paths). Do not click the "+" button; a native
   file picker cannot be driven.
4. Type the brief into the Make textbox as ONE paragraph. Newlines submit
   the form, so flatten the text. Then click Create.
5. Generation runs for 15 to 25 minutes for six pages and auto-switches the
   visible file as it writes. The canvas does not respond to wheel or drag
   from automation. Do not navigate away: the tab holds unsaved state and a
   forced navigation would interrupt the stream.
6. To read the result, use Present: the Present menu's "New tab" opens
   `...?file=<Name>.dc.html&present=1`, which scrolls with the space bar and
   screenshots normally. Change the `file=` parameter to read other pages.
7. Harvest beats and copy ideas, then check them against the product's
   source before adopting any. Treat the artboards as a sketch by a
   colleague who has not seen the app.

The brief that was sent is in the appendix. Its structure (source-of-truth
statement, bans, product facts, visual system, the app's own look with real
strings, one line per page, copy rules) is the reusable part.

## 6. The system that made it fast

Everything lives in one folder (`components/flagship/product/`). Build this
before any page, because every page is assembled from it.

### 6.1 Devices (`device.tsx`)

- `PhoneShell`: the device at the phone's logical size (390×844 for the
  iPhone frames the app is laid out on). Children are the screen, edge to
  edge; status bar, dynamic island and the floating tab bar are overlays.
  Every value from the app's source: tab bar radius 35 at 65% white blur
  with a sliding capsule, the app font, the app canvas colour.
- `Zoom`: renders any fixed-size content at a target width with CSS `zoom`.
  Zoom re-lays out at the target size, so 15px type at 0.77 becomes real
  11.5px glyphs; a transform scale would blur it. Zoom also affects layout,
  which lets grids measure the phone at its shown size.
- `FitZoom`: fits a fixed-width window (the 1100px dashboard) to whatever
  container it lands in, with a ResizeObserver. It MUST carry
  `contain: inline-size` plus `min-w-0 overflow-hidden`, or a grid column
  sizes itself from the unzoomed 1100px child before the observer runs, the
  observer reads that width, and the zoom locks at 1. That exact bug shipped
  once: the partner page overflowed to 1156px at 390 wide.
- `BrowserFrame`: traffic lights, an address pill with the product's real
  host, the page below.
- `Plate`: the reference surface's big rounded gradient card, in three tones
  (sky, pale, paper) so consecutive sections never look the same.

### 6.2 Screens (`screens/*.tsx`)

One file per app area, each exporting whole screens (a `PhoneShell` with
content) and the pieces they are made of. Written at the app's real values
with the app's real strings. Figures are examples; anything the copy rules
forbid (a fee rate) is never printed even inside a screen.

Rule that bit once: a whole screen already renders its own shell, so never
wrap it in the shell again. Give the API two names (`Phone` for raw content,
`PhoneAt`/`Zoom` for finished screens) so the mistake is hard to make.

### 6.3 Pull-outs (`pullouts.tsx`)

One object lifted out of the phone and enlarged to web scale: the price
breakdown, the payment lifecycle as a giant receipt, one assistant answer as
prose, the three source cards fanned, the voice bar. Same anatomy and face
as the screen it came from, at 18 to 40px type. This is what makes a section
readable across the room and what gives each page a different silhouette.

### 6.4 Compositions (`app/(marketing)/<slug>/sections.tsx`)

Each page keeps its server `page.tsx` (metadata, FAQ, JSON-LD) and gets a
client `sections.tsx`. The module on every page is the same (hero, then
three or four sections of H2 ≤ 6 words left + one sentence right + a Plate
composition, then FAQ) but the composition inside the plate differs:

| Page | Composition |
| --- | --- |
| How it works | Pinned phone; seven steps scroll past it and swap its screen (inline phones below the desktop breakpoint) |
| Pricing | Phone + its breakdown pulled out; giant receipt with no device; two-phone approval flow |
| Assistant | Two phones on one plate + the voice bar pulled out; answer as prose + fanned sources; confirm card + the screen it feeds |
| Score | Health sheet + the score pulled out with its tiers; ONE phone looping before/after; check-in screen + banner |
| Partner pitch | Dashboard window with the new booking landing + the booking card pulled out; job sheet; payouts + three numerals |
| Product tour | A different dashboard window each section, cropped differently, with the rules pulled out |

Never the same layout twice in a row. A loop (the score flipping 81 → 88)
or a scroll-driven swap counts as a composition, not just a static frame.

### 6.5 Motion rules

Full `transform` strings in Motion (never `scale(0)`), springs only for
things that should feel alive, one authored moment per section, exponential
ease-out from an already-visible resting state, reduced motion holds the
final frame. The pinned walkthrough switches on `useInView` with a
-45% margin so a step changes when its text reaches eye level.

## 7. Verification, in bounded passes

Do not run an open-ended polish loop. One batched inspection round, one
batch of fixes, one confirmation round.

1. **A lab route** (deleted before commit) rendering every screen at 320px
   plus every dashboard window, shot per cell with Playwright. This caught
   the health sheet drawn under the tab bar and single-hour board blocks
   overflowing their row before any page existed.
2. **Per-section viewport shots** at 1440 and 390 (`walk-shot.mjs`: scroll
   each section id to eye level, shoot). This caught the doubled bezel.
3. **Scroll-through full-page shots** (`proof-full.mjs`: scroll the page
   slowly so every in-view reveal fires, then full-page capture, and print
   `scrollWidth` so horizontal overflow is a number, not a guess). A plain
   full-page screenshot never scrolls, so reveal-on-scroll sections shoot at
   opacity 0.
4. Typecheck, lint, production build. Console errors counted per route.
5. **A proof board** as a published artifact: every page full length at both
   widths beside its previous version, with the assumptions stated. The
   client reviews visuals only there.

Windows note: Git Bash rewrites `ROUTE=/pricing` into a filesystem path;
run the harness with `MSYS_NO_PATHCONV=1`.

## 8. The unification pass

After the first review the client asked whether the reference surface's
version of a screen was the unified one. The answer came from the app
source, not opinion: the app's health modal draws a circular gradient ring
(the rounded-square ring only appears in onboarding), and the tracker groups
rows into NOW / SOON / HEALTHY tiers with chips. The product screens were
aligned to that. Lesson: when two of your own recreations disagree, resolve
it by reading the product's code, then make the reference surface and the
new pages agree.

## 9. Checklist for the next project

- [ ] Capture the finished reference surface; write or read the tokens file.
- [ ] Read the product's source for every screen you will draw; copy exact
      values and strings; list the copy locks.
- [ ] Ten minutes on Mobbin for the page type. Optional Claude Design draft
      from the same brief.
- [ ] Build devices, screens, pull-outs first; render them in a lab route;
      fix what the lab shows.
- [ ] One composition per page; no layout repeated; at least one loop or
      scroll-driven moment.
- [ ] Verify at two widths with scroll-through captures; check overflow as a
      number; typecheck, lint, build.
- [ ] Publish the proof board with before/after; state assumptions.
- [ ] Ask what the unified reference is; align to the product's code.

## 10. Where things are in this repo

- System: `components/flagship/product/` (device, ui, pullouts, walkthrough,
  screens/).
- Pages: `app/(marketing)/{how-it-works,pricing,oto,vehicle-health-score,partner-with-us,for-shops}/`.
- Tokens: `DESIGN.md` (section 10 documents the product-page system).
- Harness: `.agent/pw/walk-shot.mjs`, `.agent/pw/proof-full.mjs`,
  `.agent/pw/out/build-proof.py` (gitignored, local).
- Rejected scene code: `.agent/archive/scenes-drawn-2026-09-05/` (local).
- Proof board: "The App, Up Close" artifact (2026-09-05).
- Claude Design draft: project "Otopair product pages".


## Appendix: the brief sent to Claude Design (verbatim)

```
Design six desktop product pages (1440 wide, full page) for otopair.com. Ignore any attached design system; the attached screenshots of the finished HOME PAGE are the source of truth for mood, palette, type and components. The pages must feel like the same property as that home page and must LOOK LIKE THE APP: every page is built around large, faithful, high-fidelity screens of the real Otopair product, the way Mercury, Superpower and Linear product pages show real UI. No line-art illustrations, no diagrams with leader-line callouts, no icon+heading+text card grids, no eyebrow labels above headings, no dark sections, no gradient text.

WHAT OTOPAIR IS. A car-repair marketplace in Staten Island, NY. Drivers use the iPhone/Android app: they tell "Oto" (an AI concierge) what the car is doing by voice or text, Oto scopes the job and reads the car from its VIN, verified shops each show a fixed total for that exact car, the driver books with a $20 hold (an authorization, not a charge), the shop inspects and confirms the estimate, anything above what the driver approved needs the driver's yes in the app within 24 hours, and the card is charged only when the job is marked complete. Shops use a web dashboard (schedule board, job sheets, payouts through Stripe on Stripe's payout schedule, no subscription, no setup fee).

VISUAL SYSTEM (from the home page). Page ground white. Hero: sky wash #95C7E7 fading to white by ~600px, floating glass pill nav. Display serif Petrona (light, 250 weight) for H1 60px and section H2 46-54px; Inter for everything you read (body 17/1.65, UI 14-15). Ink #1a1a1a, body text #4c5661, muted #777169, web accent blue #4B82A5 (links, the closing band title), sky tint #EBF5FB, paper #f7f6f3, hairline rgba(26,26,26,0.12). Ink pill button (h48, rounded-full, #1a1a1a, white 15px text); secondary action is an underlined text link. Big plates: rounded 40px cards with a vertical gradient #95C7E7 to white holding a device. Glass chips: white/40 with a half-pixel white/60 border and backdrop blur. Cards: rounded 20px, hairline border, 2px 4%-alpha shadow. Every page closes with the same sky footer band "Available whenever you need it".

THE APP'S OWN LOOK (inside the device screens only). Background #f5f5f7, product blue #5299FE, ink #141C24, meta gray #6B7280, borders #E5E7EB, Urbanist-style rounded sans. Floating glass tab bar (Home, Bookings, My Cars, Oto) with a sliding blue capsule under the active tab. Real screens to draw:
- Oto chat: user bubbles solid #5299FE white text; Oto replies white bubbles; a "Show thinking" link; quick-reply chips; a sources strip with three cards "Service History", "Manufacturer Data", "Error Codes" each with a green check; a 14-spoke starburst thinking indicator; a voice bar with a waveform and "Said, not typed".
- Book Service wizard inside the chat: 5 steps (Service, Vehicle, Shop, Time, Review) with a stepper, mechanic rows with rating and distance, time chips.
- Review & Pay screen: shop name, "Verified shop", rows "Labor (1 h 20 min) $180", "Parts, fixed $110", "Tax + service fee $22", "Fixed price $312", Apple Pay / Google Pay, a "Book & Pay" blue button, and the line "$20 hold today. Charged only after the shop inspects the car."
- Bookings tab card: vehicle + shop + date, an Uber-Eats-style segmented progress bar (4 segments, filled #5299FE, next segment sweeping) with stages Booked, Confirmed, In service, Ready; an approval banner "Your car requires more than we expected / Tap to review your mechanic's updated estimate" with an amber rail and wrench icon; an approve-estimate screen with the approved ceiling $312, the proposal $452 for "Rear pads worn, +$140", buttons Approve / Decline, "24 hours to answer".
- Payment breakdown after completion: three rows "Hold placed at booking $20.00", "Estimate confirmed $312.00", "Final charged $312.00", then "Parts used".
- My Cars: car photo, "2019 Civic EX", mileage, a squircle ring (rounded-square progress ring, blue) with the Vehicle Health Score "81", pills Oil change ON TIME / Brakes SOON / Tires NEEDS ATTENTION / Battery ON TIME / State inspection ON TIME, Maintenance Tracker rows, a quarterly check-in card "Time for a quick update: mileage, services done elsewhere, warning lights".
- Shop web dashboard (browser frame, light): a day schedule board with mechanics as columns (Marcus, Dee, Twunna) and time blocks; a job sheet "Oil Change, 2021 Bugatti Chiron, John Wilson, CONFIRMED" with a 4-step progress and "Start service"; a payouts page with "Captured $312", "Your bank on Stripe's payout schedule", 100% of your rate.

THE SIX PAGES. Each page: sky hero with H1 + one-sentence lede + ink pill + text link, then three to four sections, then a short "Questions drivers ask" list, then the footer band. Give each page its OWN composition; do not repeat one layout six times.
1. /how-it-works, H1 "How Otopair works, in seven steps." A scroll walkthrough: the phone stays pinned on the right while seven short steps scroll on the left, and the phone screen changes per step (Tell Oto, see shop totals, Book & Pay with the $20 hold, shop confirms after inspection, extra work needs your yes, charged at completion, review). Show 3 frames of that walkthrough.
2. /pricing, H1 "The price you approve is the most you pay." Section 1: the Review & Pay screen enlarged as the hero object on a gradient plate with the breakdown legible. Section 2: the hold as the three-row payment lifecycle, huge. Section 3: the approve-estimate screen beside the sentence "It cannot go up without you."
3. /oto, H1 "Oto is a guide for your car, not a diagnosis." Section 1: a phone at large scale mid-conversation with the voice bar. Section 2: one Oto answer pulled out of the phone and enlarged with its three source cards fanned beside it. Section 3: the record-confirmation card and the health score it moves.
4. /vehicle-health-score, H1 "Vehicle Health Score, explained." Section 1: the My Cars screen with the squircle ring big, the five pills around it. Section 2: two phones, 81 today and 88 after the tire rotation, "Only real upkeep moves it." Section 3: the quarterly check-in card.
5. /partner-with-us, H1 "Fill your bays. Skip the phone tag." For shop owners: Section 1: the web schedule board in a browser frame with a new booking landing on it ("Brake pad replacement, 2019 Honda Civic EX, Tue 9:40 AM, $20 hold on the card"). Section 2: the job sheet confirming the estimate after inspection. Section 3: the payouts page. Then a five-step application list (Apply, Review, Invite, Stripe, Set up).
6. /for-shops, H1 "Your rate. Your schedule. Paid through Stripe." A dashboard tour: three sections each showing a different portal screen (day board, job sheet with progress, payouts).

Hard rules on copy: never print a platform fee rate or a price range; the only numbers stated as facts are the $20 hold and the 24 hours; shops are paid "through Stripe on Stripe's payout schedule"; no em dashes anywhere; no lorem ipsum; write real copy in the voice of the home page (plain, specific, unhurried).
```
