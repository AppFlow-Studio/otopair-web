"use client";

import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { UnderlineLink, useReducedMotionSafe } from "./shared";

type PillLink = { label: string; href: string };
type PillCta = { label: string; href: string };

// motion-wrapped next/link so a route CTA keeps client navigation AND the same
// spring hover the anchor CTA has.
const MotionLink = motion.create(Link);

// Home defaults. Labels must name the section they land on — V1's verbatim
// About/Careers/Services labels pointed at unrelated anchors ("Careers" landed
// on the shop pitch; site audit 2026-08-31). "Partner with us" is the real
// entry point into the shops funnel and routes to the partner page rather
// than a section.
const HOME_LINKS: PillLink[] = [
  { label: "How it works", href: "#how-it-works" },
  { label: "For shops", href: "#for-shops" },
  { label: "Coverage", href: "#coverage" },
  { label: "Partner with us", href: "/partner-with-us" },
];
const HOME_CTA: PillCta = { label: "Get Oto", href: "#get-oto" };

// Returning shop owners/staff sign in here. `/shop` is role-gated, so middleware
// funnels signed-out visitors through Clerk sign-in first, then into the portal.
const HOME_SHOP_SIGN_IN: PillLink = { label: "Shop sign-in", href: "/shop" };

// Glass recipe shared by the ≥sm pill (Figma V1 node 302:1212), the <sm bar
// (mobile frame node 390:3223) and the <sm menu sheet: white @ 20%, 0.5px
// white @ 50% edge, 35px backdrop blur, no shadow.
const GLASS = "border-white/50 bg-white/20 backdrop-blur-[35px]";

/**
 * Floating glass pill nav — fixed and always visible (2026-08-31; it used to
 * hide on scroll-down and reveal on scroll-up).
 *
 * Below `sm` (640px) it is not a pill: the mobile frame (node 390:3223) runs a
 * full-bleed 59px glass BAR — pin mark at x 18.5, the 101x28 "Get Oto" plate
 * ending 60px from the right edge, and a two-line hamburger at x 359.5–379.5
 * (frame width 402). Figma has no open state, so the menu is ours: a glass
 * sheet directly under the bar listing the links + shop sign-in as 44px rows.
 *
 * Reused across the flagship pages: pass `links`/`cta` to retarget it (the
 * partner page carries its own sections + an "Apply" CTA); defaults render the
 * home nav. `shopSignIn` renders a secondary text link beside the CTA; pass
 * `null` to omit it (e.g. the partner funnel).
 */
