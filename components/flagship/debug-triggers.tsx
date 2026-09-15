"use client";

/**
 * TEMPORARY dev-only trigger panel — pinned to the far right of the hero.
 * One button per component the agent can summon: every show_demo card, each
 * funnel step, the VIN/vehicle card, and example show_info_card payloads
 * (one per layout, shaped exactly like what ElevenLabs would send).
 *
 * DELETE THIS FILE (and its mount in flagship-hero.tsx) before shipping.
 */

import { useState } from "react";
import { DEMO_FEATURES } from "./oto-flow";
import { SERVICE_EXPLAINERS, SYMPTOMS } from "./oto-knowledge";
import type { OtoAgent } from "./use-oto-agent";

// A real 17-char VIN (2003 Honda Accord) — exercises the live NHTSA decode.
const TEST_VIN = "1HGCM82633A004352";

// Example agent payloads — exactly what the ElevenLabs tool call would carry.
// Their words follow the knowledge base (docs/oto/knowledge-base), so a card
// summoned from here never shows a claim Oto isn't allowed to make. The
// earlier samples promised warranty coverage, "vetted" shops, price ranges and
// a shop count.
const INFO_SAMPLES: Record<string, unknown> = {
  list: {
    title: "Who stands behind the repair",
    summary: "The shop does the work and stands behind it.",
    layout: "list",
    items: [
      "Any parts or labor warranty is the shop's own",
      "Its terms vary by shop and by job",
      "Ask the shop in the app, so the answer is on the record",
      "Otopair keeps the approved price, messages and receipt",
    ],
    footnote: "Disputes are opened from the booking in the app.",
  },
  steps: {
    title: "Getting a tire quote",
    summary: "Tires work on quotes instead of fixed prices.",
    layout: "steps",
    items: [
      "Post a tire request for your exact car",
      "Shops send quotes naming the tire brand and model",
      "Compare the price per tire, labor and the total",
      "Accept one, or cancel the request for free",
    ],
  },
  rows: {
    title: "What's in your total",
    summary: "One total for your exact car, before you confirm.",
    layout: "rows",
    rows: [
      { label: "Parts", value: "Chosen for your exact car" },
      { label: "Labor", value: "The shop's own rate" },
      { label: "Tax and service fee", value: "Inside the total" },
      { label: "Locked total", value: "Can't go up without your yes" },
    ],
  },
  stats: {
    title: "Otopair in numbers",
    layout: "stats",
    stats: [
      { value: "22", label: "Bookable services" },
      { value: "4", label: "Service categories" },
      { value: "$20", label: "Hold at booking" },
      { value: "24 h", label: "To answer a request" },
    ],
    footnote: "Live first on Staten Island.",
  },
  compare: {
    title: "What Oto does",
    summary: "Possibilities, never a diagnosis.",
    layout: "compare",
    pros: ["Turns what the car is doing into a job a shop can price", "Explains what a mechanic will check", "Shows the full total before you book"],
    cons: ["Never replaces the mechanic's inspection", "Never approves extra work for you", "Never guesses on safety items"],
  },
};

const BTN =
  "w-full rounded-md border border-[#1a1a1a]/10 bg-white/80 px-2 py-1 text-left text-[10px] leading-tight text-[#1a1a1a]/75 transition-colors hover:bg-white hover:text-[#1a1a1a]";

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="px-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-[#1a1a1a]/40">
        {label}
      </p>
      {children}
    </div>
  );
}

export default function DebugTriggers({ oto }: { oto: OtoAgent }) {
  const [open, setOpen] = useState(true);

  return (
    // max-lg:hidden — on a phone-sized preview the panel covered half the
    // page and swallowed wheel scrolling (2026-09-03).
    <div className="fixed right-2 top-1/2 z-[70] -translate-y-1/2 max-lg:hidden">
      {open ? (
        <div className="max-h-[86vh] w-[148px] space-y-3 overflow-y-auto rounded-xl border border-[#1a1a1a]/10 bg-[#eceae6]/95 p-2 shadow-[0_10px_30px_rgba(0,0,0,0.12)] backdrop-blur [scrollbar-width:thin]">
        <button type="button" onClick={() => setOpen(false)} className={`${BTN} text-center font-semibold`}>
          ▸ hide dev panel
        </button>

        <Group label="Funnel">
          {(["scheduling", "shops", "datetime", "confirmed"] as const).map((s) => (
            <button key={s} type="button" className={BTN} onClick={() => oto.advance(s)}>
              {s}
            </button>
          ))}
        </Group>

        <Group label="Vehicle">
          <button type="button" className={BTN} onClick={() => void oto.decodeVin(TEST_VIN)}>
            decode VIN (Accord)
          </button>
          <button type="button" className={BTN} onClick={() => oto.showVehicle()}>
            show vehicle
          </button>
        </Group>

        <Group label="Demo cards">
          {DEMO_FEATURES.map((f) => (
            <button key={f} type="button" className={BTN} onClick={() => oto.showDemo(f)}>
              {f.replace(/_/g, " ")}
            </button>
          ))}
        </Group>

        <Group label="Services">
          {SERVICE_EXPLAINERS.map((s) => (
            <button key={s.service} type="button" className={BTN} onClick={() => oto.showService(s.service)}>
              {s.service.toLowerCase()}
            </button>
          ))}
        </Group>

        <Group label="Symptoms">
          {SYMPTOMS.map((s) => (
            <button key={s.id} type="button" className={BTN} onClick={() => oto.showSymptom(s.id)}>
              {s.symptom.toLowerCase()}
            </button>
          ))}
        </Group>

        <Group label="Dynamic (info card)">
          {Object.keys(INFO_SAMPLES).map((k) => (
            <button key={k} type="button" className={BTN} onClick={() => oto.showInfoCard(INFO_SAMPLES[k])}>
              {k}
            </button>
          ))}
        </Group>

        <Group label="Session">
          <button type="button" className={BTN} onClick={() => oto.reset()}>
            reset
          </button>
        </Group>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-l-xl border border-[#1a1a1a]/10 bg-[#eceae6]/95 px-1.5 py-3 text-[10px] font-semibold text-[#1a1a1a]/60 shadow backdrop-blur"
        >
          ◂ dev
        </button>
      )}
    </div>
  );
}
