"use client";

import { useEffect, useState, type ReactNode } from "react";
import PillNav from "./pill-nav";
import FooterCta from "./landing/footer-cta";
import { Reveal, serif, serifDisplay } from "./landing/reveal";
import { Bezel } from "./bezel";
import { Breadcrumbs, type Crumb } from "@/components/seo/breadcrumbs";

/**
 * Shell for the flagship's secondary pages — legal, help, trust, local and
 * service pages — so they read as the same property as the home page rather
 * than as an appendix: the floating glass pill nav retargeted to the home
 * sections, the blue → white hero wash the landing and partner heroes use,
 * an eyebrow in the landing's caps style, the light display serif for the
 * title, and the landing's own closing band (FooterCta, which carries the
 * NAP).
 *
 * Two hero shapes. Without `visual` the hero is the centered manifesto the
 * legal and help documents keep (taste §4.3 override). With `visual` it is
 * an asymmetric split from `lg`: the text stack left on six columns, the
 * visual right on six, seated in a glass Bezel over one soft radial glow,
 * and the wash runs deeper so the plate never hangs off its bottom edge.
 * Either way the hero carries at most four text elements (eyebrow, title,
 * lede, actions); the pages put facts and proof in the sections below.
 *
 * Client component only because `serif`/`serifDisplay` live in the client
 * module reveal.tsx (a server import would get client-reference proxies,
 * not the style objects). The pages that use it stay server components and
 * keep their `metadata` exports; they pass plain JSX as children.
 *
 * Long-form pages pass `toc` (the section list) and get a sticky
 * "On this page" rail at ≥lg with the active section tracked, and a
 * collapsible version of the same list under the hero on smaller screens.
 * `numbered` turns on the 01. / 02. section numerals the landing's ladders
 * use (CSS counters — see .shell-numbered in globals.css). `width: "wide"`
 * widens the main column for grids (directories, service indexes).
 *
 * House style on these pages (site audit 2026-08-31 §5.2/5.3): Section
 * titles are question-shaped where natural, and each section's first
 * paragraph answers its title on its own.
 */

// Off the home page the pill nav points at the Tier 1 URLs (the home page
// itself keeps its in-page anchors — that design is settled).
const SHELL_LINKS = [
  { label: "How it works", href: "/how-it-works" },
  { label: "For shops", href: "/for-shops" },
  { label: "Coverage", href: "/coverage" },
  { label: "Partner with us", href: "/partner-with-us" },
];
const SHELL_CTA = { label: "Get Oto", href: "/download" };

export type TocItem = { id: string; title: string };
export type ShellLink = { label: string; href: string };

