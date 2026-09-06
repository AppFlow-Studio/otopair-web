"use client";

/* eslint-disable react-hooks/set-state-in-effect -- archived as-was; see note below */

/*
 * ARCHIVED 2026-08-18 — mechanic-side "day in the shop" sim.
 *
 * This was the 02 panel of the price-lock section: the shop-owner POV
 * (mechanic dashboard -> all-mechanics schedule board -> booking rings in ->
 * mod-flag ack -> accept -> no-show backfill -> payout). Deepika's review and
 * AB agreed the customer-facing landing page should not show the mechanic
 * side of the product, so the live section now shows the customer booking
 * walkthrough from Figma V1 (node 302:1162) instead.
 *
 * Kept compiling so it can be lifted onto a future shop-facing page. Nothing
 * imports this module from the landing page.
 */

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bell } from "lucide-react";

const EASE = [0.22, 1, 0.36, 1] as const;

/* ============================ PANELS ============================== */

/* Light-theme values lifted from the shop portal (globals.css :root) —
   hardcoded so the marketing mock never flips with the site theme. */
const APP = {
  primary: "#5299fe",
  border: "#d6dade",
  fg: "#0f172a",
  muted: "#687076",
};

function MiniStat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-[10px] border bg-white px-2.5 py-2" style={{ borderColor: APP.border }}>
      <p className="text-[8px] font-medium uppercase tracking-[0.08em]" style={{ color: APP.muted }}>
        {label}
      </p>
      <p className="mt-0.5 text-[15px] font-semibold leading-none" style={{ color: APP.fg }}>
        {value}
      </p>
      <p className="mt-1 text-[8.5px]" style={{ color: APP.muted }}>
        {sub}
      </p>
    </div>
  );
}

