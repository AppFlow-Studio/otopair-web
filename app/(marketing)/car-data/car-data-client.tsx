"use client";

// Public car-data lookup (client half). Rendered inside the page shell
// (design pass 2026-09-05): the site's paper plate, pills and fields. Input: VIN (assisted by the public
// /api/vin NHTSA decode) or Year/Make/Model[/Trim]. Output: the teaser —
// identity + render + headline specs with layer badges, two sample
// intervals, and the locked-counts card that IS the call to action.
//
// Motion (docs/design/motion.md): the two static blocks — the lookup card
// and the closing CTA strip — settle on entry as whole blocks. The fields
// inside them never animate on their own, and the result region below is
// deliberately left static: it re-renders on every query, and a reveal
// there would re-play or flash each time the lookup changes.

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { LayerLetter } from "@/convex/lib/dataLayers";
import { Reveal } from "@/components/flagship/landing/reveal";
import { OTOINDEX } from "@/lib/otoindex";

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
const serif = { fontFamily: "var(--font-Petrona)", fontWeight: 400 } as const;
const BTN = "inline-flex h-12 items-center justify-center rounded-full bg-[#1a1a1a] px-6 text-[15px] font-medium text-white transition-[transform,box-shadow] duration-300 hover:-translate-y-px hover:shadow-[0_16px_36px_-14px_rgba(26,26,26,0.55)]";
const BTN_OUT = "inline-flex h-12 items-center justify-center rounded-full border border-[#1a1a1a]/20 bg-white px-6 text-[15px] font-medium text-[#1a1a1a] transition-colors hover:border-[#1a1a1a]";
const BTN_SM = "inline-flex h-11 items-center justify-center rounded-full bg-[#1a1a1a] px-5 text-[14px] font-medium text-white transition-[transform,box-shadow] duration-300 hover:-translate-y-px";
const BTN_OUT_SM = "inline-flex h-11 items-center justify-center rounded-full border border-[#1a1a1a]/20 bg-white px-5 text-[14px] font-medium text-[#1a1a1a] transition-colors hover:border-[#1a1a1a]";

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
    "h-12 rounded-full border border-[#1a1a1a]/12 bg-white px-5 text-[15px] text-[#1a1a1a] outline-none placeholder:text-[#8f8a82] focus-visible:border-[#4B82A5] focus-visible:ring-2 focus-visible:ring-[#4B82A5]/30";

  return (
    <div className="w-full">
      <div className="mx-auto max-w-3xl">
        {/* Lookup card */}
        <Reveal>
          <div className="rounded-[28px] bg-[#f7f6f3] p-6 tab:rounded-[40px] tab:p-8" style={{ boxShadow: "inset 0 0 0 1px rgba(26,26,26,0.06)" }}>
            <div className="flex gap-1 rounded-full bg-[#1a1a1a]/[0.06] p-1">
              {(["ymmt", "vin"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    setMode(m);
                    setArmed(false);
                    setPickedKey(null);
                  }}
                  className={`flex-1 rounded-full px-4 py-2 text-[14px] font-medium transition ${
                    mode === m ? "bg-white text-[#1a1a1a] shadow-[0_1px_3px_rgba(26,26,26,0.08)]" : "text-[#6b655d]"
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
                  className={`shrink-0 ${BTN}`}
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
                  className={`col-span-2 sm:col-span-1 ${BTN}`}
                >
                  Look up
                </button>
              </div>
            )}
          </div>
        </Reveal>

        {/* Result */}
        {lookupArgs && (
          <div className="mt-8">
            {result === undefined ? (
              <div className="h-64 animate-pulse rounded-[28px] bg-[#1a1a1a]/[0.05]" />
            ) : result === null ? (
              <div className="rounded-[28px] bg-[#f7f6f3] p-6 text-center text-[15px] text-[#4c5661]" style={{ boxShadow: "inset 0 0 0 1px rgba(26,26,26,0.06)" }}>
                We don&apos;t have that vehicle in the catalog yet. Coverage grows every week; email
                data@otopair.com and we will let you know when it lands.
              </div>
            ) : result.object === "multiple_matches" ? (
              <div className="rounded-[28px] bg-[#f7f6f3] p-6" style={{ boxShadow: "inset 0 0 0 1px rgba(26,26,26,0.06)" }}>
                <p className="text-[15px] font-semibold" style={{ color: ink }}>
                  A few configurations match. Pick yours:
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {result.matches.map((m) => (
                    <button
                      key={m.config_key}
                      onClick={() => setPickedKey(m.config_key)}
                      className="rounded-full border border-[#1a1a1a]/12 bg-white px-3.5 py-1.5 font-mono text-[12px] text-[#1a1a1a] transition hover:border-[#4B82A5]"
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
        <Reveal>
          <div className="mt-16 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-[#1a1a1a]/10 pt-8">
            <p className="text-[15px]" style={{ color: muted }}>
              Building something with car data?
            </p>
            <a href={OTOINDEX.docs} className={BTN_OUT}>
              The OtoIndex API docs
            </a>
            <a
              href="mailto:data@otopair.com?subject=Data%20API%20access"
              className="text-[14px] text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]"
            >
              Or email data@otopair.com
            </a>
          </div>
        </Reveal>
      </div>
    </div>
  );
}

function TeaserCard({ t }: { t: Extract<NonNullable<Teaser>, { object: "teaser" }> }) {
  const lockedTotal =
    Math.max(0, t.locked.specs_served - t.headline_specs.length) +
    Math.max(0, t.locked.intervals - t.sample_intervals.length) +
    t.locked.part_fitments +
    t.locked.empirical_labor_services;
  return (
    <div className="overflow-hidden rounded-[28px] bg-white ring-1 ring-[#1a1a1a]/[0.08] shadow-[0_1px_2px_rgba(26,26,26,0.04)]">
      {/* Identity band */}
      <div className="flex flex-wrap items-center gap-5 border-b border-[#1a1a1a]/8 bg-[#f7f6f3] p-6">
        {t.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={t.image_url}
            alt={`${t.config.year} ${t.config.make} ${t.config.model}`}
            className="h-24 w-40 rounded-[16px] bg-white object-contain"
          />
        ) : (
          // No render on file yet: the pin mark on the same plate, never a
          // dashed box with text where a picture belongs.
          <div className="flex h-24 w-40 items-center justify-center rounded-[16px] bg-[#f1efe9]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/images/landing/pin-logo.png" alt="" width={44} height={44} className="h-[44px] w-[44px] object-contain opacity-70" />
          </div>
        )}
        <div>
          <div className="text-[24px]" style={{ ...serif, color: ink }}>
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
            This configuration is in the catalog but its enrichment is still filling in.
            Check back soon.
          </p>
        ) : (
          <div className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
            {t.headline_specs.map((s) => (
              <div key={s.label} className="flex items-center justify-between border-b border-[#1a1a1a]/8 py-2">
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
              <div key={iv.name} className="flex items-center justify-between border-b border-[#1a1a1a]/8 py-2">
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
        <div className="mt-6 rounded-[20px] bg-[#f7f6f3] p-5" style={{ boxShadow: "inset 0 0 0 1px rgba(26,26,26,0.06)" }}>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[14px]" style={{ color: ink }}>
            <span className="font-semibold">In the full report:</span>
            <span>{t.locked.specs_served} maintenance specs</span>
            <span>{t.locked.intervals} OEM service intervals</span>
            <span>{t.locked.part_fitments} exact-fit OEM parts</span>
            {t.locked.empirical_labor_services > 0 && (
              <span>{t.locked.empirical_labor_services} real-world labor times</span>
            )}
          </div>
          <p className="mt-2 text-[13px]" style={{ color: muted }}>
            {lockedTotal > 0
              ? "Every value carries its source and confidence: OEM documents, verified mechanic data, and measurements from real jobs."
              : "This configuration is still enriching."}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <a
              href="mailto:data@otopair.com?subject=Full%20vehicle%20report"
              className={BTN_SM}
            >
              Get the full report
            </a>
            <a
              href="mailto:data@otopair.com?subject=Data%20API%20access"
              className={BTN_OUT_SM}
            >
              API access
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
