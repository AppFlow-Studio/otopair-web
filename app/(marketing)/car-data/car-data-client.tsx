"use client";

// Public car-data lookup (client half). Marketing brand: #eceae6 canvas,
// Lora display headline, ink #1a1a1a. Input: VIN (assisted by the public
// /api/vin NHTSA decode) or Year/Make/Model[/Trim]. Output: the teaser —
// identity + render + headline specs with layer badges, two sample
// intervals, and the locked-counts card that IS the call to action.

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { LayerLetter } from "@/convex/lib/dataLayers";

type TeaserSpec = { label: string; value: string; layer: LayerLetter };
type Teaser =
  | {
      object: "teaser";
      config: {
        config_key: string;
        year: number;
        make: string;
        model: string;
        trim: string | null;
        engine: string | null;
        drivetrain: string | null;
      };
      image_url: string | null;
      headline_specs: TeaserSpec[];
      sample_intervals: { name: string; display: string }[];
      locked: {
        specs_served: number;
        intervals: number;
        part_fitments: number;
        empirical_labor_services: number;
      };
    }
  | { object: "multiple_matches"; matches: { config_key: string; label: string }[] }
  | null;

const LAYER_TINT: Record<string, string> = {
  A: "#2f7bff",
  C: "#e2a33c",
  D: "#22b07d",
  E: "#8b5cf6",
};

const ink = "#1a1a1a";
const muted = "#6b655d";

