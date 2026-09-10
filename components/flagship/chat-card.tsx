"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { ChatMessage } from "./oto-flow";
import VoiceBar, { Waveform } from "./voice-bar";

interface ChatCardProps {
  messages: ChatMessage[];
  thinking?: boolean;
  listening?: boolean;
  onSend: (text: string) => void;
  onMic: () => void;
}

/**
 * The scrolling message list + thinking dots, shared by the desktop ChatCard
 * and the mobile hero card (hero-mobile-card.tsx). `compact` steps the
 * bubbles down to 13px / tighter padding for the 348-wide mobile glass card;
 * the default is the desktop sizing verbatim.
 */
export function Transcript({
  messages,
  thinking = false,
  compact = false,
  className,
  children,
}: {
  messages: ChatMessage[];
  thinking?: boolean;
  compact?: boolean;
  className?: string;
  /** Rendered after the last message inside the scroll container — the
   *  mobile hero card puts Oto's result card (booking, demo) inline here,
   *  the way the Figma conversation frame does (326:138 hero). */
  children?: React.ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Only auto-follow when the user is already near the bottom, so scrolling
    // up to re-read isn't yanked back down as streamed tokens arrive.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (!nearBottom) return;
    const id = requestAnimationFrame(() =>
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
    );
    return () => cancelAnimationFrame(id);
  }, [messages, thinking]);

  // Bubble type 13.5 → 15px (a step under the input's rendered 16px) with a
  // touch more padding — sized up with the card itself (design feedback
  // 2026-09-03, "enlarge chat boxes"). Compact keeps a 13px step for mobile.
  // Compact = the mobile frame's bubbles (326:164): the visitor's in solid
  // white, Oto's in a soft grey, both r-8 at 12px.
  const userBubble = compact
    ? "max-w-[82%] rounded-[8px] bg-white/90 px-[12px] py-[9px] text-[12px] leading-[17px] tracking-[0.2px] text-[#1a1a1a]"
    : "max-w-[80%] rounded-2xl rounded-tr-sm bg-[#1a1a1a]/[0.06] px-4 py-3 text-[15px] leading-snug text-[#1a1a1a]";
  const otoBubble = compact
    ? "max-w-[82%] rounded-[8px] bg-[#1a1a1a]/[0.09] px-[12px] py-[9px] text-[12px] leading-[17px] tracking-[0.2px] text-[#1a1a1a]"
    : "max-w-[85%] rounded-2xl rounded-tl-sm bg-[#1a1a1a]/[0.04] px-4 py-3 text-[15px] leading-snug text-[#1a1a1a]/80";
  const dots = compact
    ? "flex gap-1 rounded-2xl bg-[#1a1a1a]/[0.04] px-3 py-2"
    : "flex gap-1 rounded-2xl bg-[#1a1a1a]/[0.04] px-4 py-3";

  return (
    <div ref={scrollRef} className={className}>
      <AnimatePresence initial={false}>
        {messages.map((m) => (
          <motion.div
            key={m.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
          >
            <p className={m.role === "user" ? userBubble : otoBubble}>{m.text}</p>
          </motion.div>
        ))}
      </AnimatePresence>

      {thinking && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex justify-start"
        >
          <span className={dots}>
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="h-1.5 w-1.5 rounded-full bg-[#1a1a1a]/40"
                animate={{ opacity: [0.3, 1, 0.3] }}
                transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }}
              />
            ))}
          </span>
        </motion.div>
      )}
      {children}
    </div>
  );
}

/** Left-hand "Talk to Oto" live-assistant card with transcript + input. */
export default function ChatCard({
  messages,
  thinking = false,
  listening = false,
  onSend,
  onMic,
}: ChatCardProps) {
  return (
    <div className="flex h-full w-full flex-col rounded-[20px] border border-white/40 bg-white/55 p-6 shadow-[0_22px_60px_rgba(0,0,0,0.10)] backdrop-blur-[40px]">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#1a1a1a]/45">
            Live AI Assistant
          </p>
          <h3
            className="mt-1 text-[26px] leading-none text-[#1a1a1a]"
            style={{ fontFamily: "var(--font-Petrona)" }}
          >
            Talk to Oto
          </h3>
        </div>
        <Waveform active={listening || thinking} className="mt-1 text-[#1a1a1a]" bars={6} />
      </div>

      {/* Transcript */}
      <Transcript
        messages={messages}
        thinking={thinking}
        className="my-5 flex-1 space-y-3 overflow-y-auto pr-1 [scrollbar-width:thin]"
      />

      <VoiceBar onSend={onSend} onMic={onMic} listening={listening} className="h-[56px]" />
    </div>
  );
}
