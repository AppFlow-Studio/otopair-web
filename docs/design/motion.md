# Motion — the entrance system

Every marketing page should arrive the way the home page and the six product
pages already do: content settles into place instead of appearing all at once.
This is the contract. It is a **house vocabulary, already built** — the job on
any page is to apply it, never to invent a second system.

## The primitives

All of them live in `components/flagship/landing/reveal.tsx` and are client
components. A **server** page may import and render them (`<Reveal>` around
server JSX is fine) — what a server page may never do is read a *value* out of
a client module.

| Primitive | Use for | Shape |
| --- | --- | --- |
| `Reveal` | one block, on its own trigger | fade + 26px up, 0.7s |
| `Stagger` | a list or grid of peers | container + per-child fade-up, 60ms apart |
| `Sequence` + `Seq` | choreography: several parts, one shared clock | `at` is seconds from the group's t=0 |
| `SeqPop` / `PopIn` | small objects inside a card (chips, bubbles, badges) | spring, scale 0.96 → 1 |
| `SeqRule` | a hairline that should draw itself | scaleX 0 → 1 from the left |
| `CountUp` (`components/flagship/shared`) | a real number | eases 0 → value in view |
| `Bar` (`components/flagship/shared`) | a meter or rating | fills on entry |

`Rise` (in `app/(marketing)/pricing/sections.tsx`) is the product pages' older
alias for `Reveal`. Leave it where it already is; do not spread it further.

Easing everywhere is `[0.22, 1, 0.36, 1]`. Every primitive already handles
`prefers-reduced-motion` (it degrades to a plain fade with no delay) and every
one of them carries `data-reveal`, which the root layout's `<noscript>` rule
uses to un-hide the page for a visitor whose JS never runs. Anything you
hand-roll with `motion.*` and an `initial` opacity **must** carry `data-reveal`
too, or it ships invisible without JS.

## What gets which treatment

- **Section heading + its lede** — one `Reveal`, no delay. One block, not one
  per line.
- **Running prose, legal clauses, a `<dl>` of definitions** — the block fades
  up as a whole. Never animate paragraph-by-paragraph or term-by-term: it
  fights reading and turns a policy page into a slideshow.
- **A grid or list of peers** (service tiles, shop cards, borough rails, FAQ
  questions, press items, job posts) — `Stagger`. Put the grid's own classes
  on the container's `className`.
- **A phone, a plate, a pull-out card, a map** — these are objects, so they
  settle: `Reveal`, or `Seq` inside a `Sequence` when the object and the text
  beside it should arrive in a known order (text first, object a beat later).
- **A hairline that separates two ideas** — `SeqRule`.
- **A real number that is the point of the sentence** — `CountUp`.
- **A step list where the order is the content** — `Sequence` with `Seq at={i * 0.08}`.

## What does not get animated

- Anything inside `PageShell`'s hero. The shell already staggers the
  breadcrumb, eyebrow, title, lede and CTA row; adding more double-animates it.
- The pill nav, the footer band, the table of contents rail.
- The six product pages' `sections.tsx` — already choreographed.
- Anything whose own component already animates (check for `motion.` before
  wrapping).
- Form fields, inputs and error text. A field that fades in as you tab to it
  is a bug, not a flourish.

## Timing

Keep a page's whole entrance under about a second per section. Nothing waits
on anything below it. Concretely: `delay` above 0.3s on a top-level block is
almost always wrong, and `Stagger`'s `cap` exists so a 22-tile directory
finishes in the same beat as a four-card row.

## The two hazards

1. **Wrapping a grid child changes the grid.** `Reveal`, `Seq` and
   `Stagger`'s items all render a plain `<div>`. If the thing you wrap was a
   grid or flex child carrying `col-span-*`, `flex-1`, `w-*` or `order-*`,
   those classes must move to the wrapper — otherwise the wrapper becomes the
   item and the layout collapses. Add `min-w-0` to any wrapper that becomes a
   grid or flex item; a default `min-width: auto` on a grid item is the single
   most common cause of horizontal overflow in this codebase.
2. **A wrapper between a parent and a child breaks structural CSS.** Do not
   put one inside a `<dl>` between it and its `<dt>`/`<dd>`, inside a `<ul>`
   between it and its `<li>`, or anywhere `space-y-*`, `divide-*`, `:first-child`
   or a CSS counter (`.shell-numbered`) is doing work. Wrap the whole list
   instead, or move the classes.

## Checking your work

`npm run build` catches the server/client boundary mistakes. The page then has
to be looked at: content visible at rest, nothing that pops after the reader
has already started reading it, and no new horizontal scrollbar
(`.agent/pw/overflow-find.mjs`).
