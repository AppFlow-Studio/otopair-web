"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Calendar, Car, MessageSquare } from "lucide-react";

/**
 * Devices for the product pages (design pass 2026-09-05, fourth cut).
 *
 * The home page's PhoneFrame is drawn at 232×486 with 5–10px type, because
 * it lives inside a 1269px story card. The product pages show the app UP
 * CLOSE, so this shell is drawn at the phone's own logical size (390×844,
 * the iPhone 15/16 frame otopair-1 is laid out on) and every screen inside
 * it uses the app's real values: Urbanist, 15px body, 16px paddings, the
 * radii from constants/theme.ts. `Phone` then sets the rendered width with
 * CSS `zoom` (the same mechanism TabletScale uses), so one screen renders
 * at 390 in a hero, 300 in a column and 168 on a phone without a second
 * set of sizes. Zoom re-lays out at the target size, so type stays crisp,
 * unlike a transform scale.
 *
 * Palette = otopair-1 BrandColors / SemanticColors (constants/theme.ts).
 */
export const APP = {
  blue: "#5299FE",
  blueDark: "#2563EB",
  blueLight: "#EFF6FF",
  ink: "#141C24",
  text: "#1A1A1A",
  body: "#374151",
  meta: "#6B7280",
  dim: "#9CA3AF",
  border: "#E5E7EB",
  surface: "#F8FAFC",
  bg: "#f5f5f7",
  green: "#059669",
  greenLight: "#ECFDF5",
  amber: "#D97706",
  amberLight: "#FFFBEB",
  red: "#DC2626",
  redLight: "#FEF2F2",
  inactive: "#86868B",
} as const;

/** The app's face. Falls back to the site sans when the font is still loading. */
export const appFont: CSSProperties = { fontFamily: "var(--font-Urbanist), Inter, system-ui, sans-serif" };

export const PHONE_W = 390;
export const PHONE_H = 844;

/* ------------------------------------------------------------------ */
/* Tab bar — components/navigation/TabBar.tsx                           */
/* ------------------------------------------------------------------ */

/** The floating glass tab bar: blur 80, white/65, radius 35, 6px padding,
 *  a sliding rgba(0,0,0,0.073) capsule (radius 28) behind the active tab.
 *  Icons: Home = brand mark, Bookings = Calendar (+ red dot), My Cars =
 *  Car, Oto = MessageSquare. Active #5299FE bold, inactive #86868B. */
