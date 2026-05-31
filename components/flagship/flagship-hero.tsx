"use client";

import { useCallback, useState } from "react";
import { ConversationProvider } from "@elevenlabs/react";
import { AnimatePresence, motion } from "motion/react";
import { RotateCcw } from "lucide-react";
import PillNav from "./pill-nav";
import OtoOrb from "./oto-orb";
import VoiceBar from "./voice-bar";
import ChatCard from "./chat-card";
import {
  BookingConfirmedCard,
  ChooseShopCard,
  DateTimeCard,
  SchedulingCard,
  VehicleCard,
} from "./cards";
import { DemoCard } from "./demo-cards";
import { useOtoAgent } from "./use-oto-agent";

function PlatformToggle() {
  const [platform, setPlatform] = useState<"iphone" | "android">("iphone");
  return (
    <div className="relative flex h-[52px] w-[260px] items-center rounded-full bg-white p-1 shadow-[-8px_16px_18px_rgba(0,0,0,0.12)]">
      {(["iphone", "android"] as const).map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => setPlatform(p)}
          className={`relative z-10 flex h-full flex-1 items-center justify-center gap-1.5 rounded-full text-[14px] transition-colors ${
            platform === p ? "text-[#1a1a1a]" : "text-[#1a1a1a]/45"
          }`}
        >
          {p === "iphone" ? "iPhone" : "Android"}
        </button>
      ))}
      <span className="pointer-events-none absolute top-1/2 left-1/2 h-6 w-px -translate-x-1/2 -translate-y-1/2 bg-[#1a1a1a]/10" />
    </div>
  );
}

