"use client";

import Image from "next/image";
import { Calendar, Car, MessageSquare } from "lucide-react";

/* Colors lifted from otopair-1/constants/theme.ts (BrandColors) — the real
   mobile app's palette. secondary matches the web's #5299fe exactly. */
export const PHONE = {
  primary: "#141C24",
  blue: "#5299FE",
  bg: "#f5f5f7",
  inactive: "#86868B",
};

/** The app's floating glass tab bar (components/navigation/TabBar.tsx):
 *  blurred white/65 pill, white/40 border, sliding blue capsule behind the
 *  active tab; icons Home(brand)/Calendar/Car/MessageSquare; red dot on
 *  Bookings. `active` = index 0..3. */
export function MiniTabBar({ active, bookingsBadge = false }: { active: number; bookingsBadge?: boolean }) {
  const tabs = [
    { label: "Home", icon: "brand" as const },
    { label: "Bookings", icon: Calendar, badge: bookingsBadge },
    { label: "My Cars", icon: Car },
    { label: "Oto", icon: MessageSquare },
  ];
  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-2.5 z-20">
      <div
        className="relative flex rounded-[18px] border p-[3px] backdrop-blur-md"
        style={{ borderColor: "rgba(255,255,255,0.4)", backgroundColor: "rgba(255,255,255,0.65)", boxShadow: "0 8px 24px rgba(0,0,0,0.12)" }}
      >
        {/* Sliding capsule */}
        <div
          className="absolute bottom-[3px] top-[3px] rounded-[15px] transition-[left] duration-300 ease-out"
          style={{
            left: `calc(3px + (100% - 6px) * ${active} / 4)`,
            width: "calc((100% - 6px) / 4)",
            backgroundColor: "rgba(37, 99, 235, 0.1)",
          }}
        />
        {tabs.map((t, i) => {
          const on = i === active;
          const color = on ? PHONE.blue : PHONE.inactive;
          return (
            <span key={t.label} className="relative z-10 flex flex-1 flex-col items-center gap-[1px] py-1">
              <span className="relative">
                {t.icon === "brand" ? (
                  <Image src="/logo.png" alt="" width={11} height={11} className="h-[11px] w-[11px] object-contain" />
                ) : (
                  <t.icon className="h-[11px] w-[11px]" style={{ color }} strokeWidth={1.8} />
                )}
                {t.badge && (
                  <span className="absolute -right-1 -top-0.5 h-[4.5px] w-[4.5px] rounded-full border border-white bg-[#FF3B30]" />
                )}
              </span>
              <span className="text-[5.5px] leading-none" style={{ color, fontWeight: on ? 700 : 500 }}>
                {t.label}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** iOS-style status bar — time left, signal/wifi/battery glyphs right. */
function StatusBar() {
  return (
    <div className="flex items-center justify-between px-4 pb-1 pt-2">
      <span className="text-[7px] font-semibold" style={{ color: PHONE.primary }}>
        9:41
      </span>
      <span className="flex items-center gap-1">
        {/* signal */}
        <span className="flex items-end gap-[1px]">
          {[3, 4.5, 6, 7.5].map((h) => (
            <span key={h} className="w-[1.5px] rounded-sm" style={{ height: h, backgroundColor: PHONE.primary }} />
          ))}
        </span>
        {/* wifi */}
        <svg width="9" height="7" viewBox="0 0 12 9" fill="none" aria-hidden>
          <path d="M6 8.4 L7.6 6.5 A2.6 2.6 0 0 0 4.4 6.5 Z" fill={PHONE.primary} />
          <path d="M2.7 4.6 A5 5 0 0 1 9.3 4.6" stroke={PHONE.primary} strokeWidth="1.1" strokeLinecap="round" />
          <path d="M0.9 2.6 A7.6 7.6 0 0 1 11.1 2.6" stroke={PHONE.primary} strokeWidth="1.1" strokeLinecap="round" />
        </svg>
        {/* battery */}
        <span className="flex items-center gap-[1px]">
          <span className="flex h-[6px] w-[12px] items-center rounded-[2px] border px-[1px]" style={{ borderColor: `${PHONE.primary}66` }}>
            <span className="h-[3.5px] w-[8px] rounded-[1px]" style={{ backgroundColor: PHONE.primary }} />
          </span>
          <span className="h-[2.5px] w-[1px] rounded-r" style={{ backgroundColor: `${PHONE.primary}66` }} />
        </span>
      </span>
    </div>
  );
}

/**
 * The device shell: dark bezel, dynamic island, status bar, #f5f5f7 screen
 * (BrandColors.background), and the floating tab bar. Children render as the
 * screen content between status bar and tab bar. Designed at 232×486 — scale
 * it with transforms like the Shops window.
 */
export default function PhoneFrame({
  tab,
  bookingsBadge = false,
  children,
}: {
  tab: number;
  bookingsBadge?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="relative h-[486px] w-[232px] rounded-[30px] p-[6px]"
      style={{ backgroundColor: "#1a1a1a", boxShadow: "0 26px 60px rgba(20,40,80,0.4), inset 0 0 0 1px rgba(255,255,255,0.08)" }}
    >
      <div
        className="relative h-full w-full overflow-hidden rounded-[24px]"
        style={{ backgroundColor: PHONE.bg }}
      >
        {/* Screen content — full bleed, edge-to-edge under the status bar
            (screens pad their own top ~24px, like a real safe area) */}
        <div className="absolute inset-0">{children}</div>

        {/* Status bar + dynamic island float above every screen and overlay */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-50">
          <StatusBar />
        </div>
        <div className="pointer-events-none absolute left-1/2 top-[7px] z-50 h-[11px] w-[52px] -translate-x-1/2 rounded-full bg-black" />

        <MiniTabBar active={tab} bookingsBadge={bookingsBadge} />
      </div>
    </div>
  );
}