export function TabBar({ active, bookingsBadge = false }: { active: 0 | 1 | 2 | 3; bookingsBadge?: boolean }) {
  const tabs = [
    { label: "Home", icon: "brand" as const },
    { label: "Bookings", icon: Calendar, badge: bookingsBadge },
    { label: "My Cars", icon: Car },
    { label: "Oto", icon: MessageSquare },
  ];
  return (
    <div className="pointer-events-none absolute inset-x-5 bottom-[30px] z-30">
      <div
        className="relative flex rounded-[35px] border p-[6px] backdrop-blur-xl"
        style={{
          borderColor: "rgba(255,255,255,0.4)",
          backgroundColor: "rgba(255,255,255,0.65)",
          boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
        }}
      >
        <div
          className="absolute bottom-[6px] top-[6px] rounded-[28px] transition-[left] duration-300 ease-out"
          style={{
            left: `calc(6px + (100% - 12px) * ${active} / 4)`,
            width: "calc((100% - 12px) / 4)",
            backgroundColor: "rgba(0,0,0,0.073)",
          }}
        />
        {tabs.map((t, i) => {
          const on = i === active;
          const color = on ? APP.blue : APP.inactive;
          return (
            <span key={t.label} className="relative z-10 flex flex-1 flex-col items-center gap-[3px] py-[7px]">
              <span className="relative">
                {t.icon === "brand" ? (
                  <Image src="/logo.png" alt="" width={22} height={22} className="h-[22px] w-[22px] object-contain" style={on ? undefined : { filter: "grayscale(1) opacity(0.55)" }} />
                ) : (
                  <t.icon className="h-[22px] w-[22px]" style={{ color }} strokeWidth={1.8} />
                )}
                {t.badge && <span className="absolute -right-1.5 -top-1 h-[9px] w-[9px] rounded-full border-2 border-white bg-[#FF3B30]" />}
              </span>
              <span className="text-[10px] leading-none" style={{ color, fontWeight: on ? 700 : 500 }}>
                {t.label}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Status bar + island                                                 */
/* ------------------------------------------------------------------ */

function StatusBar({ dark = false }: { dark?: boolean }) {
  const c = dark ? "#ffffff" : APP.ink;
  return (
    <div className="flex items-center justify-between px-[30px] pt-[18px]">
      <span className="text-[15px] font-semibold tracking-[-0.01em]" style={{ color: c }}>
        9:41
      </span>
      <span className="flex items-center gap-[6px]">
        <span className="flex items-end gap-[1.5px]">
          {[4, 6, 8, 10].map((h) => (
            <span key={h} className="w-[3px] rounded-[1px]" style={{ height: h, backgroundColor: c }} />
          ))}
        </span>
        <svg width="16" height="12" viewBox="0 0 12 9" fill="none" aria-hidden>
          <path d="M6 8.4 L7.6 6.5 A2.6 2.6 0 0 0 4.4 6.5 Z" fill={c} />
          <path d="M2.7 4.6 A5 5 0 0 1 9.3 4.6" stroke={c} strokeWidth="1.1" strokeLinecap="round" />
          <path d="M0.9 2.6 A7.6 7.6 0 0 1 11.1 2.6" stroke={c} strokeWidth="1.1" strokeLinecap="round" />
        </svg>
        <span className="flex items-center gap-[1.5px]">
          <span className="flex h-[12px] w-[25px] items-center rounded-[4px] border-[1.5px] px-[2px]" style={{ borderColor: `${c}66` }}>
            <span className="h-[7px] w-[17px] rounded-[1.5px]" style={{ backgroundColor: c }} />
          </span>
          <span className="h-[4px] w-[1.5px] rounded-r" style={{ backgroundColor: `${c}66` }} />
        </span>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* PhoneShell + Phone                                                  */
/* ------------------------------------------------------------------ */

/**
 * The device at 390×844. Children are the screen, edge to edge (status bar
 * and island float over them, as in the app: backgrounds always reach the
 * top). Screens pad their own top (~60px) as the safe area. `tab` shows
 * the floating tab bar; omit it for full-screen routes (Review & Pay).
 */
export function PhoneShell({
  tab,
  bookingsBadge,
  darkStatus = false,
  bg = APP.bg,
  children,
  className = "",
}: {
  tab?: 0 | 1 | 2 | 3;
  bookingsBadge?: boolean;
  darkStatus?: boolean;
  bg?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`relative shrink-0 rounded-[56px] p-[10px] ${className}`}
      style={{
        width: PHONE_W + 20,
        height: PHONE_H + 20,
        backgroundColor: "#1a1a1a",
        boxShadow: "0 40px 90px rgba(20,40,80,0.35), 0 12px 28px rgba(20,40,80,0.18), inset 0 0 0 1.5px rgba(255,255,255,0.1)",
        ...appFont,
      }}
    >
      <div className="relative h-full w-full overflow-hidden rounded-[46px]" style={{ backgroundColor: bg }}>
        <div className="absolute inset-0">{children}</div>
        <div className="pointer-events-none absolute inset-x-0 top-0 z-40">
          <StatusBar dark={darkStatus} />
        </div>
        <div className="pointer-events-none absolute left-1/2 top-[12px] z-40 h-[34px] w-[122px] -translate-x-1/2 rounded-full bg-black" />
        {tab !== undefined && <TabBar active={tab} bookingsBadge={bookingsBadge} />}
        {/* home indicator */}
        <div className="pointer-events-none absolute bottom-[8px] left-1/2 z-40 h-[5px] w-[134px] -translate-x-1/2 rounded-full" style={{ backgroundColor: darkStatus ? "rgba(255,255,255,0.9)" : "rgba(20,28,36,0.9)" }} />
      </div>
    </div>
  );
}

/**
 * Renders any 390-space content at `width` CSS px via `zoom`. The wrapper
 * reserves the zoomed box in layout (zoom is layout-affecting, unlike
 * transform), so grids and flex rows measure the phone at its shown size.
 */
export function Zoom({ width, base, children, className = "", style }: { width: number; base: number; children: ReactNode; className?: string; style?: CSSProperties }) {
  const z = width / base;
  return (
    <div className={className} style={{ zoom: z, ...style } as CSSProperties}>
      {children}
    </div>
  );
}

/**
 * Zooms `base`-wide content to fill its container (ResizeObserver, one
 * measurement per resize). For the browser-framed dashboard, which has to
 * read at 1100 on desktop and still fit a 340px column. `max` caps the
 * scale so the window never renders larger than drawn.
 */
export function FitZoom({ base, max = 1, children, className = "" }: { base: number; max?: number; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState<number>(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const z = w ? Math.min(max, w / base) : max;
  // contain: inline-size makes this box contribute NO intrinsic width, so a
  // grid or flex ancestor can never size itself from the unzoomed 1100px
  // window before the observer runs (otherwise the column grows to fit it,
  // the observer reads that width, and the zoom locks at 1: the partner
  // page overflowed to 1156px at 390 wide until this line).
  return (
    <div ref={ref} className={`w-full min-w-0 overflow-hidden ${className}`} style={{ contain: "inline-size" }}>
      <div style={{ zoom: z, width: base } as CSSProperties}>{children}</div>
    </div>
  );
}

/** A PhoneShell shown at `width` px (bezel included). */
export function Phone({ width = 300, className = "", ...shell }: { width?: number; className?: string } & Parameters<typeof PhoneShell>[0]) {
  return (
    <Zoom width={width} base={PHONE_W + 20} className={className}>
      <PhoneShell {...shell} />
    </Zoom>
  );
}

/* ------------------------------------------------------------------ */
/* Browser frame — the shop portal is a web app                        */
/* ------------------------------------------------------------------ */

/**
 * A light browser window for the shop dashboard: traffic lights, an
 * address pill with the portal's real host, the page below. Drawn at
 * `width`×`height` in its own px; wrap in Zoom to fit a column.
 */
export function BrowserFrame({
  url = "shop.otopair.com/schedule",
  width = 1100,
  height = 680,
  children,
  className = "",
}: {
  url?: string;
  width?: number;
  height?: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`relative shrink-0 overflow-hidden rounded-[18px] border border-[#1a1a1a]/10 bg-white ${className}`}
      style={{ width, height, boxShadow: "0 30px 70px rgba(20,40,80,0.22), 0 8px 20px rgba(20,40,80,0.10)" }}
    >
      <div className="flex h-[44px] items-center gap-3 border-b border-[#1a1a1a]/8 bg-[#f7f6f3] px-4">
        <span className="flex items-center gap-[7px]">
          {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => (
            <span key={c} className="h-[11px] w-[11px] rounded-full" style={{ backgroundColor: c }} />
          ))}
        </span>
        <span className="mx-auto flex h-[26px] w-[46%] items-center justify-center gap-2 rounded-[7px] bg-white text-[12.5px] text-[#4c5661] shadow-[0_1px_2px_rgba(26,26,26,0.06)]">
          <svg width="10" height="12" viewBox="0 0 10 12" fill="none" aria-hidden>
            <rect x="1" y="5" width="8" height="6.5" rx="1.5" stroke="#777169" strokeWidth="1.2" />
            <path d="M3 5V3.5a2 2 0 0 1 4 0V5" stroke="#777169" strokeWidth="1.2" />
          </svg>
          {url}
        </span>
        <span className="w-[52px]" />
      </div>
      <div className="relative" style={{ height: height - 44 }}>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Plate — the home page's gradient card                               */
/* ------------------------------------------------------------------ */

/**
 * The rounded-40 plate the home page seats its phone on (Figma 302:1073:
 * vertical gradient #95C7E7 → white). `tone` picks the wash depth:
 * `sky` runs blue to white top to bottom (a tall plate with a device),
 * `pale` starts from the tint (a shorter plate whose object is the
 * point), `paper` is the warm summary panel. Pass `clip` to let the
 * device hang off the bottom edge (the plate clips it).
 */
export function Plate({
  tone = "sky",
  clip = false,
  className = "",
  children,
}: {
  tone?: "sky" | "pale" | "paper";
  clip?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const bg =
    tone === "sky"
      ? "linear-gradient(180deg, #95C7E7 0%, #C9E3F4 42%, #FFFFFF 100%)"
      : tone === "pale"
        ? "linear-gradient(180deg, #EBF5FB 0%, #FFFFFF 100%)"
        : "#f7f6f3";
  return (
    <div
      className={`relative rounded-[28px] tab:rounded-[40px] ${clip ? "overflow-hidden" : ""} ${className}`}
      style={{ background: bg, boxShadow: tone === "paper" ? "inset 0 0 0 1px rgba(26,26,26,0.06)" : "inset 0 0 0 1px rgba(255,255,255,0.6)" }}
    >
      {children}
    </div>
  );
}
