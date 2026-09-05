"use client";

import { Fragment, type ReactNode } from "react";
import { motion } from "motion/react";
import { Banknote, Calendar, ChevronRight, ClipboardList, LayoutGrid, Settings, Users, Wrench } from "lucide-react";
import { BrowserFrame } from "../device";

/**
 * The shop's web dashboard, as designed in the Figma shops shelf (frames
 * 385:155 → 386:344 and the job-sheet screens the home page's ShopsPanel
 * plays): a light board on the sky tint, "Time (EST)" in an ink header,
 * mechanics as columns, hours as rows, bookings as white blocks; the job
 * sheet with the 4-node stepper, scope row, vehicle-condition card and the
 * ink action button. Drawn at desktop size inside BrowserFrame; pages
 * Zoom it to fit.
 *
 * Vocabulary from the portal (app/(portal)/*): Schedule, Bookings,
 * Customers, Team, Payouts, Settings; "Stripe connected"; "the transfers
 * that have already left Stripe".
 */
const NAV = [
  { l: "Schedule", i: Calendar },
  { l: "Bookings", i: ClipboardList },
  { l: "Customers", i: Users },
  { l: "Team", i: Wrench },
  { l: "Payouts", i: Banknote },
  { l: "Settings", i: Settings },
];

function Shell({ active, children, shop = "Eltingville Auto Care" }: { active: string; children: ReactNode; shop?: string }) {
  return (
    <div className="flex h-full" style={{ fontFamily: "Inter, system-ui, sans-serif" }}>
      <aside className="flex w-[212px] shrink-0 flex-col border-r border-[#1a1a1a]/8 bg-white px-4 py-5">
        <div className="flex items-center gap-2 px-2">
          <span className="flex h-[26px] w-[26px] items-center justify-center rounded-[8px] bg-[#1a1a1a] text-[11px] font-bold text-white">
            E
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-semibold text-[#1a1a1a]">{shop}</span>
            <span className="block text-[11px] text-[#777169]">Shop dashboard</span>
          </span>
        </div>
        <nav className="mt-6 flex flex-col gap-[2px]">
          {NAV.map((n) => {
            const on = n.l === active;
            return (
              <span key={n.l} className={`flex items-center gap-2.5 rounded-[8px] px-2.5 py-[7px] text-[13px] ${on ? "bg-[#EBF5FB] font-semibold text-[#1a1a1a]" : "text-[#4c5661]"}`}>
                <n.i className="h-[15px] w-[15px]" style={{ color: on ? "#4B82A5" : "#777169" }} strokeWidth={1.8} />
                {n.l}
              </span>
            );
          })}
        </nav>
        <div className="mt-auto rounded-[10px] border border-[#1a1a1a]/8 p-3">
          <p className="text-[11px] text-[#777169]">Payouts</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-[12.5px] font-medium text-[#1a1a1a]">
            <span className="h-[7px] w-[7px] rounded-full bg-[#10B981]" />
            Stripe connected
          </p>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-hidden bg-[#f7f6f3]">{children}</main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Day board                                                           */
/* ------------------------------------------------------------------ */

export const MECHS = ["Marcus T.", "Dee A.", "Twunna S."] as const;
const HOURS = ["8:00 AM", "9:00 AM", "10:00 AM", "11:00 AM", "12:00 PM", "1:00 PM", "2:00 PM"] as const;
const ROW_H = 64;

export type Block = { mech: 0 | 1 | 2; start: number; span?: number; title: string; sub: string; who: string; tone?: "new" | "live" | "done" | "plain"; badge?: string };

export const BOARD_BLOCKS: Block[] = [
  { mech: 1, start: 0.25, span: 1, title: "Oil change", sub: "2021 Toyota Camry", who: "John Wilson", tone: "done", badge: "Complete" },
  { mech: 2, start: 1, span: 2, title: "State inspection", sub: "2018 Subaru Outback", who: "Priya N.", tone: "plain", badge: "10:00a" },
  { mech: 0, start: 1.66, span: 1.5, title: "Front brake pads", sub: "2019 Honda Civic EX", who: "Dee Ramos", tone: "new", badge: "9:40a" },
  { mech: 1, start: 3, span: 1, title: "Tire rotation", sub: "2020 Kia Telluride", who: "Alex M.", tone: "plain", badge: "11:00a" },
];

export function DayBoard({ blocks = BOARD_BLOCKS, landing, nowAt = 1.9, date = "Tuesday, September 9" }: { blocks?: Block[]; landing?: string; nowAt?: number; date?: string }) {
  return (
    <div className="flex h-full flex-col px-7 pt-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-[#777169]">Schedule</p>
          <p className="mt-1 text-[22px] font-semibold tracking-[-0.01em] text-[#1a1a1a]" style={{ fontFamily: "var(--font-Petrona), Georgia, serif", fontWeight: 400 }}>
            {date}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-[#1a1a1a]/12 bg-white px-3 py-[6px] text-[12px] text-[#1a1a1a]">Today</span>
          <span className="rounded-full border border-[#1a1a1a]/12 bg-white px-3 py-[6px] text-[12px] text-[#1a1a1a]">All mechanics ⌄</span>
          <span className="rounded-full bg-[#1a1a1a] px-3.5 py-[6px] text-[12px] font-medium text-white">+ Walk-in</span>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-[84px_repeat(3,1fr)] gap-2">
        <div className="flex h-[52px] items-center justify-center rounded-[6px] bg-[#1a1a1a] text-[10.5px] font-medium uppercase tracking-[0.08em] text-[#cfcfcf]">Time (EST)</div>
        {MECHS.map((m, i) => (
          <div key={m} className="flex h-[52px] flex-col items-center justify-center rounded-[6px] bg-white">
            <span className="text-[13px] font-semibold tracking-[-0.01em] text-[#1a1a1a]">{m}</span>
            <span className="mt-0.5 text-[11px]" style={{ color: blocks.some((b) => b.mech === i && b.tone === "new") ? "#5299fe" : "#8a9094" }}>
              {blocks.filter((b) => b.mech === i).length} job{blocks.filter((b) => b.mech === i).length === 1 ? "" : "s"}
            </span>
          </div>
        ))}
      </div>

      <div className="relative mt-2 flex-1">
        <div className="grid grid-cols-[84px_repeat(3,1fr)] gap-x-2">
          {HOURS.map((h) => (
            <Fragment key={h}>
              <div className="flex items-start pl-2 pt-1 text-[11px] tracking-[0.02em] text-[#33383b]" style={{ height: ROW_H }}>
                {h}
              </div>
              {MECHS.map((m) => (
                <div key={m + h} className="border-t border-[#1a1a1a]/8" style={{ height: ROW_H }} />
              ))}
            </Fragment>
          ))}
        </div>

        {/* now line */}
        <div className="pointer-events-none absolute inset-x-0 z-10" style={{ top: nowAt * ROW_H }}>
          <span className="absolute -top-[14px] left-2 text-[10px] font-medium text-[#5299fe]">now</span>
          <span className="block h-[1.5px] bg-[#5299fe]" />
          <span className="absolute -top-[3px] left-0 h-[7px] w-[7px] rounded-full bg-[#5299fe]" />
        </div>

        {blocks.map((b) => {
          const isNew = b.tone === "new";
          const glow = landing === b.title;
          return (
            <motion.div
              key={b.title + b.mech}
              className="absolute z-20 rounded-[8px] border p-2.5"
              style={{
                left: `calc(84px + 8px + (100% - 84px - 3 * 8px) / 3 * ${b.mech} + 3px)`,
                width: "calc((100% - 84px - 3 * 8px) / 3 - 6px)",
                top: b.start * ROW_H + 2,
                height: (b.span ?? 1) * ROW_H - 6,
                backgroundColor: b.tone === "done" ? "rgba(255,255,255,0.55)" : "#fff",
                borderColor: isNew ? "#5299fe" : "rgba(26,26,26,0.08)",
                boxShadow: glow ? "0 16px 34px rgba(20,40,80,0.20)" : "0 1px 2px rgba(26,26,26,0.04)",
              }}
              initial={false}
              animate={glow ? { scale: [1, 0.985, 1.005, 1] } : { scale: 1 }}
              transition={{ duration: 0.55 }}
            >
              <p className="truncate text-[12.5px] font-semibold tracking-[-0.01em] text-[#1a1a1a]">{b.who}</p>
              <p className="mt-0.5 truncate text-[11.5px] text-[#33383b]">{b.title}</p>
              {(b.span ?? 1) >= 1.5 && <p className="mt-1 truncate text-[10px] text-[#8a9094]">{b.sub}</p>}
              {b.badge && (
                <span className={`absolute bottom-2 right-2 rounded-full px-2 py-0.5 text-[9.5px] font-medium ${isNew ? "bg-[#5299fe] text-white" : "bg-[#dbe3e8]/90 text-[#33383b]"}`}>
                  {isNew ? "$20 hold on card" : b.badge}
                </span>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Job sheet                                                           */
/* ------------------------------------------------------------------ */

function StepNode({ n, state }: { n: number; state: "done" | "active" | "todo" }) {
  const dark = state !== "todo";
  return (
    <span className="z-[2] flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12.5px] font-medium" style={{ backgroundColor: dark ? "#1a1a1a" : "#fff", color: dark ? "#fff" : "#1a1a1a", boxShadow: dark ? undefined : "inset 0 0 0 1px rgba(26,26,26,0.12)" }}>
      {state === "done" ? "✓" : n}
    </span>
  );
}

export function JobSheet({
  step = 2,
  estimate = "confirmed",
}: {
  step?: 1 | 2 | 3 | 4;
  /** The inspection's outcome: within the approved ceiling (auto-confirmed)
   *  or above it (waiting on the driver). */
  estimate?: "pending" | "confirmed" | "awaiting";
}) {
  const stateOf = (n: number): "done" | "active" | "todo" => (n < step ? "done" : n === step ? "active" : "todo");
  return (
    <div className="grid h-full grid-cols-[1fr_320px] gap-6 px-7 pt-6">
      <div>
        <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-[#777169]">Bookings / Today</p>
        <p className="mt-1 text-[24px] tracking-[-0.01em] text-[#1a1a1a]" style={{ fontFamily: "var(--font-Petrona), Georgia, serif", fontWeight: 400 }}>
          Front brake pads · Dee Ramos
        </p>
        <div className="mt-6 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-[#33383b]">Job progress</span>
          <span className="rounded-full bg-[#dbe3e8]/90 px-2.5 py-1 text-[9.5px] font-medium uppercase tracking-[0.06em] text-[#33383b]">Confirmed</span>
        </div>
        <div className="relative mt-3 flex items-center">
          {[1, 2, 3, 4].map((n) => (
            <Fragment key={n}>
              {n > 1 && (
                <span className="relative mx-1 h-[1.5px] min-w-0 flex-1 overflow-hidden rounded bg-[#c9d4dc]">
                  <span className="absolute inset-y-0 left-0 w-full origin-left bg-[#1a1a1a]" style={{ transform: `scaleX(${step - 1 >= n - 1 ? 1 : 0})`, transition: "transform 450ms cubic-bezier(0.22,1,0.36,1)" }} />
                </span>
              )}
              <StepNode n={n} state={stateOf(n)} />
            </Fragment>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-4 text-[11px] text-[#8a9094]">
          {["Checked in", "Inspected", "In service", "Complete"].map((l, i) => (
            <span key={l} className={i === 0 ? "" : i === 3 ? "text-right" : "text-center"}>
              {l}
            </span>
          ))}
        </div>

        <div className="mt-6 flex items-center justify-between rounded-[6px] bg-white px-5 py-4">
          <div>
            <p className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-[#8a9094]">Services</p>
            <p className="mt-1 text-[15px] font-semibold tracking-[-0.01em] text-[#1a1a1a]">Front brake pads</p>
          </div>
          <span className="text-[12px] text-[#6b7280]">1 service · 1 part ⌄</span>
        </div>

        <p className="mt-5 text-[11px] font-medium uppercase tracking-[0.1em] text-[#33383b]">Inspection</p>
        <div className="mt-2 rounded-[6px] bg-white px-5 py-4">
          <p className="text-[14px] font-semibold tracking-[-0.01em] text-[#1a1a1a]">Front pads at 2 mm. Rotors fine.</p>
          <p className="mt-1 text-[12px] leading-[1.45] text-[#6b7280]">Driver approved $312.00 at booking. Your confirmed estimate is within it, so it confirmed on its own. Add anything more and the driver gets it in the app with 24 hours to answer.</p>
          <div className="mt-3 flex items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-full bg-[#1a1a1a] px-3 py-[6px] text-[12px] font-medium text-white">
              {estimate === "awaiting" ? "Sent for approval" : "✓ Estimate confirmed · $312.00"}
            </span>
            <span className="rounded-full border border-[#1a1a1a]/12 px-3 py-[6px] text-[12px] text-[#1a1a1a]">Add unforeseen scope</span>
          </div>
        </div>

        <div className="mt-5 flex h-[46px] w-full items-center justify-center rounded-[6px] bg-[#1a1a1a] text-[12.5px] font-medium uppercase tracking-[0.12em] text-white" style={{ boxShadow: "0 6px 18px rgba(15,23,42,0.18)" }}>
          {step >= 4 ? "Complete" : step >= 3 ? "Mark ready" : "Start service"}
        </div>
      </div>

      <aside className="flex flex-col gap-3">
        <div className="rounded-[6px] bg-white p-4">
          <p className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-[#8a9094]">Driver</p>
          <p className="mt-1 text-[14px] font-semibold text-[#1a1a1a]">Dee Ramos</p>
          <p className="text-[12px] text-[#6b7280]">2019 Honda Civic EX · KXT 4821</p>
          <p className="mt-2 text-[12px] italic leading-[1.45] text-[#4c5661]">&ldquo;Squeaks when I brake, mostly first thing in the morning.&rdquo;</p>
        </div>
        <div className="rounded-[6px] bg-white p-4">
          <p className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-[#8a9094]">Payment</p>
          <p className="mt-1 flex items-center justify-between text-[12.5px] text-[#4c5661]">
            <span>Hold on card</span>
            <span className="font-medium text-[#1a1a1a]">$20.00</span>
          </p>
          <p className="mt-1 flex items-center justify-between text-[12.5px] text-[#4c5661]">
            <span>Approved ceiling</span>
            <span className="font-medium text-[#1a1a1a]">$312.00</span>
          </p>
          <p className="mt-1 flex items-center justify-between text-[12.5px] text-[#4c5661]">
            <span>Captured when complete</span>
            <span className="font-medium text-[#1a1a1a]">$312.00</span>
          </p>
        </div>
        <div className="rounded-[6px] bg-white p-4">
          <p className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-[#8a9094]">Vehicle profile</p>
          <p className="mt-1 text-[13px] font-semibold text-[#1a1a1a]">Ready</p>
          <p className="text-[12px] text-[#6b7280]">1.5L turbo · 41,200 mi · last brake service 18 mo ago</p>
        </div>
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Payouts                                                             */
/* ------------------------------------------------------------------ */

const PAYOUTS = [
  { job: "Front brake pads", who: "Dee Ramos", captured: "Tue, Sep 9", amount: "$312.00", state: "Captured" },
  { job: "Oil change", who: "John Wilson", captured: "Tue, Sep 9", amount: "$84.00", state: "Captured" },
  { job: "State inspection", who: "Priya N.", captured: "Mon, Sep 8", amount: "$37.00", state: "Paid out" },
  { job: "Tire rotation + balance", who: "Alex M.", captured: "Fri, Sep 5", amount: "$96.00", state: "Paid out" },
];

export function Payouts() {
  return (
    <div className="flex h-full flex-col px-7 pt-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-[#777169]">Payouts</p>
          <p className="mt-1 text-[22px] tracking-[-0.01em] text-[#1a1a1a]" style={{ fontFamily: "var(--font-Petrona), Georgia, serif", fontWeight: 400 }}>
            Your rate, paid through Stripe
          </p>
        </div>
        <span className="flex items-center gap-2 rounded-full border border-[#1a1a1a]/12 bg-white px-3 py-[6px] text-[12px] text-[#1a1a1a]">
          <span className="h-[7px] w-[7px] rounded-full bg-[#10B981]" />
          Stripe connected · Open Express dashboard
          <ChevronRight className="h-[12px] w-[12px] text-[#777169]" />
        </span>
      </div>
      <div className="mt-5 grid grid-cols-3 gap-3">
        {[
          { k: "Captured this week", v: "$1,248.00", s: "6 jobs marked complete" },
          { k: "Next payout", v: "$396.00", s: "On Stripe's payout schedule" },
          { k: "Your rate", v: "100%", s: "No subscription, no setup fee" },
        ].map((t) => (
          <div key={t.k} className="rounded-[10px] border border-[#1a1a1a]/8 bg-white p-4">
            <p className="text-[11px] text-[#777169]">{t.k}</p>
            <p className="mt-1 text-[24px] font-semibold tabular-nums tracking-[-0.02em] text-[#1a1a1a]">{t.v}</p>
            <p className="mt-0.5 text-[11.5px] text-[#6b7280]">{t.s}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 overflow-hidden rounded-[10px] border border-[#1a1a1a]/8 bg-white">
        <div className="flex items-center justify-between border-b border-[#1a1a1a]/8 px-4 py-3">
          <span className="text-[13px] font-semibold text-[#1a1a1a]">Recent payouts</span>
          <span className="text-[11.5px] text-[#6b7280]">Your payout account and the transfers that have already left Stripe.</span>
        </div>
        <table className="w-full text-left text-[12.5px]">
          <thead>
            <tr className="text-[10.5px] uppercase tracking-[0.08em] text-[#8a9094]">
              <th className="px-4 py-2 font-medium">Job</th>
              <th className="px-4 py-2 font-medium">Driver</th>
              <th className="px-4 py-2 font-medium">Captured</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {PAYOUTS.map((p) => (
              <tr key={p.job + p.who} className="border-t border-[#1a1a1a]/6">
                <td className="px-4 py-[10px] font-medium text-[#1a1a1a]">{p.job}</td>
                <td className="px-4 py-[10px] text-[#4c5661]">{p.who}</td>
                <td className="px-4 py-[10px] text-[#4c5661]">{p.captured}</td>
                <td className="px-4 py-[10px]">
                  <span className={`rounded-full px-2 py-[3px] text-[10.5px] font-medium ${p.state === "Paid out" ? "bg-[#ECFDF5] text-[#047857]" : "bg-[#EBF5FB] text-[#1D4ED8]"}`}>{p.state}</span>
                </td>
                <td className="px-4 py-[10px] text-right font-medium tabular-nums text-[#1a1a1a]">{p.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


/* ------------------------------------------------------------------ */
/* Rates & services (Settings)                                         */
/* ------------------------------------------------------------------ */

/** Tier labels from convex/lib/vehicleTiers.ts. Rates are the shop's own;
 *  the figures here are examples, no platform rate is printed. */
const TIERS: [string, string, string][] = [
  ["T1", "Mainstream", "$140"],
  ["T2a", "Value premium", "$170"],
  ["T2b", "German mid", "$180"],
  ["T2c", "BMW non-M", "$190"],
  ["T3a", "Performance", "$215"],
];
const SERVICES: [string, boolean, string?][] = [
  ["Oil change", true, "$84 flat"],
  ["Front brake pads", true],
  ["Tire rotation + balance", true, "$96 flat"],
  ["State inspection", true, "$37 flat"],
  ["Battery replacement", true],
  ["Wheel alignment", false],
  ["Transmission service", false],
];

export function Rates() {
  return (
    <div className="flex h-full flex-col px-7 pt-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-[#777169]">Settings</p>
          <p className="mt-1 text-[22px] tracking-[-0.01em] text-[#1a1a1a]" style={{ fontFamily: "var(--font-Petrona), Georgia, serif", fontWeight: 400 }}>
            Rates and services
          </p>
        </div>
        <span className="rounded-full bg-[#1a1a1a] px-3.5 py-[6px] text-[12px] font-medium text-white">Save changes</span>
      </div>
      <div className="mt-5 grid grid-cols-[1fr_1.15fr] gap-4">
        <div className="rounded-[10px] border border-[#1a1a1a]/8 bg-white">
          <div className="border-b border-[#1a1a1a]/8 px-4 py-3">
            <p className="text-[13px] font-semibold text-[#1a1a1a]">Labor rate by vehicle tier</p>
            <p className="text-[11.5px] text-[#6b7280]">Per hour. Tiers you do not take stay off.</p>
          </div>
          {TIERS.map(([code, label, rate], i) => (
            <div key={code} className={`flex items-center justify-between px-4 py-[10px] ${i > 0 ? "border-t border-[#1a1a1a]/6" : ""}`}>
              <span className="flex items-center gap-3">
                <span className="w-[34px] rounded-[5px] bg-[#EBF5FB] px-1.5 py-[2px] text-center text-[10.5px] font-semibold text-[#1D4ED8]">{code}</span>
                <span className="text-[12.5px] text-[#1a1a1a]">{label}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="rounded-[6px] border border-[#1a1a1a]/12 px-2.5 py-[4px] text-[12.5px] font-medium tabular-nums text-[#1a1a1a]">{rate}</span>
                <span className="text-[11px] text-[#8a9094]">/ hr</span>
              </span>
            </div>
          ))}
          <div className="flex items-center justify-between border-t border-[#1a1a1a]/6 px-4 py-[10px] opacity-60">
            <span className="flex items-center gap-3">
              <span className="w-[34px] rounded-[5px] bg-[#F1F5F9] px-1.5 py-[2px] text-center text-[10.5px] font-semibold text-[#475569]">T4</span>
              <span className="text-[12.5px] text-[#1a1a1a]">Ultra-exotic</span>
            </span>
            <span className="text-[11px] text-[#8a9094]">Not offered</span>
          </div>
        </div>
        <div className="rounded-[10px] border border-[#1a1a1a]/8 bg-white">
          <div className="flex items-center justify-between border-b border-[#1a1a1a]/8 px-4 py-3">
            <div>
              <p className="text-[13px] font-semibold text-[#1a1a1a]">Services</p>
              <p className="text-[11.5px] text-[#6b7280]">Any of the 22 on or off. A flat price where you want one.</p>
            </div>
            <span className="text-[11.5px] text-[#4B82A5]">5 of 22 on</span>
          </div>
          {SERVICES.map(([name, on, flat], i) => (
            <div key={name} className={`flex items-center justify-between px-4 py-[9px] ${i > 0 ? "border-t border-[#1a1a1a]/6" : ""}`}>
              <span className="text-[12.5px] text-[#1a1a1a]" style={{ opacity: on ? 1 : 0.55 }}>
                {name}
              </span>
              <span className="flex items-center gap-3">
                {flat && <span className="rounded-full bg-[#EBF5FB] px-2 py-[2px] text-[10.5px] font-medium text-[#1D4ED8]">{flat}</span>}
                {!flat && on && <span className="text-[10.5px] text-[#8a9094]">Labor + parts</span>}
                <span className="relative inline-flex h-[18px] w-[32px] items-center rounded-full" style={{ backgroundColor: on ? "#1a1a1a" : "#D1D5DB" }}>
                  <span className="absolute h-[14px] w-[14px] rounded-full bg-white" style={{ left: on ? 16 : 2 }} />
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
      <p className="mt-3 text-[11.5px] text-[#6b7280]">Otopair never discounts or negotiates a rate. What you set is what the driver sees, built into one total for their exact car.</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Framed pages                                                        */
/* ------------------------------------------------------------------ */

export function PortalWindow({ page, width = 1100, height = 680, shop, ...props }: { page: "board" | "job" | "payouts" | "rates"; width?: number; height?: number; /** Sidebar shop name; the local pages pass a placeholder so no stand-in shop appears. */ shop?: string } & Partial<Parameters<typeof DayBoard>[0]> & Partial<Parameters<typeof JobSheet>[0]>) {
  const url = page === "board" ? "shop.otopair.com/schedule" : page === "job" ? "shop.otopair.com/bookings/4f2a9c" : page === "rates" ? "shop.otopair.com/settings/rates" : "shop.otopair.com/payouts";
  const active = page === "board" ? "Schedule" : page === "job" ? "Bookings" : page === "rates" ? "Settings" : "Payouts";
  return (
    <BrowserFrame url={url} width={width} height={height}>
      <Shell active={active} shop={shop}>
        {page === "board" && <DayBoard blocks={props.blocks} landing={props.landing} nowAt={props.nowAt} date={props.date} />}
        {page === "job" && <JobSheet step={props.step} estimate={props.estimate} />}
        {page === "payouts" && <Payouts />}
        {page === "rates" && <Rates />}
      </Shell>
    </BrowserFrame>
  );
}

export { LayoutGrid };
