"use client";

import type { CSSProperties, ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Battery,
  BatteryCharging,
  Calendar,
  Check,
  ChevronRight,
  CircleDot,
  ClipboardCheck,
  Clock,
  Disc,
  Droplet,
  Filter,
  Gauge,
  HelpCircle,
  History,
  Info,
  MapPin,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { APP, PHONE_H, PHONE_W, PhoneShell } from "../device";
import { BRAKES, ChatScreen, OtoTurn, UserBubble } from "./chat";
import { SERVICES as CATALOG } from "@/lib/service-catalog";
import { SERVICE_COPY } from "@/lib/service-copy";

/**
 * The booking flow's first two screens (otopair-1 app/(booking-flow)):
 *
 *  Screen 1 · Select Services: a full-bleed map with the frosted-blue
 *  glass sheet over it (GlassSheet: #CFE0EB → #E8EEF3 at 92%, top radius
 *  20). Inside: close / search / vehicle puck, "Select Services", the two
 *  hero cards (CLOSEST SHOP, MOST RECENT), the four category rows with
 *  their counts, the QUICK BOOK chips. At the low snap (18%) only the
 *  handle and the top row show, and a MapBrowseShopCard floats over the
 *  map (image 80, name, ★ rating · Auto repair shop, Open).
 *
 *  Screen 2 · Category: the same sheet, one category's services as
 *  ServiceMultiSelectRow cards (icon tile 44, label 16 bold, clock + the
 *  time for this car, the ? top-right, an ink check pill when selected)
 *  and the blue StickyContinueBar.
 *
 * Every string is the app's (constants/serviceTaxonomy.ts labels, the
 * hero cards' own loading states). Shop names are only ever passed in
 * by the page, from live data, so the local pages never show a stand-in
 * shop.
 */

/* ------------------------------------------------------------------ */
/* Taxonomy — constants/serviceTaxonomy.ts, the 22 bookable slugs       */
/* ------------------------------------------------------------------ */

export type TabKey = "routine_upkeep" | "tires_brakes" | "major_service" | "inspections";

export const TABS: { key: TabKey; label: string; subtitle: string; icon: LucideIcon; category: string }[] = [
  { key: "routine_upkeep", label: "Routine", subtitle: "Fluids, filters, battery", icon: Wrench, category: "Routine" },
  { key: "tires_brakes", label: "Tires & Brakes", subtitle: "Tires, rotation, brakes", icon: CircleDot, category: "Tires & Brakes" },
  { key: "major_service", label: "Scheduled service", subtitle: "Spark plugs, timing, fluids", icon: Calendar, category: "Scheduled Service" },
  { key: "inspections", label: "Inspections", subtitle: "State, emissions, diagnostics", icon: ClipboardCheck, category: "Inspections" },
];

type Entry = { label: string; tab: TabKey; time: string; icon: LucideIcon; quote?: boolean; /** The app's "Shows for:" label. */ showsFor: string };

/** label, tab, per-car time ("About …", as the app shows once the car is
 *  known), icon. Order within a tab is the app's. */
export const TAXONOMY: Record<string, Entry> = {
  oil_change: { label: "Oil & filter change", tab: "routine_upkeep", time: "About 24 min", icon: Droplet, showsFor: "Gas engines" },
  filter_replacement: { label: "Air & cabin filters", tab: "routine_upkeep", time: "About 21 min", icon: Filter, showsFor: "All vehicles" },
  battery_test: { label: "Battery test", tab: "routine_upkeep", time: "About 12 min", icon: Battery, showsFor: "All vehicles" },
  battery_replacement: { label: "Battery replacement", tab: "routine_upkeep", time: "About 30 min", icon: BatteryCharging, showsFor: "All vehicles" },
  tire_rotation: { label: "Tire rotation", tab: "tires_brakes", time: "About 24 min", icon: Disc, showsFor: "Rotatable tires" },
  tire_balance: { label: "Tire balancing", tab: "tires_brakes", time: "About 45 min", icon: Gauge, showsFor: "All vehicles" },
  wheel_alignment: { label: "Wheel alignment", tab: "tires_brakes", time: "About 1 hr", icon: Settings, showsFor: "All vehicles" },
  tire_replacement: { label: "Tire replacement", tab: "tires_brakes", time: "Quote", icon: Disc, quote: true, showsFor: "All vehicles" },
  brake_pad_replacement: { label: "Brake pad replacement", tab: "tires_brakes", time: "About 1 hr 30 min", icon: Disc, showsFor: "All vehicles" },
  rotor_replacement: { label: "Brake rotor replacement", tab: "tires_brakes", time: "About 3 hr", icon: Disc, showsFor: "All vehicles" },
  brake_fluid_flush: { label: "Brake fluid flush", tab: "tires_brakes", time: "About 51 min", icon: Droplet, showsFor: "All vehicles" },
  spark_plugs: { label: "Spark plug replacement", tab: "major_service", time: "About 1 hr 30 min", icon: Sparkles, showsFor: "Gas engines" },
  timing_belt: { label: "Timing belt replacement", tab: "major_service", time: "About 5 hr", icon: Wrench, showsFor: "Belt-driven engines" },
  coolant_flush: { label: "Coolant flush", tab: "major_service", time: "About 1 hr 15 min", icon: Droplet, showsFor: "All vehicles" },
  transmission_service: { label: "Transmission fluid change", tab: "major_service", time: "About 1 hr 30 min", icon: Droplet, showsFor: "All vehicles" },
  power_steering_flush: { label: "Power steering flush", tab: "major_service", time: "About 45 min", icon: Droplet, showsFor: "Hydraulic steering" },
  differential_service: { label: "Differential fluid change", tab: "major_service", time: "About 1 hr", icon: Droplet, showsFor: "AWD / RWD only" },
  fuel_system_cleaning: { label: "Fuel system cleaning", tab: "major_service", time: "About 1 hr", icon: Sparkles, showsFor: "Gas engines" },
  state_inspection: { label: "State inspection", tab: "inspections", time: "About 30 min", icon: ClipboardCheck, showsFor: "Registered vehicles" },
  emissions_test: { label: "Emissions test", tab: "inspections", time: "About 18 min", icon: ShieldCheck, showsFor: "Gas engines" },
  check_engine_light: { label: "Check-engine light diagnosis", tab: "inspections", time: "About 1 hr", icon: Zap, showsFor: "1996 & newer" },
  diagnostic_scan: { label: "Diagnostic scan", tab: "inspections", time: "About 30 min", icon: Search, showsFor: "1996 & newer" },
};

const TAB_ORDER: Record<TabKey, string[]> = {
  routine_upkeep: ["oil_change", "filter_replacement", "battery_test", "battery_replacement"],
  tires_brakes: ["tire_rotation", "tire_balance", "wheel_alignment", "tire_replacement", "brake_pad_replacement", "rotor_replacement", "brake_fluid_flush"],
  major_service: ["spark_plugs", "timing_belt", "coolant_flush", "transmission_service", "power_steering_flush", "differential_service", "fuel_system_cleaning"],
  inspections: ["state_inspection", "emissions_test", "check_engine_light", "diagnostic_scan"],
};

export function tabOf(slug: string): TabKey {
  return TAXONOMY[slug]?.tab ?? "routine_upkeep";
}

export function servicesInTab(tab: TabKey): string[] {
  return TAB_ORDER[tab];
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

const INK = "#0F172A";
const SHEET_TOP_FULL = Math.round(PHONE_H * 0.08); // sheet at 92%
const SHEET_H_PEEK = Math.round(PHONE_H * 0.18);
const GLASS_CARD: CSSProperties = {
  backgroundColor: "rgba(255,255,255,0.55)",
  border: "1px solid rgba(255,255,255,0.85)",
  boxShadow: "0px 2px 4px rgba(0,0,0,0.05), 0px 10px 28px rgba(0,0,0,0.07)",
};

/** The static map under the sheet, or the app's pale fallback wash. */
export function MapBackdrop({ src, children }: { src?: string | null; children?: ReactNode }) {
  return (
    <div className="absolute inset-0 overflow-hidden" style={{ backgroundColor: "#DCE7EF" }}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
      ) : (
        <div
          className="absolute inset-0 opacity-60"
          style={{ backgroundImage: "linear-gradient(rgba(255,255,255,0.7) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.7) 1px, transparent 1px)", backgroundSize: "54px 54px" }}
        />
      )}
      {children}
    </div>
  );
}

