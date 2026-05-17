"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { drawerInputClassName, DrawerFieldLabel } from "@/components/drawer-panel-styles";

interface VehicleYMMTPickerProps {
  year: string;
  make: string;
  model: string;
  trim: string;
  onChange: (next: { year?: string; make?: string; model?: string; trim?: string }) => void;
}

const MIN_YEAR = 1981;

function buildYearOptions(): ComboboxOption[] {
  const max = new Date().getFullYear() + 1;
  const opts: ComboboxOption[] = [];
  for (let y = max; y >= MIN_YEAR; y--) {
    opts.push({ value: String(y), label: String(y) });
  }
  return opts;
}

function findMakeIdByName(
  makes: Array<{ _id: Id<"makes">; name: string }> | undefined,
  name: string
): Id<"makes"> | null {
  if (!makes || !name) return null;
  const norm = name.trim().toLowerCase();
  return makes.find((m) => m.name.trim().toLowerCase() === norm)?._id ?? null;
}

function findModelIdByName(
  models: Array<{ _id: Id<"models">; name: string }> | null | undefined,
  name: string
): Id<"models"> | null {
  if (!models || !name) return null;
  const norm = name.trim().toLowerCase();
  return models.find((m) => m.name.trim().toLowerCase() === norm)?._id ?? null;
}

export default function VehicleYMMTPicker({
  year,
  make,
  model,
  trim,
  onChange,
}: VehicleYMMTPickerProps) {
  const yearOptions = useMemo(buildYearOptions, []);

  const makes = useQuery(api.ymmtCatalog.listMakes);
  const ensureModels = useAction(api.ymmtCatalog.ensureModelsForMakeYear);
  const ensureTrims = useAction(api.ymmtCatalog.ensureTrimsForModelYear);

  const yearNum = year && /^\d{4}$/.test(year) ? Number(year) : null;
  const makeId = findMakeIdByName(makes, make);

  const models = useQuery(
    api.ymmtCatalog.listModelsForMakeYear,
    makeId && yearNum ? { makeId, year: yearNum } : "skip"
  );

  const modelId = findModelIdByName(models ?? undefined, model);

  const trims = useQuery(
    api.ymmtCatalog.listTrimsForModelYear,
    modelId && yearNum ? { modelId, year: yearNum } : "skip"
  );

  const [modelLoading, setModelLoading] = useState(false);
  const [trimLoading, setTrimLoading] = useState(false);
  const lastModelFetch = useRef<string>("");
  const lastTrimFetch = useRef<string>("");

  useEffect(() => {
    if (!makeId || !yearNum) return;
    if (models !== null) return;
    const key = `${makeId}:${yearNum}`;
    if (lastModelFetch.current === key) return;
    lastModelFetch.current = key;
    setModelLoading(true);
    ensureModels({ makeId, year: yearNum }).finally(() => setModelLoading(false));
  }, [makeId, yearNum, models, ensureModels]);

  useEffect(() => {
    if (!modelId || !yearNum) return;
    if (trims !== null) return;
    const key = `${modelId}:${yearNum}`;
    if (lastTrimFetch.current === key) return;
    lastTrimFetch.current = key;
    setTrimLoading(true);
    ensureTrims({ modelId, year: yearNum }).finally(() => setTrimLoading(false));
  }, [modelId, yearNum, trims, ensureTrims]);

  const makeOptions: ComboboxOption[] = useMemo(
    () => (makes ?? []).map((m) => ({ value: m.name, label: m.name })),
    [makes]
  );
  const modelOptions: ComboboxOption[] = useMemo(
    () => (models ?? []).map((m) => ({ value: m.name, label: m.name })),
    [models]
  );
  const trimOptions: ComboboxOption[] = useMemo(
    () => (trims ?? []).map((t) => ({ value: t.name, label: t.name })),
    [trims]
  );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <DrawerFieldLabel>Year</DrawerFieldLabel>
          <Combobox
            value={year}
            onChange={(v) => onChange({ year: v, model: "", trim: "" })}
            options={yearOptions}
            inputClassName={drawerInputClassName}
            placeholder="2024"
          />
        </div>
        <div className="col-span-2">
          <DrawerFieldLabel>Make</DrawerFieldLabel>
          <Combobox
            value={make}
            onChange={(v) => onChange({ make: v, model: "", trim: "" })}
            options={makeOptions}
            inputClassName={drawerInputClassName}
            placeholder="Toyota"
          />
        </div>
      </div>
      <div>
        <DrawerFieldLabel>Model</DrawerFieldLabel>
        <Combobox
          value={model}
          onChange={(v) => onChange({ model: v, trim: "" })}
          options={modelOptions}
          loading={modelLoading}
          disabled={!yearNum || !make}
          inputClassName={drawerInputClassName}
          placeholder={!yearNum || !make ? "Pick year + make first" : "Camry"}
          emptyText={modelLoading ? "Loading…" : "No matches — type to add"}
        />
      </div>
      <div>
        <DrawerFieldLabel>
          Trim{" "}
          <span className="normal-case tracking-normal font-normal text-muted-foreground/60">
            (Optional)
          </span>
        </DrawerFieldLabel>
        <Combobox
          value={trim}
          onChange={(v) => onChange({ trim: v })}
          options={trimOptions}
          loading={trimLoading}
          disabled={!model}
          inputClassName={drawerInputClassName}
          placeholder={!model ? "Pick model first" : "XLE"}
          emptyText={trimLoading ? "Loading…" : "Type a trim"}
        />
      </div>
    </div>
  );
}
