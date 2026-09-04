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
import type { OtoAgent } from "./use-oto-agent";

// A real 17-char VIN (2003 Honda Accord) — exercises the live NHTSA decode.
const TEST_VIN = "1HGCM82633A004352";

// Example agent payloads — exactly what the ElevenLabs tool call would carry.
const INFO_SAMPLES: Record<string, unknown> = {
  list: {
    title: "Is there a warranty?",
    summary: "Every repair booked through Otopair is covered.",
    layout: "list",
    items: [
      "12-month / 12,000-mile parts & labor coverage",
      "Backed by the shop, enforced by Otopair",
      "Claims handled in-app — no phone calls",
      "Covered at any Otopair shop, not just the original",
    ],
    footnote: "Coverage details appear on every quote before you book.",
  },
  steps: {
    title: "Getting a tire quote",
    summary: "Tires work on live quotes instead of fixed prices.",
    layout: "steps",
    items: [
      "Tell Oto your car or plug in your VIN",
      "Pick a tier — budget, mid, or premium",
      "Nearby shops send live installed prices",
      "Choose one and book your slot",
    ],
  },
  rows: {
    title: "What's in your total",
    summary: "Every charge is its own line — nothing folded in.",
    layout: "rows",
    rows: [
      { label: "Parts", value: "Exact part, exact price" },
      { label: "Labor", value: "Shop's posted rate" },
      { label: "Otopair fee", value: "7%, always visible" },
      { label: "Taxes", value: "Itemized at checkout" },
    ],
  },
  stats: {
    title: "Otopair at launch",
    layout: "stats",
    stats: [
      { value: "4", label: "NYC boroughs" },
      { value: "120+", label: "Vetted shops" },
      { value: "90s", label: "To book" },
      { value: "7%", label: "Flat fee" },
    ],
    footnote: "Staten Island and more cities are next.",
  },
  compare: {
    title: "Diagnostics with Oto",
    summary: "What the AI diagnosis does — and what it never does.",
    layout: "compare",
    pros: ["Narrows likely causes from symptoms", "Estimates a fair price range", "Preps the shop before you arrive"],
    cons: ["Never replaces the mechanic's inspection", "Never auto-approves extra work", "Never guesses on safety items"],
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