export default function PillNav({
  links = HOME_LINKS,
  cta = HOME_CTA,
  shopSignIn = HOME_SHOP_SIGN_IN,
}: {
  links?: PillLink[];
  cta?: PillCta;
  shopSignIn?: PillLink | null;
}) {
  const reduce = useReducedMotionSafe();
  const [open, setOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const sheetId = useId();
  const close = useCallback(() => setOpen(false), []);

  // Dismissal: outside tap, Escape, scrolling more than 40px from where the
  // sheet opened, or crossing up into `sm` (the pill's own links take over
  // there and the sheet has nowhere to live).
  useEffect(() => {
    if (!open) return;
    const startY = window.scrollY;
    const onPointerDown = (e: PointerEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onScroll = () => {
      if (Math.abs(window.scrollY - startY) > 40) close();
    };
    const mq = window.matchMedia("(min-width: 640px)");
    const onMq = () => {
      if (mq.matches) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, { passive: true });
    mq.addEventListener("change", onMq);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll);
      mq.removeEventListener("change", onMq);
    };
  }, [open, close]);

  // Mobile frame: 101x28 plate, r40, #1a1a1a, 13/22 label, -10px 8px 10px
  // rgba(26,26,26,.4) shadow. ≥sm keeps V1's h-9 / min-w-150 / 15px plate and
  // its blue-tinted shadow.
  const ctaClass =
    // No shadow below sm — Figma declares one on the plate, but on the glass
    // bar it read as a smear (design feedback 2026-09-03).
    "group relative flex h-[28px] w-[101px] shrink-0 items-center justify-center gap-2 rounded-[40px] border border-[#1a1a1a] bg-[#1a1a1a] px-4 text-[13px] leading-[22px] text-white shadow-none transition-colors hover:border-[#333] hover:bg-[#333] sm:h-9 sm:w-auto sm:min-w-[150px] sm:px-5 sm:text-[15px] sm:shadow-[-5px_10px_20px_rgba(70,127,237,0.17)]";
  const ctaInner = (
    <>
      {/* V1 floats the pin over the button rather than putting it in flow, so
          the label stays centred within the button. */}
      {/* pin-logo-3d (500px) over logo.png (200px, soft edges) — the small
          flat export read as a blurry blob at button size (2026-08-30).
          The source carries transparent padding (visible mark = 266x341 of
          500): 18px renders the mobile frame's 10x12 pin with its left edge
          11px in from the plate; 22px is the V1 desktop size. */}
      <Image
        src="/pin-logo-3d.png"
        alt=""
        width={22}
        height={22}
        aria-hidden
        className="absolute left-[6px] top-1/2 h-[18px] w-[18px] -translate-y-1/2 object-contain sm:left-[20px] sm:h-[22px] sm:w-[22px]"
      />
      {cta.label}
    </>
  );
  // No transform hovers anywhere inside the pill: a transform-animated child
  // becomes its own composited layer overlapping the rounded backdrop-blur,
  // and Chromium then draws that overlap rect with the blur's corner mask
  // dropped — the lighter band beside the button and the squared pill end
  // (design feedback 2026-09-03). Hover feedback is colour only.
  const ctaMotion = {
    whileTap: { opacity: 0.85 },
    transition: { duration: 0.15 },
  } as const;

  const lineTransition = reduce
    ? { duration: 0 }
    : { duration: 0.25, ease: [0.22, 1, 0.36, 1] as const };
  const sheetRows: PillLink[] = shopSignIn ? [...links, shopSignIn] : links;

  return (
    // Opacity-only entrance. The old y:-24 slide left a transform on this
    // fixed, backdrop-blurred surface, and Chrome re-rasterizes a blur that
    // sits under any transform — the pill shimmered on scroll, the same
    // judder the listens bubbles had (design feedback 2026-09-03).
    <motion.header
      ref={headerRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="fixed inset-x-0 top-0 z-50 sm:flex sm:justify-center sm:px-4 sm:pt-4"
    >
      {/* ≥sm values are Figma V1's declared layer props (node 302:1212): r100,
          white @ 20%, 0.5px white @ 50% edge, 35px backdrop blur, no shadow on
          the pill. The V1 pill holds 3 destinations with wide air between them;
          we carry 5, so the pill widens to 810px and the link gap grows to keep
          V1's breathing room instead of packing 6 items into V1's 680px
          (design feedback 2026-08-30). 810, not 800: the audit's longer link
          labels (How it works / For shops / Coverage) overflowed the 800px
          pill by ~10px, which ate the button's 17px right inset down to 7.
          <sm is the mobile frame's edge-to-edge 59px bar with only a bottom
          hairline; insets 18.5 (mark) / 10.5 (44px hamburger hit box, whose
          20px lines then land at the frame's x 359.5) and 1px top padding so
          the content centres on the frame's y 30. */}
      <nav
        className="relative isolate flex h-[59px] w-full items-center justify-between gap-4 pl-[18.5px] pr-[10.5px] pt-px sm:h-[69px] sm:max-w-[810px] sm:pl-[30px] sm:pr-[17px] sm:pt-0"
      >
        {/* The glass is its OWN element, behind the content (-z-10 inside the
            nav's isolated stacking context). When the blur lived on the nav
            itself, any child repaint — the CTA's hover spring and its shadow,
            a link's colour transition — re-sampled the backdrop only inside
            that repaint rect, and the blur's edge treatment showed as a
            lighter vertical band beside the button (design feedback
            2026-09-03). With the blur on a childless sibling layer, children
            repaint on top and the backdrop is only ever re-rendered whole. */}
        <span
          aria-hidden
          className={`pointer-events-none absolute inset-0 -z-10 border-b-[0.5px] ${GLASS} sm:rounded-[100px] sm:border-[0.5px]`}
        />
        <Link href="/" className="flex items-center" aria-label="Otopair home">
          {/* Layout box sized to the mark's presence: 17x21 in the mobile
              frame, 28x34 in the V1 pill (the 24x30 box undersold it next to
              the wider spacing). pin-logo-3d.png (500px source — the old
              200px logo.png read as a blurry blob at this size, 2026-08-30)
              carries transparent padding, so the image is scaled to 31px /
              48px and centred. */}
          <span className="relative block h-[21px] w-[17px] shrink-0 transition-opacity hover:opacity-80 sm:h-[34px] sm:w-[28px]">
            <Image
              src="/pin-logo-3d.png"
              alt="Otopair"
              width={48}
              height={48}
              priority
              className="absolute left-1/2 top-1/2 h-[31px] w-[31px] max-w-none -translate-x-1/2 -translate-y-1/2 object-contain sm:h-[48px] sm:w-[48px]"
            />
          </span>
        </Link>

        <ul className="hidden items-center gap-9 sm:flex">
          {links.map((l) => (
            <li key={l.label} className="whitespace-nowrap">
              <UnderlineLink
                href={l.href}
                className="text-[15px] leading-[28px] text-[#1a1a1a] transition-colors hover:text-[#1a1a1a]/70"
              >
                {l.label}
              </UnderlineLink>
            </li>
          ))}
        </ul>

        {/* 5.5px: the frame's gap between the plate's right edge (x 342) and
            the hamburger hit box (lines at 359.5 minus the 12px inset that
            centres them in 44px). */}
        <div className="flex items-center gap-[5.5px] sm:gap-4">
          {shopSignIn && (
            /* Hide via a wrapper: UnderlineLink's base class ends in
               `inline-block`, which ties with `hidden` at equal specificity
               and wins on stylesheet order — so the link itself can't be
               responsive-hidden reliably (audit P2, 2026-08-30). */
            <span className="hidden sm:block">
              <UnderlineLink
                href={shopSignIn.href}
                className="whitespace-nowrap text-[15px] leading-[28px] text-[#1a1a1a] transition-colors hover:text-[#1a1a1a]/70"
              >
                {shopSignIn.label}
              </UnderlineLink>
            </span>
          )}
          {cta.href.startsWith("#") ? (
            <motion.a href={cta.href} {...ctaMotion} className={ctaClass}>
              {ctaInner}
            </motion.a>
          ) : (
            <MotionLink href={cta.href} {...ctaMotion} className={ctaClass}>
              {ctaInner}
            </MotionLink>
          )}

          {/* Hamburger (mobile frame nodes 390:3228/3229): two 20px x 1.5px
              #1a1a1a lines 7px apart centre-to-centre, in a 44px hit box.
              Open state morphs them into an X — a one-shot child transform,
              not a continuous tiny animation under the glass. */}
          <button
            type="button"
            aria-expanded={open}
            aria-controls={sheetId}
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
            className="flex h-11 w-11 shrink-0 items-center justify-center sm:hidden"
          >
            {/* mt-[2px]: the frame draws the lines at y 26.5/33.5, ~1px below
                the bar's content centre where the mark and plate sit. */}
            <span className="relative mt-[2px] block h-[8.5px] w-5">
              <motion.span
                aria-hidden
                className="absolute left-0 top-0 block h-[1.5px] w-5 rounded-full bg-[#1a1a1a]"
                animate={{ y: open ? 3.5 : 0, rotate: open ? 45 : 0 }}
                transition={lineTransition}
              />
              <motion.span
                aria-hidden
                className="absolute bottom-0 left-0 block h-[1.5px] w-5 rounded-full bg-[#1a1a1a]"
                animate={{ y: open ? -3.5 : 0, rotate: open ? -45 : 0 }}
                transition={lineTransition}
              />
            </span>
          </button>
        </div>
      </nav>

      {/* Mobile menu sheet: same glass as the bar, hung directly under it. It
          fades rather than slides — a backdrop-blur surface must never ride a
          small transform animation (pixel judder, standing rule). The bar's
          bottom hairline is the divider, so the sheet drops its own top edge. */}
      <AnimatePresence>
        {open && (
          <motion.div
            key="sheet"
            id={sheetId}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.2, ease: "easeOut" }}
            className={`rounded-b-[20px] border-[0.5px] border-t-0 px-[27px] py-4 ${GLASS} sm:hidden`}
          >
            <ul className="flex flex-col">
              {sheetRows.map((l) => (
                <li key={l.label}>
                  <SheetRow href={l.href} onSelect={close}>
                    {l.label}
                  </SheetRow>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.header>
  );
}

/**
 * One 44px-tall menu row. Same routing rule as UnderlineLink: in-page anchors
 * stay plain <a> so Lenis's anchor handler owns the scroll (it listens on the
 * window, after React's own click, so closing the sheet here can't rob it).
 */
function SheetRow({
  href,
  onSelect,
  children,
}: {
  href: string;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  const cls =
    "flex h-11 w-full items-center text-[15px] leading-[22px] text-[#1a1a1a]";
  if (href.startsWith("#")) {
    return (
      <a href={href} className={cls} onClick={onSelect}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls} onClick={onSelect}>
      {children}
    </Link>
  );
}
