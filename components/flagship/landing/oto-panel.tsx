"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlignLeft,
  ArrowLeft,
  ArrowUp,
  Calendar,
  Car,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Disc,
  Droplet,
  FileText,
  Info,
  Mic,
  Pencil,
  Plus,
  RotateCw,
  SquarePen,
  Star,
  ThumbsDown,
  ThumbsUp,
  Volume2,
  Wrench,
  X,
} from "lucide-react";
import PhoneFrame from "./phone-frame";

const EASE = [0.22, 1, 0.36, 1] as const;

/* Palette from otopair-1: BrandColors + the ai-chat surface grays. */
const C = {
  blue: "#5299FE",
  ink: "#141C24",
  border: "#E5E7EB",
  meta: "#6B7280",
  dim: "#9CA3AF",
  body: "#374151",
  sheet: "#EDF2FA",
  green: "#10B981",
};

/* The story: voice symptom → Oto asks the narrowing question (quick-reply
   chips) → checks the car's own records → plain-English diagnosis → the
   real 5-step BookService wizard → Book & Pay hands off to the dedicated
   Review & Pay screen → paid → back in chat, booked. */
type OtoPhase =
  | "greet"
  | "listen"
  | "sent"
  | "reply"
  | "chips"
  | "pick"
  | "think"
  | "diag"
  | "s1"
  | "s2"
  | "s3"
  | "s4"
  | "s4pick"
  | "s5"
  | "pay"
  | "payscreen"
  | "gpay"
  | "success"
  | "receipt";

const OTO_ORDER: OtoPhase[] = [
  "greet",
  "listen",
  "sent",
  "reply",
  "chips",
  "pick",
  "think",
  "diag",
  "s1",
  "s2",
  "s3",
  "s4",
  "s4pick",
  "s5",
  "pay",
  "payscreen",
  "gpay",
  "success",
  "receipt",
];

const OTO_SEQ: [OtoPhase, number][] = [
  ["listen", 2200],
  ["sent", 4600],
  ["reply", 5500],
  ["chips", 7300],
  ["pick", 9100],
  ["think", 9900],
  ["diag", 12100],
  ["s1", 15100],
  ["s2", 17900],
  ["s3", 20100],
  ["s4", 22900],
  ["s4pick", 24300],
  ["s5", 25700],
  ["pay", 28300],
  ["payscreen", 28900],
  ["gpay", 31200],
  ["success", 31900],
  ["receipt", 34500],
];
const OTO_LOOP_MS = 37700; // loop length — mirrored in STORY_MS (price-lock-section)

const OTO_CAPTIONS: Record<OtoPhase, string> = {
  greet: "Meet Oto — your car's concierge.",
  listen: "Say it like you'd tell a friend.",
  sent: "Say it like you'd tell a friend.",
  reply: "It narrows it down like a real tech.",
  chips: "It narrows it down like a real tech.",
  pick: "It narrows it down like a real tech.",
  think: "Checked against your car's own records.",
  diag: "Checked against your car's own records.",
  s1: "Diagnosis to booking, one chat.",
  s2: "Diagnosis to booking, one chat.",
  s3: "Real mechanics. Oto picks the fit.",
  s4: "Live slots — tap to reserve.",
  s4pick: "Live slots — tap to reserve.",
  s5: "Every detail confirmed before you pay.",
  pay: "Every detail confirmed before you pay.",
  payscreen: "A locked price. A $20 hold — that's it.",
  gpay: "A locked price. A $20 hold — that's it.",
  success: "Booked in about 90 seconds.",
  receipt: "Booked in about 90 seconds.",
};

/** The 14-spoke spinning starburst thinking indicator (AITypingIndicator). */
function Starburst({ spin }: { spin: boolean }) {
  return (
    <motion.svg
      width="12"
      height="12"
      viewBox="0 0 28 28"
      animate={spin ? { rotate: 360, scale: [1, 1.12, 1] } : undefined}
      transition={{
        rotate: { duration: 2.4, ease: "linear", repeat: Infinity },
        scale: { duration: 1.2, ease: "easeInOut", repeat: Infinity },
      }}
      aria-hidden
    >
      {Array.from({ length: 14 }, (_, i) => {
        const a = (i / 14) * Math.PI * 2;
        return (
          <line
            key={i}
            x1={14 + Math.cos(a) * 6}
            y1={14 + Math.sin(a) * 6}
            x2={14 + Math.cos(a) * 12}
            y2={14 + Math.sin(a) * 12}
            stroke={C.blue}
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        );
      })}
    </motion.svg>
  );
}

