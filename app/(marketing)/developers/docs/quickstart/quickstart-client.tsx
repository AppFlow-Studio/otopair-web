"use client";

// Quickstart (client half) — now an interactive console, not just a copy-paste
// walkthrough. Three acts: (1) "What you can pull" — the data-group breakdown,
// each card jumping into (2) the live Playground (paste a key → run any
// endpoint → structured OR raw output, with real-data samples pre-loaded), then
// (3) the provenance model + the classic 60-second path for narrative. Reuses
// the shared primitives so it stays in lockstep with the Reference + dashboard.

import { useCallback, useState } from "react";
import Link from "next/link";
import { MONO, CopyButton, baseUrl } from "../../shared";
import { DATA_GROUPS, endpointById, type DataGroup } from "./catalog";
import { Playground } from "./playground";

const ink = "#1a1a1a";
const muted = "#6b655d";
const CARD = "rounded-2xl border border-[#dcd8d0] bg-[#f7f5f1] p-6";

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="mt-3">
      <div className="flex justify-end">
        <CopyButton text={code} label="Copy" />
      </div>
      <pre className={`mt-1 overflow-x-auto rounded-lg bg-slate-900 p-3 ${MONO} leading-5 text-slate-100`}>{code}</pre>
    </div>
  );
}

function GroupCard({ g, onTry }: { g: DataGroup; onTry: (id: string) => void }) {
  const ep = endpointById(g.endpointId);
  return (
    <div className="flex flex-col rounded-2xl border border-[#dcd8d0] bg-[#f7f5f1] p-5 transition hover:border-[#2f7bff]">
      <div className="flex items-center gap-2">
        <h3 className="text-[15px] font-semibold" style={{ color: ink }}>
          {g.title}
        </h3>
        <span
          className={`ml-auto inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            g.depth === "deep" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
          }`}
        >
          {g.depth === "deep" ? "deep coverage" : "growing"}
        </span>
      </div>
      <p className="mt-2 text-[13px] leading-5" style={{ color: muted }}>
        {g.blurb}
      </p>
      <div className="mt-3 flex flex-wrap gap-1">
        {g.fields.map((f) => (
          <span key={f} className="rounded-full bg-white px-2 py-0.5 text-[11px] text-slate-500 ring-1 ring-inset ring-slate-200">
            {f}
          </span>
        ))}
      </div>
      <button
        onClick={() => onTry(g.endpointId)}
        className="mt-4 inline-flex items-center gap-1 self-start text-[13px] font-semibold transition hover:gap-2"
        style={{ color: "#2f7bff" }}
      >
        Try <span className={MONO}>{ep?.path}</span> <span aria-hidden>→</span>
      </button>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className={CARD}>
      <div className="flex items-center gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#1a1a1a] text-[13px] font-bold text-white">
          {n}
        </span>
        <h2 className="text-[16px] font-semibold" style={{ color: ink }}>
          {title}
        </h2>
      </div>
      <div className="mt-3 text-[14px] leading-6" style={{ color: muted }}>
        {children}
      </div>
    </div>
  );
}