export default function PageShell({
  eyebrow,
  mark,
  title,
  lede,
  updated,
  crumbs,
  hero,
  visual,
  visualPlacement = "split",
  visualFrame = true,
  heroAlign = "center",
  footerTitle,
  footerAction,
  footerAnchorId,
  toc,
  numbered = false,
  width = "prose",
  navLinks,
  navCta,
  children,
}: {
  /** Retarget the pill nav (a page with its own sections passes its own
   *  anchors, as the partner page does). Defaults to the home sections. */
  navLinks?: ShellLink[];
  navCta?: ShellLink;
  /** Optional: the breadcrumb already names the page, and a heading carries
   *  its own weight. Pass one only where the section label adds a fact. */
  eyebrow?: string;
  /** A small object above the title (a service's own app icon), for pages
   *  whose subject has a mark but no scene. */
  mark?: ReactNode;
  /** A string, or a fragment with `<br />` where the title is a sequence
   *  of sentences that should sit one per line. */
  title: ReactNode;
  lede: ReactNode;
  /** ISO date; rendered as "Last updated …" under the lede (legal pages). */
  updated?: string;
  /** Breadcrumb trail, rendered above the eyebrow + emitted as schema. */
  crumbs?: Crumb[];
  /** Extra hero content under the lede — a CTA row, a waitlist form. */
  hero?: ReactNode;
  /** Right-hand hero object (an image, a live map). Turns the hero into the
   *  split layout; the shell frames it in a glass Bezel. */
  visual?: ReactNode;
  /** `split`: text left, visual right from `lg` (titles that fit two lines
   *  in half a column). `stack`: the centered text with the visual as a
   *  wide plate under it (long titles; the plate takes a 2/1 image). */
  visualPlacement?: "split" | "stack";
  /** `false` renders the visual bare (an app screen with its own device
   *  frame needs no plate around it). Default: the glass Bezel. */
  visualFrame?: boolean;
  /** Hero text alignment when there is no visual: `center` (the manifesto
   *  documents keep) or `start` (a page whose sections are left-aligned on
   *  the grid keeps the hero on the same axis). */
  heroAlign?: "center" | "start";
  /** Closing band overrides (FooterCta): a shop-facing page passes its own
   *  line and an Apply pill instead of the store pill. */
  footerTitle?: string;
  footerAction?: ReactNode;
  footerAnchorId?: string;
  toc?: TocItem[];
  numbered?: boolean;
  width?: "prose" | "wide";
  children: ReactNode;
}) {
  const wide = width === "wide";
  const hasToc = !!toc?.length;
  const split = !!visual && visualPlacement === "split";
  const stack = !!visual && visualPlacement === "stack";
  const text = (
    <HeroText
      eyebrow={eyebrow}
      mark={mark}
      title={title}
      lede={lede}
      updated={updated}
      crumbs={crumbs}
      hero={hero}
      align={split || (!visual && heroAlign === "start") ? "start" : "center"}
    />
  );
  const startHero = !visual && heroAlign === "start";
  return (
    <div className="min-h-screen w-full bg-white">
      <PillNav links={navLinks ?? SHELL_LINKS} cta={navCta ?? SHELL_CTA} />
      {/* isolate: flattens the page into one surface so the fixed pill's
          backdrop-filter can blur it (Chromium skips nested backdrop-filter
          elements otherwise — 2026-09-03). */}
      <div className="isolate">
        {/* Hero wash — same blue as the home/partner heroes so the glass nav
            reads identically here. The split hero runs it deeper so the
            visual's plate sits on blue, not on the white below it. */}
        <header
          className={`w-full ${
            split
              ? "bg-[linear-gradient(to_bottom,#98C9E8_0px,#FFFFFF_640px)] tab:bg-[linear-gradient(to_bottom,#98C9E8_0px,#FFFFFF_760px)]"
              : stack
                ? "bg-[linear-gradient(to_bottom,#98C9E8_0px,#FFFFFF_760px)] tab:bg-[linear-gradient(to_bottom,#98C9E8_0px,#FFFFFF_1040px)]"
                : "bg-[linear-gradient(to_bottom,#98C9E8_0px,#FFFFFF_460px)]"
          }`}
        >
          {stack && (
            <div className="mx-auto w-full max-w-[1190px] px-6 pt-[142px] sm:px-10 tab:pt-[160px]">
              <div className="mx-auto max-w-[760px] text-center">{text}</div>
              <div className="relative mt-12 tab:mt-16">
                <div
                  aria-hidden
                  className="pointer-events-none absolute -inset-x-16 -inset-y-10 -z-10 rounded-full bg-[radial-gradient(closest-side,rgba(255,255,255,0.85),rgba(255,255,255,0))]"
                />
                <Reveal delay={0.16} y={18}>
                  {visualFrame ? <Bezel tone="glass">{visual}</Bezel> : visual}
                </Reveal>
              </div>
            </div>
          )}
          {split && (
            <div className="mx-auto grid w-full max-w-[1190px] gap-10 px-6 pt-[132px] sm:px-10 lg:grid-cols-12 lg:items-center lg:gap-12 lg:pt-[150px]">
              <div className="lg:col-span-6">{text}</div>
              <div className="relative lg:col-span-6">
                {visualFrame && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute -inset-10 -z-10 rounded-full bg-[radial-gradient(closest-side,rgba(255,255,255,0.85),rgba(255,255,255,0))]"
                  />
                )}
                <Reveal delay={0.12} y={18}>
                  {visualFrame ? <Bezel tone="glass">{visual}</Bezel> : visual}
                </Reveal>
              </div>
            </div>
          )}
          {!split && !stack && (
            <div
              className={`mx-auto w-full px-6 pt-[142px] sm:px-10 tab:pt-[160px] ${
                startHero ? "max-w-[1200px]" : "max-w-[760px] text-center"
              }`}
            >
              {startHero ? <div className="max-w-[760px]">{text}</div> : text}
            </div>
          )}
        </header>

        <div
          className={`mx-auto w-full px-6 pb-8 pt-14 sm:px-10 tab:pt-16 ${
            wide ? "max-w-[1200px]" : hasToc ? "max-w-[1040px]" : "max-w-[720px]"
          }`}
        >
          {hasToc && <MobileToc items={toc!} />}
          <div className={hasToc ? "lg:grid lg:grid-cols-[220px_minmax(0,720px)] lg:justify-between lg:gap-14" : undefined}>
            {hasToc && <DesktopToc items={toc!} />}
            <main id="main" tabIndex={-1} className={`min-w-0 outline-none ${numbered ? "shell-numbered" : ""}`}>
              {children}
            </main>
          </div>
        </div>

        <FooterCta title={footerTitle} action={footerAction} anchorId={footerAnchorId} className="mt-14 tab:mt-20" />
      </div>
    </div>
  );
}

