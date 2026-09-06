"use client";

import type { ReactNode } from "react";
import type { ChatMessage } from "./oto-flow";
import VoiceBar, { Waveform } from "./voice-bar";
import { Transcript } from "./chat-card";
import { serif } from "./landing/reveal";

/**
 * The mobile frame's mic glyph (Figma 390:3211 `_ÎÓÈ_1`, 9×14, white) that
 * floats over the frosted orb in the engaged-but-quiet card. Figma's own
 * export, inlined so it can sit inside a real button instead of an <img>.
 */
function MicGlyph() {
  return (
    <svg width="9" height="14" viewBox="0 0 9 14" fill="none" aria-hidden>
      <path
        d="M4.49994 9.57066C2.87781 9.57066 1.55807 8.29988 1.55807 6.73792V2.83274C1.55807 1.27078 2.87793 0 4.49994 0C6.12194 0 7.44181 1.27078 7.44181 2.83274V6.73792C7.44181 8.29988 6.12207 9.57066 4.49994 9.57066ZM4.49994 0.695208C3.27585 0.695208 2.28006 1.65406 2.28006 2.83274V6.73792C2.28006 7.9166 3.27585 8.87545 4.49994 8.87545C5.72402 8.87545 6.71982 7.9166 6.71982 6.73792V2.83274C6.71982 1.65406 5.72402 0.695208 4.49994 0.695208Z"
        fill="currentColor"
      />
      <path
        d="M4.50169 11.197C2.01942 11.197 0 9.25233 0 6.86202C0 6.67008 0.161599 6.51436 0.361058 6.51436C0.560518 6.51436 0.722116 6.66996 0.722116 6.86202C0.722116 8.86894 2.41771 10.5018 4.50182 10.5018C6.58593 10.5018 8.27801 8.86894 8.27801 6.86202C8.27801 6.67008 8.43961 6.51436 8.63907 6.51436C8.83853 6.51436 9.00013 6.66996 9.00013 6.86202C9.00013 9.25221 6.98234 11.197 4.50194 11.197H4.50169Z"
        fill="currentColor"
      />
      <path
        d="M4.50169 14C4.30236 14 4.14063 13.8444 4.14063 13.6523V10.8493C4.14063 10.6574 4.30223 10.5016 4.50169 10.5016C4.70115 10.5016 4.86275 10.6572 4.86275 10.8493V13.6523C4.86275 13.8443 4.70115 14 4.50169 14Z"
        fill="currentColor"
      />
    </svg>
  );
}

interface MobileHeroCardProps {
  messages: ChatMessage[];
  thinking: boolean;
  listening: boolean;
  onSend: (text: string) => void;
  onMic: () => void;
  /** Oto's current result card (booking step / demo / info), rendered inline
   *  under the transcript — the frame keeps everything in one card. */
  canvas?: ReactNode;
  /** Header title once the conversation is running (frame 4 reads "Oto
   *  booked your appointment" when a booking lands). */
  conversationTitle?: string;
  /** Optional status pill, absolutely positioned inside the card header. */
  status?: ReactNode;
  className?: string;
}

/**
 * The mobile hero's glass "Talk to Oto" card. On a phone the hero has NO card
 * while idle (Figma frames "iPhone 16 & 17 Pro - 1/6": orb + an input bar).
 * The card appears once the visitor engages and the BIG orb stays where it
 * is, behind the glass — never inside the card (design feedback 2026-09-03):
 *
 *  - Engaged (frame 7, 390:3200): 348×323 at y 484, r-10, 0.5px #1a1a1a edge,
 *    67° white gradient 20% → 3.5%, 35px backdrop blur. The orb's crown
 *    rises 76px above the card; the rest is frosted through it. Header
 *    "LIVE AI ASSISTANT" 9px/28 at (17, 20) + "Talk to Oto" 18px/41 at
 *    (17, 35), waveform glyph at (297.5, 31.5), the mic glyph over the orb
 *    at card y 156, the "or send a message" field 15px off the bottom.
 *  - In conversation (frame 4, 326:164): the same card grown to 579 — UP
 *    over the headline, bottom edge staying put — with a one-line header
 *    (waveform + title), the bubbles, Oto's result card inline, the field.
 *    The hero owns the upward growth (its margin); this card owns its
 *    height and contents.
 */
export default function MobileHeroCard({
  messages,
  thinking,
  listening,
  onSend,
  onMic,
  canvas,
  conversationTitle = "Talk to Oto",
  status,
  className,
}: MobileHeroCardProps) {
  const inConversation = messages.length > 0 || thinking || !!canvas;
  return (
    <div
      className={`relative flex flex-col overflow-hidden rounded-[10px] border-[0.5px] border-[#1a1a1a] backdrop-blur-[35px] transition-[height] duration-[450ms] ease-out ${
        inConversation ? "h-[579px]" : "h-[323px]"
      } ${className ?? ""}`}
      style={{
        backgroundImage:
          "linear-gradient(67.32deg, rgba(255,255,255,0.2) 10.42%, rgba(255,255,255,0.035) 77.11%)",
      }}
    >
      {inConversation ? (
        /* Frame 4 header: the waveform glyph then the title on one 15px line. */
        <div className="relative flex shrink-0 items-center gap-[10px] px-[17px] pt-[17px]">
          <Waveform active={listening || thinking} bars={5} className="text-[#1a1a1a]" />
          <h3 className="text-[15px] leading-[22px] text-[#1a1a1a]">{conversationTitle}</h3>
          {status}
        </div>
      ) : (
        /* Frame 7 header — 76px tall: the two text boxes overlap (28px and
           41px line boxes at 20 and 35), which the negative margin
           reproduces in flow. */
        <div className="relative shrink-0 px-[17px] pt-[20px]">
          <p className="text-[9px] leading-[28px] tracking-[0.45px] text-[#777169]">
            LIVE AI ASSISTANT
          </p>
          <h3
            className="-mt-[13px] text-[18px] leading-[41px] tracking-[0.374px] text-[#1a1a1a]"
            style={serif}
          >
            Talk to Oto
          </h3>
          <div className="absolute right-[25.5px] top-[31.5px] flex h-[24px] w-[25px] items-center justify-center">
            <Waveform active={listening || thinking} bars={5} className="text-[#1a1a1a]" />
          </div>
          {status}
        </div>
      )}

      {inConversation ? (
        <Transcript
          messages={messages}
          thinking={thinking}
          compact
          className="mt-[18px] min-h-0 flex-1 space-y-[10px] overflow-y-auto px-[17px] pb-2 [scrollbar-width:thin]"
        >
          {canvas && <div className="pt-[6px]">{canvas}</div>}
        </Transcript>
      ) : (
        <div className="relative flex-1">
          {/* Mic glyph over the frosted orb: card y 156 (+7 to the glyph's
              centre) → 87px into this box. 44px hit area, 9×14 mark. */}
          <button
            type="button"
            onClick={onMic}
            aria-label="Talk to Oto"
            className="absolute left-1/2 top-[87px] flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center text-white"
          >
            <MicGlyph />
          </button>
        </div>
      )}

      <VoiceBar
        variant="compact"
        mic={inConversation}
        onSend={onSend}
        onMic={onMic}
        listening={listening}
        className="mx-[17px] mb-[15px] mt-2 shrink-0"
      />
    </div>
  );
}
