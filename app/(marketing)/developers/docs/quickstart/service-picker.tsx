"use client";

// Searchable service-slug picker for the playground's `?service=` filter
// (/v1/parts, /v0/labor). Options come from the public catalog
// (dataPublic.listServices) — the exact slug set the API accepts. Label shows
// "Name · slug" so you can search by either; the value committed is the slug.
// Custom typing stays allowed (allowCustomValue) so any slug can be tried.

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";

const INPUT =
  "w-full rounded-lg border border-[#dcd8d0] bg-white px-3 py-2 text-[13px] text-slate-800 outline-none placeholder:text-slate-300 focus:border-[#2f7bff]";

export function ServicePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const services = useQuery(api.dataPublic.listServices);
  const options = useMemo<ComboboxOption[]>(
    () => (services ?? []).map((s) => ({ value: s.slug, label: `${s.name} · ${s.slug}` })),
    [services],
  );
  return (
    <Combobox
      value={value}
      onChange={onChange}
      options={options}
      loading={services === undefined}
      inputClassName={`${INPUT} font-mono`}
      placeholder="all services — or pick one"
      emptyText={services === undefined ? "Loading…" : "No matches — type a slug"}
      ariaLabel="Service"
    />
  );
}
