"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { ArrowUpRight } from "lucide-react";

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
}

/** "Ask Oto about your car…" input — mic to talk, type + arrow to chat. */
export default function VoiceBar({
  onSend,
  onMic,
  onFocus,
  listening = false,
  placeholder = "Ask Oto about your car...",
  className,
}: VoiceBarProps) {
  const [value, setValue] = useState("");

  const submit = () => {
    const text = value.trim();
    if (!text) {
      onMic();
      return;
    }
    onSend(text);
    setValue("");
  };

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
        placeholder={placeholder}
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
