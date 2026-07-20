"use client";

// Shared vehicle-config picker for every Data-portal surface that needs a
// config. Nobody outside the team knows config_keys, so the picker leads
// with the two human paths — VIN and Year/Make/Model[/Trim] — and keeps the
// raw config_key search as the expert third tab. Backed by
// convex/dataVehicleResolve (same YMMT normalization as the /v0 API).

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";

export type PickedConfig = { id: string; config_key: string };

type ConfigMatch = {
  id: string;
  config_key: string;
  year: number;
  trim_name: string | null;
  engine_label: string | null;
  pricing_tier: string | null;
  enrichment_status: string | null;
};

const MODES = ["VIN", "Year/Make/Model", "config_key"] as const;
type Mode = (typeof MODES)[number];

export function ConfigPicker({
  token,
  selected,
  onSelect,
  label = "Vehicle",
}: {
  token: string;
  selected: PickedConfig | null;
  onSelect: (config: PickedConfig | null) => void;
  label?: string;
}) {
  const [mode, setMode] = useState<Mode>("VIN");
  const [open, setOpen] = useState(false);
  // VIN mode
  const [vin, setVin] = useState("");
  const [vinArmed, setVinArmed] = useState(false);
  // YMMT mode
  const [year, setYear] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [trim, setTrim] = useState("");
  const [ymmtArmed, setYmmtArmed] = useState(false);
  // search mode
  const [search, setSearch] = useState("");

  const facets = useQuery(api.dataVehicleResolve.facets, open ? { token } : "skip");

  const yearNum = parseInt(year, 10);
  const resolveArgs =
    mode === "VIN" && vinArmed && vin.trim().length >= 11
      ? { token, vin: vin.trim() }
      : mode === "Year/Make/Model" && ymmtArmed && !isNaN(yearNum) && make.trim() && model.trim()
        ? {
            token,
            year: yearNum,
            make: make.trim(),
            model: model.trim(),
            trim: trim.trim() || undefined,
          }
        : mode === "config_key" && search.trim().length >= 2
          ? { token, search: search.trim() }
          : null;

  const result = useQuery(api.dataVehicleResolve.resolve, resolveArgs ?? "skip");

  const pick = (m: ConfigMatch) => {
    onSelect({ id: m.id, config_key: m.config_key });
    setOpen(false);
    setVinArmed(false);
    setYmmtArmed(false);
  };

  return (
    <div className="relative">
      <label className="text-xs font-semibold text-slate-600">{label}</label>
      {/* Selected chip / open trigger */}
      {selected && !open ? (
        <div className="mt-1.5 flex items-center gap-2">
          <span className="rounded-lg border-[1.5px] border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[13px] text-slate-900">
            {selected.config_key}
          </span>
          <button
            onClick={() => setOpen(true)}
            className="rounded-md px-2 py-1 text-[12px] font-medium text-blue-600 hover:bg-blue-50"
          >
            change
          </button>
          <button
            onClick={() => onSelect(null)}
            className="rounded-md px-2 py-1 text-[12px] font-medium text-slate-400 hover:bg-slate-100"
          >
            clear
          </button>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className={`mt-1.5 w-full rounded-lg border-[1.5px] border-slate-200 px-3 py-2 text-left text-sm text-slate-400 hover:border-blue-400 ${open ? "hidden" : ""}`}
        >
          Find by VIN, year/make/model, or config_key…
        </button>
      )}

      {open && (
        <div className="mt-1.5 rounded-xl border-[1.5px] border-blue-400 bg-white p-3 shadow-lg">
          <div className="flex items-center gap-1">
            {MODES.map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${
                  mode === m ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {m}
              </button>
            ))}
            <button
              onClick={() => setOpen(false)}
              className="ml-auto rounded-md px-2 py-1 text-[12px] text-slate-400 hover:bg-slate-100"
            >
              close
            </button>
          </div>

          {mode === "VIN" && (
            <div className="mt-2 flex gap-2">
              <input
                value={vin}
                onChange={(e) => {
                  setVin(e.target.value);
                  setVinArmed(false);
                }}
                onKeyDown={(e) => e.key === "Enter" && setVinArmed(true)}
                placeholder="17-char VIN — e.g. 4T1G11AK5MU123456"
                className="w-full rounded-lg border-[1.5px] border-slate-200 px-3 py-2 font-mono text-[13px] uppercase outline-none focus:border-blue-500"
                autoFocus
              />
              <button
                onClick={() => setVinArmed(true)}
                className="shrink-0 rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700"
              >
                Look up
              </button>
            </div>
          )}

          {mode === "Year/Make/Model" && (
            <div className="mt-2 space-y-2">
              <div className="flex gap-2">
                <input
                  value={year}
                  onChange={(e) => {
                    setYear(e.target.value);
                    setYmmtArmed(false);
                  }}
                  placeholder="Year"
                  list="config-picker-years"
                  className="w-20 rounded-lg border-[1.5px] border-slate-200 px-2.5 py-2 text-[13px] outline-none focus:border-blue-500"
                  autoFocus
                />
                <input
                  value={make}
                  onChange={(e) => {
                    setMake(e.target.value);
                    setYmmtArmed(false);
                  }}
                  placeholder="Make"
                  list="config-picker-makes"
                  className="w-32 rounded-lg border-[1.5px] border-slate-200 px-2.5 py-2 text-[13px] outline-none focus:border-blue-500"
                />
                <input
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value);
                    setYmmtArmed(false);
                  }}
                  placeholder="Model"
                  className="w-32 rounded-lg border-[1.5px] border-slate-200 px-2.5 py-2 text-[13px] outline-none focus:border-blue-500"
                />
                <input
                  value={trim}
                  onChange={(e) => {
                    setTrim(e.target.value);
                    setYmmtArmed(false);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && setYmmtArmed(true)}
                  placeholder="Trim (optional)"
                  className="w-32 rounded-lg border-[1.5px] border-slate-200 px-2.5 py-2 text-[13px] outline-none focus:border-blue-500"
                />
                <button
                  onClick={() => setYmmtArmed(true)}
                  className="shrink-0 rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700"
                >
                  Find
                </button>
              </div>
              <datalist id="config-picker-years">
                {(facets?.years ?? []).map((y: number) => (
                  <option key={y} value={y} />
                ))}
              </datalist>
              <datalist id="config-picker-makes">
                {(facets?.makes ?? []).map((m: string) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
          )}

          {mode === "config_key" && (
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="config_key contains… (expert path)"
              className="mt-2 w-full rounded-lg border-[1.5px] border-slate-200 px-3 py-2 font-mono text-[13px] outline-none focus:border-blue-500"
              autoFocus
            />
          )}

          {/* Results */}
          {resolveArgs && (
            <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-slate-100">
              {result === undefined ? (
                <div className="px-3 py-2 text-sm text-slate-500">Looking up…</div>
              ) : (
                <>
                  {result.note && (
                    <div className="border-b border-slate-100 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                      {result.note}
                    </div>
                  )}
                  {(result.matches as ConfigMatch[]).map((m) => (
                    <button
                      key={m.id}
                      onClick={() => pick(m)}
                      className="flex w-full items-center gap-2 border-b border-slate-50 px-3 py-2 text-left hover:bg-blue-50"
                    >
                      <span className="truncate font-mono text-[12px] text-slate-800">
                        {m.config_key}
                      </span>
                      {m.trim_name && (
                        <span className={`${pill} bg-slate-100 text-slate-600`}>{m.trim_name}</span>
                      )}
                      {m.engine_label && (
                        <span className={`${pill} bg-slate-100 text-slate-500`}>
                          {m.engine_label}
                        </span>
                      )}
                      {m.pricing_tier && (
                        <span className={`${pill} ml-auto bg-slate-100 text-slate-600`}>
                          {m.pricing_tier}
                        </span>
                      )}
                    </button>
                  ))}
                  {result.truncated && (
                    <div className="px-3 py-1.5 text-[11px] text-slate-400">
                      results truncated — narrow the search
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