/** The hero's text stack, shared by both hero shapes. `align` is the only
 *  difference: centered under the manifesto hero, ragged-left in the split. */
function HeroText({
  eyebrow,
  mark,
  title,
  lede,
  updated,
  crumbs,
  hero,
  align,
}: {
  eyebrow?: string;
  mark?: ReactNode;
  title: ReactNode;
  lede: ReactNode;
  updated?: string;
  crumbs?: Crumb[];
  hero?: ReactNode;
  align: "start" | "center";
}) {
  const centered = align === "center";
  const mx = centered ? "mx-auto" : "";
  return (
    <>
      {crumbs && (
        <Reveal>
          <Breadcrumbs items={crumbs} className={centered ? "mb-5" : "mb-5 [&_ol]:justify-start"} />
        </Reveal>
      )}
      {mark && (
        <Reveal>
          <div className={`mb-5 flex ${centered ? "justify-center" : "justify-start"}`}>{mark}</div>
        </Reveal>
      )}
      {eyebrow && (
        <Reveal>
          <p className="text-[13px] tracking-[0.14em] text-[#5f7182]">{eyebrow}</p>
        </Reveal>
      )}
      <Reveal delay={0.05}>
        <h1
          className={`${mx} ${eyebrow ? "mt-4" : "mt-1"} max-w-[18ch] text-[34px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] ${
            centered ? "tab:text-[52px] lg:text-[58px]" : "tab:text-[48px] lg:text-[54px]"
          }`}
          style={serifDisplay}
        >
          {title}
        </h1>
      </Reveal>
      <Reveal delay={0.1}>
        <p className={`${mx} mt-6 max-w-[54ch] text-[17px] leading-relaxed text-[#4c5661] [text-wrap:pretty]`}>{lede}</p>
      </Reveal>
      {updated && (
        <Reveal delay={0.14}>
          <p className="mt-5 text-[13px] tracking-[0.05em] text-[#777169]">
            Last updated{" "}
            <time dateTime={updated}>
              {new Date(`${updated}T12:00:00Z`).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
                timeZone: "UTC",
              })}
            </time>
          </p>
        </Reveal>
      )}
      {hero && (
        <Reveal delay={0.16}>
          <div className={`mt-8 flex flex-col gap-3 ${centered ? "items-center" : "items-start"}`}>{hero}</div>
        </Reveal>
      )}
    </>
  );
}

/** Sticky rail. Active section = the last heading that has scrolled past
 *  the top third of the viewport, tracked with one IntersectionObserver so
 *  the page never reads layout on scroll. */