export function CarDataClient() {
  const [mode, setMode] = useState<"vin" | "ymmt">("ymmt");
  const [vin, setVin] = useState("");
  const [year, setYear] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [trim, setTrim] = useState("");
  const [armed, setArmed] = useState(false);
  const [pickedKey, setPickedKey] = useState<string | null>(null);

  const makes = useQuery(api.ymmtCatalog.listMakes, {});
  const yearNum = parseInt(year, 10);
  const lookupArgs = pickedKey
    ? { config_key: pickedKey }
    : armed && mode === "vin" && vin.trim().length >= 11
      ? { vin: vin.trim() }
      : armed && mode === "ymmt" && !isNaN(yearNum) && make.trim() && model.trim()
        ? {
            year: yearNum,
            make: make.trim(),
            model: model.trim(),
            trim: trim.trim() || undefined,
          }
        : null;
  const result = useQuery(
    api.dataPublic.teaserLookup,
    lookupArgs ?? "skip",
  ) as Teaser | undefined;

  const search = () => {
    setPickedKey(null);
    setArmed(true);
  };

  const inputCls =
    "rounded-xl border border-[#d8d4cc] bg-white/80 px-4 py-3 text-[15px] outline-none focus:border-[#2f7bff] placeholder:text-[#a09a90]";

  return (
    <main className="min-h-screen w-full bg-[#eceae6] px-4 pb-24 pt-28 md:pt-32">
      <div className="mx-auto max-w-3xl">
        {/* Headline */}
        <h1
          className="text-center text-4xl leading-tight md:text-5xl"
          style={{ fontFamily: "var(--font-Lora)", color: ink }}
        >
          Every spec. Every interval.
          <br />
          Your exact car.
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-center text-[15px]" style={{ color: muted }}>
          Maintenance data built from OEM sources and verified by working mechanics —
          fluid specs, service intervals, parts and real-world labor times.
        </p>

        {/* Lookup card */}
        <div className="mt-10 rounded-2xl border border-[#dcd8d0] bg-[#f7f5f1] p-6 shadow-sm">
          <div className="flex gap-1 rounded-xl bg-[#e5e1da] p-1">
            {(["ymmt", "vin"] as const).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  setArmed(false);
                  setPickedKey(null);
                }}
                className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold transition ${
                  mode === m ? "bg-white text-[#1a1a1a] shadow-sm" : "text-[#6b655d]"
                }`}
              >
                {m === "ymmt" ? "Year / Make / Model" : "VIN"}
              </button>
            ))}
          </div>

          {mode === "vin" ? (
            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <input
                value={vin}
                onChange={(e) => {
                  setVin(e.target.value.toUpperCase());
                  setArmed(false);
                }}
                onKeyDown={(e) => e.key === "Enter" && search()}
                placeholder="17-character VIN"
                className={`${inputCls} w-full font-mono tracking-wide`}
              />
              <button
                onClick={search}
                className="shrink-0 rounded-xl bg-gradient-to-r from-[rgba(59,130,246,1)] to-[rgba(37,99,235,1)] px-6 py-3 text-[15px] font-semibold text-white shadow-md transition hover:brightness-110"
              >
                Look up
              </button>
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <input
                value={year}
                onChange={(e) => {
                  setYear(e.target.value);
                  setArmed(false);
                }}
                placeholder="Year"
                inputMode="numeric"
                className={inputCls}
              />
              <input
                value={make}
                onChange={(e) => {
                  setMake(e.target.value);
                  setArmed(false);
                }}
                placeholder="Make"
                list="cardata-makes"
                className={inputCls}
              />
              <datalist id="cardata-makes">
                {(makes ?? []).map((m: { _id: string; name: string }) => (
                  <option key={m._id} value={m.name} />
                ))}
              </datalist>
              <input
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  setArmed(false);
                }}
                placeholder="Model"
                className={inputCls}
              />
              <input
                value={trim}
                onChange={(e) => {
                  setTrim(e.target.value);
                  setArmed(false);
                }}
                onKeyDown={(e) => e.key === "Enter" && search()}
                placeholder="Trim (optional)"
                className={inputCls}
              />
              <button
                onClick={search}
                className="col-span-2 rounded-xl bg-gradient-to-r from-[rgba(59,130,246,1)] to-[rgba(37,99,235,1)] px-6 py-3 text-[15px] font-semibold text-white shadow-md transition hover:brightness-110 sm:col-span-1"
              >
                Look up
              </button>
            </div>
          )}
        </div>

        {/* Result */}
        {lookupArgs && (
          <div className="mt-8">
            {result === undefined ? (
              <div className="h-64 animate-pulse rounded-2xl bg-[#e5e1da]" />
            ) : result === null ? (
              <div className="rounded-2xl border border-[#e6c9a0] bg-[#faf3e6] p-6 text-center text-[15px]" style={{ color: "#8a6d3b" }}>
                We don&apos;t have that vehicle in the catalog yet. Coverage grows every
                week — join the waitlist below and we&apos;ll let you know.
              </div>
            ) : result.object === "multiple_matches" ? (
              <div className="rounded-2xl border border-[#dcd8d0] bg-[#f7f5f1] p-6">
                <p className="text-[15px] font-semibold" style={{ color: ink }}>
                  A few configurations match — pick yours:
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {result.matches.map((m) => (
                    <button
                      key={m.config_key}
                      onClick={() => setPickedKey(m.config_key)}
                      className="rounded-full border border-[#d8d4cc] bg-white px-3.5 py-1.5 font-mono text-[12px] text-[#1a1a1a] transition hover:border-[#2f7bff]"
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <TeaserCard t={result} />
            )}
          </div>
        )}

        {/* Bottom CTA strip */}
        <div className="mt-16 text-center">
          <p className="text-[13px]" style={{ color: muted }}>
            Building something with car data?
          </p>
          <a
            href="mailto:data@otopair.com?subject=Data%20API%20access"
            className="mt-2 inline-block rounded-xl border border-[#1a1a1a] px-6 py-3 text-[15px] font-semibold transition hover:bg-[#1a1a1a] hover:text-white"
            style={{ color: ink }}
          >
            Talk to us about API access
          </a>
        </div>
      </div>
    </main>
  );
}

function TeaserCard({ t }: { t: Extract<NonNullable<Teaser>, { object: "teaser" }> }) {
  const lockedTotal =
    Math.max(0, t.locked.specs_served - t.headline_specs.length) +
    Math.max(0, t.locked.intervals - t.sample_intervals.length) +
    t.locked.part_fitments +
    t.locked.empirical_labor_services;
  return (
    <div className="overflow-hidden rounded-2xl border border-[#dcd8d0] bg-white shadow-sm">
      {/* Identity band */}
      <div className="flex flex-wrap items-center gap-5 border-b border-[#eceae6] bg-[#f7f5f1] p-6">
        {t.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={t.image_url}
            alt={`${t.config.year} ${t.config.make} ${t.config.model}`}
            className="h-24 w-40 rounded-xl bg-white object-contain"
          />
        ) : (
          <div className="flex h-24 w-40 items-center justify-center rounded-xl border border-dashed border-[#d8d4cc] text-[12px] text-[#a09a90]">
            render coming soon
          </div>
        )}
        <div>
          <div className="text-2xl font-semibold" style={{ fontFamily: "var(--font-Lora)", color: ink }}>
            {t.config.year} {t.config.make} {t.config.model}
          </div>
          <div className="mt-1 text-[14px]" style={{ color: muted }}>
            {[t.config.trim, t.config.engine, t.config.drivetrain].filter(Boolean).join(" · ") ||
              "base configuration"}
          </div>
        </div>
      </div>

      {/* Free rows */}
      <div className="p-6">
        {t.headline_specs.length === 0 && t.sample_intervals.length === 0 ? (
          <p className="text-[14px]" style={{ color: muted }}>
            This configuration is in the catalog but its enrichment is still filling in —
            check back soon.
          </p>
        ) : (
          <div className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
            {t.headline_specs.map((s) => (
              <div key={s.label} className="flex items-center justify-between border-b border-[#f1efe9] py-2">
                <span className="text-[13px]" style={{ color: muted }}>
                  {s.label}
                </span>
                <span className="flex items-center gap-2 text-[14px] font-medium" style={{ color: ink }}>
                  {s.value}
                  <span
                    className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white"
                    style={{ backgroundColor: LAYER_TINT[s.layer] ?? "#94a3b8" }}
                    title={`Data layer ${s.layer} — every value carries tracked provenance (A = OEM/official, C = researched, D = measured on real jobs, E = mechanic-verified)`}
                  >
                    {s.layer}
                  </span>
                </span>
              </div>
            ))}
            {t.sample_intervals.map((iv) => (
              <div key={iv.name} className="flex items-center justify-between border-b border-[#f1efe9] py-2">
                <span className="text-[13px]" style={{ color: muted }}>
                  {iv.name} interval
                </span>
                <span className="text-[14px] font-medium" style={{ color: ink }}>
                  {iv.display}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Locked card — the CTA */}
        <div className="mt-6 rounded-xl border border-[#e0dcd4] bg-[#faf9f6] p-5">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[14px]" style={{ color: ink }}>
            <span className="font-semibold">🔒 In the full report:</span>
            <span>{t.locked.specs_served} maintenance specs</span>
            <span>{t.locked.intervals} OEM service intervals</span>
            <span>{t.locked.part_fitments} exact-fit OEM parts</span>
            {t.locked.empirical_labor_services > 0 && (
              <span>{t.locked.empirical_labor_services} real-world labor times</span>
            )}
          </div>
          <p className="mt-2 text-[13px]" style={{ color: muted }}>
            {lockedTotal > 0
              ? "Every value carries its source and confidence — OEM documents, verified mechanic data, and measurements from real jobs."
              : "This configuration is still enriching."}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <a
              href="mailto:data@otopair.com?subject=Full%20vehicle%20report"
              className="rounded-xl bg-gradient-to-r from-[rgba(59,130,246,1)] to-[rgba(37,99,235,1)] px-5 py-2.5 text-[14px] font-semibold text-white shadow-md transition hover:brightness-110"
            >
              Get the full report
            </a>
            <a
              href="mailto:data@otopair.com?subject=Data%20API%20access"
              className="rounded-xl border border-[#1a1a1a] px-5 py-2.5 text-[14px] font-semibold transition hover:bg-[#1a1a1a] hover:text-white"
              style={{ color: ink }}
            >
              API access
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