function HeroInner() {
  const oto = useOtoAgent();
  // Open the conversation view on any step/demo change OR as soon as there's a
  // message (so a live voice/text chat shows even before a card is summoned).
  const active =
    oto.step !== "intro" ||
    oto.demoFeature !== null ||
    oto.messages.length > 0 ||
    oto.connected;
  // Is there a card to show on the right? (booking-flow step or a demo card)
  const hasRightCard = oto.demoFeature !== null || oto.step !== "intro";
  const orbActive = oto.isSpeaking || oto.thinking;

  // Live audio level (0..1) sampled from the conversation — drives orb reactivity.
  const getOrbLevel = useCallback(() => {
    try {
      const data = oto.isSpeaking
        ? oto.getOutputByteFrequencyData()
        : oto.getInputByteFrequencyData();
      if (!data || data.length === 0) return 0;
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      return Math.min(1, sum / data.length / 96);
    } catch {
      return 0;
    }
  }, [oto]);

  return (
    <section className="relative flex min-h-screen w-full flex-col overflow-hidden bg-[#eceae6]">
      <PillNav />

      {/* Headline block — collapses once the conversation starts so the
          cards + orb get the vertical space and aren't clipped. */}
      <div
        className={`relative z-20 flex flex-col items-center px-6 text-center transition-[padding] duration-500 ${
          active ? "pt-[88px]" : "pt-[150px]"
        }`}
      >
        <h1
          className={`text-[#1a1a1a] transition-all duration-500 ${
            active
              ? "max-w-[28ch] text-[22px] leading-tight sm:text-[26px]"
              : "max-w-[14ch] text-[44px] leading-[1.05] sm:text-[56px] md:text-[60px]"
          }`}
          style={{ fontFamily: "var(--font-Lora)" }}
        >
          No more phone tag with mechanics
        </h1>
        <AnimatePresence initial={false}>
          {!active && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.4 }}
              className="flex flex-col items-center overflow-hidden"
            >
              <p className="mt-5 max-w-[44ch] text-[17px] leading-relaxed text-[#777169]">
                Talk to Oto. Get fixed prices from real shops nearby.
                <br className="hidden sm:block" /> Book in 90 seconds.
              </p>
              <div className="mt-7">
                <PlatformToggle />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Content stage — fills the remaining viewport and vertically centers
          the active conversation so it doesn't sit crammed at the top. */}
      <div
        className={`relative z-10 mx-auto flex w-full max-w-[1280px] justify-center px-6 ${
          active ? "flex-1 items-center pb-16" : "items-center pb-24 pt-10"
        }`}
      >
        {/* Intro background orb (big, centered). In active states the orb is
            rendered in-flow alongside the cards so they center together. */}
        {!active && (
          <motion.div
            aria-hidden
            className="pointer-events-none absolute left-1/2 z-0 -translate-x-1/2"
            initial={false}
            animate={{ width: 360, height: 360, opacity: 1, top: 70 }}
            transition={{ type: "spring", stiffness: 120, damping: 22 }}
          >
            <OtoOrb active={orbActive} getLevel={getOrbLevel} className="h-full w-full" />
          </motion.div>
        )}

        <AnimatePresence mode="wait">
          {!active ? (
            <motion.div
              key="intro"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="relative z-10 flex w-full flex-col items-center pt-[440px]"
            >
              <VoiceBar
                onSend={oto.sendText}
                onMic={oto.startVoice}
                listening={oto.isSpeaking}
                className="w-full max-w-[460px]"
              />
            </motion.div>
          ) : hasRightCard ? (
            // Card-mode: chat on the left, orb in the center channel, card right.
            <motion.div
              key="cards"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className="relative z-10 flex w-full flex-col items-center gap-6 lg:flex-row lg:items-center lg:justify-between lg:gap-6"
            >
              <div className="h-[460px] w-full lg:w-[400px] lg:shrink-0">
                <ChatCard
                  messages={oto.messages}
                  thinking={oto.thinking}
                  listening={oto.isSpeaking}
                  onSend={oto.sendText}
                  onMic={oto.startVoice}
                />
              </div>

              <div className="flex shrink-0 items-center justify-center">
                <OtoOrb
                  active={orbActive}
                  getLevel={getOrbLevel}
                  className="h-[200px] w-[200px] lg:h-[300px] lg:w-[300px]"
                />
              </div>

              <div className="flex w-full items-center lg:w-[400px] lg:shrink-0">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={oto.demoFeature ?? oto.step}
                    initial={{ opacity: 0, y: 14, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -14, scale: 0.98 }}
                    transition={{ duration: 0.35, ease: [0.25, 0.1, 0.25, 1] }}
                    className="w-full"
                  >
                    {oto.demoFeature && <DemoCard feature={oto.demoFeature} />}
                    {!oto.demoFeature && oto.step === "vehicle" && oto.vehicle && (
                      <VehicleCard vehicle={oto.vehicle} onContinue={() => oto.advance("shops")} />
                    )}
                    {!oto.demoFeature && oto.step === "scheduling" && (
                      <SchedulingCard onConfirm={() => oto.advance("shops")} />
                    )}
                    {!oto.demoFeature && oto.step === "shops" && (
                      <ChooseShopCard
                        shops={oto.shops}
                        selectedId={oto.selectedShop?.id}
                        onSelect={(s) => oto.chooseShop(s)}
                        onContinue={(s) => oto.chooseShop(s)}
                      />
                    )}
                    {!oto.demoFeature && oto.step === "datetime" && (
                      <DateTimeCard
                        slots={oto.slots}
                        selectedId={oto.selectedSlot?.id}
                        onSelect={oto.chooseSlot}
                        onConfirm={oto.confirmAppointment}
                      />
                    )}
                    {!oto.demoFeature && oto.step === "confirmed" && (
                      <BookingConfirmedCard
                        booking={oto.booking}
                        onSavePreSignup={oto.savePreSignup}
                        saved={oto.presignupSaved}
                      />
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>
            </motion.div>
          ) : (
            // Chat-mode: no card to show → normal centered chat, orb on top.
            <motion.div
              key="chat"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className="relative z-10 flex w-full flex-col items-center"
            >
              <OtoOrb
                active={orbActive}
                getLevel={getOrbLevel}
                className="mb-5 h-[120px] w-[120px] shrink-0"
              />
              <div className="h-[460px] w-full max-w-[600px]">
                <ChatCard
                  messages={oto.messages}
                  thinking={oto.thinking}
                  listening={oto.isSpeaking}
                  onSend={oto.sendText}
                  onMic={oto.startVoice}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Restart affordance once the flow is complete */}
      <AnimatePresence>
        {oto.step === "confirmed" && (
          <motion.button
            type="button"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={oto.reset}
            className="absolute bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-white/70 px-4 py-2 text-[12px] text-[#1a1a1a]/60 backdrop-blur transition-colors hover:text-[#1a1a1a]"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Start over
          </motion.button>
        )}
      </AnimatePresence>
    </section>
  );
}

/** Flagship Oto hero — conversation-driven flow over the ElevenLabs SDK. */
export default function FlagshipHero() {
  return (
    <ConversationProvider>
      <HeroInner />
    </ConversationProvider>
  );
}
