"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import OtoOrb from "./oto-orb";
import VoiceBar, { Waveform } from "./voice-bar";
import ChatCard from "./chat-card";
import MobileHeroCard from "./hero-mobile-card";
import PlatformPill from "./landing/platform-pill";
import { useReducedMotionSafe } from "./shared";
import { serifDisplay } from "./landing/reveal";
import {
  BookingConfirmedCard,
  ChooseShopCard,
  DateTimeCard,
  SchedulingCard,
  VehicleCard,
} from "./cards";
import { DemoCard } from "./demo-cards";
import { DynamicCard } from "./dynamic-card";
import DebugTriggers from "./debug-triggers"; // TEMP — remove with debug-triggers.tsx
import { useOtoAgent, type OtoAgent } from "./use-oto-agent";

// Discoverability chips under the intro bar — each routes to a real demo card
// (in live + scripted-demo mode alike).
const QUICK_CHIPS = [
  "What can you do?",
  "How does pricing work?",
  "How do rewards work?",
  "Where are you available?",
];

/** Small live-status indicator that sits under the orb when active (desktop)
 *  or in the mobile card's header — `className` places the wrapper. */
function StatusPill({ oto, className = "mt-5 h-7" }: { oto: OtoAgent; className?: string }) {
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
    <div className={className}>
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
  // Below sm the engaged hero swaps the big orb for the small one inside the
  // glass card (see MobileHeroCard) — this only gates the hidden orb's rAF
  // work; the visibility itself is CSS (max-sm:hidden), so SSR and the first
  // client paint agree.
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639.98px)");
    const sync = () => setMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

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

  // Sections further down the page (PathSection's Voice Intake card) can hand
  // the visitor to the live hero conversation: they scroll up and fire this
  // event, and the hero opens the mic exactly as if VoiceBar's mic was tapped.
  useEffect(() => {
    const onTalk = () => oto.startVoice();
    window.addEventListener("otopair:talk", onTalk);
    return () => window.removeEventListener("otopair:talk", onTalk);
  }, [oto]);

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
  // Below sm: once anything has been said or shown, the glass card grows up
  // over the headline (Figma frame 4). Drives the card's margin and lifts
  // the stage above the headline block's z-20.
  const mobileConversation = active && (oto.messages.length > 0 || oto.thinking || hasCard);

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
      // Content-sized in BOTH states — never viewport-elastic. Sizing the
      // hero to the screen puts (viewport − content) of dead air around
      // whatever it holds, ballooning on tall windows; that got flagged twice
      // on 2026-08-30 (idle tail, then active state). The min is only a floor
      // for stub states; real content always exceeds it.
      // Below sm the composition is the mobile Figma frame (390:3180): the
      // wash runs #86C9E7 → white by 381px (44.7% of the frame's 852 hero)
      // and the block is purely content-sized — the frame's hero ends at
      // 852 where "Now onboarding" begins, with no floor to pad it.
      className="relative flex min-h-0 w-full flex-col overflow-hidden bg-[linear-gradient(to_bottom,#86C9E7_0px,#FFFFFF_381px)] sm:min-h-[720px] sm:bg-[linear-gradient(to_bottom,#98C9E8_0px,#FFFFFF_600px)]"
    >
      {/* PillNav is rendered by the page, ABOVE this section — a fixed
          backdrop-blur inside this overflow-hidden section lost its blur on
          scroll (Chromium). */}

      {/* TEMP: dev-only trigger panel for every card the agent can summon. */}
      {process.env.NODE_ENV === "development" && <DebugTriggers oto={oto} />}

      {/* Headline — IDENTICAL in idle and active (design feedback 2026-08-30:
          the circled block must not move or resize when the conversation
          opens). The old active-shrink variant also double-animated (framer
          layout + CSS transition-all) and visibly warped on the flip — an
          audit P2; with one static style both animators are gone. */}
      {/* pb-6: breathing room between the subhead and whatever sits below it
          (orb when idle, panels when active) — 2026-08-30. */}
      {/* Mobile (< sm) is the frame's stack (390:3215/3216/3183): headline top
          at y 142 (83px under the 59px bar), 28/28 on a 385 measure — so the
          side inset is 8px, not 24 — subhead 14/16 on 336 at y 224, and the
          iPhone | Android pill at y 272 (16px under the subhead's 48px box).
          The block's pb goes to 0 here: the stage carries the frame's 99px
          pill → orb gap itself. */}
      <div className="relative z-20 flex flex-col items-center px-2 pb-0 pt-[142px] text-center sm:px-6 sm:pb-6 sm:pt-[150px]">
        {/* Figma V1's declared type (node 302:901): 60px / 65px line-height /
            #1a1a1a / 683px measure / no tracking. V1 sets it in Romie, which
            we don't license — Petrona is the standing substitute. */}
        <h1
          className="max-w-[385px] text-[28px] leading-[28px] text-[#1a1a1a] sm:max-w-[683px] sm:text-[48px] sm:leading-[1.08] md:text-[60px] md:leading-[65px]"
          style={serifDisplay}
        >
          No more phone tag with mechanics
        </h1>

        {/* Subhead — V1 node 302:978: 18px / 25px / #777169 / 487px. */}
        {/* Mobile tracking: Inter sets the first sentence 344.5px wide at
            14px where Suisse (the frame's face) sets it ~328, so on the
            frame's 336 measure it broke to three lines. −0.25px brings it to
            ~331 — the frame's two lines, break after "nearby." — at 360, 390
            and 430 alike. Invisible at this size; drops away from sm. */}
        <p className="mt-[26px] max-w-[336px] text-[14px] leading-[16px] tracking-[-0.25px] text-[#777169] sm:mt-5 sm:max-w-[487px] sm:text-[18px] sm:leading-[25px] sm:tracking-normal">
          Talk to Oto. Get fixed prices from real shops nearby.
          <br /> Book in 90 seconds.
        </p>

        {/* Mobile only — the frame's 198×37 split pill (390:3183). Desktop
            has no store control in the hero. */}
        <PlatformPill size="sm" className="mt-4 sm:hidden" />
      </div>

      {/* Content stage. The orb is the centerpiece: large, and it sits BEHIND
          the translucent panels (which overlap its edges so it glows through). */}
      {/* The hero is a fixed composition like the Figma frame, not
          viewport-elastic: min-h-screen + centered content meant every extra
          pixel of screen height became air under the chips (2026-08-30 —
          "they got farther when I wanted them closer"). Natural height + this
          pb gives a constant chips → "Now onboarding" gap at every screen. */}
      {/* Mobile insets are the frame's: 27px sides (the 348-wide card), 99px
          from the pill down to the orb's crown (y 309 → 408), 41px from the
          idle bar's foot to the hero's end (811 → 852). */}
      <div
        className={`relative z-10 mx-auto flex w-full max-w-[1180px] flex-1 items-center justify-center px-[27px] pb-[41px] pt-[99px] sm:px-6 sm:pb-10 sm:pt-0 ${
          mobileConversation ? "max-sm:z-30" : ""
        }`}
      >
        <div className="relative flex w-full flex-col items-center justify-center gap-8 lg:flex-row lg:items-center lg:justify-center lg:gap-0">
          {/* LEFT — chat (translucent; overlaps the orb's left edge) */}
          {/* Panel sizing (design feedback 2026-09-03: "enlarge orb + chat
              boxes"): both flanking boxes go 380×460 → 440×530 from xl up.
              The lg band (1024–1279) keeps the 380 WIDTH because the stage
              row is as narrow as 976px at 1024 — with the bigger orb it fits
              only by deepening the layout overlap (negative margin) to 80px
              (lg:-mr-20); xl restores 64px. Against the 1.18× active orb the
              VISUAL overlap is ~113px at lg / ~97px at xl. Row math, xl:
              440 + 360 + 440 − 128 = 1112 ≤ 1132. lg: 380 + 360 + 380 − 160
              = 960 ≤ 976. The HEIGHT goes to 530 from lg, not xl: the row is
              lg:items-center, so a 460 row with the 425px active orb (plus
              its status pill) pushed the orb's crown 6px above the panel
              tops and to within ~8px of the subhead at the bob peak — the
              exact crowding the 08-24 pass shrank the orb for. 530 nests it
              ~28px below the panel tops at every lg+ width (review 09-03). */}
          {/* Hidden below sm — there the glass MobileHeroCard in the orb
              column IS the chat surface (transcript inside it). */}
          <AnimatePresence>
            {active && (
              <motion.div
                key="chat"
                {...slide(-1, 0.06)}
                className="relative z-10 order-2 hidden h-[420px] w-full shrink-0 sm:block sm:h-[460px] lg:order-1 lg:-mr-20 lg:h-[530px] lg:w-[380px] xl:-mr-16 xl:w-[440px]"
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
          {/* Below lg the stage stacks (orb first) with no row to centre in,
              so the active 1.18× scale grows the orb UPWARD out of its box —
              25px on a 280 box, 32px on 360 — and its 10px idle float adds
              to that. An active-only top margin (24/32px) absorbs it so the
              subhead→orb gap stays ≈24px static / ≈14px at the float peak,
              instead of the orb rim riding under "Book in 90 seconds."
              (review 09-03). lg+ rows are tall enough to centre it instead. */}
          {/* Below sm the column is full-width so the glass card can span the
              frame's 348, and the active margin is dropped: the mobile
              geometry is constant (the pill sits 99px above the orb, so the
              1.18× rise of ~22px + the 10px float never nears the subhead),
              and a state-dependent margin would jump the card. */}
          <div
            className={`order-1 flex w-full shrink-0 flex-col items-center transition-[margin-top] duration-500 ease-out sm:w-auto lg:order-2 ${
              active ? "relative z-0 sm:mt-8 lg:mt-0" : "relative z-10"
            }`}
          >
            {/* Orb box: 280 → 360 from sm (design feedback 2026-09-03, "enlarge
                orb"). 360 wide (340 tall) is what the 2026-08-24 pass shrank
                FROM because the subhead sat on the orb; the headline block's
                pb-6 (added 08-30) now keeps that 24px gap in the idle state at
                any orb size, and the active-state margin above covers the
                scaled orb, so the size can come back without the crowding.
                Below sm it is the frame's 247 (390:3181) — the active 1.18×
                (291px) still fits inside the 348 card it sits behind. */}
            {/* Below sm the orb stays put at the frame's 247 in every state
                (frames 1/6 idle, 7 engaged, 4 in conversation) — the glass
                card overlaps it from below and frosts it (design feedback
                2026-09-03: "not in the chat bar"). Only sm+ grows it. */}
            <motion.div
              animate={{ scale: active && !mobile ? 1.18 : 1 }}
              transition={{ type: "spring", stiffness: 140, damping: 20 }}
              className="h-[247px] w-[247px] sm:h-[360px] sm:w-[360px]"
            >
              <OtoOrb
                active={orbActive}
                getLevel={getOrbLevel}
                paused={!inView}
                className="h-full w-full"
              />
            </motion.div>

            {/* Mobile only, IDLE — the frame's 348×39 bar 117px under the orb
                (y 772 on a 408 orb; frames 1/6). No card until a message. */}
            {!active && (
              <VoiceBar
                variant="idle-mobile"
                onSend={oto.sendText}
                onMic={oto.startVoice}
                listening={oto.isSpeaking}
                className="mt-[117px] w-full sm:hidden"
              />
            )}

            {/* Mobile only, ENGAGED — the glass card at the frame's y 484,
                overlapping the 247 orb from 76px below its crown (frame 7:
                orb 408–655, card from 484 → 171px up from the orb's foot).
                In conversation (frame 4) the card is 579 tall and grows
                UPWARD over the blurred headline with its bottom edge fixed:
                card top 229 = 426px up from the orb's foot. The status pill
                lives in the header, left of the waveform glyph. */}
            {active && (
              <motion.div
                key="mobile-card"
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                className={`relative z-10 w-full transition-[margin-top] duration-[450ms] ease-out sm:hidden ${
                  mobileConversation ? "-mt-[426px]" : "-mt-[171px]"
                }`}
              >
                <MobileHeroCard
                  messages={oto.messages}
                  thinking={oto.thinking}
                  listening={oto.isSpeaking}
                  onSend={oto.sendText}
                  onMic={oto.startVoice}
                  canvas={hasCard ? renderRightCard() : null}
                  conversationTitle={
                    oto.step === "confirmed" ? "Oto booked your appointment" : "Talk to Oto"
                  }
                  status={
                    <StatusPill
                      oto={oto}
                      className={
                        mobileConversation
                          ? "absolute right-[17px] top-[15px]"
                          : "absolute right-[60px] top-[24px]"
                      }
                    />
                  }
                />
              </motion.div>
            )}

            {active && <StatusPill oto={oto} className="mt-5 hidden h-7 sm:block" />}

            <AnimatePresence>
              {!active && (
                <motion.div
                  key="intro-controls"
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -14, transition: { duration: 0.25 } }}
                  transition={{ duration: 0.5, delay: 0.1 }}
                  className="mt-4 hidden w-full flex-col items-center sm:flex"
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
                className="relative z-10 order-3 flex w-full shrink-0 items-center justify-center max-sm:hidden lg:order-3 lg:-ml-20 lg:h-[530px] lg:w-[380px] xl:-ml-16 xl:w-[440px]"
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

      {/* (Scroll cue removed 2026-08-30 — it floated alone in the hero's tail
          and read as a stray mark rather than a hint.) */}
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