function DesktopToc({ items }: { items: TocItem[] }) {
  const active = useActiveSection(items);
  return (
    <aside className="hidden lg:block">
      <nav aria-label="On this page" className="sticky top-[110px]">
        <p className="text-[12px] tracking-[0.14em] text-[#777169]">ON THIS PAGE</p>
        <ol className="mt-4 flex flex-col gap-[6px] border-l border-[#1a1a1a]/10">
          {items.map((it) => {
            const on = it.id === active;
            return (
              <li key={it.id}>
                <a
                  href={`#${it.id}`}
                  aria-current={on ? "location" : undefined}
                  className={`-ml-px block border-l-2 py-[3px] pl-4 text-[14px] leading-snug transition-colors duration-300 ease-expo ${
                    on
                      ? "border-[#4B82A5] text-[#1a1a1a]"
                      : "border-transparent text-[#777169] hover:border-[#1a1a1a]/25 hover:text-[#1a1a1a]"
                  }`}
                >
                  {it.title}
                </a>
              </li>
            );
          })}
        </ol>
      </nav>
    </aside>
  );
}

function MobileToc({ items }: { items: TocItem[] }) {
  return (
    <details className="group mb-10 rounded-[22px] border border-[#1a1a1a]/10 bg-[#f7f6f3] lg:hidden">
      <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-[14px] text-[#1a1a1a] [&::-webkit-details-marker]:hidden">
        <span className="tracking-[0.05em]">On this page</span>
        <span aria-hidden className="text-[#777169] transition-transform duration-500 ease-expo group-open:rotate-180">
          ⌄
        </span>
      </summary>
      <ol className="flex flex-col gap-2 border-t border-[#1a1a1a]/10 px-5 py-4">
        {items.map((it, i) => (
          <li key={it.id} className="flex gap-3 text-[15px] leading-snug">
            <span className="w-6 shrink-0 text-[#4B82A5]" style={serif}>
              {String(i + 1).padStart(2, "0")}
            </span>
            <a href={`#${it.id}`} className="text-[#4c5661] hover:text-[#1a1a1a]">
              {it.title}
            </a>
          </li>
        ))}
      </ol>
    </details>
  );
}

function useActiveSection(items: TocItem[]) {
  const [active, setActive] = useState<string>(items[0]?.id ?? "");
  useEffect(() => {
    const els = items.map((it) => document.getElementById(it.id)).filter((el): el is HTMLElement => !!el);
    if (!els.length) return;
    // Track which sections are intersecting the band between the top of the
    // viewport and 35% down; the top-most intersecting one is active. Falls
    // back to the last section above the band when none intersects (long
    // sections).
    const visible = new Set<string>();
    const pick = () => {
      const ordered = els.map((el) => el.id);
      const firstVisible = ordered.find((id) => visible.has(id));
      if (firstVisible) return setActive(firstVisible);
      let last = ordered[0];
      for (const el of els) {
        if (el.getBoundingClientRect().top < window.innerHeight * 0.35) last = el.id;
      }
      setActive(last);
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        pick();
      },
      { rootMargin: "-100px 0px -65% 0px", threshold: 0 },
    );
    els.forEach((el) => io.observe(el));
    pick();
    return () => io.disconnect();
  }, [items]);
  return active;
}

/** One titled block of copy. `id` makes it linkable, matches the toc, and
 *  anchors a future FAQPage / BreadcrumbList node. */
export function Section({
  id,
  title,
  children,
  after,
}: {
  id?: string;
  title: string;
  children: ReactNode;
  /** A block that belongs to the section but not to its prose: a ladder,
   *  a tile grid, a gallery. Rendered after the copy, outside the Prose
   *  element selectors, so its own type and list styles stand. */
  after?: ReactNode;
}) {
  return (
    <Reveal>
      <section
        id={id}
        className="shell-section scroll-mt-28 border-t border-[#1a1a1a]/10 py-10 first:border-t-0 first:pt-0 tab:py-14"
      >
        <h2
          className="text-[24px] leading-[1.15] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[28px]"
          style={serif}
        >
          {title}
        </h2>
        <Prose>{children}</Prose>
        {after && <div className="mt-8">{after}</div>}
      </section>
    </Reveal>
  );
}

