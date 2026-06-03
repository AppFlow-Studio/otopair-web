"use client";

import { useCallback, useRef } from "react";
import { ConversationProvider } from "@elevenlabs/react";
import {
  AnimatePresence,
  motion,
  useAnimationFrame,
  useInView,
  useMotionValue,
  useTransform,
} from "motion/react";
import { RotateCcw } from "lucide-react";
import PillNav from "./pill-nav";
import OtoOrb from "./oto-orb";
import VoiceBar, { Waveform } from "./voice-bar";
import ChatCard from "./chat-card";
import { PlatformToggle, useReducedMotionSafe } from "./shared";
import {
  BookingConfirmedCard,
  ChooseShopCard,
  DateTimeCard,
  SchedulingCard,
  VehicleCard,
} from "./cards";
import { DemoCard } from "./demo-cards";
import { DynamicCard } from "./dynamic-card";
import { useOtoAgent, type OtoAgent } from "./use-oto-agent";

// Discoverability chips under the intro bar — each routes to a real demo card
// (in live + scripted-demo mode alike).
const QUICK_CHIPS = [
  "What can you do?",
  "How does pricing work?",
  "How do rewards work?",
  "Where are you available?",
];

/** Small live-status indicator that sits under the orb when active. */
function StatusPill({ oto }: { oto: OtoAgent }) {
  let label = "";
  let dot = "bg-[#22b07d]";
  let wave = false;
  if (oto.thinking) {
    label = "Oto is thinking";
    dot = "bg-[#e2a33c]";
  } else if (oto.isSpeaking) {
    label = "Oto is speaking";
    dot = "bg-[#2f7bff]";
    wave = true;
  } else if (oto.connected) {
    label = "Listening";
  } else if (oto.status === "connecting") {
    label = "Connecting…";
    dot = "bg-[#777169]";
  }

  return (
    <div className="mt-5 h-7">
      <AnimatePresence mode="wait">
        {label && (
          <motion.div
            key={label}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.3 }}
            className="flex items-center gap-2 rounded-full bg-white/55 px-3.5 py-1.5 text-[12px] text-[#1a1a1a]/70 backdrop-blur"
          >
            {wave ? (
              <Waveform active className="text-[#2f7bff]" bars={4} />
            ) : (
              <motion.span
                className={`h-1.5 w-1.5 rounded-full ${dot}`}
                animate={{ opacity: [0.4, 1, 0.4] }}
                transition={{ duration: 1.4, repeat: Infinity }}
              />
            )}
            {label}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function HeroInner() {
  const oto = useOtoAgent();
  const reduce = useReducedMotionSafe();
  const sectionRef = useRef<HTMLElement>(null);
  const inView = useInView(sectionRef, { amount: 0.05 });

  // The hero flips to its live 3-panel layout the instant the user engages —
  // before any message lands — so chat + schedule slide in together.
  const active =
    oto.awake ||
    oto.step !== "intro" ||
    oto.demoFeature !== null ||
    oto.dynamicCard !== null ||
    oto.messages.length > 0 ||
    oto.connected;
  const orbActive = oto.isSpeaking || oto.thinking || oto.status === "connecting";

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

  // ── The schedule/canvas panel "responds in real time as Oto speaks" ──
  // canvasLevel breathes while Oto is active and reacts to live output audio.
  const canvasLevel = useMotionValue(0);
  useAnimationFrame((t) => {
    if (reduce || !active) {
      if (canvasLevel.get() !== 0) canvasLevel.set(0);
      return;
    }
    const speaking = oto.isSpeaking || oto.thinking || oto.status === "connecting";
    const base = speaking ? 0.3 + 0.16 * Math.sin(t / 420) : 0.05;
    const target = Math.max(base, getOrbLevel());
    canvasLevel.set(canvasLevel.get() + (target - canvasLevel.get()) * 0.18);
  });
  const canvasShadow = useTransform(
    canvasLevel,
    (l) =>
      `0 0 0 ${(1 + l * 3).toFixed(2)}px rgba(47,123,255,${(0.08 + l * 0.4).toFixed(3)}), 0 22px 60px rgba(0,0,0,0.08)`
  );
  const canvasScale = useTransform(canvasLevel, [0, 1], [1, 1.012]);

  // The right "canvas" panel — Oto's screen. Defaults to the schedule preview
  // and swaps to whatever Oto is currently demonstrating.
  const rightKey = oto.dynamicCard
    ? `dynamic:${oto.dynamicCard.title}`
    : oto.demoFeature ?? (oto.step === "intro" ? "schedule" : oto.step);
  const renderRightCard = () => {
    if (oto.dynamicCard) return <DynamicCard payload={oto.dynamicCard} />;
    if (oto.demoFeature) return <DemoCard feature={oto.demoFeature} />;
    if (oto.step === "vehicle" && oto.vehicle)
      return <VehicleCard vehicle={oto.vehicle} onContinue={() => oto.advance("shops")} />;
    if (oto.step === "shops")
      return (
        <ChooseShopCard
          shops={oto.shops}
          selectedId={oto.selectedShop?.id}
          onSelect={(s) => oto.chooseShop(s)}
          onContinue={(s) => oto.chooseShop(s)}
        />
      );
    if (oto.step === "datetime")
      return (
        <DateTimeCard
          slots={oto.slots}
          selectedId={oto.selectedSlot?.id}
          onSelect={oto.chooseSlot}
          onConfirm={oto.confirmAppointment}
        />
      );
    if (oto.step === "confirmed")
      return (
        <BookingConfirmedCard
          booking={oto.booking}
          onSavePreSignup={oto.savePreSignup}
          saved={oto.presignupSaved}
        />
      );
    if (oto.step === "scheduling")
      return <SchedulingCard onConfirm={() => oto.advance("shops")} />;
    // Prechat: nothing to show yet — keep the canvas empty (just the orb).
    return null;
  };
  const hasCard =
    oto.dynamicCard !== null ||
    oto.demoFeature !== null ||
    oto.step === "vehicle" ||
    oto.step === "scheduling" ||
    oto.step === "shops" ||
    oto.step === "datetime" ||
    oto.step === "confirmed";

  // Reduced-motion-aware slide choreography for the side panels.
  const slide = (dir: -1 | 1, delay: number) =>
    reduce
      ? {
          initial: { opacity: 0 },
          animate: { opacity: 1, transition: { duration: 0.3 } },
          exit: { opacity: 0 },
        }
      : {
          initial: { opacity: 0, x: dir * 48, filter: "blur(6px)" },
          animate: {
            opacity: 1,
            x: 0,
            filter: "blur(0px)",
            transition: { type: "spring", stiffness: 190, damping: 26, delay },
          },
          exit: { opacity: 0, x: dir * 48, filter: "blur(6px)" },
        };

  return (
    <section
      ref={sectionRef}
      className="relative flex min-h-screen w-full flex-col overflow-hidden bg-[#eceae6]"
    >
      <PillNav />

      {/* Headline — collapses (but stays prominent) once the conversation starts. */}
      <div
        className={`relative z-20 flex flex-col items-center px-6 text-center transition-[padding] duration-500 ${
          active ? "pt-[100px]" : "pt-[150px]"
        }`}
      >
        <motion.h1
          layout
          className={`tracking-[-0.01em] text-[#1a1a1a] transition-all duration-500 ${
            active
              ? "max-w-[20ch] text-[34px] leading-[1.05] sm:text-[42px]"
              : "max-w-[14ch] text-[46px] leading-[1.04] sm:text-[58px] md:text-[62px]"
          }`}
          style={{ fontFamily: "var(--font-Lora)" }}
        >
          No more phone tag with mechanics
        </motion.h1>

        {/* Subhead stays present (per the Figma hero vision); just shrinks. */}
        <p
          className={`text-[#6b655d] transition-all duration-500 ${
            active ? "mt-3 max-w-[52ch] text-[14px]" : "mt-5 max-w-[44ch] text-[17px] leading-relaxed"
          }`}
        >
          Talk to Oto. Get fixed prices from real shops nearby.
          {!active && <br className="hidden sm:block" />} Book in 90 seconds.
        </p>

        <AnimatePresence initial={false}>
          {!active && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.4 }}
              className="flex flex-col items-center overflow-hidden"
            >
              <div className="mt-7">
                <PlatformToggle />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Content stage. The orb is the centerpiece: large, and it sits BEHIND
          the translucent panels (which overlap its edges so it glows through). */}
      <div className="relative z-10 mx-auto flex w-full max-w-[1180px] flex-1 items-center justify-center px-6 pb-16">
        <div className="relative flex w-full flex-col items-center justify-center gap-8 lg:flex-row lg:items-center lg:justify-center lg:gap-0">
          {/* LEFT — chat (translucent; overlaps the orb's left edge) */}
          <AnimatePresence>
            {active && (
              <motion.div
                key="chat"
                {...slide(-1, 0.06)}
                className="relative z-10 order-2 h-[420px] w-full shrink-0 sm:h-[460px] lg:order-1 lg:-mr-16 lg:w-[380px]"
              >
                <ChatCard
                  messages={oto.messages}
                  thinking={oto.thinking}
                  listening={oto.isSpeaking}
                  onSend={oto.sendText}
                  onMic={oto.startVoice}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {/* CENTER — the orb. Grows when active, and drops BEHIND the panels. */}
          <div
            className={`order-1 flex shrink-0 flex-col items-center lg:order-2 ${
              active ? "relative z-0" : "relative z-10"
            }`}
          >
            <motion.div
              animate={{ scale: active ? 1.18 : 1 }}
              transition={{ type: "spring", stiffness: 140, damping: 20 }}
              className="h-[280px] w-[280px] sm:h-[340px] sm:w-[360px]"
            >
              <OtoOrb
                active={orbActive}
                getLevel={getOrbLevel}
                paused={!inView}
                className="h-full w-full"
              />
            </motion.div>

            {active && <StatusPill oto={oto} />}

            <AnimatePresence>
              {!active && (
                <motion.div
                  key="intro-controls"
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -14, transition: { duration: 0.25 } }}
                  transition={{ duration: 0.5, delay: 0.1 }}
                  className="mt-8 flex w-full flex-col items-center"
                >
                  <VoiceBar
                    onSend={oto.sendText}
                    onMic={oto.startVoice}
                    listening={oto.isSpeaking}
                    className="w-full max-w-[460px]"
                  />
                  <div className="mt-4 flex max-w-[480px] flex-wrap items-center justify-center gap-2">
                    {QUICK_CHIPS.map((c, i) => (
                      <motion.button
                        key={c}
                        type="button"
                        onClick={() => oto.sendText(c)}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.35 + i * 0.07 }}
                        whileHover={{ y: -2 }}
                        whileTap={{ scale: 0.96 }}
                        className="rounded-full border border-[#1a1a1a]/12 bg-white/55 px-4 py-2 text-[13px] text-[#1a1a1a]/75 backdrop-blur transition-colors hover:bg-white/80 hover:text-[#1a1a1a]"
                      >
                        {c}
                      </motion.button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* RIGHT — Oto's live canvas. Only renders when Oto actually has a
              card to show (no demo component shows for no reason). */}
          <AnimatePresence>
            {active && hasCard && (
              <motion.div
                key="canvas"
                {...slide(1, 0.12)}
                className="relative z-10 order-3 flex w-full shrink-0 items-center justify-center lg:order-3 lg:-ml-16 lg:h-[460px] lg:w-[380px]"
              >
                {/* Audio-reactive ring — pulses with Oto's voice while it narrates. */}
                <motion.div
                  className="relative w-full rounded-[22px]"
                  style={reduce ? undefined : { boxShadow: canvasShadow, scale: canvasScale }}
                >
                  {/* Quick crossfade between cards — each card runs its own
                      multi-step "assemble in" animation internally. */}
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={rightKey}
                      initial={{ opacity: 0, scale: 0.985 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.99 }}
                      transition={{ duration: 0.22, ease: "easeOut" }}
                      className="w-full"
                    >
                      {renderRightCard()}
                    </motion.div>
                  </AnimatePresence>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
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

      {/* Scroll cue */}
      <AnimatePresence>
        {!active && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none absolute bottom-6 left-1/2 z-20 -translate-x-1/2"
          >
            <div className="flex h-9 w-[22px] items-start justify-center rounded-full border border-[#1a1a1a]/20 p-1.5" aria-hidden>
              {!reduce && (
                <motion.span
                  className="h-1.5 w-1 rounded-full bg-[#1a1a1a]/40"
                  animate={{ y: [0, 8, 0], opacity: [1, 0.3, 1] }}
                  transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
                />
              )}
            </div>
          </motion.div>
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
