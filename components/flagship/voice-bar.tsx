"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { ArrowUpRight, Mic } from "lucide-react";

/** Animated audio-waveform glyph. */
export function Waveform({
  active = false,
  className,
  bars = 5,
}: {
  active?: boolean;
  className?: string;
  bars?: number;
}) {
  return (
    <div className={`flex items-center gap-[3px] ${className ?? ""}`} aria-hidden>
      {Array.from({ length: bars }).map((_, i) => (
        <motion.span
          key={i}
          className="w-[2.5px] rounded-full bg-current"
          animate={
            active
              ? { height: ["6px", "18px", "9px", "16px", "6px"] }
              : { height: ["7px", "12px", "7px"] }
          }
          transition={{
            duration: active ? 0.9 : 2.4,
            repeat: Infinity,
            ease: "easeInOut",
            delay: i * 0.12,
          }}
        />
      ))}
    </div>
  );
}

interface VoiceBarProps {
  onSend: (text: string) => void;
  onMic: () => void;
  /** Fired when the user engages the bar (focus/click) — used to "wake" Oto. */
  onFocus?: () => void;
  listening?: boolean;
  placeholder?: string;
  className?: string;
  /**
   * `compact` is the mobile frame's "or send a message" field (Figma
   * 390:3217 — 318×32, r-8, white @ 50%, 0.5px #777169 @ 40% edge, 35px
   * backdrop blur, 11px placeholder, 17px ↗). Default is the desktop bar.
   */
  variant?: "default" | "compact" | "idle-mobile";
  /**
   * Compact only: render the waveform mic button at the left. The frame's
   * idle field has none — its mic is the glyph floating on the orb — so the
   * hero passes `mic` only once the transcript has replaced that glyph.
   */
  mic?: boolean;
}

/** "Ask Oto about your car…" input — mic to talk, type + arrow to chat. */
export default function VoiceBar({
  onSend,
  onMic,
  onFocus,
  listening = false,
  placeholder,
  className,
  variant = "default",
  mic = false,
}: VoiceBarProps) {
  const [value, setValue] = useState("");
  const compact = variant === "compact";
  const idleMobile = variant === "idle-mobile";
  const hint = placeholder ?? (compact ? "or send a message" : "Ask Oto about your car...");

  const submit = () => {
    const text = value.trim();
    if (!text) {
      onMic();
      return;
    }
    onSend(text);
    setValue("");
  };

  // The mobile frame's IDLE bar (Figma 321:1409 / 328:120 — frames "iPhone
  // 16 & 17 Pro - 1/6"): 348×39 under the orb, waveform at the left, a mic
  // at the right, "Ask Oto about your car..." between. Before any message
  // there is no chat card at all on a phone — this bar is the whole surface.
  if (idleMobile) {
    return (
      <div
        className={`relative flex h-[39px] items-center gap-2 rounded-[10px] border-[0.5px] border-[#1a1a1a]/25 bg-white/80 pl-3 pr-1.5 shadow-[0_6px_18px_rgba(0,0,0,0.06)] backdrop-blur-[35px] ${className ?? ""}`}
      >
        <motion.button
          type="button"
          onClick={onMic}
          aria-label="Talk to Oto"
          whileTap={{ scale: 0.9 }}
          transition={{ type: "spring", stiffness: 400, damping: 18 }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#1a1a1a]"
        >
          <Waveform active={listening} bars={4} className="scale-[0.85] text-[#1a1a1a]" />
        </motion.button>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={onFocus}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-[#1a1a1a] focus:outline-none"
          style={{ fontSize: 16 }}
          aria-label="Message Oto"
          enterKeyHint="send"
        />
        {!value && (
          <span
            aria-hidden
            className="pointer-events-none absolute left-[44px] top-1/2 -translate-y-1/2 whitespace-nowrap text-[12px] leading-[20px] tracking-[0.3px] text-[#1a1a1a]/70"
          >
            {hint}
          </span>
        )}
        <motion.button
          type="button"
          onClick={submit}
          aria-label={value.trim() ? "Send" : "Talk to Oto"}
          whileTap={{ scale: 0.9 }}
          transition={{ type: "spring", stiffness: 400, damping: 18 }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#1a1a1a]"
        >
          {value.trim() ? (
            <ArrowUpRight className="h-[16px] w-[16px]" strokeWidth={1.5} />
          ) : (
            <Mic className="h-[15px] w-[15px]" strokeWidth={1.6} />
          )}
        </motion.button>
      </div>
    );
  }

  if (compact) {
    return (
      <div
        className={`relative flex h-[32px] items-center rounded-[8px] border-[0.5px] border-[rgba(119,113,105,0.4)] bg-white/50 pl-[14.5px] pr-[6px] backdrop-blur-[35px] ${className ?? ""}`}
      >
        {mic && (
          <motion.button
            type="button"
            onClick={onMic}
            aria-label="Talk to Oto"
            whileTap={{ scale: 0.9 }}
            transition={{ type: "spring", stiffness: 400, damping: 18 }}
            className="-ml-[7px] mr-[4px] flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[#1a1a1a]"
          >
            <Waveform active={listening} bars={4} className="scale-[0.8] text-[#1a1a1a]" />
          </motion.button>
        )}

        {/* The input stays at 16px so iOS Safari doesn't zoom the page on
            focus; the frame's 11px hint is a sibling span rather than a
            ::placeholder so its size and centring don't depend on the
            input's line box. */}
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={onFocus}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-[#1a1a1a] focus:outline-none"
          style={{ fontSize: 16 }}
          aria-label="Message Oto"
          enterKeyHint="send"
        />
        {!value && (
          <span
            aria-hidden
            className={`pointer-events-none absolute top-1/2 -translate-y-1/2 whitespace-nowrap text-[11px] leading-[20px] tracking-[0.55px] text-[#777169] ${
              mic ? "left-[36px]" : "left-[14.5px]"
            }`}
          >
            {hint}
          </span>
        )}

        <motion.button
          type="button"
          onClick={submit}
          aria-label="Send"
          whileTap={{ scale: 0.9 }}
          transition={{ type: "spring", stiffness: 400, damping: 18 }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#1a1a1a]"
        >
          <ArrowUpRight className="h-[17px] w-[17px]" strokeWidth={1.5} />
        </motion.button>
      </div>
    );
  }

  return (
    <div
      className={`flex h-[64px] items-center gap-3 rounded-[14px] border border-[#1a1a1a]/15 bg-white/70 px-4 backdrop-blur-2xl shadow-[0_10px_30px_rgba(0,0,0,0.06)] ${className ?? ""}`}
    >
      <motion.button
        type="button"
        onClick={onMic}
        aria-label="Talk to Oto"
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.9 }}
        transition={{ type: "spring", stiffness: 400, damping: 18 }}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#1a1a1a] transition-colors hover:bg-[#1a1a1a]/5"
      >
        <Waveform active={listening} className="text-[#1a1a1a]" />
      </motion.button>

      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={onFocus}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={hint}
        className="h-full flex-1 bg-transparent text-[15px] tracking-wide text-[#1a1a1a] placeholder:text-[#1a1a1a]/45 focus:outline-none"
        style={{ fontSize: 16 }}
        aria-label="Message Oto"
      />

      <motion.button
        type="button"
        onClick={submit}
        aria-label="Send"
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.9 }}
        transition={{ type: "spring", stiffness: 400, damping: 18 }}
        className="group flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#1a1a1a] transition-colors hover:bg-[#1a1a1a]/5"
      >
        <ArrowUpRight
          className="h-5 w-5 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
          strokeWidth={1.5}
        />
      </motion.button>
    </div>
  );
}