/** Voice-recording strip (AIInputBox recording state). */
function VoiceStrip({ animate }: { animate: boolean }) {
  return (
    <div
      className="flex items-center gap-1.5 rounded-[13px] border-[1.5px] px-2 py-1.5"
      style={{ backgroundColor: "#EEF2FF", borderColor: C.blue }}
    >
      <span className="flex h-[14px] items-center gap-[2px]">
        {[6, 10, 14, 9, 12, 7, 13, 10, 6, 11, 8, 12].map((h, i) => (
          <motion.span
            key={i}
            className="w-[2px] rounded-full"
            style={{ backgroundColor: C.blue, height: h * 0.8 }}
            animate={animate ? { scaleY: [1, 0.45, 1] } : undefined}
            transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.07, ease: "easeInOut" }}
          />
        ))}
      </span>
      <span className="flex-1 text-[6.5px]" style={{ color: C.meta }}>
        Release to send
      </span>
      <span
        className="flex h-4 w-4 items-center justify-center rounded-full"
        style={{ backgroundColor: C.blue }}
      >
        <ArrowUp className="h-2.5 w-2.5 text-white" strokeWidth={2.5} />
      </span>
    </div>
  );
}

/** Idle glass input bar: "Ask Oto" + plus + mic. */
function InputBar() {
  return (
    <div
      className="flex items-center gap-1.5 rounded-[13px] border px-2 py-1.5"
      style={{ backgroundColor: "rgba(255,255,255,0.7)", borderColor: "rgba(0,0,0,0.06)" }}
    >
      <span className="flex-1 text-[7px]" style={{ color: C.dim }}>
        Ask Oto
      </span>
      <Plus className="h-3 w-3" style={{ color: "rgba(0,0,0,0.4)" }} strokeWidth={2} />
      <Mic className="h-3 w-3" style={{ color: "rgba(0,0,0,0.4)" }} strokeWidth={2} />
    </div>
  );
}

/** copy · speak · 👍 · 👎 under every Oto turn (ai-chat action row). */
function ActionRow() {
  return (
    <span className="mt-1 flex items-center gap-2">
      <Copy className="h-[7px] w-[7px]" style={{ color: C.dim }} strokeWidth={2} />
      <Volume2 className="h-[7px] w-[7px]" style={{ color: C.dim }} strokeWidth={2} />
      <ThumbsUp className="h-[7px] w-[7px]" style={{ color: C.dim }} strokeWidth={2} />
      <ThumbsDown className="h-[7px] w-[7px]" style={{ color: C.dim }} strokeWidth={2} />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Wizard sheet — the real 5-step BookServiceComponent                 */
/* ------------------------------------------------------------------ */

function SheetHeader({
  title,
  sub,
  back,
}: {
  title: string;
  sub?: string;
  back?: boolean;
}) {
  return (
    <div className="relative px-2 pt-2 text-center">
      {back && (
        <ArrowLeft className="absolute left-2 top-2 h-2.5 w-2.5" style={{ color: C.meta }} />
      )}
      <X className="absolute right-2 top-2 h-2.5 w-2.5" style={{ color: C.meta }} />
      <span className="block text-[7.5px] font-semibold" style={{ color: C.ink }}>
        {title}
      </span>
      {sub && (
        <span className="block text-[5.5px]" style={{ color: C.meta }}>
          {sub}
        </span>
      )}
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    <div className="px-2 pt-1">
      <span className="text-[5.5px] font-medium" style={{ color: C.ink }}>
        Step {step} of 5
      </span>
      <div
        className="mt-0.5 h-[2.5px] overflow-hidden rounded-full"
        style={{ backgroundColor: "rgba(0,0,0,0.08)" }}
      >
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: C.blue }}
          initial={false}
          animate={{ width: `${step * 20}%` }}
          transition={{ duration: 0.5, ease: EASE }}
        />
      </div>
    </div>
  );
}

function SheetDesc({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 pt-1 text-[5.8px] leading-snug" style={{ color: C.meta }}>
      {children}
    </p>
  );
}

function SheetCta({
  label,
  disabled = false,
  pressed = false,
}: {
  label: string;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <div className="px-2 pb-2 pt-1">
      <span className="relative block">
        <motion.span
          className="block rounded-full py-1 text-center text-[6.5px] font-semibold"
          style={
            disabled
              ? { backgroundColor: "#E2E8F0", color: "#94A3B8" }
              : { backgroundColor: C.blue, color: "#fff" }
          }
          animate={{ scale: pressed ? 0.94 : 1 }}
          transition={{ duration: 0.18, ease: EASE }}
        >
          {label}
        </motion.span>
        {pressed && (
          <motion.span
            className="pointer-events-none absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#1a1a1a]/15"
            initial={{ scale: 0.3, opacity: 0.6 }}
            animate={{ scale: 2.2, opacity: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          />
        )}
      </span>
    </div>
  );
}

function ServiceRow({
  icon: IconCmp,
  name,
  desc,
  mins,
  selected = false,
}: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties; strokeWidth?: number }>;
  name: string;
  desc: string;
  mins: string;
  selected?: boolean;
}) {
  return (
    <div
      className="flex items-center gap-1.5 rounded-[8px] border p-1.5"
      style={
        selected
          ? { borderColor: C.blue, backgroundColor: "#EAF2FF" }
          : { borderColor: C.border, backgroundColor: "#fff" }
      }
    >
      <span
        className="flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-full"
        style={{ backgroundColor: "#5299FE1A" }}
      >
        <IconCmp className="h-[7px] w-[7px]" style={{ color: C.blue }} strokeWidth={2} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-[6.8px] font-semibold"
          style={{ color: selected ? C.blue : C.ink }}
        >
          {name}
        </span>
        <span className="block truncate text-[5.8px]" style={{ color: C.meta }}>
          {desc}
        </span>
      </span>
      <span className="text-[5.8px]" style={{ color: C.meta }}>
        {mins}
      </span>
      <span
        className="flex h-[10px] w-[10px] shrink-0 items-center justify-center rounded-full border"
        style={
          selected ? { backgroundColor: C.blue, borderColor: C.blue } : { borderColor: "#D1D5DB" }
        }
      >
        {selected && <Check className="h-[6px] w-[6px] text-white" strokeWidth={3} />}
      </span>
    </div>
  );
}

