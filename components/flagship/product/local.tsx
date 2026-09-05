"use client";

import { useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { motion, useInView } from "motion/react";
import { Check, ChevronRight, ClipboardCheck, Clock, CreditCard, Star, Users } from "lucide-react";
import { BOROUGHS } from "@/lib/coverage";
import type { PublicShopSummary } from "@/lib/public-shops";
import { SERVICES } from "@/lib/service-catalog";
import { project, staticMapSrc, type MapCenter } from "@/lib/static-map";
import { useReducedMotionSafe } from "../shared";
import { APP, appFont } from "./device";
import { PullCard } from "./pullouts";
import { Rise } from "@/app/(marketing)/pricing/sections";

/**
 * Web-scale objects for the local pages (coverage, the boroughs, the
 * Staten Island hub, the shop directory). Each one is the app's object
 * at reading size, in the app's face, fed by real data where the page
 * has it:
 *
 *  - BoroughRail: the five boroughs on one line, the live one carrying
 *    the real shop count, the first segment drawing itself in.
 *  - DirectoryCard: MapBrowseShopCard's anatomy (image 80, name, rating
 *    · Auto repair shop, Open) at 96px with the directory's facts.
 *  - VerifiedPull: the four things a shop clears before it is listed.
 */

const EASE = [0.22, 1, 0.36, 1] as const;
const INK = "#0F172A";

/** "8:00 AM" from "08:00" (a copy of lib/public-shops formatTime, which
 *  lives in a server module). */
function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h)) return hhmm;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m ?? 0).padStart(2, "0")} ${suffix}`;
}
const serif = { fontFamily: "var(--font-Petrona)", fontWeight: 400 } as const;

/* ------------------------------------------------------------------ */
/* Borough rail                                                        */
/* ------------------------------------------------------------------ */

export function BoroughRail({ current, liveCount = null }: { current?: string; liveCount?: number | null }) {
  const reduce = useReducedMotionSafe();
  const ref = useRef<HTMLOListElement>(null);
  const on = useInView(ref, { once: true, margin: "-20% 0px" });
  const drawn = reduce || on;
  const liveLine = liveCount == null ? null : liveCount === 0 ? "Verified shops onboarding now" : `${liveCount} verified ${liveCount === 1 ? "shop" : "shops"} bookable today`;
  return (
    <ol ref={ref} className="relative grid gap-y-10 lg:grid-cols-5 lg:gap-x-6 lg:gap-y-0" aria-label="Boroughs, in launch order">
      {/* the track: vertical on phones, horizontal from lg */}
      <span aria-hidden className="absolute bottom-3 left-[9px] top-3 w-px bg-[#1a1a1a]/12 lg:hidden" />
      <span aria-hidden className="absolute left-[10%] right-[10%] top-[9px] hidden h-px bg-[#1a1a1a]/12 lg:block" />
      {/* the drawn segment: Staten Island to Brooklyn */}
      <motion.span
        aria-hidden
        className="absolute left-[9px] top-3 hidden w-px origin-top bg-[#4B82A5] max-lg:block"
        style={{ height: "calc(20% + 2px)" }}
        initial={{ transform: reduce ? "scaleY(1)" : "scaleY(0)" }}
        animate={{ transform: drawn ? "scaleY(1)" : "scaleY(0)" }}
        transition={{ duration: 1.1, ease: EASE, delay: 0.2 }}
      />
      <motion.span
        aria-hidden
        className="absolute left-[10%] top-[9px] hidden h-px origin-left bg-[#4B82A5] lg:block"
        style={{ width: "20%" }}
        initial={{ transform: reduce ? "scaleX(1)" : "scaleX(0)" }}
        animate={{ transform: drawn ? "scaleX(1)" : "scaleX(0)" }}
        transition={{ duration: 1.1, ease: EASE, delay: 0.2 }}
      />
      {BOROUGHS.map((b, i) => {
        const here = b.slug === current;
        return (
          <li key={b.slug} className="relative flex gap-5 pl-9 lg:flex-col lg:items-center lg:pl-0 lg:text-center">
            {/* stop */}
            <motion.span
              aria-hidden
              className="absolute left-0 top-[2px] flex h-[19px] w-[19px] items-center justify-center rounded-full lg:static lg:mx-auto"
              initial={{ opacity: reduce ? 1 : 0, transform: reduce ? "scale(1)" : "scale(0.6)" }}
              animate={{ opacity: drawn ? 1 : 0, transform: drawn ? "scale(1)" : "scale(0.6)" }}
              transition={{ duration: 0.5, ease: EASE, delay: 0.15 + i * 0.16 }}
            >
              {b.live ? (
                <>
                  <motion.span className="absolute inset-0 rounded-full bg-[#4B82A5]/30" animate={reduce ? undefined : { transform: ["scale(1)", "scale(1.9)", "scale(1)"], opacity: [0.6, 0, 0.6] }} transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }} />
                  <span className="relative h-[11px] w-[11px] rounded-full bg-[#4B82A5]" />
                </>
              ) : (
                <span className={`h-[11px] w-[11px] rounded-full border-[1.5px] bg-white ${here ? "border-[#1a1a1a]" : "border-[#1a1a1a]/30"}`} />
              )}
            </motion.span>
            <div className="min-w-0 lg:mt-5">
              <p className={`text-[12px] tracking-[0.1em] ${b.live ? "text-[#4B82A5]" : here ? "text-[#1a1a1a]" : "text-[#777169]"}`}>{b.date.toUpperCase()}</p>
              <h3 className={`mt-2 text-[24px] leading-none text-[#1a1a1a] ${here ? "underline decoration-[#4B82A5]/40 underline-offset-[6px]" : ""}`} style={serif}>
                {b.name}
              </h3>
              {b.live && liveLine && <p className="mt-2 text-[13.5px] font-medium text-[#4B82A5]">{liveLine}</p>}
              <p className="mt-3 max-w-[30ch] text-[14.5px] leading-[1.55] text-[#6b655d] lg:mx-auto">{b.blurb}</p>
              {!here && (
                <Link href={`/${b.slug}`} className="mt-3 inline-block text-[14px] text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">
                  {b.live ? `Shops in ${b.name}` : `Join the ${b.name.replace(/^The /, "")} waitlist`}
                </Link>
              )}
              {here && <p className="mt-3 text-[14px] text-[#1a1a1a]">You are here.</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/* Directory                                                           */
/* ------------------------------------------------------------------ */

const NAME_BY_SLUG = new Map(SERVICES.map((s) => [s.slug, s.name]));

export function DirectoryCard({
  shop,
  index = 0,
  n,
  active = false,
  onHover,
}: {
  shop: PublicShopSummary;
  index?: number;
  /** Number shown on the card and on its map pin. */
  n?: number;
  active?: boolean;
  onHover?: (slug: string | null) => void;
}) {
  const href = `/shops/${shop.slug}`;
  const place = shop.neighborhood ?? shop.city;
  const open = shop.openToday;
  const names = shop.serviceSlugs.map((x) => NAME_BY_SLUG.get(x)).filter((x): x is string => !!x);
  return (
    // min-w-0: a grid or flex item defaults to min-width:auto, so the card's
    // longest name would otherwise widen the whole column past the viewport.
    <Rise delay={Math.min(index, 8) * 0.05} className="min-w-0">
      <Link
        href={href}
        onMouseEnter={() => onHover?.(shop.slug)}
        onMouseLeave={() => onHover?.(null)}
        onFocus={() => onHover?.(shop.slug)}
        onBlur={() => onHover?.(null)}
        className={`group relative flex h-full items-stretch gap-4 rounded-[20px] bg-white p-3 ring-1 transition-[transform,box-shadow] duration-500 ease-expo hover:-translate-y-0.5 hover:shadow-lift focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4B82A5] ${active ? "ring-[#4B82A5]/60" : "ring-[#1a1a1a]/[0.06]"}`}
        style={{ ...appFont, boxShadow: "0 1px 2px rgba(26,26,26,0.04), 0 10px 28px rgba(26,26,26,0.05)" }}
      >
        {n != null && (
          <span className="absolute -left-2 -top-2 flex h-[26px] w-[26px] items-center justify-center rounded-full text-[12px] font-bold text-white ring-2 ring-white" style={{ backgroundColor: active ? "#4B82A5" : INK }}>
            {n}
          </span>
        )}
        <span className="flex h-[72px] w-[72px] shrink-0 items-center justify-center overflow-hidden rounded-[16px] sm:h-[96px] sm:w-[96px]" style={{ backgroundColor: "#E5E7EB" }}>
          {shop.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={shop.logoUrl} alt="" width={96} height={96} loading="lazy" className="h-full w-full object-cover" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/images/landing/pin-logo.png" alt="" width={64} height={64} loading="lazy" className="h-[48px] w-[48px] object-contain sm:h-[64px] sm:w-[64px]" />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col justify-center gap-[5px] py-1">
          <span className="line-clamp-2 text-[19px] font-bold leading-[1.15]" style={{ color: INK }}>
            {shop.name}
          </span>
          <span className="truncate text-[14px] font-medium" style={{ color: "#4B5563" }}>
            Auto repair shop · {place}
          </span>
          <span className="text-[14px] font-semibold" style={{ color: open ? "#16A34A" : "#9CA3AF" }}>
            {open ? `Open today · ${formatTime(open.open)} to ${formatTime(open.close)}` : "Closed today"}
          </span>
          <span className="mt-[2px] flex items-center gap-2 text-[12.5px]" style={{ color: "#6B7280" }}>
            <span className="inline-flex items-center gap-1">
              <Check className="h-[12px] w-[12px]" style={{ color: "#16A34A" }} strokeWidth={3} />
              Verified by Otopair
            </span>
            <span>·</span>
            <span>
              {shop.serviceCount} {shop.serviceCount === 1 ? "service" : "services"}
            </span>
          </span>
          {names.length > 0 && (
            <span className="mt-1 flex flex-wrap gap-1">
              {names.slice(0, 3).map((x) => (
                <span key={x} className="rounded-full px-2 py-[2px] text-[11.5px] font-medium" style={{ backgroundColor: "#F1F5F9", color: "#475569" }}>
                  {x}
                </span>
              ))}
              {names.length > 3 && (
                <span className="rounded-full px-2 py-[2px] text-[11.5px] font-medium" style={{ color: "#6B7280" }}>
                  +{names.length - 3} more
                </span>
              )}
            </span>
          )}
        </span>
        <ChevronRight className="my-auto h-[20px] w-[20px] shrink-0 transition-transform duration-500 ease-expo group-hover:translate-x-0.5" style={{ color: "#9CA3AF" }} />
      </Link>
    </Rise>
  );
}

/* ------------------------------------------------------------------ */
/* The directory: the list beside a map with numbered pins             */
/* ------------------------------------------------------------------ */

const DIR_MAP: MapCenter = { lat: 40.5795, lng: -74.1502, zoom: 10.9 };
const DIR_W = 520;
const DIR_H = 640;

export type DirectoryGroup = { label: string; id: string; shops: PublicShopSummary[] };

/**
 * The populated directory: every shop as the app's browse card with a
 * number, and a static map of the island beside it (sticky from lg) with
 * the same numbers as pins. Hovering or focusing a card lights its pin.
 * `groups` renders neighborhood headings in the list (past six shops);
 * the numbering runs across the whole list.
 */
export function DirectoryWithMap({ shops, groups }: { shops: PublicShopSummary[]; groups?: DirectoryGroup[] }) {
  const [active, setActive] = useState<string | null>(null);
  const order = groups ? groups.flatMap((g) => g.shops) : shops;
  const numbers = new Map(order.map((s, i) => [s.slug, i + 1]));
  const pins = order
    .filter((s) => s.lat != null && s.lng != null)
    .map((s) => ({ slug: s.slug, name: s.name, n: numbers.get(s.slug)!, ...project(s.lat!, s.lng!, DIR_MAP, DIR_W, DIR_H) }))
    .filter((p) => p.x > 14 && p.x < DIR_W - 14 && p.y > 14 && p.y < DIR_H - 14);
  const src = staticMapSrc(DIR_MAP, DIR_W, DIR_H);
  const card = (s: PublicShopSummary, i: number) => <DirectoryCard key={s.slug} shop={s} index={i} n={numbers.get(s.slug)} active={active === s.slug} onHover={setActive} />;
  return (
    <div className="grid gap-8 lg:grid-cols-12 lg:gap-10">
      <div className="order-2 flex min-w-0 flex-col gap-4 lg:order-1 lg:col-span-7">
        {groups
          ? groups.map((g, gi) => (
              <section key={g.id} id={g.id} className={`scroll-mt-28 ${gi > 0 ? "mt-6" : ""}`}>
                <h3 className="mb-4 flex items-baseline gap-3 text-[22px] leading-none text-[#1a1a1a]" style={serif}>
                  {g.label}
                  <span className="text-[13px] text-[#777169]" style={{ fontFamily: "Inter, system-ui, sans-serif" }}>
                    {g.shops.length} {g.shops.length === 1 ? "shop" : "shops"}
                  </span>
                </h3>
                <div className="flex flex-col gap-4">{g.shops.map((s, i) => card(s, i))}</div>
              </section>
            ))
          : shops.map((s, i) => card(s, i))}
      </div>
      <div className="order-1 lg:order-2 lg:col-span-5">
        <div className="lg:sticky lg:top-[110px]">
          <div className="relative overflow-hidden rounded-[24px] bg-[#DCE7EF] ring-1 ring-[#1a1a1a]/[0.08] shadow-[0_1px_2px_rgba(26,26,26,0.04),0_10px_28px_rgba(26,26,26,0.05)]" style={{ aspectRatio: `${DIR_W} / ${DIR_H}` }}>
            {src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
            ) : (
              <div className="absolute inset-0 opacity-60" style={{ backgroundImage: "linear-gradient(rgba(255,255,255,0.7) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.7) 1px, transparent 1px)", backgroundSize: "54px 54px" }} />
            )}
            {/* pins share the image's coordinate space via percentages */}
            {pins.map((p) => {
              const on = active === p.slug;
              return (
                <span key={p.slug} className="absolute" style={{ left: `${(p.x / DIR_W) * 100}%`, top: `${(p.y / DIR_H) * 100}%`, zIndex: on ? 2 : 1 }}>
                  <span
                    className="flex h-[26px] w-[26px] items-center justify-center rounded-full text-[12px] font-bold text-white ring-2 ring-white transition-transform duration-300 ease-expo"
                    style={{ backgroundColor: on ? "#4B82A5" : INK, transform: `translate(-50%, -50%) scale(${on ? 1.2 : 1})`, boxShadow: "0 4px 10px rgba(15,23,42,0.25)", ...appFont }}
                  >
                    {p.n}
                  </span>
                  {on && (
                    <span className="absolute left-1/2 top-[16px] -translate-x-1/2 whitespace-nowrap rounded-full bg-white px-[10px] py-[4px] text-[12px] font-semibold shadow-[0_4px_12px_rgba(15,23,42,0.18)]" style={{ color: INK, ...appFont }}>
                      {p.name}
                    </span>
                  )}
                </span>
              );
            })}
            <span className="absolute bottom-2 right-3 text-[10px] tracking-wide text-[#3a556e]/70">© Mapbox © OpenStreetMap</span>
            <span className="absolute left-3 top-3 rounded-full border-[0.5px] border-white/60 bg-white/75 px-3 py-[6px] text-[12.5px] tracking-[0.02em] text-[#1a1a1a] backdrop-blur-[20px]">
              {order.length} verified {order.length === 1 ? "shop" : "shops"} · Staten Island
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function DirectoryGrid({ shops, offset = 0 }: { shops: PublicShopSummary[]; offset?: number }) {
  return (
    <div className="grid gap-4 tab:grid-cols-2">
      {shops.map((s, i) => (
        <DirectoryCard key={s.slug} shop={s} index={offset + i} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Verified                                                            */
/* ------------------------------------------------------------------ */

const CHECKS = [
  { icon: ClipboardCheck, t: "Reviewed and approved by Otopair", s: "A decision by the team, by hand. Not an automated check." },
  { icon: CreditCard, t: "Payment through Stripe", s: "A connected account with charges and payouts enabled, so the $20 hold and the final charge run through Otopair." },
  { icon: Clock, t: "Real opening hours", s: "All seven days published. The app books against them." },
  { icon: Users, t: "Someone to do the work", s: "At least one working mechanic and one service switched on." },
];

export function VerifiedPull({ className = "" }: { className?: string }) {
  return (
    <PullCard className={`w-[min(100%,440px)] p-6 tab:p-7 ${className}`}>
      <p className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.08em]" style={{ color: "#16A34A" }}>
        <Check className="h-[14px] w-[14px]" strokeWidth={3} />
        Verified by Otopair
      </p>
      <p className="mt-2 text-[20px] font-bold leading-[1.2]" style={{ color: APP.ink }}>
        Four things, read from the shop&apos;s live account.
      </p>
      <ul className="mt-5 flex flex-col divide-y" style={{ borderColor: "rgba(0,0,0,0.06)" }}>
        {CHECKS.map((c) => (
          <li key={c.t} className="flex items-start gap-3.5 py-3.5 first:pt-0 last:pb-0" style={{ borderColor: "rgba(0,0,0,0.06)" }}>
            <span className="mt-[2px] flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px]" style={{ backgroundColor: "#5299FE1A" }}>
              <c.icon className="h-[17px] w-[17px]" style={{ color: APP.blue }} strokeWidth={2} />
            </span>
            <span>
              <span className="block text-[16px] font-semibold" style={{ color: APP.ink }}>
                {c.t}
              </span>
              <span className="mt-[2px] block text-[13.5px] leading-[1.5]" style={{ color: APP.meta }}>
                {c.s}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-5 text-[13px] leading-[1.5]" style={{ color: APP.meta }}>
        Otopair&apos;s own approval. It does not certify licences or insurance; ask the shop for those.
      </p>
    </PullCard>
  );
}

/* ------------------------------------------------------------------ */
/* Small shared bits                                                   */
/* ------------------------------------------------------------------ */

/** A numbered editorial step beside a device. */
export function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="shrink-0 text-[15px] tabular-nums text-[#4B82A5]" style={serif}>
        0{n}.
      </span>
      <span>
        <span className="block text-[18px] text-[#1a1a1a]" style={serif}>
          {title}
        </span>
        <span className="mt-1 block max-w-[40ch] text-[15px] leading-[1.55] text-[#4c5661]">{children}</span>
      </span>
    </li>
  );
}

/** A rating line in the app's face, for web-scale review rows. */
export function RatingLine({ rating, count }: { rating: number; count: number }) {
  return (
    <span className="inline-flex items-center gap-1.5" style={appFont}>
      <Star className="h-[16px] w-[16px]" style={{ color: APP.blue, fill: APP.blue }} />
      <span className="text-[16px] font-semibold" style={{ color: INK }}>
        {rating.toFixed(1)}
      </span>
      <span className="text-[13px]" style={{ color: "#6B7280" }}>
        ({count})
      </span>
    </span>
  );
}
