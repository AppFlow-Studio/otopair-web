# Otopair — DESIGN.md

Design system for otopair.com and its secondary pages, written in the
awesome-design-md format so an agent can build a page that belongs to this
site without opening Figma. Every value below is taken from shipped code
(components/flagship/**, app/globals.css, app/layout.tsx), not invented.
When Figma and this file disagree, Figma wins; update this file.

## 1. Visual Theme & Atmosphere

Calm, trust-first, and quietly premium. A sky-blue wash fades to white at
the top of every page; glass elements sit on it like frosted panels. The
type is a light display serif (Petrona, standing in for Romie) for anything
that needs to feel considered, and Inter for everything you read. Nothing
is saturated except the one blue accent, and even that is muted. The site
should feel like a receipt you can trust: airy, specific, unhurried. No dark
sections, no neon, no gradients other than the sky wash and its blue foot.

## 2. Color Palette & Roles

| Role | Hex | Use |
| --- | --- | --- |
| Ink | `#1a1a1a` | Headlines, primary text, ink pill buttons |
| Text | `#4c5661` | Body copy on white |
| Muted | `#777169` | Captions, eyebrows, secondary labels |
| Muted warm | `#6b655d` | Card body copy |
| Accent blue | `#4B82A5` | Links, ladder numerals, closing-band title, focus rings |
| Sky | `#95C7E7` / `#98C9E8` / `#86C9E7` | Hero wash top, footer band foot |
| Sky tint | `#EBF5FB` | Chip fills, icon plates, stat bars |
| Paper | `#f7f6f3` | Summary cards, soft panels |
| White | `#ffffff` | Page ground, cards |
| Hairline | `rgba(26,26,26,0.12)` | Borders, rules |
| Error | `#b04a3a` | Form errors only |
| Success | `#457942` | Confirmations only |

Rules: one accent (the blue), locked across the page. Semantic red and
green never appear as decoration. Product-blue `#5299fe` belongs to the
mobile app, not the website.

## 3. Typography Rules

- **Display serif:** Petrona 250 with `font-size-adjust: cap-height 0.72`
  (`serifDisplay` in components/flagship/landing/reveal.tsx). H1 60/65 on
  desktop, 34-36/1.02 on phones. Section H2 46-54, mobile 34.
- **Text serif:** Petrona 400 (`serif`) for card titles (22px), ladder
  step titles, stat labels, small brand marks. Never for body copy.
- **Sans:** Inter for body (17/1.65 long-form, 15/1.6 cards), UI (14-15),
  eyebrows (13px, `tracking-[0.14em]`, uppercase, muted).
- **Numerals:** Literata for landing stat tiles only.
- Headlines get `text-wrap: balance`; measure stays under 65ch.
- Emphasis inside a headline is the same face, never a second family.

## 4. Component Stylings

- **Ink pill button:** `h-12 rounded-full bg-[#1a1a1a] px-6 text-[15px] text-white`,
  hover `opacity-85`, focus ring `ring-2 ring-[#4B82A5]/50`. One primary
  per view. Secondary action is an underlined text link, not a second pill.
- **Glass chip / nav:** `bg-white/20 border-[0.5px] border-white/50 backdrop-blur-[35px]`
  on the sky wash; `bg-white/40 border-white/60 backdrop-blur` for proof chips.
- **Card:** `rounded-[20px] border border-[#1a1a1a]/10 bg-white p-6 shadow-[0_1px_2px_rgba(26,26,26,0.04)]`.
  Cards only when the items are peers; otherwise `border-t` rows.
- **Soft panel:** `rounded-[20px] bg-[#f7f6f3] border hairline` (summary boxes).
- **Ladder row:** blue serif numeral `01.` at 15-17px, hairline between rows.
- **Inputs:** `h-12 rounded-full border border-[#1a1a1a]/12 bg-white px-5`,
  focus `border-[#4B82A5] ring-2 ring-[#4B82A5]/30`; label above, error below in `#b04a3a`.
- **Links in prose:** accent blue, underline at 40% alpha, offset 3px.

## 5. Layout Principles

- Page container 1440 max; content box 1190; long-form measure 720;
  wide grids 1200. Gutters 27px phone, 40px tablet, 78px desktop.
- Section rhythm: 96-128px between sections on desktop, 64-96 on phones.
- Grid over flex math. Mobile-first classes; the landing's desktop
  breakpoint is `tab:` (63.99rem); phones and tablets share the phone rules.
- Eyebrow restraint: the hero may carry one; at most one more per three
  sections. Section titles are question-shaped on informational pages.
- Every page opens with the sky wash and closes with FooterCta (band +
  NAP + legal links). Do not invent a second footer.

## 6. Depth & Elevation

Almost flat. Cards carry a 1px hairline and a 2px, 4%-alpha shadow; hover
lifts to `0 6px 24px rgba(26,26,26,0.08)`. Glass panels get their edge from
a half-pixel white border, not a shadow. The orb's glow is the only soft
light source and it lives on the home hero only.

## 7. Do's and Don'ts

Do: write the answer first under every heading; use real product facts;
keep one accent; use the display serif for titles and Inter for reading;
let white space do the separating; give every image real alt text.

Don't: print the platform fee rate or any price range; use `#5299fe` on the
web; add dark-mode sections; stack three identical cards under a centered
hero; put an eyebrow above every H2; use Fraunces or Instrument Serif;
hand-roll icons (lucide-react is the project's icon set, 1.5 stroke).

## 8. Responsive Behavior

Phones: single column, 27px gutters, H1 34-36px, pill buttons full width
only inside forms. Tablets 640-1023 render the phone layout (the home page
scales it with CSS zoom; secondary pages simply reflow). Desktop from 1024:
the glass pill nav, two-column heroes, 3-column card grids. Reduced motion
turns every entrance into a fade and disables smooth scrolling.

## 9. Agent Prompt Guide

- "Build it on PageShell" → `components/flagship/page-shell.tsx` (hero wash,
  breadcrumbs, toc rail, numbered sections, FooterCta).
- Copy the tokens above; never invent a new blue.
- Verify with the Playwright harness in `.agent/pw/` at 1440 and 390 wide.
- Quick palette: ink `#1a1a1a`, text `#4c5661`, muted `#777169`,
  accent `#4B82A5`, sky `#95C7E7`, tint `#EBF5FB`, paper `#f7f6f3`.

## 10. Product pages: the app, up close (Sep 5 2026)

The six product pages (how-it-works, pricing, oto, vehicle-health-score,
partner-with-us, for-shops) show the real product, not illustrations of
it. Everything lives in `components/flagship/product/`:

- **Devices** (`device.tsx`): `PhoneShell` is the driver app at its own
  logical size, 390x844, drawn with the app's values (Urbanist via
  `--font-Urbanist`, `#f5f5f7` canvas, product blue `#5299FE` inside the
  glass only, the floating tab bar at radius 35 / white 65%). `Zoom`
  renders 390-space content at any width with CSS `zoom` (crisp, layout
  affecting). `FitZoom` fits a fixed-width window to its container.
  `BrowserFrame` is the shop dashboard window. `Plate` is the home page's
  rounded-40 gradient card in three tones: `sky`, `pale`, `paper`.
- **Screens** (`screens/*.tsx`): chat (Oto turns, sources, quick replies,
  voice bar, thinking state), book (shop totals), pay (Review & Pay),
  bookings (progress bar, approval banner, approve-estimate, receipt),
  cars (My Cars, Vehicle Health sheet, quarterly check-in), record
  (confirm card), portal (day board, job sheet, payouts, rates). Sizes
  and strings come from otopair-1 source; figures are examples and no
  fee rate is ever printed.
- **Pull-outs** (`pullouts.tsx`): one object lifted out of the phone and
  enlarged to web scale (breakdown, payment lifecycle, answer, fanned
  sources, voice bar) so a section reads across the room.
- **Walkthrough** (`walkthrough.tsx`): the pinned phone for how-it-works.
  Steps on the left switch the screen when they reach the middle band of
  the viewport; below `tab` every step carries its own phone.
- **Page module**: hero (heroAlign start) -> 3 x [H2 <= 6 words left, one
  sentence right, a Plate composition] -> FAQ. Each page gets its own
  composition (pinned phone; phone + pull-out; giant receipt; two-phone
  flow; browser window + pull-out; loop). Never the same layout six times.
- **Never** wrap a full screen (`ReviewPayScreen` etc.) in `Phone`: they
  already render their own `PhoneShell`. Use `Zoom` or `PhoneAt`.