function MechanicRow({
  initials,
  name,
  shop,
  meta,
  pick = false,
}: {
  initials: string;
  name: string;
  shop: string;
  meta: string;
  pick?: boolean;
}) {
  return (
    <div
      className="relative flex items-center gap-1.5 rounded-[8px] border p-1.5"
      style={
        pick
          ? { borderColor: C.blue, backgroundColor: "#EAF2FF" }
          : { borderColor: C.border, backgroundColor: "#fff" }
      }
    >
      {pick && (
        <span
          className="absolute -top-1.5 right-1.5 flex items-center gap-0.5 rounded-full border px-1 py-[1px] text-[5px] font-semibold"
          style={{ backgroundColor: "#FEF3C7", borderColor: "#FACC15", color: "#92400E" }}
        >
          <Star className="h-[4.5px] w-[4.5px] fill-[#F59E0B] text-[#F59E0B]" />
          Oto&apos;s Pick
        </span>
      )}
      <span
        className="flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full text-[5.5px] font-semibold"
        style={{ backgroundColor: "#5299FE1A", color: C.blue }}
      >
        {initials}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[6.8px] font-semibold" style={{ color: C.ink }}>
          {name}
        </span>
        <span className="block truncate text-[5.8px]" style={{ color: C.body }}>
          {shop}
        </span>
        <span className="flex items-center gap-0.5 text-[5.3px]" style={{ color: C.meta }}>
          <Star className="h-[4.5px] w-[4.5px] fill-[#F59E0B] text-[#F59E0B]" />
          {meta}
        </span>
      </span>
      <span
        className="flex h-[10px] w-[10px] shrink-0 items-center justify-center rounded-full border"
        style={pick ? { backgroundColor: C.blue, borderColor: C.blue } : { borderColor: "#D1D5DB" }}
      >
        {pick && <Check className="h-[6px] w-[6px] text-white" strokeWidth={3} />}
      </span>
    </div>
  );
}

function TimeChip({ label, on = false }: { label: string; on?: boolean }) {
  return (
    <span
      className="flex items-center justify-center gap-0.5 rounded-[6px] border py-[3px] text-[5.5px] font-medium"
      style={
        on
          ? { backgroundColor: C.blue, borderColor: C.blue, color: "#fff" }
          : { backgroundColor: "#fff", borderColor: C.border, color: C.body }
      }
    >
      <Clock className="h-[5px] w-[5px]" style={{ color: on ? "#fff" : C.dim }} strokeWidth={2} />
      {label}
    </span>
  );
}

