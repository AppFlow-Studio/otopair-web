"use client";

/* ------------------------------------------------------------------ */
/* OtoCard — the one contract for everything Oto puts on screen.        */
/*                                                                     */
/* Before this file there were 24 card components across three files    */
/* that agreed on the shell (24px padding, 20px radius, frosted white,  */
/* Petrona titles) and on nothing else. Measured 2026-09-07: heights    */
/* ran 241px → 549px inside a fixed 530px panel, so the panel           */
/* re-centred on every swap; `confirmed` overhung it by 19px; the       */
/* CardHead helper was used by 8 of 14 demo cards while 12 components   */
/* hand-rolled the same markup; three cards had lost their header icon; */
/* RatingsCard had no title at all; and there were three different      */
/* overflow policies — including none at all on the ONE card whose      */
/* content the agent composes at runtime.                              */
/*                                                                     */
/* Nothing here changes how a card LOOKS. The shell string, the header  */
/* sizes and the Step entrance are carried over byte-for-byte. What it  */
/* adds is a single owner for the three things the cards disagreed on:  */
/* height, overflow, and the header.                                   */
/* ------------------------------------------------------------------ */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Step } from "./shared";

/** The card shell. Previously duplicated byte-for-byte in cards.tsx and
 *  demo-cards.tsx; this is now the only definition. */
export const CARD =
  "w-full rounded-[24px] border border-white/60 bg-white/75 p-6 backdrop-blur-2xl shadow-[0_24px_64px_-12px_rgba(0,0,0,0.12),0_4px_16px_-2px_rgba(0,0,0,0.04)] ring-1 ring-black/[0.03]";

/* ------------------------------------------------------------------ */
/* Surface — where a card is being rendered.                           */
/*                                                                     */
/* The hero calls renderRightCard() twice: once into the fixed 530px    */
/* desktop canvas panel, and once into the mobile glass card, where the */
/* card is one item in a scrolling transcript with no height of its     */
/* own. "panel" fills and scrolls internally; "inline" sizes to its     */
/* content, which is what the mobile transcript needs. Defaults to      */
/* inline so a card rendered anywhere else can never collapse.          */
/* ------------------------------------------------------------------ */
export type CardSurface = "panel" | "inline";
const SurfaceContext = createContext<CardSurface>("inline");

export function CardSurfaceProvider({
  surface,
  children,
}: {
  surface: CardSurface;
  children: React.ReactNode;
}) {
  return <SurfaceContext.Provider value={surface}>{children}</SurfaceContext.Provider>;
}

export const useCardSurface = () => useContext(SurfaceContext);

/* ------------------------------------------------------------------ */
/* ScrollBody — honest overflow.                                       */
/*                                                                     */
/* The old cards clipped silently: ServiceCatalogCard advertised "4     */
/* categories" in its own subtitle and showed three, with 90px below an */
/* invisible fold. A mask (rather than an overlay) is what works on the */
/* frosted shell — an opaque gradient would paint a white band over     */
/* translucent glass. The fade only appears on the edge that actually   */
/* has content beyond it.                                              */
/* ------------------------------------------------------------------ */
const FADE = 26;

function ScrollBody({
  children,
  className = "",
  enabled,
}: {
  children: React.ReactNode;
  className?: string;
  enabled: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const slack = el.scrollHeight - el.clientHeight;
    if (slack <= 4) {
      setEdges((p) => (p.top || p.bottom ? { top: false, bottom: false } : p));
      return;
    }
    const top = el.scrollTop > 2;
    const bottom = el.scrollTop < slack - 2;
    setEdges((p) => (p.top === top && p.bottom === bottom ? p : { top, bottom }));
  }, []);

  // Cards animate their rows in, so the scroll height settles after mount —
  // a ResizeObserver on the content is what catches that, not a single pass.
  useLayoutEffect(() => {
    if (!enabled) return;
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [enabled, measure]);

  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(measure, 900); // after the entrance choreography
    return () => clearTimeout(t);
  }, [enabled, measure, children]);

  if (!enabled) return <div className={className}>{children}</div>;

  const mask =
    edges.top && edges.bottom
      ? `linear-gradient(to bottom, transparent 0, #000 ${FADE}px, #000 calc(100% - ${FADE}px), transparent 100%)`
      : edges.bottom
        ? `linear-gradient(to bottom, #000 calc(100% - ${FADE}px), transparent 100%)`
        : edges.top
          ? `linear-gradient(to bottom, transparent 0, #000 ${FADE}px)`
          : undefined;

  return (
    <div
      ref={ref}
      onScroll={measure}
      className={`min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-width:thin] [scrollbar-color:rgba(0,0,0,0.12)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-black/12 hover:[&::-webkit-scrollbar-thumb]:bg-black/25 ${className}`}
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* CardHead — the header every card was already trying to render.      */
/* Moved here from demo-cards.tsx unchanged (18px icon at strokeWidth   */
/* 1.6, 19px Petrona title, 12px subtitle) and now used by all of them. */
/* ------------------------------------------------------------------ */
export function CardHead({
  icon: Icon,
  title,
  subtitle,
  delay = 0.05,
  aside,
}: {
  icon?: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  subtitle?: string;
  delay?: number;
  /** Optional right-aligned element on the title row (a badge, a pill). */
  aside?: React.ReactNode;
}) {
  return (
    <Step delay={delay}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            {Icon && (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#2f7bff]/10 text-[#2f7bff] shadow-sm ring-1 ring-[#2f7bff]/20">
                <Icon className="h-4 w-4" strokeWidth={1.8} />
              </div>
            )}
            <h3
              className="truncate text-[20px] font-medium tracking-tight text-[#1a1a1a]"
              style={{ fontFamily: "var(--font-Petrona)" }}
            >
              {title}
            </h3>
          </div>
          {subtitle && <p className="mt-1.5 text-[12px] leading-snug text-[#1a1a1a]/60">{subtitle}</p>}
        </div>
        {aside && <div className="shrink-0">{aside}</div>}
      </div>
    </Step>
  );
}

/* ------------------------------------------------------------------ */
/* OtoCard — shell + pinned header + scrolling body + pinned footer.   */
/*                                                                     */
/* In the panel the card always fills the frame, so the canvas stops    */
/* re-centring on every swap. VehicleCard already did exactly this and  */
/* was the only one of 24 that did; this generalises it.                */
/* ------------------------------------------------------------------ */
export function OtoCard({
  icon,
  title,
  subtitle,
  aside,
  header,
  footer,
  children,
  className = "",
  bodyClassName = "",
  surface,
}: {
  icon?: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title?: string;
  subtitle?: string;
  aside?: React.ReactNode;
  /** Escape hatch for a card whose header genuinely isn't the standard one
   *  (the booking receipt's centred check mark). Wins over icon/title. */
  header?: React.ReactNode;
  /** Pinned to the bottom of the card — actions that must stay reachable
   *  when the body scrolls. */
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Overrides the surrounding surface. Rarely needed. */
  surface?: CardSurface;
}) {
  const ctx = useCardSurface();
  const fill = (surface ?? ctx) === "panel";

  return (
    <div
      className={`${CARD} ${
        fill ? "flex h-full flex-col !p-4 sm:!p-5" : ""
      } ${className}`}
    >
      {header ?? (title ? <CardHead icon={icon} title={title} subtitle={subtitle} aside={aside} /> : null)}
      <ScrollBody enabled={fill} className={bodyClassName}>
        {children}
      </ScrollBody>
      {footer ? <div className="shrink-0 pt-2">{footer}</div> : null}
    </div>
  );
}
