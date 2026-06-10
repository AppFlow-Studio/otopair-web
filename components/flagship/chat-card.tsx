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

/** Left-hand "Talk to Oto" live-assistant card with transcript + input. */
export default function ChatCard({
  messages,
  thinking = false,
  listening = false,
  onSend,
  onMic,
}: ChatCardProps) {
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

  return (
    <div className="flex h-full w-full flex-col rounded-[20px] border border-white/40 bg-white/45 p-6 shadow-[0_22px_60px_rgba(0,0,0,0.10)] backdrop-blur-[40px]">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#1a1a1a]/45">
            Live AI Assistant
          </p>
          <h3
            className="mt-1 text-[26px] leading-none text-[#1a1a1a]"
            style={{ fontFamily: "var(--font-Lora)" }}
          >
            Talk to Oto
          </h3>
        </div>
        <Waveform active={listening || thinking} className="mt-1 text-[#1a1a1a]" bars={6} />
      </div>

      {/* Transcript */}
      <div
        ref={scrollRef}
        className="my-5 flex-1 space-y-3 overflow-y-auto pr-1 [scrollbar-width:thin]"
      >
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
              <p
                className={
                  m.role === "user"
                    ? "max-w-[80%] rounded-2xl rounded-tr-sm bg-[#1a1a1a]/[0.06] px-4 py-2.5 text-[13.5px] leading-snug text-[#1a1a1a]"
                    : "max-w-[85%] rounded-2xl rounded-tl-sm bg-[#1a1a1a]/[0.04] px-4 py-2.5 text-[13.5px] leading-snug text-[#1a1a1a]/80"
                }
              >
                {m.text}
              </p>
            </motion.div>
          ))}
        </AnimatePresence>

        {thinking && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex justify-start"
          >
            <span className="flex gap-1 rounded-2xl bg-[#1a1a1a]/[0.04] px-4 py-3">
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
      </div>

      <VoiceBar onSend={onSend} onMic={onMic} listening={listening} className="h-[56px]" />
    </div>
  );
}