export function QuickstartClient() {
  const base = baseUrl();
  const [selectedId, setSelectedId] = useState("fluids");

  const jumpTo = useCallback((id: string) => {
    setSelectedId(id);
    // Defer the scroll so the endpoint switch paints first.
    requestAnimationFrame(() => {
      document.getElementById("playground")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);

  const fluidsCall = `curl '${base}/v1/fluids?config_key=2019_honda_cr_v_ex_l15be' \\\n  -H 'Authorization: Bearer otp_live_…'`;
  const includeCall = `curl '${base}/v1/vehicle?config_key=2019_honda_cr_v_ex_l15be&include=fluids,tires' \\\n  -H 'Authorization: Bearer otp_live_…'`;

  return (
    <main className="min-h-screen w-full bg-[#eceae6] px-4 pb-24 pt-10 md:pt-12">
      <div className="mx-auto max-w-5xl">
        <Link href="/developers" className="text-[14px] font-semibold hover:opacity-70" style={{ color: ink }}>
          ← Developers
        </Link>
        <div className="mt-4 flex items-end gap-4">
          <h1 className="text-3xl md:text-4xl" style={{ fontFamily: "var(--font-Lora)", color: ink }}>
            Quickstart
          </h1>
          <Link href="/developers/docs" className="ml-auto text-[14px] font-semibold hover:opacity-70" style={{ color: "#2f7bff" }}>
            Full reference →
          </Link>
        </div>
        <p className="mt-3 max-w-2xl text-[15px] leading-7" style={{ color: muted }}>
          Not another VIN decoder. Real OEM fluid capacities, exact-fit part numbers with live prices, service
          intervals, and labor measured from real jobs — every value tagged with where it came from. See exactly what
          you can pull, then run it live below. Free tier: one key, all read scopes, 60 requests/min, no card.
        </p>

        {/* ── Act 1: What you can pull ──────────────────────────────────── */}
        <section className="mt-12">
          <h2 className="text-2xl" style={{ fontFamily: "var(--font-Lora)", color: ink }}>
            What you can pull
          </h2>
          <p className="mt-2 max-w-2xl text-[14px] leading-6" style={{ color: muted }}>
            Identify a vehicle by VIN, year/make/model, or config key — then pull any of these groups on its own, or all
            at once. Tap a card to load it into the live console.
          </p>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {DATA_GROUPS.map((g) => (
              <GroupCard key={g.title} g={g} onTry={jumpTo} />
            ))}
          </div>
        </section>

        {/* ── Act 2: The live console ───────────────────────────────────── */}
        <section id="playground" className="mt-14 scroll-mt-6">
          <div className="flex items-end gap-3">
            <h2 className="text-2xl" style={{ fontFamily: "var(--font-Lora)", color: ink }}>
              Try it live
            </h2>
            <span className="mb-1 text-[13px]" style={{ color: muted }}>
              real requests against this deployment
            </span>
          </div>
          <p className="mt-2 max-w-2xl text-[14px] leading-6" style={{ color: muted }}>
            Every endpoint is pre-loaded with a real sample, so you can explore the shape with no key. Paste a key to
            run it for real and swap the sample for live data — as a structured render or raw JSON.
          </p>
          <div className="mt-6">
            <Playground selectedId={selectedId} onSelectId={setSelectedId} />
          </div>
        </section>

        {/* ── Act 3a: Provenance model ──────────────────────────────────── */}
        <section className="mt-16 rounded-2xl border border-[#dcd8d0] bg-[#1a1a1a] p-8">
          <h2 className="text-2xl text-white" style={{ fontFamily: "var(--font-Lora)" }}>
            Provenance is the product.
          </h2>
          <p className="mt-3 max-w-2xl text-[14px] leading-7 text-[#cfcabf]">
            Every served field carries a <strong className="text-white">layer</strong> (A OEM · C sourced · D empirical ·
            E verified), a <strong className="text-white">confidence</strong>, and a{" "}
            <strong className="text-white">source_domain</strong>. Licensed rows we can&apos;t sell aren&apos;t hidden —
            they come back in <code className={`${MONO} text-white`}>excluded[]</code> with the blocking layer. The gate
            is visible, never silent — you saw the chips in the console above.
          </p>
        </section>

        {/* ── Act 3b: The 60-second path ────────────────────────────────── */}
        <section className="mt-12">
          <h2 className="text-2xl" style={{ fontFamily: "var(--font-Lora)", color: ink }}>
            The 60-second path
          </h2>
          <div className="mt-6 space-y-4">
            <Step n={1} title="Mint your key">
              <p>
                Sign in on the{" "}
                <Link href="/developers" className="underline" style={{ color: ink }}>
                  developer dashboard
                </Link>{" "}
                and hit <strong>Mint my key</strong>. The full key (<code className={MONO}>otp_live_…</code>) is shown{" "}
                <strong>exactly once</strong> — copy it, then paste it into the console above.
              </p>
            </Step>
            <Step n={2} title="Make your first call">
              <p>
                Look up a vehicle by year / make / model (or VIN, or config_key). Matched more than one config? You get a{" "}
                <code className={MONO}>409 multiple_matches</code> with the candidate{" "}
                <code className={MONO}>config_key</code>s — re-send with one (or add <code className={MONO}>&amp;trim=</code>).
              </p>
            </Step>
            <Step n={3} title="Go granular">
              <p>Don&apos;t need the whole payload? Hit a single group — fluids, tires, maintenance-schedule, parts, specs:</p>
              <CodeBlock code={fluidsCall} />
              <p className="mt-2">Or field-select the flagship endpoint with ?include=:</p>
              <CodeBlock code={includeCall} />
            </Step>
          </div>
        </section>

        <div className="mt-10 rounded-2xl border border-[#dcd8d0] bg-[#f7f5f1] p-6 text-center">
          <p className="text-[14px]" style={{ color: muted }}>
            Full endpoint list, error codes, and the data-layer model live in the{" "}
            <Link href="/developers/docs" className="font-semibold underline" style={{ color: ink }}>
              interactive reference
            </Link>
            .
          </p>
        </div>
      </div>
    </main>
  );
}