/** RatingMarkerPill: the pin logo, a white rating chip, the name with a
 *  white halo. `rating` null hides the chip (a shop with no reviews yet). */
export function MapPinMarker({ name, rating, x, y, selected = false }: { name: string; rating?: string | null; x: number; y: number; selected?: boolean }) {
  return (
    <div className="absolute flex -translate-x-1/2 -translate-y-full flex-col items-center" style={{ left: x, top: y }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/images/landing/pin-logo.png" alt="" className="h-[48px] w-[48px] object-contain" style={{ transform: selected ? "scale(1.08)" : undefined, filter: selected ? "drop-shadow(0 0 10px rgba(82,153,254,0.6))" : "drop-shadow(0 4px 6px rgba(15,23,42,0.25))" }} />
      {rating && (
        <span className="-mt-1 flex items-center gap-[3px] rounded-full bg-white px-[7px] py-[2px] text-[11px] font-bold" style={{ color: INK, border: selected ? `1.5px solid ${APP.blue}` : "1px solid rgba(15,23,42,0.06)", boxShadow: "0 1px 3px rgba(15,23,42,0.15)" }}>
          <Star className="h-[10px] w-[10px] fill-[#F59E0B] text-[#F59E0B]" />
          {rating}
        </span>
      )}
      <span className="mt-[3px] max-w-[120px] truncate text-[12px] font-bold" style={{ color: INK, textShadow: "0 0 4px #fff, 0 0 4px #fff, 0 1px 2px #fff" }}>
        {name}
      </span>
    </div>
  );
}

function GlassSheet({ top, children, className = "" }: { top: number; children: ReactNode; className?: string }) {
  return (
    <div
      className={`absolute inset-x-0 bottom-0 overflow-hidden rounded-t-[20px] ${className}`}
      style={{ top, background: "linear-gradient(180deg, #CFE0EB 0%, #DCE7EF 50%, #E8EEF3 100%)", backdropFilter: "blur(24px)", boxShadow: "0 -6px 30px rgba(15,23,42,0.08)" }}
    >
      <div className="flex justify-center pt-2">
        <span className="h-[4px] w-[44px] rounded-full" style={{ backgroundColor: "rgba(15,23,42,0.18)" }} />
      </div>
      {children}
    </div>
  );
}

function IconBtn({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-[40px] w-[40px] items-center justify-center rounded-full" style={{ backgroundColor: "rgba(255,255,255,0.7)" }}>
      {children}
    </span>
  );
}

/** VehiclePuck: a 44 ring on a #E5EBF1 disc with the car in it. */
export function VehiclePuck({ size = 44 }: { size?: number }) {
  return (
    <span className="flex items-center justify-center rounded-full" style={{ width: size, height: size, backgroundColor: "rgba(15,23,42,0.12)" }}>
      <span className="flex items-center justify-center overflow-hidden rounded-full" style={{ width: size - 4, height: size - 4, backgroundColor: "#E5EBF1" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/images/landing/app/covered-car.png" alt="" className="h-[82%] w-[82%] object-contain" />
      </span>
    </span>
  );
}

function TopRow({ back = false }: { back?: boolean }) {
  return (
    <div className="flex items-center px-4 pb-3 pt-3">
      <IconBtn>{back ? <ArrowLeft className="h-[20px] w-[20px]" style={{ color: "#1F2937" }} strokeWidth={2} /> : <X className="h-[20px] w-[20px]" style={{ color: "#1F2937" }} strokeWidth={2} />}</IconBtn>
      <span className="flex-1" />
      {!back && (
        <>
          <IconBtn>
            <Search className="h-[20px] w-[20px]" style={{ color: "#1F2937" }} strokeWidth={2} />
          </IconBtn>
          <span className="w-2" />
        </>
      )}
      <VehiclePuck />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Screen 1 · Select Services                                          */
/* ------------------------------------------------------------------ */

export type ClosestShop = { name: string; miles?: string };
export type BrowseShop = { name: string; rating?: string | null; open: boolean; logoUrl?: string | null };
export type MapPin = { name: string; rating?: string | null; x: number; y: number; selected?: boolean };

function HeroCard({ icon: Icon, eyebrow, title, sub }: { icon: LucideIcon; eyebrow: string; title: string; sub?: string }) {
  return (
    <div className="flex min-h-[160px] flex-1 flex-col rounded-[18px] p-4" style={GLASS_CARD}>
      <span className="mb-7 flex h-[34px] w-[34px] items-center justify-center rounded-[10px]" style={{ backgroundColor: "rgba(255,255,255,0.7)" }}>
        <Icon className="h-[20px] w-[20px]" style={{ color: "#4B5563" }} strokeWidth={2} />
      </span>
      <span className="mb-[6px] text-[12px] font-semibold tracking-[0.06em]" style={{ color: "#6B7280" }}>
        {eyebrow}
      </span>
      <span className="mb-[6px] line-clamp-2 text-[18px] font-bold leading-[22px]" style={{ color: INK }}>
        {title}
      </span>
      {sub && (
        <span className="text-[14px]" style={{ color: "#6B7280" }}>
          {sub}
        </span>
      )}
    </div>
  );
}

/** MapBrowseShopCard: the floating card at the low snap. */
export function BrowseCard({ shop, className = "" }: { shop: BrowseShop; className?: string }) {
  return (
    <div className={`flex items-stretch gap-3 rounded-[20px] bg-white p-[10px] ${className}`} style={{ boxShadow: "0 6px 16px rgba(15,23,42,0.18)" }}>
      <span className="flex h-[80px] w-[80px] shrink-0 items-center justify-center overflow-hidden rounded-[14px]" style={{ backgroundColor: "#E5E7EB" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={shop.logoUrl ?? "/images/landing/pin-logo.png"} alt="" className={shop.logoUrl ? "h-full w-full object-cover" : "h-[56px] w-[56px] object-contain"} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-1 py-[2px]">
        <span className="truncate text-[16px] font-bold" style={{ color: INK }}>
          {shop.name}
        </span>
        <span className="flex items-center gap-1 text-[14px]" style={{ color: "#4B5563" }}>
          {shop.rating && (
            <>
              <Star className="h-[13px] w-[13px]" style={{ color: INK, fill: INK }} strokeWidth={2} />
              <span className="font-medium" style={{ color: INK }}>
                {shop.rating}
              </span>
              <span style={{ color: "#6B7280" }}> · </span>
            </>
          )}
          <span className="truncate font-medium">Auto repair shop</span>
        </span>
        <span className="text-[14px] font-semibold" style={{ color: shop.open ? "#16A34A" : "#9CA3AF" }}>
          {shop.open ? "Open" : "Closed"}
        </span>
      </span>
    </div>
  );
}

const QUICK_DEFAULT = ["Oil & filter change", "State inspection", "Brake pad replacement", "Tire rotation"];

export function SelectServicesScreen({
  mode = "full",
  closest = null,
  pins = [],
  browse = null,
  mapSrc = null,
  counts,
}: {
  mode?: "full" | "peek";
  /** The nearest verified shop, from live data; null shows the card's own loading state. */
  closest?: ClosestShop | null;
  pins?: MapPin[];
  /** The floating browse card at the low snap (peek only). */
  browse?: BrowseShop | null;
  mapSrc?: string | null;
  /** Services per tab; defaults to the catalog's counts. */
  counts?: Partial<Record<TabKey, number>>;
}) {
  const peek = mode === "peek";
  const n = (t: TabKey) => counts?.[t] ?? TAB_ORDER[t].length;
  return (
    <PhoneShell>
      <MapBackdrop src={mapSrc}>
        {pins.map((p) => (
          <MapPinMarker key={p.name} {...p} />
        ))}
      </MapBackdrop>

      {peek && browse && (
        <div className="absolute inset-x-4 z-10" style={{ bottom: SHEET_H_PEEK + 12 }}>
          <BrowseCard shop={browse} />
        </div>
      )}

      <GlassSheet top={peek ? PHONE_H - SHEET_H_PEEK : SHEET_TOP_FULL}>
        <TopRow />
        <div className="px-5">
          <p className="text-[30px] font-bold leading-[36px]" style={{ color: INK }}>
            Select Services
          </p>
          <p className="mt-[6px] text-[16px]" style={{ color: "#6B7280" }}>
            What does your car need?
          </p>
        </div>
        {!peek && (
          <>
            <div className="mt-[18px] flex gap-3 px-5">
              <HeroCard icon={MapPin} eyebrow="CLOSEST SHOP" title={closest?.name ?? "Finding nearby shops..."} sub={closest ? (closest.miles ? `${closest.miles} miles away` : "Verified by Otopair") : "Updating distance..."} />
              <HeroCard icon={History} eyebrow="MOST RECENT" title="Nothing yet" />
            </div>
            <div className="mx-5 mt-[22px] overflow-hidden rounded-[22px]" style={{ ...GLASS_CARD, border: "1px solid rgba(255,255,255,0.8)" }}>
              {TABS.map((t, i) => (
                <div key={t.key} className={`flex items-center gap-[14px] px-4 py-[14px] ${i > 0 ? "border-t" : ""}`} style={{ borderColor: "rgba(15,23,42,0.06)" }}>
                  <span className="flex h-[40px] w-[40px] items-center justify-center rounded-[12px]" style={{ backgroundColor: "rgba(255,255,255,0.7)" }}>
                    <t.icon className="h-[20px] w-[20px]" style={{ color: "#4B5563" }} strokeWidth={2} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[16px] font-semibold leading-[22px]" style={{ color: INK }}>
                      {t.label}
                    </span>
                    <span className="block text-[14px]" style={{ color: "#6B7280" }}>
                      {n(t.key)} service{n(t.key) === 1 ? "" : "s"}
                    </span>
                  </span>
                  <ChevronRight className="h-[20px] w-[20px]" style={{ color: "#9CA3AF" }} strokeWidth={2} />
                </div>
              ))}
            </div>
            <p className="mt-[22px] px-5 text-[12px] font-semibold tracking-[0.06em]" style={{ color: "#6B7280" }}>
              QUICK BOOK
            </p>
            <div className="mt-[10px] flex gap-[10px] overflow-hidden px-5">
              {QUICK_DEFAULT.map((q) => (
                <span key={q} className="shrink-0 whitespace-nowrap rounded-full px-[18px] py-3 text-[14px] font-semibold" style={{ color: "#1F2937", backgroundColor: "rgba(255,255,255,0.6)", border: "1px solid rgba(255,255,255,0.8)" }}>
                  {q}
                </span>
              ))}
            </div>
          </>
        )}
      </GlassSheet>
    </PhoneShell>
  );
}

/* ------------------------------------------------------------------ */
/* Screen 2 · Category                                                 */
/* ------------------------------------------------------------------ */

export function ServiceRow({ slug, selected = false, highlight = false }: { slug: string; selected?: boolean; highlight?: boolean }) {
  const e = TAXONOMY[slug];
  if (!e) return null;
  const Icon = e.icon;
  return (
    <div
      className="relative mx-5 mb-3 flex items-center gap-[14px] rounded-[20px] px-4 py-[18px]"
      style={{
        ...GLASS_CARD,
        ...(selected ? { backgroundColor: "rgba(82,153,254,0.18)", border: "1px solid rgba(82,153,254,0.55)" } : {}),
        ...(highlight ? { border: `2px solid ${APP.blue}`, boxShadow: "0 0 12px rgba(82,153,254,0.5)" } : {}),
      }}
    >
      <span className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-[12px]" style={{ backgroundColor: "rgba(255,255,255,0.75)" }}>
        <Icon className="h-[22px] w-[22px]" style={{ color: "#4B5563" }} strokeWidth={2} />
      </span>
      <span className="min-w-0 flex-1 pr-7">
        <span className="block text-[16px] font-bold leading-[20px]" style={{ color: INK }}>
          {e.label}
        </span>
        <span className="mt-[10px] flex items-center gap-[5px] text-[14px] font-medium" style={{ color: "#6B7280" }}>
          {!e.quote && <Clock className="h-[14px] w-[14px]" strokeWidth={2} />}
          {e.time}
        </span>
      </span>
      <HelpCircle className="absolute right-3 top-3 h-[20px] w-[20px]" style={{ color: APP.blue }} strokeWidth={2} />
      {selected && (
        <span className="absolute bottom-3 right-3 flex h-[28px] w-[28px] items-center justify-center rounded-full" style={{ backgroundColor: INK }}>
          <Check className="h-[18px] w-[18px] text-white" strokeWidth={2.5} />
        </span>
      )}
    </div>
  );
}

/** The category screen's glass (sheet, rows, Continue bar) without the
 *  device, so the info sheet can sit over it. */
function CategoryBody({ tab, selected = [], highlight, mapSrc = null }: { tab: TabKey; selected?: string[]; highlight?: string; mapSrc?: string | null }) {
  const t = TABS.find((x) => x.key === tab)!;
  const slugs = TAB_ORDER[tab];
  const count = selected.length;
  return (
    <>
      <MapBackdrop src={mapSrc} />
      <GlassSheet top={SHEET_TOP_FULL}>
        <TopRow back />
        <div className="mb-[18px] px-5">
          <div className="mb-2 flex items-center gap-3">
            <span className="flex h-[44px] w-[44px] items-center justify-center rounded-[14px]" style={{ backgroundColor: "rgba(255,255,255,0.7)" }}>
              <t.icon className="h-[22px] w-[22px]" style={{ color: "#4B5563" }} strokeWidth={2} />
            </span>
            <span className="text-[28px] font-bold leading-[34px]" style={{ color: INK }}>
              {t.label}
            </span>
          </div>
          <p className="text-[16px]" style={{ color: "#6B7280" }}>
            {t.subtitle} · {slugs.length} service{slugs.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="pb-[120px]">
          {slugs.map((s) => (
            <ServiceRow key={s} slug={s} selected={selected.includes(s)} highlight={highlight === s} />
          ))}
        </div>
      </GlassSheet>
      {/* In the app this list scrolls, so the rows that do not fit are simply
          below the fold. A still cannot scroll, so on the seven-service tabs
          (Tires & Brakes, Scheduled service) the last card ran straight
          through the Continue pill — and because the pill is 45% blue while
          nothing is selected, the card's own text showed through it. This is
          what the bottom of a scrolled list actually looks like: the rows fade
          into the sheet before they reach the CTA. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[150px]"
        // Opaque by 38% of 150px = 57px down, i.e. 93px above the phone's
        // bottom edge — one pixel clear of the pill's own top (30px inset +
        // 56px pill + 8px). Anything softer and the row still reads through
        // the translucent pill.
        style={{ background: "linear-gradient(180deg, rgba(232,238,243,0) 0%, rgba(232,238,243,0.88) 24%, #E8EEF3 38%)" }}
      />
      {/* StickyContinueBar */}
      <div className="absolute inset-x-0 bottom-0 z-20 px-4 pb-[30px] pt-2">
        <span className="flex min-h-[56px] items-center justify-between rounded-full px-[22px] py-4" style={{ backgroundColor: count ? APP.blue : "rgba(82,153,254,0.45)" }}>
          <span className="flex-1 text-center text-[16px] font-semibold text-white">
            Continue · {count} service{count === 1 ? "" : "s"}
          </span>
          <ArrowRight className="h-[20px] w-[20px] text-white" strokeWidth={2} />
        </span>
      </div>
    </>
  );
}

/** `forSlug` picks the tab from a service slug (server pages cannot call
 *  tabOf, a client-module function). */
export function CategoryScreen({ tab: tabProp, forSlug, selected = [], highlight, mapSrc = null }: { tab?: TabKey; forSlug?: string; selected?: string[]; highlight?: string; mapSrc?: string | null }) {
  const tab: TabKey = tabProp ?? (forSlug ? tabOf(forSlug) : "routine_upkeep");
  return (
    <PhoneShell>
      <CategoryBody tab={tab} selected={selected} highlight={highlight} mapSrc={mapSrc} />
    </PhoneShell>
  );
}

/* ------------------------------------------------------------------ */
/* ServiceInfoSheet — the ⓘ on a service row                           */
/* ------------------------------------------------------------------ */

const SHEET_H = Math.min(680, Math.round(PHONE_H * 0.78));

/** SimpleSection: a 3×14 blue bar, a 12px caps title, 16/22 body. */
function InfoSection({ title, body }: { title: string; body: string }) {
  return (
    <div className="mb-[22px]">
      <div className="mb-2 flex items-center gap-2">
        <span className="h-[14px] w-[3px] rounded-[2px]" style={{ backgroundColor: APP.blue }} />
        <span className="text-[12px] font-bold uppercase tracking-[1.2px]" style={{ color: APP.blue }}>
          {title}
        </span>
      </div>
      <p className="text-[16px] leading-[22px]" style={{ color: "#374151" }}>
        {body}
      </p>
    </div>
  );
}

/**
 * The info sheet (components/booking-flow/ServiceInfoSheet.tsx) over the
 * category list: a floating white sheet (radius 46, handle 36×5), the
 * service header (icon tile 48, tab eyebrow, 22px title), the QUICK LOOK
 * card with the guide's three lines, WHAT IT IS / WHY IT MATTERS / SIGNS
 * YOU MIGHT NEED IT, and the time + "Shows for" chips. The words are the
 * app's (lib/service-copy.ts mirrors constants/serviceCopy.ts, simple
 * tier), never paraphrased.
 */
export function ServiceInfoScreen({ slug, mapSrc = null }: { slug: string; mapSrc?: string | null }) {
  const e = TAXONOMY[slug];
  const c = SERVICE_COPY[slug];
  if (!e || !c) return <CategoryScreen forSlug={slug} selected={[slug]} mapSrc={mapSrc} />;
  const t = TABS.find((x) => x.key === e.tab)!;
  const Icon = e.icon;
  return (
    <PhoneShell>
      <CategoryBody tab={e.tab} selected={[slug]} mapSrc={mapSrc} />
      <div className="absolute inset-0 z-30" style={{ backgroundColor: "rgba(0,0,0,0.4)" }} />
      <div className="absolute inset-x-2 bottom-2 z-40 overflow-hidden rounded-[46px] bg-white" style={{ height: SHEET_H }}>
        <div className="flex justify-center pt-[10px]">
          <span className="h-[5px] w-[36px] rounded-[2.5px]" style={{ backgroundColor: "#D1D5DB" }} />
        </div>
        <div className="px-[22px] pb-7 pt-[10px]">
          <div className="mb-5 flex items-center gap-[14px]">
            <span className="flex h-[48px] w-[48px] shrink-0 items-center justify-center rounded-[14px]" style={{ backgroundColor: "rgba(82,153,254,0.12)", border: "1px solid rgba(82,153,254,0.24)" }}>
              <Icon className="h-[24px] w-[24px]" style={{ color: "#4B5563" }} strokeWidth={2} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="mb-[2px] block text-[11px] font-bold tracking-[1.2px]" style={{ color: APP.blue }}>
                {t.label.toUpperCase()}
              </span>
              <span className="line-clamp-2 text-[22px] font-bold leading-[28px]" style={{ color: INK }}>
                {e.label}
              </span>
            </span>
          </div>
          <div className="mb-6 rounded-[18px] px-4 py-[14px]" style={{ backgroundColor: "rgba(82,153,254,0.08)", border: "1px solid rgba(82,153,254,0.28)", boxShadow: "0px 2px 4px rgba(0,0,0,0.05), 0px 10px 28px rgba(0,0,0,0.07)" }}>
            <div className="mb-2 flex items-center gap-[6px]">
              <Sparkles className="h-[14px] w-[14px]" style={{ color: APP.blue }} strokeWidth={2.2} />
              <span className="text-[11px] font-bold tracking-[1.2px]" style={{ color: APP.blue }}>
                QUICK LOOK
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {c.quick.map((l) => (
                <p key={l} className="text-[16px] font-medium leading-[22px]" style={{ color: INK }}>
                  {l}
                </p>
              ))}
            </div>
          </div>
          <InfoSection title="What it is" body={c.whatItIs} />
          <InfoSection title="Why it matters" body={c.whyItMatters} />
          <InfoSection title="Signs you might need it" body={c.signs} />
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-4" style={{ borderColor: "rgba(15,23,42,0.08)" }}>
            <span className="flex items-center gap-[6px] rounded-full px-[10px] py-[6px] text-[14px] font-semibold" style={{ color: "#1F2937", backgroundColor: "rgba(15,23,42,0.05)", border: "1px solid rgba(15,23,42,0.06)" }}>
              <Clock className="h-[14px] w-[14px]" style={{ color: "#4B5563" }} strokeWidth={2} />
              {e.time.replace("About ", "~")}
            </span>
            <span className="flex items-center gap-[6px] rounded-full px-[10px] py-[6px] text-[14px] font-semibold" style={{ color: "#1F2937", backgroundColor: "rgba(15,23,42,0.05)", border: "1px solid rgba(15,23,42,0.06)" }}>
              <Info className="h-[14px] w-[14px]" style={{ color: "#4B5563" }} strokeWidth={2} />
              Shows for: {e.showsFor}
            </span>
          </div>
        </div>
      </div>
    </PhoneShell>
  );
}

/* ------------------------------------------------------------------ */
/* Oto's in-chat wizard, stage 1 (BookServiceComponent)                */
/* ------------------------------------------------------------------ */

const SHEET = "#EDF2FA";

/** The wizard opened from the conversation, on "Select services", with
 *  the services Oto pre-checked from the chat and the "+ Add more
 *  services" expander (the collapsed state the source opens in). */
export function ServiceSheet({ slugs, count = slugs.length }: { slugs: string[]; count?: number }) {
  return (
    <div className="overflow-hidden rounded-[16px]" style={{ backgroundColor: SHEET, boxShadow: "0 4px 14px rgba(20,40,80,0.08)" }}>
      <div className="relative px-4 pt-4 text-center">
        <ArrowLeft className="absolute left-4 top-4 h-[18px] w-[18px]" style={{ color: APP.meta }} />
        <X className="absolute right-4 top-4 h-[18px] w-[18px]" style={{ color: APP.meta }} />
        <p className="text-[15px] font-bold" style={{ color: APP.ink }}>
          Select services
        </p>
        <div className="mt-3 text-left">
          <span className="text-[11px] font-medium" style={{ color: APP.ink }}>
            Step 1 of 5
          </span>
          <div className="mt-1 h-[4px] overflow-hidden rounded-full" style={{ backgroundColor: "rgba(0,0,0,0.08)" }}>
            <div className="h-full rounded-full" style={{ backgroundColor: APP.blue, width: "20%" }} />
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2 p-3">
        <p className="text-[13px] leading-[18px]" style={{ color: "#6B7280" }}>
          Pre-checked from our chat — here&apos;s what we talked about. Add anything that should ride along; bundling saves a shop trip.
        </p>
        <div className="flex flex-col gap-1">
          {slugs.map((slug) => {
            const c = CATALOG.find((s) => s.slug === slug);
            const e = TAXONOMY[slug];
            if (!c || !e) return null;
            const Icon = e.icon;
            return (
              <div key={slug} className="flex items-center gap-3 rounded-[12px] border p-3" style={{ borderColor: APP.blue, backgroundColor: "#5299FE0D" }}>
                <span className="flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: "#5299FE1A" }}>
                  <Icon className="h-[18px] w-[18px]" style={{ color: APP.blue }} strokeWidth={2} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold leading-[18px]" style={{ color: APP.blue }}>
                    {c.name}
                  </span>
                  <span className="mt-[2px] block text-[12px] leading-[16px]" style={{ color: "#6B7280" }}>
                    {c.description}
                  </span>
                </span>
                <span className="shrink-0 text-[11px]" style={{ color: "#9CA3AF" }}>
                  {e.time.replace("About ", "")}
                </span>
                <span className="flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: APP.blue }}>
                  <Check className="h-[11px] w-[11px] text-white" strokeWidth={3} />
                </span>
              </div>
            );
          })}
          <span className="flex items-center justify-center rounded-[8px] border border-dashed py-[10px] text-[13px] font-semibold" style={{ borderColor: "#C7CDD6", color: APP.blue }}>
            + Add more services
          </span>
        </div>
      </div>
      <div className="border-t px-3 pb-3 pt-3" style={{ borderColor: "rgba(0,0,0,0.06)" }}>
        <span className="flex h-[48px] items-center justify-center rounded-full text-[16px] font-semibold text-white" style={{ backgroundColor: APP.blue }}>
          Continue with {count} service{count === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}

/** The conversation asking for one service by name, and the wizard
 *  opening on it. `ask` is the driver's line; the catalog name is used
 *  for the pre-checked row so no copy is invented for Oto. */
export function BookServiceScreen({ slug, ask }: { slug: string; ask: string }) {
  const c = CATALOG.find((s) => s.slug === slug);
  return (
    <ChatScreen input="none">
      <UserBubble>{ask}</UserBubble>
      <OtoTurn thinking={false}>{c ? `${c.name} it is. Here is the booking with it pre-checked; add anything else the car needs before we pick a shop.` : BRAKES.answer}</OtoTurn>
      <ServiceSheet slugs={[slug]} />
    </ChatScreen>
  );
}

export const PHONE = { w: PHONE_W, h: PHONE_H };
