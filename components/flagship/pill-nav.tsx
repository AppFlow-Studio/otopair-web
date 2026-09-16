"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useReducedMotionSafe } from "./shared";
import { navMenu } from "./nav-menu";

export type NavItem = { label: string; href: string; hint?: string };
export type NavGroup = { label?: string; items: NavItem[] };
export type PillLink = { label: string; href: string; groups?: NavGroup[] };
type PillCta = { label: string; href: string };

// motion-wrapped next/link so a route CTA keeps client navigation AND the same
// spring hover the anchor CTA has.
const MotionLink = motion.create(Link);

// Home defaults — the four category triggers with the landing page's in-page
// anchors on the top-level labels. See nav-menu.ts for why.
const HOME_LINKS: PillLink[] = navMenu(true);
const HOME_CTA: PillCta = { label: "Get Oto", href: "#get-oto" };

// Returning shop owners/staff sign in here. `/shop` is role-gated, so middleware
// funnels signed-out visitors through Clerk sign-in first, then into the portal.
const HOME_SHOP_SIGN_IN: PillLink = { label: "Shop sign-in", href: "/shop" };

// Glass recipe shared by the ≥lg pill (Figma V1 node 302:1212), the <lg bar
// (mobile frame node 390:3223), the <lg menu sheet and the ≥lg hover panel:
// white @ 20%, 0.5px white @ 50% edge, 35px backdrop blur, no shadow.
const GLASS = "border-white/50 bg-white/20 backdrop-blur-[35px]";

// Shared hover treatment for every textual item in the pill — the category
// triggers, any plain link, and the shop sign-in. A background pill, never a
// transform: colour-only feedback is the standing rule on this glass. The
// sliding UnderlineLink was dropped here on 2026-09-10 so sign-in stops
// reading as a different kind of control from the four beside it.
const PILL_ITEM =
  "-mx-[10px] inline-flex items-center whitespace-nowrap rounded-full px-[10px] py-[3px] text-[15px] leading-[28px] text-[#1a1a1a] transition-colors";
const PILL_IDLE = "hover:bg-white/30";
const PILL_OPEN = "bg-white/45";

// Hover intent. 70ms in stops the panel flickering open as the pointer crosses
// the pill on its way somewhere else; 160ms out is enough to cross the 8px gap
// between the pill and the panel without the panel closing underneath you.
const OPEN_DELAY = 70;
const CLOSE_DELAY = 160;

