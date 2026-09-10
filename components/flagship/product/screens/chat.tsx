"use client";

import type { ReactNode } from "react";
import { motion } from "motion/react";
import { ArrowUp, Check, Copy, Mic, Plus, ThumbsDown, ThumbsUp, Volume2 } from "lucide-react";
import { APP, PhoneShell } from "../device";

/**
 * The in-app Oto conversation (otopair-1 app/(main-tabs)/ai-chat +
 * components/ai-chat). Drawn at the app's values: user bubble #5299FE,
 * radius 18, 10/16 padding, 15/22 type, max 80%; Oto turn is plain text
 * on the canvas at 15/22 with the action row under it; AISources renders
 * a horizontal strip of white cards with a green dot and a two-line
 * label; AIQuickReplies are white pills with a hairline; AIInputBox is
 * a white rounded field ("Ask Oto", plus, mic) that turns into the blue
 * waveform strip while recording.
 */

export function UserBubble({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex justify-end ${className}`}>
      <div className="max-w-[80%] rounded-[18px] rounded-br-[6px] px-4 py-[10px] text-[15px] leading-[22px] text-white" style={{ backgroundColor: APP.blue }}>
        {children}
      </div>
    </div>
  );
}

export function OtoTurn({ children, thinking = true, className = "" }: { children: ReactNode; thinking?: boolean; className?: string }) {
  return (
    <div className={`max-w-[95%] ${className}`}>
      <div className="text-[15px] leading-[22px]" style={{ color: APP.text }}>
        {children}
      </div>
      <div className="mt-2 flex items-center gap-4">
        {thinking && (
          <span className="text-[13px] font-medium" style={{ color: APP.blue }}>
            Show thinking
          </span>
        )}
        <span className="flex items-center gap-3" style={{ color: APP.dim }}>
          <Copy className="h-[14px] w-[14px]" strokeWidth={2} />
          <Volume2 className="h-[14px] w-[14px]" strokeWidth={2} />
          <ThumbsUp className="h-[14px] w-[14px]" strokeWidth={2} />
          <ThumbsDown className="h-[14px] w-[14px]" strokeWidth={2} />
        </span>
      </div>
    </div>
  );
}

export const SOURCES = [
  { name: "Service History", sub: "Your past maintenance and repair records" },
  { name: "Manufacturer Data", sub: "Vehicle specifications and VIN database" },
  { name: "Error Codes", sub: "OBD-II diagnostic trouble code dictionary" },
] as const;

/** AISources: "Sources" label + horizontal strip of cards. */
export function Sources({ items = SOURCES, className = "" }: { items?: readonly { name: string; sub: string }[]; className?: string }) {
  return (
    <div className={className}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: APP.dim }}>
        Sources
      </p>
      <div className="mt-2 flex gap-2">
        {items.map((s) => (
          <div key={s.name} className="min-w-0 flex-1 rounded-[12px] border bg-white p-[10px]" style={{ borderColor: APP.border }}>
            <span className="flex h-[16px] w-[16px] items-center justify-center rounded-full" style={{ backgroundColor: "#10B981" }}>
              <Check className="h-[10px] w-[10px] text-white" strokeWidth={3} />
            </span>
            <p className="mt-2 text-[12px] font-semibold leading-[15px]" style={{ color: APP.ink }}>
              {s.name}
            </p>
            <p className="mt-[3px] text-[10px] leading-[13px]" style={{ color: APP.meta }}>
              {s.sub}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** AIQuickReplies: white pills; `on` is the tapped one. */
export function QuickReplies({ items, on, className = "" }: { items: string[]; on?: string; className?: string }) {
  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {items.map((it) => {
        const picked = it === on;
        return (
          <span
            key={it}
            className="inline-flex items-center gap-1.5 rounded-full border px-[14px] py-[8px] text-[13px] font-medium"
            style={picked ? { backgroundColor: APP.ink, borderColor: APP.ink, color: "#fff" } : { backgroundColor: "#fff", borderColor: APP.border, color: APP.ink }}
          >
            {picked && <Check className="h-[12px] w-[12px]" strokeWidth={2.5} />}
            {it}
          </span>
        );
      })}
    </div>
  );
}

/** The 14-spoke starburst thinking indicator (AITypingIndicator). */
export function Starburst({ size = 22, spin = true }: { size?: number; spin?: boolean }) {
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      animate={spin ? { rotate: 360 } : undefined}
      transition={{ duration: 2.4, ease: "linear", repeat: Infinity }}
      aria-hidden
    >
      {Array.from({ length: 14 }, (_, i) => {
        const a = (i / 14) * Math.PI * 2;
        return <line key={i} x1={14 + Math.cos(a) * 6} y1={14 + Math.sin(a) * 6} x2={14 + Math.cos(a) * 12} y2={14 + Math.sin(a) * 12} stroke={APP.blue} strokeWidth="1.8" strokeLinecap="round" />;
      })}
    </motion.svg>
  );
}

/** The thinking state: starburst, "Reading your car", the three sources
 *  ticking off (AITypingIndicator + AIReasoning). `done` = how many are checked. */
export function ThinkingTurn({ done = 2 }: { done?: 0 | 1 | 2 | 3 }) {
  return (
    <div className="flex flex-col items-center pt-6">
      <Starburst size={34} />
      <p className="mt-4 text-[15px] font-semibold" style={{ color: APP.ink }}>
        Reading your car
      </p>
      <p className="mt-1 text-center text-[12.5px] leading-[17px]" style={{ color: APP.meta }}>
        Service history, manufacturer data
        <br />
        and stored codes
      </p>
      <div className="mt-4 flex w-[80%] flex-col gap-2">
        {SOURCES.map((s, i) => {
          const ok = i < done;
          return (
            <span key={s.name} className="flex items-center gap-2 rounded-[12px] border bg-white px-3 py-[9px] text-[13px] font-medium" style={{ borderColor: APP.border, color: ok ? APP.ink : APP.dim, opacity: ok ? 1 : 0.7 }}>
              <span className="flex h-[16px] w-[16px] items-center justify-center rounded-full" style={{ backgroundColor: ok ? "#10B981" : "transparent", boxShadow: ok ? undefined : `inset 0 0 0 1.5px ${APP.border}` }}>
                {ok && <Check className="h-[10px] w-[10px] text-white" strokeWidth={3} />}
              </span>
              {s.name}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** AIInputBox, idle or recording. */
export function InputBar({ mode = "idle", animate = true }: { mode?: "idle" | "voice"; animate?: boolean }) {
  if (mode === "voice") {
    return (
      <div className="flex items-center gap-3 rounded-[22px] border-[1.5px] px-4 py-[10px]" style={{ backgroundColor: "#EEF2FF", borderColor: APP.blue }}>
        <span className="flex h-[26px] items-center gap-[3px]">
          {[8, 14, 20, 12, 18, 9, 22, 15, 8, 17, 11, 19, 13, 7].map((h, i) => (
            <motion.span
              key={i}
              className="w-[3px] rounded-full"
              style={{ backgroundColor: APP.blue, height: h }}
              animate={animate ? { scaleY: [1, 0.45, 1] } : undefined}
              transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.07, ease: "easeInOut" }}
            />
          ))}
        </span>
        <span className="flex-1 text-[13px]" style={{ color: APP.meta }}>
          Release to send
        </span>
        <span className="flex h-[32px] w-[32px] items-center justify-center rounded-full" style={{ backgroundColor: APP.blue }}>
          <ArrowUp className="h-[16px] w-[16px] text-white" strokeWidth={2.5} />
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 rounded-[22px] border bg-white px-4 py-[12px]" style={{ borderColor: "rgba(0,0,0,0.06)", boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
      <span className="flex-1 text-[15px]" style={{ color: APP.dim }}>
        Ask Oto
      </span>
      <Plus className="h-[20px] w-[20px]" style={{ color: "rgba(0,0,0,0.45)" }} strokeWidth={2} />
      <Mic className="h-[20px] w-[20px]" style={{ color: "rgba(0,0,0,0.45)" }} strokeWidth={2} />
    </div>
  );
}

function ChatHeader({ car }: { car: string }) {
  return (
    <div className="flex items-center justify-between px-5 pt-[62px]">
      <div className="flex items-center gap-[10px]">
        <span className="flex h-[36px] w-[36px] items-center justify-center rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.08)]">
          <Starburst size={18} spin={false} />
        </span>
        <span>
          <span className="block text-[16px] font-bold leading-[18px]" style={{ color: APP.ink }}>
            Oto
          </span>
          <span className="block text-[12px]" style={{ color: APP.meta }}>
            {car}
          </span>
        </span>
      </div>
      <span className="text-[13px] font-medium" style={{ color: APP.blue }}>
        New chat
      </span>
    </div>
  );
}

/**
 * The full screen. `children` is the transcript; `input` picks the bar
 * state. Tab bar on (Oto tab) unless `bare`.
 */
export function ChatScreen({
  children,
  input = "idle",
  car = "2019 Civic EX · VIN read",
  animate = true,
  bare = false,
}: {
  children: ReactNode;
  input?: "idle" | "voice" | "none";
  car?: string;
  animate?: boolean;
  bare?: boolean;
}) {
  return (
    <PhoneShell tab={bare ? undefined : 3}>
      <div className="flex h-full flex-col">
        <ChatHeader car={car} />
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-5 pt-5">{children}</div>
        {input !== "none" && (
          <div className={`px-4 ${bare ? "pb-[36px]" : "pb-[112px]"} pt-3`}>
            <InputBar mode={input} animate={animate} />
          </div>
        )}
      </div>
    </PhoneShell>
  );
}

/* The canonical brake-squeal transcript, in pieces so pages can stop at
   any turn. Copy mirrors the home page's Oto story (oto-panel.tsx). */
export const BRAKES = {
  user: "My brakes squeak when I slow down, mostly first thing in the morning.",
  question: "Does it fade after a few stops, or stay the whole drive?",
  chips: ["Fades after a few stops", "Stays the whole drive", "Only when it rains"],
  answer:
    "A squeal that fades as the brakes warm up is usually the wear indicator on the pads. Your last brake service on file is 18 months ago, so I'd scope a brake pad replacement and let the shop confirm it on the lift.",
  next: ["Yes, book it", "How urgent is it?", "Show shops near me"],
};
