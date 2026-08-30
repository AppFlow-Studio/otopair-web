"use client";

// Searchable YMMT picker for the playground — cascading Year → Make → Model →
// Trim comboboxes driven by the real catalog (convex/ymmtCatalog). Makes are
// listed up front; models/trims lazy-cache from NHTSA vPIC via the ensure*
// actions the moment a make+year (then model+year) is chosen — the same
// pattern the booking picker uses. Custom typing stays allowed, so the console
// never blocks a valid API query just because the catalog hasn't seen it yet.

import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";

const INPUT =
  "w-full rounded-lg border border-[#dcd8d0] bg-white px-3 py-2 text-[13px] text-slate-800 outline-none placeholder:text-slate-300 focus:border-[#2f7bff]";
const MIN_YEAR = 1981;

export type YmmtValue = { year: string; make: string; model: string; trim: string };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-slate-400">{label}</span>
      {children}
    </label>
  );
}

export function YmmtPicker({
  value,
  onChange,
}: {
  value: YmmtValue;
  onChange: (patch: Partial<YmmtValue>) => void;
}) {
  const yearOptions = useMemo<ComboboxOption[]>(() => {
    const max = new Date().getFullYear() + 1;
    const opts: ComboboxOption[] = [];
    for (let y = max; y >= MIN_YEAR; y--) opts.push({ value: String(y), label: String(y) });
    return opts;
  }, []);

  const makes = useQuery(api.ymmtCatalog.listMakes);
  const ensureModels = useAction(api.ymmtCatalog.ensureModelsForMakeYear);
  const ensureTrims = useAction(api.ymmtCatalog.ensureTrimsForModelYear);

  const yearNum = value.year && /^\d{4}$/.test(value.year) ? Number(value.year) : null;

  const makeId = useMemo(() => {
    if (!makes || !value.make) return null;
    const norm = value.make.trim().toLowerCase();
    return makes.find((m) => m.name.trim().toLowerCase() === norm)?._id ?? null;
  }, [makes, value.make]);

  const models = useQuery(
    api.ymmtCatalog.listModelsForMakeYear,
    makeId && yearNum ? { makeId, year: yearNum } : "skip",
  );

  const modelId = useMemo(() => {
    if (!models || !value.model) return null;
    const norm = value.model.trim().toLowerCase();
    return models.find((m) => m.name.trim().toLowerCase() === norm)?._id ?? null;
  }, [models, value.model]);

  const trims = useQuery(
    api.ymmtCatalog.listTrimsForModelYear,
    modelId && yearNum ? { modelId, year: yearNum } : "skip",
  );

  const [modelLoading, setModelLoading] = useState(false);
  const [trimLoading, setTrimLoading] = useState(false);
  const lastModelFetch = useRef("");
  const lastTrimFetch = useRef("");

  // A null query result means "make+year not cached yet" — warm it once.
  useEffect(() => {
    if (!makeId || !yearNum || models !== null) return;
    const key = `${makeId}:${yearNum}`;
    if (lastModelFetch.current === key) return;
    lastModelFetch.current = key;
    setModelLoading(true);
    ensureModels({ makeId, year: yearNum }).finally(() => setModelLoading(false));
  }, [makeId, yearNum, models, ensureModels]);

  useEffect(() => {
    if (!modelId || !yearNum || trims !== null) return;
    const key = `${modelId}:${yearNum}`;
    if (lastTrimFetch.current === key) return;
    lastTrimFetch.current = key;
    setTrimLoading(true);
    ensureTrims({ modelId, year: yearNum }).finally(() => setTrimLoading(false));
  }, [modelId, yearNum, trims, ensureTrims]);

  const makeOptions = useMemo<ComboboxOption[]>(
    () => (makes ?? []).map((m) => ({ value: m.name, label: m.name })),
    [makes],
  );
  const modelOptions = useMemo<ComboboxOption[]>(
    () => (models ?? []).map((m) => ({ value: m.name, label: m.name })),
    [models],
  );
  const trimOptions = useMemo<ComboboxOption[]>(
    () => (trims ?? []).map((t) => ({ value: t.name, label: t.name })),
    [trims],
  );

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Field label="year">
        <Combobox
          value={value.year}
          onChange={(v) => onChange({ year: v, model: "", trim: "" })}
          options={yearOptions}
          inputClassName={INPUT}
          placeholder="2019"
          ariaLabel="Year"
        />
      </Field>
      <Field label="make">
        <Combobox
          value={value.make}
          onChange={(v) => onChange({ make: v, model: "", trim: "" })}
          options={makeOptions}
          loading={makes === undefined}
          inputClassName={INPUT}
          placeholder="Honda"
          ariaLabel="Make"
        />
      </Field>
      <Field label="model">
        <Combobox
          value={value.model}
          onChange={(v) => onChange({ model: v, trim: "" })}
          options={modelOptions}
          loading={modelLoading}
          disabled={!yearNum || !value.make}
          inputClassName={INPUT}
          placeholder={!yearNum || !value.make ? "year + make first" : "CR-V"}
          emptyText={modelLoading ? "Loading…" : "No matches — type to add"}
          ariaLabel="Model"
        />
      </Field>
      <Field label="trim (optional)">
        <Combobox
          value={value.trim}
          onChange={(v) => onChange({ trim: v })}
          options={trimOptions}
          loading={trimLoading}
          disabled={!value.model}
          inputClassName={INPUT}
          placeholder={!value.model ? "model first" : "EX"}
          emptyText={trimLoading ? "Loading…" : "Type a trim"}
          ariaLabel="Trim"
        />
      </Field>
    </div>
  );
}