/**
 * Floating glass pill nav — fixed and always visible (2026-08-31; it used to
 * hide on scroll-down and reveal on scroll-up).
 *
 * Below `lg` (1024px) — phones AND tablets, the 810px pill cannot fit under ~860 — it is not a pill: the mobile frame (node 390:3223) runs a
 * full-bleed 59px glass BAR — pin mark at x 18.5, the 101x28 "Get Oto" plate
 * ending 60px from the right edge, and a two-line hamburger at x 359.5–379.5
 * (frame width 402). Figma has no open state, so the menu is ours: a glass
 * sheet directly under the bar listing the links + shop sign-in as 44px rows.
 *
 * Reused across the flagship pages: pass `links`/`cta` to retarget it (the
 * partner page carries its own sections + an "Apply" CTA); defaults render the
 * home nav. `shopSignIn` renders a secondary text link beside the CTA; pass
 * `null` to omit it (e.g. the partner funnel).
 *
 * A link carrying `groups` becomes a hover trigger (Duna's pattern, picked in
 * the 2026-09-10 review): the label stays a real link — clicking it still goes
 * to the overview page or scrolls to the section — and hovering or focusing it
 * opens one shared glass panel under the pill. The panel keeps its position and
 * width and only changes height between categories, so moving along the pill
 * reads as one surface resizing rather than four separate popovers.
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
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const headerRef = useRef<HTMLElement>(null);
  const sheetId = useId();
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);

  /* ---- hover intent for the ≥lg category panel -------------------- */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  const openMenu = useCallback(
    (label: string) => {
      clearTimer();
      timer.current = setTimeout(() => setMenu(label), OPEN_DELAY);
    },
    [clearTimer],
  );
  const closeMenu = useCallback(() => {
    clearTimer();
    timer.current = setTimeout(() => setMenu(null), CLOSE_DELAY);
  }, [clearTimer]);
  const closeMenuNow = useCallback(() => {
    clearTimer();
    setMenu(null);
  }, [clearTimer]);
  useEffect(() => clearTimer, [clearTimer]);

  // The panel is chrome, not content: it must not survive a navigation. Reset
  // during render off a remembered pathname rather than in an effect — React's
  // own "adjusting state when a prop changes" pattern, and the one the
  // set-state-in-effect lint rule wants.
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setMenu(null);
    setOpen(false);
  }

  // Escape closes; so does scrolling away from it, matching the mobile sheet.
  useEffect(() => {
    if (!menu) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenuNow();
    };
    const startY = window.scrollY;
    const onScroll = () => {
      if (Math.abs(window.scrollY - startY) > 40) closeMenuNow();
    };
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll);
    };
  }, [menu, closeMenuNow]);

  // Height is measured, not `auto`: the panel animates its own height between
  // categories, and height is a layout property — animating it keeps the
  // backdrop-blurred surface off a transform, which is the standing rule here
  // (a transform on blurred glass drops the corner mask in Chromium).
  const innerRef = useRef<HTMLDivElement>(null);
  const [panelH, setPanelH] = useState(0);
  useEffect(() => {
    const el = innerRef.current;
    if (menu && el) setPanelH(el.offsetHeight);
  }, [menu]);

  const active = links.find((l) => l.label === menu && l.groups);

  /* ---- mobile sheet ------------------------------------------------ */
  // Dismissal: outside tap, Escape, scrolling more than 40px from where the
  // sheet opened, or crossing up into `lg` (the pill's own links take over
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
    const mq = window.matchMedia("(min-width: 1024px)");
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
  // rgba(26,26,26,.4) shadow. ≥lg keeps V1's h-9 / min-w-150 / 15px plate and
  // its blue-tinted shadow.
  const ctaClass =
    // No shadow below sm — Figma declares one on the plate, but on the glass
    // bar it read as a smear (design feedback 2026-09-03).
    "group relative flex h-[28px] w-[101px] shrink-0 items-center justify-center gap-2 rounded-[40px] border border-[#1a1a1a] bg-[#1a1a1a] px-4 text-[13px] leading-[22px] text-white shadow-none transition-colors hover:border-[#333] hover:bg-[#333] lg:h-9 lg:w-auto lg:min-w-[150px] lg:px-5 lg:text-[15px] lg:shadow-[-5px_10px_20px_rgba(70,127,237,0.17)]";
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
        className="absolute left-[6px] top-1/2 h-[18px] w-[18px] -translate-y-1/2 object-contain lg:left-[20px] lg:h-[22px] lg:w-[22px]"
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
    // flex-col at ≥lg so the hover panel can hang under the centred pill as a
    // sibling of the nav rather than a child of it — a child would sit inside
    // the pill's isolated stacking context and be clipped by its r100.
    <motion.header
      ref={headerRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="fixed inset-x-0 top-0 z-50 lg:flex lg:flex-col lg:items-center lg:px-4 lg:pt-4"
    >
      {/* ≥lg values are Figma V1's declared layer props (node 302:1212): r100,
          white @ 20%, 0.5px white @ 50% edge, 35px backdrop blur, no shadow on
          the pill. The V1 pill holds 3 destinations with wide air between them;
          we carry 5, so the pill widens to 810px and the link gap grows to keep
          V1's breathing room instead of packing 6 items into V1's 680px
          (design feedback 2026-08-30). 810, not 800: the audit's longer link
          labels (How it works / For shops / Coverage) overflowed the 800px
          pill by ~10px, which ate the button's 17px right inset down to 7.
          <lg is the mobile frame's edge-to-edge 59px bar with only a bottom
          hairline; insets 18.5 (mark) / 10.5 (44px hamburger hit box, whose
          20px lines then land at the frame's x 359.5) and 1px top padding so
          the content centres on the frame's y 30. */}
      <nav
        className="relative isolate flex h-[59px] w-full items-center justify-between gap-4 pl-[18.5px] pr-[10.5px] pt-px lg:h-[69px] lg:max-w-[810px] lg:pl-[30px] lg:pr-[17px] lg:pt-0"
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
          className={`pointer-events-none absolute inset-0 -z-10 border-b-[0.5px] ${GLASS} lg:rounded-[100px] lg:border-[0.5px]`}
        />
        <Link href="/" className="flex items-center" aria-label="Otopair home">
          {/* Layout box sized to the mark's presence: 17x21 in the mobile
              frame, 28x34 in the V1 pill (the 24x30 box undersold it next to
              the wider spacing). pin-logo-3d.png (500px source — the old
              200px logo.png read as a blurry blob at this size, 2026-08-30)
              carries transparent padding, so the image is scaled to 31px /
              48px and centred. */}
          <span className="relative block h-[21px] w-[17px] shrink-0 transition-opacity hover:opacity-80 lg:h-[34px] lg:w-[28px]">
            <Image
              src="/pin-logo-3d.png"
              alt="Otopair"
              width={48}
              height={48}
              priority
              className="absolute left-1/2 top-1/2 h-[31px] w-[31px] max-w-none -translate-x-1/2 -translate-y-1/2 object-contain lg:h-[48px] lg:w-[48px]"
            />
          </span>
        </Link>

        {/* gap-9 as before. The items' -mx-[10px] cancels their own 10px hover
            padding, so the LABELS sit exactly where they always did and only
            the hover pill extends past them. */}
        <ul
          className="hidden items-center gap-9 lg:flex"
          onPointerLeave={closeMenu}
        >
          {links.map((l) =>
            l.groups ? (
              <li key={l.label} className="whitespace-nowrap">
                <NavTrigger
                  link={l}
                  open={menu === l.label}
                  panelId={panelId}
                  onOpen={() => openMenu(l.label)}
                  onClose={closeMenu}
                />
              </li>
            ) : (
              <li key={l.label} className="whitespace-nowrap">
                <PillItemLink href={l.href}>{l.label}</PillItemLink>
              </li>
            ),
          )}
        </ul>

        {/* 5.5px: the frame's gap between the plate's right edge (x 342) and
            the hamburger hit box (lines at 359.5 minus the 12px inset that
            centres them in 44px). */}
        <div className="flex items-center gap-[5.5px] lg:gap-4">
          {shopSignIn && (
            /* Same background-pill hover as the four category triggers — with
               the old sliding underline it read as a different kind of control
               sitting among them (design feedback 2026-09-10). The wrapper
               stays because it is what hides the item below `lg`. */
            <span className="hidden lg:block">
              <PillItemLink href={shopSignIn.href}>{shopSignIn.label}</PillItemLink>
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
            className="flex h-11 w-11 shrink-0 items-center justify-center lg:hidden"
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

      {/* Category panel (≥lg). One surface for all four menus: it fades in and
          animates its measured height, and the columns inside crossfade. No
          transform anywhere — same standing rule as the pill and the sheet.
          `overflow-hidden` is what makes the height animation read as a
          reveal rather than a clip-and-pop. */}
      <AnimatePresence>
        {active && (
          <motion.div
            key="panel"
            id={panelId}
            /* Height only — NEVER opacity. An element with opacity < 1 is a
               backdrop root, so while this container fades its child's
               backdrop-filter has nothing to sample and the page behind shows
               through unblurred; Motion also settles at 0.999963 rather than a
               clean 1, so the blur never came back and the leak was permanent
               (design feedback 2026-09-10). The content's own stagger below
               carries the entrance instead. */
            initial={{ height: 0 }}
            animate={{ height: panelH || "auto" }}
            exit={{ height: 0 }}
            transition={{ duration: reduce ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
            onPointerEnter={clearTimer}
            onPointerLeave={closeMenu}
            /* Keyboard: tabbing off the trigger fires its onBlur, which
               schedules the close. Focus then lands inside here in the same
               task, and this capture-phase handler cancels that timer — so the
               panel survives being tabbed into, and only closes once focus
               actually leaves it. */
            onFocusCapture={clearTimer}
            onBlur={closeMenu}
            className="pointer-events-auto relative isolate mt-2 hidden w-[620px] overflow-hidden rounded-[20px] shadow-[0_18px_44px_rgba(26,26,26,0.10)] lg:block"
          >
            {/* Blur on its own childless layer, exactly as the pill does it —
                which is what lets the rows below animate at all. With the blur
                on this element, a transform-animated child would become its own
                composited layer over the rounded backdrop-blur and Chromium
                would drop the corner mask across the overlap. */}
            <span
              aria-hidden
              className={`pointer-events-none absolute inset-0 -z-10 rounded-[20px] border-[0.5px] ${GLASS}`}
            />
            {/* Keyed on the category, so switching menus replays the entrance
                instead of swapping the text in place. Columns lead, rows follow
                in a short stagger. */}
            <motion.div
              key={active.label}
              ref={innerRef}
              initial="hidden"
              animate="shown"
              variants={{
                shown: { transition: { staggerChildren: reduce ? 0 : 0.035 } },
              }}
              className="grid grid-cols-2 gap-x-8 px-7 py-6"
            >
              {active.groups?.map((g) => (
                <motion.div
                  key={g.label ?? "group"}
                  variants={{
                    hidden: { opacity: 0, y: reduce ? 0 : 6 },
                    shown: {
                      opacity: 1,
                      y: 0,
                      transition: {
                        duration: reduce ? 0 : 0.26,
                        ease: [0.22, 1, 0.36, 1],
                        staggerChildren: reduce ? 0 : 0.03,
                      },
                    },
                  }}
                >
                  {g.label && (
                    <p className="mb-3 text-[11px] uppercase tracking-[0.1em] text-[#1a1a1a]/45">
                      {g.label}
                    </p>
                  )}
                  <ul className="flex flex-col gap-[14px]">
                    {g.items.map((item) => (
                      <motion.li
                        key={item.href + item.label}
                        variants={{
                          hidden: { opacity: 0, y: reduce ? 0 : 5 },
                          shown: {
                            opacity: 1,
                            y: 0,
                            transition: { duration: reduce ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] },
                          },
                        }}
                      >
                        <PanelLink item={item} onSelect={closeMenuNow} />
                      </motion.li>
                    ))}
                  </ul>
                </motion.div>
              ))}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mobile menu sheet: same glass as the bar, hung directly under it. It
          fades rather than slides — a backdrop-blur surface must never ride a
          small transform animation (pixel judder, standing rule). The bar's
          bottom hairline is the divider, so the sheet drops its own top edge.
          A link with `groups` renders as a section: the category as a 44px row,
          then its pages indented under it, so the sheet reaches the same
          destinations the hover panel does. */}
      <AnimatePresence>
        {open && (
          <motion.div
            key="sheet"
            id={sheetId}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.2, ease: "easeOut" }}
            className={`max-h-[calc(100vh-59px)] overflow-y-auto rounded-b-[20px] border-[0.5px] border-t-0 px-[27px] py-4 ${GLASS} lg:hidden`}
          >
            <ul className="flex flex-col">
              {sheetRows.map((l) => (
                <li key={l.label}>
                  <SheetRow href={l.href} onSelect={close}>
                    {l.label}
                  </SheetRow>
                  {l.groups && (
                    <ul className="mb-1 flex flex-col border-l border-[#1a1a1a]/12 pl-3">
                      {l.groups.flatMap((g) => g.items).map((item) => (
                        <li key={item.href + item.label}>
                          <SheetRow href={item.href} onSelect={close} sub>
                            {item.label}
                          </SheetRow>
                        </li>
                      ))}
                    </ul>
                  )}
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
 * A category label in the pill. Still a real link — clicking "Coverage" goes to
 * the coverage page (or scrolls to the section on home) exactly as before — but
 * hovering or focusing it opens the panel. Focus opens it too, so the menu is
 * reachable by keyboard without turning the label into a button that no longer
 * navigates.
 *
 * The active state is a background pill, not a transform: colour-only feedback
 * is the rule inside this glass surface.
 */
function NavTrigger({
  link,
  open,
  panelId,
  onOpen,
  onClose,
}: {
  link: PillLink;
  open: boolean;
  panelId: string;
  onOpen: () => void;
  onClose: () => void;
}) {
  const cls = `${PILL_ITEM} ${open ? PILL_OPEN : PILL_IDLE}`;
  // No chevron: the background pill is the affordance, the way Duna does it
  // (design feedback 2026-09-10).
  const inner = link.label;
  const props = {
    className: cls,
    "aria-expanded": open,
    "aria-haspopup": true,
    "aria-controls": panelId,
    onPointerEnter: onOpen,
    onFocus: onOpen,
    onBlur: onClose,
  } as const;

  // In-page anchors stay plain <a> so Lenis's anchor handler owns the scroll.
  if (link.href.startsWith("#")) {
    return (
      <a href={link.href} {...props}>
        {inner}
      </a>
    );
  }
  return (
    <Link href={link.href} {...props}>
      {inner}
    </Link>
  );
}

/**
 * A plain (menu-less) item in the pill — a retargeted page's own link, and the
 * shop sign-in. Carries the trigger's background-pill hover so everything in
 * the pill responds the same way.
 */
function PillItemLink({ href, children }: { href: string; children: React.ReactNode }) {
  const cls = `${PILL_ITEM} ${PILL_IDLE}`;
  // In-page anchors stay plain <a> so Lenis's anchor handler owns the scroll.
  if (href.startsWith("#")) {
    return (
      <a href={href} className={cls}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}

/** One row in the hover panel: bold label, one muted line under it. */
function PanelLink({ item, onSelect }: { item: NavItem; onSelect: () => void }) {
  const cls = "group block";
  const inner = (
    <>
      <span className="block text-[14px] leading-[20px] text-[#1a1a1a] transition-opacity group-hover:opacity-70">
        {item.label}
      </span>
      {item.hint && (
        <span className="block text-[12px] leading-[17px] text-[#1a1a1a]/50">
          {item.hint}
        </span>
      )}
    </>
  );
  if (item.href.startsWith("#")) {
    return (
      <a href={item.href} className={cls} onClick={onSelect}>
        {inner}
      </a>
    );
  }
  return (
    <Link href={item.href} className={cls} onClick={onSelect}>
      {inner}
    </Link>
  );
}

/**
 * One 44px-tall menu row. Same routing rule as UnderlineLink: in-page anchors
 * stay plain <a> so Lenis's anchor handler owns the scroll (it listens on the
 * window, after React's own click, so closing the sheet here can't rob it).
 * `sub` renders the shorter, quieter row used for a category's pages.
 */
function SheetRow({
  href,
  onSelect,
  sub = false,
  children,
}: {
  href: string;
  onSelect: () => void;
  sub?: boolean;
  children: React.ReactNode;
}) {
  const cls = sub
    ? "flex h-10 w-full items-center text-[14px] leading-[20px] text-[#1a1a1a]/70"
    : "flex h-11 w-full items-center text-[15px] leading-[22px] text-[#1a1a1a]";
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