/** Body-copy scale for the long-form pages: 17/1.65 in the landing's
 *  secondary ink, lists with a hairline marker, links underlined in the
 *  landing blue. Element selectors keep the page bodies as plain HTML. */
export function Prose({ children }: { children: ReactNode }) {
  return (
    <div
      className={[
        "mt-4 text-[17px] leading-[1.65] text-[#4c5661] [text-wrap:pretty]",
        "[&_p+p]:mt-4 [&_p+ul]:mt-3 [&_ul+p]:mt-4 [&_p+address]:mt-4 [&_p+ol]:mt-3 [&_ol+p]:mt-4 [&_p+dl]:mt-4 [&_p+table]:mt-4 [&_table+p]:mt-4",
        "[&_ul]:flex [&_ul]:flex-col [&_ul]:gap-2 [&_ul]:pl-5 [&_ul>li]:relative",
        "[&_ul>li]:before:absolute [&_ul>li]:before:-left-5 [&_ul>li]:before:top-[0.85em] [&_ul>li]:before:h-px [&_ul>li]:before:w-2.5 [&_ul>li]:before:bg-[#4B82A5]",
        "[&_ol]:flex [&_ol]:flex-col [&_ol]:gap-2 [&_ol]:pl-7 [&_ol]:[list-style:decimal-leading-zero] [&_ol>li]:pl-1 [&_ol>li::marker]:text-[#4B82A5]",
        "[&_strong]:font-medium [&_strong]:text-[#1a1a1a]",
        "[&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5] [&_a:focus-visible]:rounded-sm [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-[#4B82A5]",
        "[&_h3]:mt-6 [&_h3]:text-[19px] [&_h3]:leading-snug [&_h3]:text-[#1a1a1a]",
        "[&_table]:w-full [&_table]:border-collapse [&_table]:text-[15px] [&_th]:py-2 [&_th]:pr-4 [&_th]:text-left [&_th]:text-[12px] [&_th]:tracking-[0.1em] [&_th]:text-[#777169] [&_th]:font-normal [&_th]:uppercase [&_td]:border-t [&_td]:border-[#1a1a1a]/10 [&_td]:py-3 [&_td]:pr-4 [&_td]:align-top",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

/** Short-version summary panel for the top of a long page: the landing's
 *  soft-paper surface, seated in a bezel, with a serif label. Give it 3–5
 *  one-line bullets. */
export function Summary({ title = "The short version", items }: { title?: string; items: ReactNode[] }) {
  return (
    <Reveal>
      <Bezel tone="paper" className="mb-10" innerClassName="p-6 tab:p-7">
        <p className="text-[20px] leading-none text-[#1a1a1a]" style={serif}>
          {title}
        </p>
        <ul className="mt-4 flex flex-col gap-2 pl-5 text-[16px] leading-[1.55] text-[#4c5661] [&>li]:relative [&>li]:before:absolute [&>li]:before:-left-5 [&>li]:before:top-[0.8em] [&>li]:before:h-px [&>li]:before:w-2.5 [&>li]:before:bg-[#4B82A5]">
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      </Bezel>
    </Reveal>
  );
}

/** Directory / index card: a white plate in the bezel tray, serif title,
 *  and the site's hover lift so a card that leads somewhere feels like it
 *  can be picked up. */
export function Card({
  title,
  eyebrow,
  children,
  className,
}: {
  title: ReactNode;
  eyebrow?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Bezel lift className={`h-full ${className ?? ""}`} innerClassName="flex h-full flex-col p-6">
      {eyebrow && <p className="mb-2 text-[12px] tracking-[0.12em] text-[#777169]">{eyebrow}</p>}
      <div className="text-[22px] leading-tight text-[#1a1a1a]" style={serif}>
        {title}
      </div>
      {children}
    </Bezel>
  );
}
