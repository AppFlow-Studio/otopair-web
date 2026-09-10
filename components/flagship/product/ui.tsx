"use client";

import type { CSSProperties, ReactNode } from "react";
import { ChevronLeft, ChevronRight, Star } from "lucide-react";
import { APP } from "./device";

/**
 * The app's own controls, drawn at their real values (otopair-1
 * constants/theme.ts + the component stylesheets). Used only inside
 * PhoneShell screens; the marketing page around them keeps the site's
 * Petrona/Inter system.
 */

/** BookingCard / detail cards: white, radius 16, padding 16, 0 2px 8px 6%. */
export function AppCard({ children, className = "", style, pad = 16 }: { children: ReactNode; className?: string; style?: CSSProperties; pad?: number }) {
  return (
    <div
      className={`rounded-[16px] bg-white ${className}`}
      style={{ padding: pad, boxShadow: "0 2px 8px rgba(0,0,0,0.06)", ...style }}
    >
      {children}
    </div>
  );
}

/** Primary button: h48, radius 12, #5299FE, 16px semibold white. `tone`
 *  ink = the wallet button, ghost = the secondary "Reschedule" style. */
export function AppButton({
  children,
  tone = "blue",
  className = "",
  small = false,
  pressed = false,
}: {
  children: ReactNode;
  tone?: "blue" | "ink" | "ghost" | "white";
  className?: string;
  small?: boolean;
  pressed?: boolean;
}) {
  const s: CSSProperties =
    tone === "blue"
      ? { backgroundColor: APP.blue, color: "#fff" }
      : tone === "ink"
        ? { backgroundColor: "#000", color: "#fff" }
        : tone === "white"
          ? { backgroundColor: "#fff", color: APP.ink, boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }
          : { backgroundColor: "#F3F4F6", color: APP.ink };
  return (
    <span
      className={`flex items-center justify-center gap-2 rounded-[12px] font-semibold ${small ? "h-[40px] px-4 text-[14px]" : "h-[48px] px-4 text-[16px]"} ${className}`}
      style={{ ...s, transform: pressed ? "scale(0.97)" : undefined, transition: "transform 120ms ease-out" }}
    >
      {children}
    </span>
  );
}

/** Rounded status badge (BookingCard.statusBadge: 6/14, radius 20). */
export function Badge({ children, bg, fg, className = "" }: { children: ReactNode; bg: string; fg: string; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-[20px] px-[14px] py-[6px] text-[12px] font-semibold ${className}`} style={{ backgroundColor: bg, color: fg }}>
      {children}
    </span>
  );
}

/** Small tag chips (ON TIME / SOON / NEEDS ATTENTION, MaintenanceSignalPills). */
export function Tag({ children, tone = "blue" }: { children: ReactNode; tone?: "blue" | "amber" | "red" | "green" | "gray" }) {
  const m = {
    blue: { bg: APP.blueLight, fg: "#1D4ED8" },
    amber: { bg: APP.amberLight, fg: "#B45309" },
    red: { bg: APP.redLight, fg: "#B91C1C" },
    green: { bg: APP.greenLight, fg: "#047857" },
    gray: { bg: "#F1F5F9", fg: "#475569" },
  }[tone];
  return (
    <span className="inline-flex h-[22px] items-center rounded-full px-[9px] text-[11px] font-semibold uppercase tracking-[0.04em]" style={{ backgroundColor: m.bg, color: m.fg }}>
      {children}
    </span>
  );
}

/** Initials avatar (36px round, #E5E7EB) with an optional rating pill. */
export function Avatar({ initials, size = 36, rating, tint = false }: { initials: string; size?: number; rating?: string; tint?: boolean }) {
  return (
    <span className="relative inline-flex shrink-0">
      <span
        className="inline-flex items-center justify-center rounded-full font-semibold"
        style={{ width: size, height: size, backgroundColor: tint ? "#5299FE1A" : "#E5E7EB", color: tint ? APP.blue : APP.ink, fontSize: Math.round(size * 0.36) }}
      >
        {initials}
      </span>
      {rating && (
        <span className="absolute -bottom-1.5 -left-1.5 flex items-center gap-[2px] rounded-full bg-black px-[6px] py-[2px] text-[10px] font-bold text-white">
          <Star className="h-[9px] w-[9px] fill-[#F59E0B] text-[#F59E0B]" />
          {rating}
        </span>
      )}
    </span>
  );
}

/** Screen header for pushed routes (BookingPageHeader): round back button,
 *  centered title. */
export function ScreenHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-5 pt-[62px]">
      <span className="flex h-[36px] w-[36px] items-center justify-center rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.08)]">
        <ChevronLeft className="h-[18px] w-[18px]" style={{ color: APP.ink }} strokeWidth={2.2} />
      </span>
      <span className="flex-1 text-center text-[17px] font-bold" style={{ color: APP.ink }}>
        {title}
      </span>
      <span className="flex w-[36px] justify-end">{right}</span>
    </div>
  );
}

/** Tab-root header: big title, avatar. */
export function TabHeader({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="flex items-end justify-between px-5 pt-[64px]">
      <div>
        <p className="text-[28px] font-bold leading-[1.1] tracking-[-0.01em]" style={{ color: APP.ink }}>
          {title}
        </p>
        {sub && (
          <p className="mt-1 text-[13px]" style={{ color: APP.meta }}>
            {sub}
          </p>
        )}
      </div>
      {right}
    </div>
  );
}

export function Divider({ className = "" }: { className?: string }) {
  return <div className={`border-t ${className}`} style={{ borderColor: "rgba(0,0,0,0.06)" }} />;
}

/** A key / value line in a breakdown (ReviewPay, PaymentBreakdown). */
export function KV({ k, v, sub = false, strong = false, muted = false }: { k: ReactNode; v: ReactNode; sub?: boolean; strong?: boolean; muted?: boolean }) {
  const c = muted ? "#8E8E93" : APP.text;
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={strong ? "text-[16px] font-bold" : sub ? "text-[13px]" : "text-[14px] font-medium"} style={{ color: sub && !muted ? APP.meta : c }}>
        {k}
      </span>
      <span className={`tabular-nums ${strong ? "text-[17px] font-bold" : sub ? "text-[13px]" : "text-[14px] font-semibold"}`} style={{ color: c }}>
        {v}
      </span>
    </div>
  );
}

/** Segmented control (Upcoming / History). */
export function Segmented({ items, on }: { items: string[]; on: number }) {
  return (
    <div className="mx-5 mt-4 flex rounded-[12px] bg-[#E9ECF1] p-[3px]">
      {items.map((it, i) => (
        <span
          key={it}
          className="flex-1 rounded-[10px] py-[8px] text-center text-[14px] font-semibold"
          style={i === on ? { backgroundColor: "#fff", color: APP.ink, boxShadow: "0 1px 3px rgba(0,0,0,0.08)" } : { color: APP.meta }}
        >
          {it}
        </span>
      ))}
    </div>
  );
}

/** A chevron row (settings / detail lists). */
export function ChevronRow({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center justify-between">
      {children}
      <ChevronRight className="h-[18px] w-[18px]" style={{ color: APP.dim }} />
    </span>
  );
}