/** The 5-step wizard sheet. Step content cross-fades inside a fixed shell. */
function WizardSheet({ step, paying }: { step: 1 | 2 | 3 | 4 | 5; paying: boolean }) {
  const timePicked = step >= 5 || paying;
  return (
    <div
      className="overflow-hidden rounded-[10px] shadow-[0_4px_14px_rgba(20,40,80,0.08)]"
      style={{ backgroundColor: C.sheet }}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={step}
          initial={{ opacity: 0, x: 14 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -14 }}
          transition={{ duration: 0.28, ease: EASE }}
        >
          {step === 1 && (
            <>
              <SheetHeader title="Select services" />
              <Stepper step={1} />
              <SheetDesc>Pre-checked from our chat. Add anything that should ride along — bundling saves a shop trip.</SheetDesc>
              <div className="space-y-1 px-2 pt-1.5">
                <ServiceRow icon={Disc} name="Brake Inspection" desc="Pads, rotors & fluid check" mins="30 min" selected />
                <ServiceRow icon={Wrench} name="Front Brake Pads" desc="If the inspection calls for it" mins="60 min" />
                <ServiceRow icon={Droplet} name="Oil Change" desc="Full synthetic oil & filter" mins="30 min" />
                <ServiceRow icon={RotateCw} name="Tire Rotation" desc="Rotate tires for even wear" mins="30 min" />
              </div>
              <SheetCta label="Continue with 1 service" />
            </>
          )}

          {step === 2 && (
            <>
              <SheetHeader title="Service options" sub="1 service selected" back />
              <Stepper step={2} />
              <SheetDesc>Standard parts and labor by default — the mechanic confirms specifics at drop-off.</SheetDesc>
              <div className="px-2 pt-1.5">
                <div className="rounded-[8px] bg-white p-1.5">
                  <span className="block text-[6.8px] font-semibold" style={{ color: C.ink }}>
                    Brake Inspection
                  </span>
                  <span className="block text-[5.8px]" style={{ color: C.meta }}>
                    Standard · ~30 min
                  </span>
                </div>
              </div>
              <SheetCta label="Continue to next step" />
            </>
          )}

          {step === 3 && (
            <>
              <SheetHeader title="Choose a mechanic" sub="Brake work · specialists first" back />
              <Stepper step={3} />
              <div className="flex gap-1 px-2 pt-1.5">
                {["Closest", "Best rated", "Best price"].map((f) => (
                  <span
                    key={f}
                    className="rounded-full border px-1.5 py-[2px] text-[5.5px] font-medium"
                    style={
                      f === "Best rated"
                        ? { borderColor: C.blue, color: C.blue, backgroundColor: "#EAF2FF" }
                        : { borderColor: C.border, color: C.meta, backgroundColor: "#fff" }
                    }
                  >
                    {f}
                  </span>
                ))}
              </div>
              <div className="space-y-1.5 px-2 pt-1.5">
                <MechanicRow initials="MT" name="Marcus T." shop="Eltingville Auto Care" meta="4.9 (127) · 0.8 mi" pick />
                <MechanicRow initials="JR" name="Joe R." shop="Port Richmond Service" meta="4.7 (89) · 1.6 mi" />
                <MechanicRow initials="SV" name="Sam V." shop="Victory Blvd Motors" meta="4.6 (54) · 2.1 mi" />
              </div>
              <SheetCta label="Continue with Marcus" />
            </>
          )}

          {step === 4 && (
            <>
              <SheetHeader title="Pick a time" sub="Mechanic: Marcus T." back />
              <Stepper step={4} />
              <SheetDesc>Tap a time to reserve it. Shorter slots come up first.</SheetDesc>
              <span className="block px-2 pt-1 text-[5.5px] font-semibold tracking-wide" style={{ color: C.ink }}>
                TOMORROW
              </span>
              <div className="grid grid-cols-4 gap-1 px-2 pt-1">
                {["8:00 AM", "8:15 AM", "8:30 AM", "8:45 AM", "9:00 AM", "9:15 AM", "9:30 AM", "9:45 AM"].map(
                  (t) => (
                    <TimeChip key={t} label={t} on={timePicked && t === "8:15 AM"} />
                  ),
                )}
              </div>
              <SheetCta label={timePicked ? "Continue" : "Pick a time"} disabled={!timePicked} />
            </>
          )}

          {step === 5 && (
            <>
              <SheetHeader title="Review & book" sub="Final review" back />
              <Stepper step={5} />
              <SheetDesc>Tap any row to edit. Payment confirms on the next screen.</SheetDesc>
              <div className="space-y-1 px-2 pt-1.5">
                <div className="rounded-[8px] bg-white p-1.5">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="flex h-[15px] w-[15px] items-center justify-center rounded-full"
                      style={{ backgroundColor: "#5299FE1A" }}
                    >
                      <Wrench className="h-[7px] w-[7px]" style={{ color: C.blue }} />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[6.8px] font-semibold" style={{ color: C.ink }}>
                        Eltingville Auto Care
                      </span>
                      <span className="block text-[5.8px]" style={{ color: C.meta }}>
                        with Marcus T.
                      </span>
                    </span>
                  </div>
                  <div className="my-1 border-t" style={{ borderColor: C.border }} />
                  <span className="flex items-center gap-1 text-[5.8px]" style={{ color: C.body }}>
                    <Calendar className="h-[6.5px] w-[6.5px]" style={{ color: C.blue }} />
                    Tomorrow at 8:15 AM
                  </span>
                </div>
                {/* Services only — the old "Labor rate $150/hr (shop posted)"
                    row is gone with the rest of the rate math (design
                    feedback 2026-08-31): no per-hour numbers anywhere on the
                    marketing page. The footnote below carries the lock
                    message. */}
                <div className="rounded-[8px] bg-white p-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[5.3px] uppercase tracking-wide" style={{ color: C.dim }}>
                      Services
                    </span>
                    <span className="flex items-center gap-1 text-[5.8px] font-medium" style={{ color: C.ink }}>
                      Brake Inspection
                      <Pencil className="h-[5px] w-[5px]" style={{ color: C.dim }} />
                    </span>
                  </div>
                </div>
                <p className="px-0.5 text-[5px] leading-snug" style={{ color: C.dim }}>
                  Your price locks on the next screen — before you pay.
                </p>
              </div>
              <SheetCta label="Book & Pay" pressed={paying} />
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Review & Pay — the dedicated secure screen the app navigates to     */
/* ------------------------------------------------------------------ */

function BreakdownRow({ k, v, sub = false }: { k: string; v: string; sub?: boolean }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[5.8px]" style={{ color: sub ? C.meta : C.ink, fontWeight: sub ? 400 : 600 }}>
        {k}
      </span>
      <span className="text-[5.8px]" style={{ color: sub ? C.meta : C.ink, fontWeight: sub ? 400 : 600 }}>
        {v}
      </span>
    </div>
  );
}

/** ~16-particle center burst, deterministic offsets (confirmation.tsx vibe). */
const CONFETTI = [
  { dx: -26, dy: -34, c: "#5299FE", d: 0.0 },
  { dx: 22, dy: -40, c: "#F59E0B", d: 0.05 },
  { dx: 38, dy: -18, c: "#10B981", d: 0.1 },
  { dx: -38, dy: -12, c: "#EF4444", d: 0.02 },
  { dx: 30, dy: 14, c: "#8B5CF6", d: 0.12 },
  { dx: -30, dy: 20, c: "#F59E0B", d: 0.08 },
  { dx: 10, dy: -46, c: "#EF4444", d: 0.14 },
  { dx: -12, dy: -44, c: "#10B981", d: 0.04 },
  { dx: 44, dy: -4, c: "#5299FE", d: 0.16 },
  { dx: -44, dy: 4, c: "#8B5CF6", d: 0.06 },
  { dx: 18, dy: 30, c: "#5299FE", d: 0.18 },
  { dx: -20, dy: 28, c: "#F59E0B", d: 0.1 },
  { dx: 4, dy: 38, c: "#10B981", d: 0.2 },
  { dx: -6, dy: -30, c: "#5299FE", d: 0.03 },
  { dx: 34, dy: -30, c: "#8B5CF6", d: 0.07 },
  { dx: -34, dy: -26, c: "#EF4444", d: 0.11 },
];

function SuccessOverlay({ reduce }: { reduce: boolean }) {
  return (
    <motion.div
      className="absolute inset-0 z-10 flex flex-col items-center justify-center"
      style={{ backgroundColor: "#f5f5f7" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
    >
      <span className="relative flex h-14 w-14 items-center justify-center">
        {!reduce &&
          CONFETTI.map((p, i) => (
            <motion.span
              key={i}
              className="absolute left-1/2 top-1/2 h-[3px] w-[3px] rounded-full"
              style={{ backgroundColor: p.c }}
              initial={{ x: 0, y: 0, scale: 0, opacity: 0 }}
              animate={{ x: p.dx, y: [0, p.dy, p.dy + 14], scale: [0, 1, 0.6], opacity: [0, 1, 0], rotate: 300 }}
              transition={{ duration: 1.3, delay: p.d, ease: "easeOut" }}
            />
          ))}
        <motion.span
          className="flex h-9 w-9 items-center justify-center rounded-full shadow-[0_4px_8px_rgba(0,0,0,0.12)]"
          style={{ backgroundColor: C.green }}
          initial={reduce ? { scale: 1 } : { scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 150, damping: 12 }}
        >
          <motion.span
            initial={reduce ? { scale: 1 } : { scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 120, damping: 10, delay: reduce ? 0 : 0.3 }}
          >
            <Check className="h-5 w-5 text-white" strokeWidth={3} />
          </motion.span>
        </motion.span>
      </span>
      <motion.span
        className="mt-2 text-[9.5px] font-extrabold"
        style={{ color: C.ink }}
        initial={reduce ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: reduce ? 0 : 0.45 }}
      >
        You&apos;re all set!
      </motion.span>
      <motion.span
        className="mt-0.5 text-[6px]"
        style={{ color: C.meta }}
        initial={reduce ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: reduce ? 0 : 0.58 }}
      >
        Tomorrow 8:15 AM · Eltingville Auto Care
      </motion.span>
    </motion.div>
  );
}

function PayScreen({ pressing, success, reduce }: { pressing: boolean; success: boolean; reduce: boolean }) {
  return (
    <div className="relative flex h-full flex-col" style={{ backgroundColor: "#f5f5f7" }}>
      {/* Header */}
      <div className="flex items-center gap-1.5 px-2.5 pt-[26px]">
        <span className="flex h-[15px] w-[15px] items-center justify-center rounded-full bg-white shadow-sm">
          <ArrowLeft className="h-[8px] w-[8px]" style={{ color: C.ink }} />
        </span>
        <span className="flex-1 text-center text-[8px] font-bold" style={{ color: C.ink }}>
          Review &amp; Pay
        </span>
        <span className="w-[15px]" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 px-2.5 pt-1.5">
        {/* Who / when / what */}
        <div className="rounded-[9px] bg-white p-1.5 shadow-[0_1px_5px_rgba(0,0,0,0.05)]">
          <div className="flex items-center gap-1.5">
            <span className="relative">
              <span
                className="flex h-[16px] w-[16px] items-center justify-center rounded-full text-[5.5px] font-bold"
                style={{ backgroundColor: "#E9EEF5", color: C.ink }}
              >
                MT
              </span>
              <span
                className="absolute -bottom-1 -left-1 flex items-center gap-[1px] rounded-full bg-black px-[3px] py-[0.5px] text-[4.5px] font-bold text-white"
              >
                <Star className="h-[4px] w-[4px] fill-[#F59E0B] text-[#F59E0B]" />
                4.9
              </span>
            </span>
            <span className="min-w-0">
              <span className="block text-[7px] font-bold" style={{ color: C.ink }}>
                Marcus T.
              </span>
              <span className="block text-[5.8px]" style={{ color: C.meta }}>
                Eltingville Auto Care
              </span>
            </span>
          </div>
          <div className="my-1 border-t" style={{ borderColor: "rgba(0,0,0,0.06)" }} />
          <span className="block text-[5px] font-bold uppercase tracking-wide" style={{ color: C.blue }}>
            Appointment
          </span>
          <span className="mt-[1px] flex items-center gap-1 text-[5.8px]" style={{ color: C.body }}>
            <Calendar className="h-[6px] w-[6px]" style={{ color: C.meta }} />
            Tomorrow · 8:15 AM
          </span>
          <span className="mt-1 block text-[5px] font-bold uppercase tracking-wide" style={{ color: C.blue }}>
            Vehicle
          </span>
          <span className="mt-[1px] flex items-center gap-1 text-[5.8px]" style={{ color: C.body }}>
            <Car className="h-[6px] w-[6px]" style={{ color: C.meta }} />
            2020 BMW M2 CS
          </span>
        </div>

        {/* Service breakdown */}
        <div className="rounded-[9px] bg-white p-1.5 shadow-[0_1px_5px_rgba(0,0,0,0.05)]">
          <div className="flex items-center justify-between">
            <span className="text-[6.8px] font-bold" style={{ color: C.ink }}>
              Service Breakdown
            </span>
            <FileText className="h-[7px] w-[7px]" style={{ color: C.meta }} />
          </div>
          <div className="my-1 border-t" style={{ borderColor: "rgba(0,0,0,0.06)" }} />
          {/* One flat line per service, one locked total. NO labor math, NO
              fee line, NO ranges: the internal pricing formula and the 7%
              service fee are locked-decision secrets (Aug 2026), and a range
              under a "Fixed" headline reads as a broken promise (site audit
              2026-08-31). Fees live folded inside the service price. */}
          <div className="space-y-[3px]">
            <BreakdownRow k="Brake Inspection" v="$85.00" />
            <BreakdownRow k="Taxes" v="$7.54" sub />
          </div>
          <div className="my-1 border-t" style={{ borderColor: "rgba(0,0,0,0.06)" }} />
          <span className="block text-[6.3px] font-bold" style={{ color: C.ink }}>
            Your locked price
          </span>
          <span className="block text-[9.5px] font-extrabold" style={{ color: C.blue }}>
            $92.54
          </span>
          <div
            className="mt-1 flex items-start gap-1 rounded-[6px] border p-1"
            style={{ backgroundColor: "#EAF2FE", borderColor: "#BFDBFE" }}
          >
            <Info className="mt-[1px] h-[6px] w-[6px] shrink-0" style={{ color: C.blue }} />
            <span className="text-[5px] leading-snug" style={{ color: "#334155" }}>
              A $20 hold today — charged only once your mechanic has inspected the car.
            </span>
          </div>
        </div>

        {/* Notes for the mechanic */}
        <div className="rounded-[9px] bg-white p-1.5 shadow-[0_1px_5px_rgba(0,0,0,0.05)]">
          <span className="flex items-center gap-1 text-[6.3px] font-bold" style={{ color: C.ink }}>
            <FileText className="h-[6px] w-[6px]" style={{ color: C.meta }} />
            Notes for the mechanic
          </span>
          <span className="mt-[1px] block text-[5.3px]" style={{ color: C.meta }}>
            Anything the mechanic should know before starting? (Optional)
          </span>
          <div
            className="mt-1 rounded-[6px] border p-1 text-[5.3px] leading-snug"
            style={{ borderColor: C.border, backgroundColor: "#FAFBFC", color: C.dim }}
          >
            e.g. wheel lock is in the glovebox
          </div>
        </div>
      </div>

      {/* Wallet-first footer, straight from the app's payment screen */}
      <div className="space-y-1 px-2.5 pb-2.5 pt-1">
        <span className="relative block">
          <motion.span
            className="block rounded-full bg-black py-[5px] text-center text-[7px] font-semibold text-white"
            animate={{ scale: pressing ? 0.95 : 1 }}
            transition={{ duration: 0.18, ease: EASE }}
          >
            <span className="font-bold">G</span> Pay
          </motion.span>
          {pressing && (
            <motion.span
              className="pointer-events-none absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/25"
              initial={{ scale: 0.3, opacity: 0.7 }}
              animate={{ scale: 2.4, opacity: 0 }}
              transition={{ duration: 0.5, ease: "easeOut" }}
            />
          )}
        </span>
        <span className="flex items-center justify-between rounded-full bg-white px-2 py-[4px] shadow-[0_1px_5px_rgba(0,0,0,0.05)]">
          <span className="flex items-center gap-1">
            <span
              className="rounded-[3px] border px-[3px] py-[1px] text-[4.5px] font-bold"
              style={{ borderColor: C.border, color: C.meta }}
            >
              CARD
            </span>
            <span className="text-[6px] font-medium" style={{ color: C.blue }}>
              Pay with card
            </span>
          </span>
          <ChevronRight className="h-[7px] w-[7px]" style={{ color: C.dim }} />
        </span>
      </div>

      <AnimatePresence>{success && <SuccessOverlay reduce={reduce} />}</AnimatePresence>
    </div>
  );
}

const pop = {
  initial: { opacity: 0, y: 10, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  transition: { type: "spring" as const, stiffness: 300, damping: 26 },
};

/** 03 — Oto: the real ai-chat screen (otopair-1 app/(main-tabs)/ai-chat),
 *  played as a story: voice intake → Oto recalls the oil change → records
 *  pull → the 5-step BookService wizard → Review & Pay screen → paid →
 *  booked receipt back in the chat. */
export default function OtoPanel({ active, reduce }: { active: boolean; reduce: boolean }) {
  const [phase, setPhase] = useState<OtoPhase>("greet");
  const idx = OTO_ORDER.indexOf(phase);
  const at = (p: OtoPhase) => idx >= OTO_ORDER.indexOf(p);

  useEffect(() => {
    setPhase("greet");
    if (!active || reduce) return;
    const timers: number[] = [];
    const run = () => {
      setPhase("greet");
      for (const [p, t] of OTO_SEQ) timers.push(window.setTimeout(() => setPhase(p), t));
      timers.push(window.setTimeout(run, OTO_LOOP_MS));
    };
    run();
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [active, reduce]);

  const caption = OTO_CAPTIONS[phase];

  const sheetStep: 1 | 2 | 3 | 4 | 5 = at("s5") ? 5 : at("s4") ? 4 : at("s3") ? 3 : at("s2") ? 2 : 1;
  const onPayScreen = at("payscreen") && !at("receipt");

  return (
    <div className="flex h-full w-full flex-col p-1">
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <motion.div
          className="origin-center scale-[0.68] select-none sm:scale-100 lg:scale-[1.16]"
          initial={false}
          animate={{ opacity: active ? 1 : 0, y: active || reduce ? 0 : 14 }}
          transition={{ duration: 0.5, ease: EASE }}
        >
          <PhoneFrame tab={3}>
            {/* ---- Chat screen (slides aside while paying) ---- */}
            <motion.div
              className="absolute inset-0"
              initial={false}
              animate={{ x: onPayScreen ? "-24%" : "0%" }}
              transition={{ duration: 0.45, ease: EASE }}
            >
              {/* ai-chat gradient */}
              <div
                className="absolute inset-0"
                style={{
                  background: "linear-gradient(180deg, #A5CDFF 0%, #D6E8FF 55%, #FFFFFF 100%)",
                }}
              />

              <div className="relative flex h-full flex-col px-2.5">
                {/* Header — hamburger + avatar | "Oto ▾" pill | compose */}
                <div className="flex items-center justify-between pt-[24px]">
                  <span className="flex items-center gap-1">
                    <AlignLeft className="h-3 w-3 text-black" strokeWidth={2} />
                    <span
                      className="flex h-[14px] w-[14px] items-center justify-center rounded-full bg-white/80 text-[6px] font-semibold"
                      style={{ color: C.ink }}
                    >
                      DR
                    </span>
                  </span>
                  <span className="flex items-center gap-0.5">
                    <span className="text-[8.5px] font-semibold text-black">Oto</span>
                    <ChevronDown className="h-2 w-2" style={{ color: "rgba(0,0,0,0.3)" }} />
                  </span>
                  <SquarePen className="h-3 w-3 text-black" strokeWidth={2} />
                </div>

                {/* Vehicle context chip */}
                <div
                  className="mt-1.5 flex items-center gap-1 self-center rounded-full px-2 py-0.5 shadow-sm backdrop-blur"
                  style={{ backgroundColor: "rgba(255,255,255,0.6)" }}
                >
                  <span
                    className="flex h-[9px] w-[9px] items-center justify-center rounded-full"
                    style={{ backgroundColor: "rgba(0,0,0,0.08)" }}
                  >
                    <Car className="h-[6px] w-[6px]" style={{ color: "rgba(0,0,0,0.55)" }} strokeWidth={2} />
                  </span>
                  <span className="text-[6px] font-medium" style={{ color: "rgba(0,0,0,0.7)" }}>
                    2020 BMW M2 CS
                  </span>
                </div>

                {/* Conversation — bottom-anchored like a live chat */}
                <div className="flex min-h-0 flex-1 flex-col justify-end gap-1.5 overflow-hidden pb-1.5">
                  {!at("sent") && (
                    <motion.p
                      className="mb-4 text-center text-[9px] font-semibold leading-snug text-black"
                      initial={false}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                    >
                      Hi, how can I help
                      <br />
                      with your M2 CS?
                    </motion.p>
                  )}

                  {at("sent") && !at("s1") && (
                    <motion.div {...pop} className="self-end">
                      <span
                        className="block max-w-[150px] px-2 py-1 text-[7px] leading-snug text-white"
                        style={{ backgroundColor: C.blue, borderRadius: "9px 7px 2px 9px" }}
                      >
                        My brakes squeal when it&apos;s cold out
                      </span>
                    </motion.div>
                  )}

                  {at("reply") && !at("s1") && (
                    <motion.div {...pop} className="max-w-[95%]">
                      <p className="text-[7px] leading-snug text-black">
                        Quick check — is it only when braking, or all the time?
                      </p>
                      <ActionRow />
                    </motion.div>
                  )}

                  {phase === "chips" && (
                    <motion.div {...pop} className="flex gap-1">
                      <span
                        className="rounded-[6px] border bg-white px-2 py-[3px] text-[6.5px] font-semibold"
                        style={{ borderColor: C.blue, color: C.blue }}
                      >
                        Only when braking
                      </span>
                      <span
                        className="rounded-[6px] border px-2 py-[3px] text-[6.5px] font-semibold"
                        style={{ borderColor: "#D1D5DB", color: "#4A5568" }}
                      >
                        All the time
                      </span>
                    </motion.div>
                  )}

                  {at("pick") && !at("receipt") && (
                    <motion.div {...pop} className="self-end">
                      <span
                        className="block px-2 py-1 text-[7px] leading-snug text-white"
                        style={{ backgroundColor: C.blue, borderRadius: "9px 7px 2px 9px" }}
                      >
                        Only when braking
                      </span>
                    </motion.div>
                  )}

                  {phase === "think" && (
                    <motion.div {...pop} className="flex items-center gap-1.5">
                      <Starburst spin={!reduce} />
                      <span className="text-[6.5px] font-medium text-black">
                        Checking your brake records
                      </span>
                    </motion.div>
                  )}

                  {at("diag") && !at("receipt") && (
                    <motion.div {...pop} className="max-w-[95%]">
                      <p className="text-[7px] leading-snug text-black">
                        Likely glazed pads — common in cold snaps. Your records show 60% pad life,
                        so nothing urgent. Let&apos;s get them inspected — here&apos;s the booking.
                      </p>
                      <ActionRow />
                    </motion.div>
                  )}

                  {/* The BookService wizard rides IN the conversation, like the
                      app's inline chat component — not an overlay. */}
                  {at("s1") && !at("receipt") && (
                    <motion.div {...pop}>
                      <WizardSheet step={sheetStep} paying={phase === "pay"} />
                    </motion.div>
                  )}

                  {at("receipt") && (
                    <>
                      <motion.div
                        {...pop}
                        className="flex items-center gap-1.5 rounded-[9px] border p-1.5"
                        style={{ backgroundColor: "rgba(255,255,255,0.65)", borderColor: "rgba(0,0,0,0.05)" }}
                      >
                        <span
                          className="flex h-[14px] w-[14px] items-center justify-center rounded-full"
                          style={{ backgroundColor: "#10B98122" }}
                        >
                          <Check className="h-[8px] w-[8px]" style={{ color: C.green }} strokeWidth={3} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[7px] font-semibold" style={{ color: "#2D3748" }}>
                            Booked — Brake Inspection
                          </span>
                          <span className="block text-[6px]" style={{ color: "#718096" }}>
                            Tomorrow 8:15 AM · Eltingville Auto Care
                          </span>
                        </span>
                        <ChevronRight className="h-2.5 w-2.5" style={{ color: C.dim }} />
                      </motion.div>
                      <motion.div {...pop} className="max-w-[95%]">
                        <p className="text-[7px] leading-snug text-black">
                          You&apos;re all set — Marcus knows what to listen for. I&apos;ll remind
                          you the day before.
                        </p>
                        <ActionRow />
                      </motion.div>
                    </>
                  )}
                </div>

                {/* Input area — clears the floating tab bar (its top sits ~44px
                    from the screen bottom: 10px inset + ~34px pill), so 50px of
                    padding leaves a visible gap instead of touching it. */}
                <div className="pb-[50px]">
                  {phase === "listen" ? <VoiceStrip animate={!reduce} /> : <InputBar />}
                </div>
              </div>

            </motion.div>

            {/* ---- Review & Pay screen (covers the tab bar, like the app) ---- */}
            <motion.div
              className="absolute inset-0 z-30"
              initial={false}
              animate={{ x: onPayScreen ? "0%" : "100%" }}
              transition={{ duration: 0.45, ease: EASE }}
              style={{ boxShadow: "-8px 0 24px rgba(20,40,80,0.15)" }}
            >
              <PayScreen pressing={phase === "gpay"} success={at("success") && !at("receipt")} reduce={reduce} />
            </motion.div>
          </PhoneFrame>
        </motion.div>
      </div>

      {/* Caption — pinned to the card bottom, same treatment as Shops */}
      {/* popLayout, not wait: "wait" empties the row for a full exit+enter
          cycle, so the subtitle blinks out between beats. The crossfade
          keeps a line on screen at all times, and `relative` gives the
          exiting chip something to pin to while it fades. */}
      <div className="relative flex h-8 shrink-0 items-center justify-center sm:h-9">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={caption}
            className="whitespace-nowrap rounded-full border-[0.5px] border-white/50 bg-white/20 px-5 py-1.5 text-[12px] tracking-[0.03em] text-[#1a1a1a] backdrop-blur-[35px] sm:text-[13px] lg:px-6 lg:py-2 lg:text-[13.5px]"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: active ? 1 : 0, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
            transition={{ duration: 0.35, ease: EASE }}
          >
            {caption}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}