function MiniJob({
  initials,
  avatarClass,
  time,
  pill,
  pillClass,
  customer,
  vehicle,
  service,
  minutes,
  action,
  primaryAction = false,
  pressed = false,
}: {
  initials: string;
  avatarClass: string;
  time: string;
  pill: string;
  pillClass: string;
  customer: string;
  vehicle: string;
  service: string;
  minutes: string;
  action: string;
  primaryAction?: boolean;
  pressed?: boolean;
}) {
  return (
    <div className="rounded-[10px] border bg-[#fbfcfd] p-2.5" style={{ borderColor: APP.border }}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <span
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold ${avatarClass}`}
          >
            {initials}
          </span>
          <div className="min-w-0">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-semibold" style={{ color: APP.fg }}>
                {time}
              </span>
              <span className={`rounded-full px-1.5 py-0.5 text-[7.5px] font-semibold ${pillClass}`}>
                {pill}
              </span>
            </span>
            <p className="mt-0.5 truncate text-[10px] font-medium" style={{ color: APP.fg }}>
              {customer}
            </p>
            <p className="truncate text-[9.5px]" style={{ color: APP.muted }}>
              {vehicle}
            </p>
            <p className="mt-1 truncate text-[9.5px]" style={{ color: APP.muted }}>
              {service}
            </p>
          </div>
        </div>
        <span className="shrink-0 text-[8.5px]" style={{ color: APP.muted }}>
          {minutes}
        </span>
      </div>
      <div className="relative mt-2 inline-flex">
        <motion.span
          className="inline-flex items-center rounded-[7px] px-2.5 py-1 text-[9px] font-medium"
          animate={{ scale: pressed ? 0.92 : 1 }}
          transition={{ duration: 0.18, ease: EASE }}
          style={
            primaryAction
              ? { backgroundColor: APP.primary, color: "#fff" }
              : { border: `1px solid ${APP.border}`, color: APP.muted, opacity: 0.8 }
          }
        >
          {action}
        </motion.span>
        {/* Tap ripple for the scripted "press" beat */}
        {pressed && (
          <motion.span
            className="pointer-events-none absolute left-1/2 top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#1a1a1a]/15"
            initial={{ scale: 0.3, opacity: 0.6 }}
            animate={{ scale: 2.1, opacity: 0 }}
            transition={{ duration: 0.55, ease: "easeOut" }}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The Shops story loop — a scripted day in the shop, owner's POV.     */
/* ------------------------------------------------------------------ */

type Phase =
  | "dash"
  | "board"
  | "ring"
  | "inbox"
  | "ack"
  | "acked"
  | "pressed"
  | "placed"
  | "lapse"
  | "noshow"
  | "backfill"
  | "payout";

const PHASE_ORDER: Phase[] = [
  "dash",
  "board",
  "ring",
  "inbox",
  "ack",
  "acked",
  "pressed",
  "placed",
  "lapse",
  "noshow",
  "backfill",
  "payout",
];

/* One selling point per beat — rendered as the caption under the window. */
const CAPTIONS: Record<Phase, string> = {
  dash: "Your mechanics run the day from one screen.",
  board: "You see every bay — live.",
  ring: "New jobs arrive booked and priced — no phone tag.",
  inbox: "New jobs arrive booked and priced — no phone tag.",
  ack: "Modified cars get flagged before you commit.",
  acked: "Modified cars get flagged before you commit.",
  pressed: "Accepted. Straight into an open bay.",
  placed: "Accepted. Straight into an open bay.",
  lapse: "The board recalculates as bays fill.",
  noshow: "No-show? The slot backfills instantly.",
  backfill: "No-show? The slot backfills instantly.",
  payout: "100% of your rate — paid within 24 hours.",
};

/* Calendar-block palettes, matching the app's booking-status colors. */
const BAY_STATUS = {
  confirmed: { bg: "rgb(219 234 255)", border: "rgb(147 197 254)", text: "rgb(82 153 254)" },
  in_progress: { bg: "rgb(236 253 245)", border: "rgb(110 231 183)", text: "rgb(5 150 105)" },
  completed: { bg: "rgb(241 245 249)", border: "rgb(203 213 225)", text: "rgb(100 116 139)" },
  noshow: { bg: "rgb(254 242 242)", border: "rgb(252 165 165)", text: "rgb(225 29 72)" },
} as const;

const BOARD_H = 280; // grid height in px
const BOARD_WIN = 240; // minutes shown: 9:00 AM → 1:00 PM

/** One booking block in a mechanic's column on the all-mechanics board. */
function BayBlock({
  col,
  from,
  mins,
  status,
  line1,
  line2,
  entering = false,
  highlight = false,
}: {
  col: number;
  from: number;
  mins: number;
  status: keyof typeof BAY_STATUS;
  line1: string;
  line2?: string;
  entering?: boolean;
  highlight?: boolean;
}) {
  const s = BAY_STATUS[status];
  return (
    <motion.div
      className="absolute z-[5] overflow-hidden rounded-[5px] border-l-2 px-1 py-0.5"
      style={{
        top: (from / BOARD_WIN) * BOARD_H,
        height: Math.max(16, (mins / BOARD_WIN) * BOARD_H - 2),
        left: `calc(36px + (100% - 36px) * ${col} / 4 + 2px)`,
        width: `calc((100% - 36px) / 4 - 5px)`,
        backgroundColor: s.bg,
        borderColor: s.border,
      }}
      initial={entering ? { opacity: 0, scale: 0.5, y: -10 } : false}
      animate={{
        opacity: 1,
        scale: 1,
        y: 0,
        boxShadow: highlight
          ? ["0 0 0 0 rgba(82,153,254,0.55)", "0 0 0 7px rgba(82,153,254,0)"]
          : "0 0 0 0 rgba(82,153,254,0)",
      }}
      exit={{ opacity: 0, scale: 0.85 }}
      transition={{
        type: "spring",
        stiffness: 320,
        damping: 24,
        boxShadow: { duration: 1.1, repeat: highlight ? 2 : 0 },
      }}
    >
      <p className="truncate text-[6.8px] font-semibold" style={{ color: s.text }}>
        {line1}
      </p>
      {line2 && (
        <p className="truncate text-[6.3px]" style={{ color: s.text, opacity: 0.85 }}>
          {line2}
        </p>
      )}
    </motion.div>
  );
}

const MECHANICS = [
  { ini: "DM", name: "Dean Martin" },
  { ini: "AS", name: "Anakin Skywalker" },
  { ini: "JB", name: "James Bond" },
  { ini: "LS", name: "Luke Skywalker" },
];

/** The owner's all-mechanics day board (the real /schedule "All Mechanics"
 *  view) — four columns, and every story overlay: bell + badge, incoming
 *  toast, booking details sheet, no-show backfill, payout bar. */
function AdminBoard({ phase, dateLabel }: { phase: Phase; dateLabel: string }) {
  const idx = PHASE_ORDER.indexOf(phase);
  const at = (p: Phase) => idx >= PHASE_ORDER.indexOf(p);
  const done = at("lapse"); // time has passed — morning jobs wrapped

  return (
    <div className="relative pb-3">
      {/* Portal topbar — just the bell, like the real app */}
      <div
        className="flex items-center justify-end border-b px-3 py-1.5"
        style={{ borderColor: `${APP.border}80` }}
      >
        <span className="relative">
          <motion.span
            className="block"
            animate={phase === "ring" ? { rotate: [0, -16, 12, -8, 4, 0] } : { rotate: 0 }}
            transition={{ duration: 0.7, ease: "easeInOut" }}
          >
            <Bell className="h-3 w-3" style={{ color: APP.muted }} strokeWidth={2} />
          </motion.span>
          <AnimatePresence>
            {at("ring") && !at("placed") && (
              <motion.span
                className="absolute -right-1 -top-1 flex h-2.5 w-2.5 items-center justify-center rounded-full bg-rose-500 text-[6px] font-bold text-white"
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                exit={{ scale: 0 }}
                transition={{ type: "spring", stiffness: 500, damping: 18 }}
              >
                1
              </motion.span>
            )}
          </AnimatePresence>

          {/* Notification popover — components/notifications/notification-popover.tsx
              + notification-card.tsx (incl. the mod-flag gate), miniaturized.
              Drops below the bell, exactly like the real `right-0 top-full` one. */}
          <AnimatePresence>
            {at("inbox") && !at("placed") && (
              <motion.div
                key="popover"
                className="absolute right-0 top-full z-40 mt-1 w-[242px] origin-top-right overflow-hidden rounded-[10px] border border-gray-200 bg-white text-left shadow-[0_16px_40px_rgba(15,23,42,0.22)]"
                initial={{ opacity: 0, y: -6, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.95 }}
                transition={{ type: "spring", stiffness: 320, damping: 26 }}
              >
                {/* Header */}
                <div className="flex items-center justify-between border-b border-gray-100 px-2.5 py-1.5">
                  <span className="text-[8.5px] font-semibold text-gray-900">Notifications</span>
                  <span className="text-[7px] font-medium text-gray-500">Mark all read</span>
                </div>
                {/* Summary strip */}
                <div className="border-b border-gray-100 px-2.5 py-1 text-[6.5px] text-gray-500">
                  1 to confirm
                </div>
                {/* Tabs */}
                <div className="flex items-center gap-0.5 border-b border-gray-100 px-1.5 py-1">
                  {["All", "Live", "To confirm", "Tire quotes", "Rotor quotes"].map((t, i) => (
                    <span
                      key={t}
                      className={`whitespace-nowrap rounded-md px-1.5 py-0.5 text-[6.5px] font-medium ${
                        i === 0 ? "bg-gray-100 text-gray-900" : "text-gray-500"
                      }`}
                    >
                      {t}
                    </span>
                  ))}
                </div>

                {/* The booking notification card */}
                <div className="relative px-2.5 py-2">
                  <span className="absolute left-1 top-3 h-1 w-1 rounded-full bg-blue-500" />
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[7.5px] font-semibold text-blue-600">New booking</span>
                    <span className="text-[6.5px] text-gray-400">just now</span>
                  </div>
                  <p className="mt-0.5 text-[8.5px] font-medium text-gray-900">R. Patel</p>
                  <p className="text-[7px] text-gray-500">2019 Honda CR-V · Front brakes + rotors</p>
                  <p className="mt-0.5 text-[7px] text-gray-600">
                    Tomorrow · 11:30 AM · <span className="font-medium text-gray-900">$248.00</span>
                  </p>

                  {/* Mod flag — gates the actions until acknowledged, like the real card */}
                  {!at("acked") ? (
                    <div className="mt-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5">
                      <p className="text-[6.5px] font-semibold uppercase tracking-wide text-amber-800">
                        ⚠ This vehicle is modified
                      </p>
                      <p className="mt-0.5 text-[6.5px] text-amber-900/90">
                        Aftermarket coilovers + big-brake kit up front.
                      </p>
                      <span className="relative mt-1 block">
                        <motion.span
                          className="block w-full rounded border border-amber-300 bg-white py-1 text-center text-[7px] font-semibold text-amber-800"
                          animate={{ scale: phase === "ack" ? 0.95 : 1 }}
                          transition={{ duration: 0.18, ease: EASE }}
                        >
                          Tap to acknowledge
                        </motion.span>
                        {phase === "ack" && (
                          <motion.span
                            className="pointer-events-none absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#1a1a1a]/15"
                            initial={{ scale: 0.3, opacity: 0.6 }}
                            animate={{ scale: 2.2, opacity: 0 }}
                            transition={{ duration: 0.5, ease: "easeOut" }}
                          />
                        )}
                      </span>
                    </div>
                  ) : (
                    <div className="mt-1.5 flex items-center justify-between rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5">
                      <span className="text-[6px] font-semibold uppercase tracking-wide text-amber-800">
                        ⚠ Vehicle modified
                      </span>
                      <span className="text-[6px] font-medium text-amber-700">View</span>
                    </div>
                  )}

                  {/* Actions appear once the mod flag is acknowledged */}
                  {at("acked") && (
                    <motion.div
                      className="mt-1.5 flex items-center gap-1.5"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.25, ease: EASE }}
                    >
                      <span className="relative">
                        <motion.span
                          className="inline-flex rounded-md bg-green-600 px-2 py-1 text-[7px] font-semibold text-white"
                          animate={{ scale: phase === "pressed" ? 0.92 : 1 }}
                          transition={{ duration: 0.18, ease: EASE }}
                        >
                          Accept
                        </motion.span>
                        {phase === "pressed" && (
                          <motion.span
                            className="pointer-events-none absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#1a1a1a]/15"
                            initial={{ scale: 0.3, opacity: 0.6 }}
                            animate={{ scale: 2.2, opacity: 0 }}
                            transition={{ duration: 0.5, ease: "easeOut" }}
                          />
                        )}
                      </span>
                      <span className="inline-flex rounded-md border border-gray-200 bg-white px-2 py-1 text-[7px] font-medium text-gray-700">
                        Decline
                      </span>
                      <span className="ml-auto text-[7px] font-medium text-gray-600">Details</span>
                    </motion.div>
                  )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between border-t border-gray-100 bg-gray-50 px-2.5 py-1">
                  <span className="text-[6.5px] font-medium text-gray-700">View all bookings</span>
                  <span className="text-[6.5px] font-medium text-gray-500">Notification settings</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </span>
      </div>

      <div className="px-4 pt-2">
        <p className="text-[13px] font-bold tracking-tight" style={{ color: APP.fg }}>
          Schedule
        </p>
      </div>

      {/* Toolbar — Today / date, All Mechanics, Day|Week|Month */}
      <div
        className="mx-4 mt-2 flex items-center justify-between gap-1.5 rounded-[9px] border bg-white px-2 py-1.5"
        style={{ borderColor: APP.border }}
      >
        <span className="flex min-w-0 items-center gap-1">
          <span
            className="shrink-0 rounded-[6px] border px-1.5 py-0.5 text-[7.5px] font-medium"
            style={{ borderColor: APP.border, color: APP.fg }}
          >
            Today
          </span>
          <span className="shrink-0 text-[8.5px]" style={{ color: APP.muted }}>
            ‹ ›
          </span>
          <span className="truncate text-[8px] font-semibold" style={{ color: APP.fg }}>
            {dateLabel}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <span
            className="rounded-[6px] border px-1.5 py-0.5 text-[7.5px] font-medium"
            style={{ borderColor: APP.border, color: APP.fg }}
          >
            All Mechanics ⌄
          </span>
          <span
            className="flex overflow-hidden rounded-[6px] border text-[7.5px]"
            style={{ borderColor: APP.border }}
          >
            <span className="px-1 py-0.5 font-medium text-white" style={{ backgroundColor: APP.primary }}>
              Day
            </span>
            <span className="px-1 py-0.5" style={{ color: APP.muted }}>
              Week
            </span>
            <span className="px-1 py-0.5" style={{ color: APP.muted }}>
              Month
            </span>
          </span>
        </span>
      </div>

      {/* Column headers — one ringed avatar per mechanic */}
      <div
        className="mx-4 mt-2 flex rounded-t-[9px] border border-b-0 bg-white pb-1.5 pt-2"
        style={{ borderColor: APP.border }}
      >
        <div className="w-9 shrink-0" />
        {MECHANICS.map((m) => (
          <div key={m.ini} className="flex min-w-0 flex-1 flex-col items-center gap-0.5 px-0.5">
            <span
              className="flex h-5 w-5 items-center justify-center rounded-full bg-white text-[6.5px] font-semibold ring-1 ring-[#bfdbfe]"
              style={{ color: APP.primary }}
            >
              {m.ini}
            </span>
            <span className="w-full truncate text-center text-[6.8px]" style={{ color: APP.muted }}>
              {m.name}
            </span>
          </div>
        ))}
      </div>

      {/* The board */}
      <div
        className="relative mx-4 overflow-hidden rounded-b-[9px] border bg-white"
        style={{ borderColor: APP.border, height: BOARD_H }}
      >
        <div className="absolute inset-y-0 left-0 w-9 border-r" style={{ borderColor: `${APP.border}80` }} />
        {[1, 2, 3].map((k) => (
          <div
            key={k}
            className="absolute inset-y-0 border-l"
            style={{ left: `calc(36px + (100% - 36px) * ${k} / 4)`, borderColor: `${APP.border}59` }}
          />
        ))}
        {["9 AM", "10 AM", "11 AM", "12 PM"].map((t, i) => (
          <div key={t} className="absolute left-0 right-0" style={{ top: ((i * 60) / BOARD_WIN) * BOARD_H }}>
            <span className="absolute left-1 top-0.5 text-[7px]" style={{ color: APP.muted }}>
              {t}
            </span>
            {i > 0 && <div className="ml-9 border-t" style={{ borderColor: `${APP.border}66` }} />}
          </div>
        ))}

        {/* Dean Martin */}
        <BayBlock
          col={0}
          from={30}
          mins={60}
          status={done ? "completed" : "confirmed"}
          line1={done ? "9:30 · Mia K. ✓" : "9:30 · Mia K."}
          line2="Tire rotation"
        />
        {/* Sam's 11:30 — no-shows, then the slot backfills with a walk-in */}
        <AnimatePresence initial={false}>
          {!at("backfill") ? (
            <BayBlock
              key="sam"
              col={0}
              from={150}
              mins={45}
              status={at("noshow") ? "noshow" : "confirmed"}
              line1={at("noshow") ? "11:30 · No-show" : "11:30 · Sam T."}
              line2={at("noshow") ? "Sam T." : "Brake check"}
            />
          ) : (
            <BayBlock
              key="walkin"
              col={0}
              from={150}
              mins={45}
              status="confirmed"
              line1="11:30 · Nate P."
              line2="Walk-in · Oil change"
              entering
              highlight
            />
          )}
        </AnimatePresence>

        {/* Anakin Skywalker */}
        <BayBlock
          col={1}
          from={60}
          mins={60}
          status={done ? "completed" : "in_progress"}
          line1={done ? "10:00 · Priya V. ✓" : "10:00 · Priya V."}
          line2="Battery + charging"
        />

        {/* James Bond — the accepted booking lands here */}
        <AnimatePresence initial={false}>
          {at("placed") && (
            <BayBlock
              key="patel"
              col={2}
              from={150}
              mins={60}
              status="confirmed"
              line1="11:30 · R. Patel"
              line2="Brakes + rotors"
              entering
              highlight={phase === "placed"}
            />
          )}
        </AnimatePresence>

        {/* Luke Skywalker */}
        <BayBlock
          col={3}
          from={30}
          mins={90}
          status={done ? "completed" : "in_progress"}
          line1={done ? "9:30 · Chris M. ✓" : "9:30 · Chris M."}
          line2="Oil + inspection"
        />
        <BayBlock col={3} from={180} mins={45} status="confirmed" line1="12:00 · Dana R." line2="Brake pads" />

        {/* Current-time line — sweeps down when time passes */}
        <motion.div
          className="absolute left-9 right-0 z-10"
          initial={false}
          animate={{ top: ((done ? 155 : 80) / BOARD_WIN) * BOARD_H }}
          transition={{ duration: 1.6, ease: "easeInOut" }}
        >
          <span
            className="absolute -left-[3px] -top-[2.5px] h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: APP.primary }}
          />
          <div className="border-t" style={{ borderColor: APP.primary }} />
        </motion.div>

        {/* Payout stinger */}
        <AnimatePresence>
          {phase === "payout" && (
            <motion.div
              key="payout"
              className="absolute inset-x-2 bottom-2 z-20 flex items-center gap-2 rounded-[9px] bg-[#0f172a] px-3 py-2"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ type: "spring", stiffness: 280, damping: 26 }}
            >
              <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-500 text-[7px] font-bold text-white">
                ✓
              </span>
              <span className="text-[8px] font-medium text-white">
                $1,840 paid out — in your account within 24h
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** 02 — The Shops: a scripted day-in-the-shop. Opens on the mechanic
 *  dashboard, slides to the owner's all-mechanics board, then plays the
 *  story — new booking rings in → review → accept → lands in an open bay →
 *  time passes → a no-show backfills → payout. The caption under the
 *  window carries one selling point per beat. */
export function ShopsAdminSim({ active, reduce }: { active: boolean; reduce: boolean }) {
  const beat = (delay: number) =>
    reduce
      ? { initial: false as const, animate: { opacity: active ? 1 : 0 } }
      : {
          initial: false as const,
          animate: active ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 },
          transition: { duration: 0.45, ease: EASE, delay: active ? delay : 0 },
        };

  const [phase, setPhase] = useState<Phase>("dash");
  const [dateLabel, setDateLabel] = useState("Today");

  // Real current date, set after mount so SSR/client never disagree.
  useEffect(() => {
    setDateLabel(
      new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }),
    );
  }, []);

  // The story timeline, only while this panel has focus. Reduced-motion
  // visitors get the static dashboard instead of a self-driving demo.
  useEffect(() => {
    setPhase("dash");
    if (!active || reduce) return;
    const timers: number[] = [];
    const SEQ: [Phase, number][] = [
      ["board", 3000],
      ["ring", 5600],
      ["inbox", 7000],
      ["ack", 9800],
      ["acked", 10350],
      ["pressed", 12600],
      ["placed", 13150],
      ["lapse", 16100],
      ["noshow", 18900],
      ["backfill", 20700],
      ["payout", 23500],
    ];
    const run = () => {
      setPhase("dash");
      for (const [p, t] of SEQ) timers.push(window.setTimeout(() => setPhase(p), t));
      timers.push(window.setTimeout(run, 27100)); // loop length — mirrored in STORY_MS
    };
    run();
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [active, reduce]);

  const caption = CAPTIONS[phase];

  return (
    <div className="flex h-full w-full flex-col p-1">
      {/* The app window — full stage, no frame */}
      <div className="flex min-h-0 flex-1 items-center justify-center">
      <motion.div
        className="w-full max-w-[420px] origin-center scale-[0.85] select-none overflow-hidden rounded-[14px] bg-[#f8fafc] shadow-[0_30px_70px_rgba(20,40,80,0.3)] ring-1 ring-black/5 sm:scale-105 lg:scale-[1.22]"
        initial={false}
        animate={{ opacity: active ? 1 : 0, y: active || reduce ? 0 : 14 }}
        transition={{ duration: 0.5, ease: EASE }}
      >
        <AnimatePresence mode="wait" initial={false}>
          {phase !== "dash" ? (
            <motion.div
              key="board"
              initial={{ opacity: 0, x: 26 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 26 }}
              transition={{ duration: 0.3, ease: EASE }}
            >
              <AdminBoard phase={phase} dateLabel={dateLabel} />
            </motion.div>
          ) : (
            <motion.div
              key="dash"
              initial={{ opacity: 0, x: -26 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -26 }}
              transition={{ duration: 0.3, ease: EASE }}
            >
        {/* Greeting header — the dashboard's blue-tinted hero card */}
        <div
          className="border-b px-4 py-3.5"
          style={{
            borderColor: APP.border,
            background:
              "radial-gradient(circle at top left, rgba(59,130,246,0.10), transparent 40%), linear-gradient(180deg, rgba(255,255,255,0.98), rgba(248,250,252,0.98))",
          }}
        >
          <p className="text-[8.5px] font-medium uppercase tracking-[0.2em]" style={{ color: `${APP.primary}cc` }}>
            Atlantic Auto
          </p>
          <p className="mt-1 text-[15px] font-semibold tracking-tight" style={{ color: APP.fg }}>
            Good morning, Marco
          </p>
          <p className="mt-0.5 text-[9.5px] leading-snug" style={{ color: APP.muted }}>
            Today has 4 assigned bookings and 1 completed booking still needs finalized actuals.
          </p>
        </div>

        {/* Stat trio */}
        <motion.div className="grid grid-cols-3 gap-2 px-4 pt-3" {...beat(0.1)}>
          <MiniStat label="Today's Bookings" value="4" sub="Assigned to you" />
          <MiniStat label="This Week" value="12" sub="Completed bookings" />
          <MiniStat label="My Rating" value="4.9" sub="96 reviews" />
        </motion.div>

        {/* Today's Schedule */}
        <motion.div
          className="m-4 rounded-[12px] border bg-white p-3 shadow-[0_2px_8px_rgba(0,0,0,0.04)]"
          style={{ borderColor: APP.border }}
          {...beat(0.22)}
        >
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-[11px] font-semibold" style={{ color: APP.fg }}>
                Today&apos;s Schedule
              </p>
              <p className="text-[8.5px]" style={{ color: APP.muted }}>
                Focused on your confirmed and active work for today.
              </p>
            </div>
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[8px] font-medium text-amber-700">
              <span className="h-1 w-1 rounded-full bg-amber-500" />
              Live actions
            </span>
          </div>

          <div className="mt-2.5 space-y-2">
            <MiniJob
              initials="DR"
              avatarClass="bg-blue-100 text-blue-600"
              time="9:30 AM"
              pill="Confirmed"
              pillClass="bg-[#5299fe]/15 text-[#5299fe]"
              customer="Dana R."
              vehicle="2019 Honda CR-V"
              service="Front brake pads & rotors"
              minutes="1h 45m"
              action="Awaiting vehicle"
            />
            <MiniJob
              initials="CM"
              avatarClass="bg-green-100 text-green-600"
              time="11:15 AM"
              pill="Vehicle Here"
              pillClass="bg-cyan-50 text-cyan-700"
              customer="Chris M."
              vehicle="2020 Audi Q5"
              service="Oil change + multi-point inspection"
              minutes="45m"
              action="Start job"
              primaryAction
            />
          </div>
        </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
      </div>

      {/* Caption — one selling point per story beat, pinned to the bottom */}
      <div className="flex h-8 shrink-0 items-center justify-center sm:h-9">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={caption}
            className="whitespace-nowrap rounded-full bg-white/70 px-5 py-1.5 text-[12px] tracking-[0.03em] text-[#1a1a1a] ring-1 ring-black/5 backdrop-blur-md sm:text-[13px] lg:px-6 lg:py-2 lg:text-[13.5px]"
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

