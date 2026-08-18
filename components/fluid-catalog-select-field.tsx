"use client";

/**
 * Shared single-column fluid picker fed by the Otopair OEM catalog + the scraped
 * `oem_parts` pool (via `fluidCatalog.listForVehicle`). The vehicle's own make is
 * pinned to the top of each group; the raw list paginates ("Show more"); an
 * "Other…" escape hatch reveals a free-text field so an un-scraped fluid stays
 * enterable. Stores the chosen product NAME (free string), matching the passport
 * `fluids.*_type` shape.
 *
 * Used by BOTH the post-job survey (components/post-job-survey-dialog.tsx) and
 * the pre-job multi-point inspection (components/multi-point-inspection-dialog.tsx)
 * so the two never drift.
 */

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import {
  Select,
  SelectItem,
  SelectListBox,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/convex/_generated/api";
import { cn } from "@/lib/utils";

// Fluid prompt keys whose picker is backed by the scraped fluid CATALOG (a
// specific OEM product) rather than a generic chemistry bucket. Oil is
// deliberately absent — it's chosen by grade + type, not as one SKU — and so
// are the tire/pad fields, which aren't fluids.
export const FLUID_KIND_BY_KEY: Record<string, string> = {
  coolant_type: "coolant",
  transmission_fluid_type: "atf_fluid",
  brake_fluid_type: "brake_fluid",
  power_steering_fluid_type: "ps_fluid",
};

export type FluidCatalogOption = {
  value: string;
  label: string;
  sublabel: string | null;
  oem_part_number: string | null;
  make_match: boolean;
};

const OTHER_OPTION_ID = "__other__";
// How many raw (scraped) rows to reveal per "Show more" click.
const FLUID_CATALOG_PAGE = 40;

const fluidSelectTrigger =
  "bg-background h-10 rounded-lg border border-primary/15 px-3 text-[13px] text-foreground sm:w-64 w-full justify-between";
const fluidSelectItem = "min-h-0 rounded-sm px-2.5 py-1.5 text-[13px]";
const fluidOtherInput =
  "mt-2 w-full rounded-lg border border-primary/15 bg-background px-3 py-2 text-[13px] outline-none focus:border-primary sm:w-64";

function FluidCatalogOptionRow({
  option,
  showMakeBadge,
}: {
  option: FluidCatalogOption;
  showMakeBadge: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <span className="truncate">{option.label}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        {option.make_match && showMakeBadge ? (
          <span className="rounded bg-primary/10 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary">
            OEM
          </span>
        ) : null}
        {option.sublabel ? (
          <span className="max-w-[8.5rem] truncate text-[11px] text-muted-foreground">
            {option.sublabel}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function FluidCatalogSelectField({
  value,
  onChange,
  fluidKind,
  vin,
  placeholder,
  otherPlaceholder,
}: {
  value: string;
  onChange: (next: string) => void;
  fluidKind: string;
  vin: string | null;
  placeholder: string;
  otherPlaceholder: string;
}) {
  const data = useQuery(
    (api as any).fluidCatalog.listForVehicle,
    fluidKind ? { fluidKind, vin: vin ?? undefined } : "skip",
  ) as
    | {
        makeLabel: string | null;
        curated: FluidCatalogOption[];
        raw: FluidCatalogOption[];
        rawTotal: number;
      }
    | undefined;

  const [query, setQuery] = useState("");
  const [rawShown, setRawShown] = useState(FLUID_CATALOG_PAGE);
  const normalizedQuery = query.trim().toLowerCase();
  const loading = data === undefined;
  const curated = data?.curated ?? [];
  const raw = data?.raw ?? [];
  const showMakeBadge = !!data?.makeLabel;

  const matchesQuery = (o: FluidCatalogOption) =>
    !normalizedQuery ||
    o.label.toLowerCase().includes(normalizedQuery) ||
    (o.sublabel ?? "").toLowerCase().includes(normalizedQuery) ||
    (o.oem_part_number ?? "").toLowerCase().includes(normalizedQuery);

  const filteredCurated = curated.filter(matchesQuery);
  const filteredRaw = raw.filter(matchesQuery);
  const otherMatchesQuery = !normalizedQuery || "other".includes(normalizedQuery);

  // Resolve the stored value against the catalog (case-insensitive by name).
  const byValue = useMemo(() => {
    const m = new Map<string, FluidCatalogOption>();
    for (const o of [...curated, ...raw]) {
      const k = o.value.trim().toLowerCase();
      if (!m.has(k)) m.set(k, o);
    }
    return m;
  }, [curated, raw]);
  const matched = value ? byValue.get(value.trim().toLowerCase()) ?? null : null;
  const isOther = !!value && !matched;

  // Always render the currently-selected option even when the pagination window
  // or the search filter would otherwise hide it — its `selectedKey` must point
  // at a rendered item.
  const renderedCurated =
    matched && curated.includes(matched) && !filteredCurated.includes(matched)
      ? [matched, ...filteredCurated]
      : filteredCurated;
  const rawPage = filteredRaw.slice(0, rawShown);
  const renderedRaw =
    matched && raw.includes(matched) && !rawPage.includes(matched)
      ? [matched, ...rawPage]
      : rawPage;
  const hasMoreRaw = filteredRaw.length > rawShown;

  // Stable per-group ids so keys never collide between curated ("c…") and raw
  // ("r…"), and none of the special ids ("none", header/loading sentinels,
  // OTHER) begin with "c"/"r".
  let selectedKey = "none";
  if (matched) {
    const ci = curated.indexOf(matched);
    if (ci >= 0) selectedKey = `c${ci}`;
    else {
      const ri = raw.indexOf(matched);
      if (ri >= 0) selectedKey = `r${ri}`;
    }
  } else if (isOther) {
    selectedKey = OTHER_OPTION_ID;
  }
  const triggerLabel = matched ? matched.label : isOther ? "Other…" : placeholder;

  return (
    <div className="w-full sm:w-auto">
      <Select
        selectedKey={selectedKey}
        onSelectionChange={(key) => {
          const k = String(key);
          if (k === "none") {
            onChange("");
          } else if (k === OTHER_OPTION_ID) {
            if (matched) onChange("");
          } else if (k.startsWith("c")) {
            const o = curated[Number(k.slice(1))];
            if (o) onChange(o.value);
          } else if (k.startsWith("r")) {
            const o = raw[Number(k.slice(1))];
            if (o) onChange(o.value);
          }
          setQuery("");
        }}
      >
        <SelectTrigger className={fluidSelectTrigger}>
          <SelectValue>{triggerLabel}</SelectValue>
        </SelectTrigger>
        <SelectPopover className="rounded-md">
          <div
            className="border-b border-primary/10 p-1.5"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setRawShown(FLUID_CATALOG_PAGE);
              }}
              onKeyDown={(e) => {
                if (
                  e.key !== "ArrowDown" &&
                  e.key !== "ArrowUp" &&
                  e.key !== "Enter" &&
                  e.key !== "Escape"
                ) {
                  e.stopPropagation();
                }
              }}
              placeholder="Search fluids…"
              className="h-8 w-full rounded-md border border-primary/15 bg-background px-2.5 text-[12px] outline-none focus:border-primary"
            />
          </div>
          <SelectListBox
            shouldFocusWrap
            className="max-h-64 overflow-y-auto p-1 text-[13px]"
          >
            <SelectItem id="none" textValue={placeholder} className={fluidSelectItem}>
              <span className="text-muted-foreground">{placeholder}</span>
            </SelectItem>

            {loading ? (
              <SelectItem
                id="__loading__"
                isDisabled
                textValue="Loading"
                className={cn(fluidSelectItem, "text-muted-foreground")}
              >
                Loading catalog…
              </SelectItem>
            ) : null}

            {renderedCurated.length ? (
              <SelectItem
                id="__hdr_curated__"
                isDisabled
                textValue="Otopair OEM catalog"
                className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground"
              >
                Otopair OEM catalog
              </SelectItem>
            ) : null}
            {renderedCurated.map((o) => {
              const i = curated.indexOf(o);
              return (
                <SelectItem key={`c${i}`} id={`c${i}`} textValue={o.label} className={fluidSelectItem}>
                  <FluidCatalogOptionRow option={o} showMakeBadge={showMakeBadge} />
                </SelectItem>
              );
            })}

            {renderedRaw.length ? (
              <SelectItem
                id="__hdr_raw__"
                isDisabled
                textValue="Scraped catalog"
                className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground"
              >
                Scraped catalog
              </SelectItem>
            ) : null}
            {renderedRaw.map((o) => {
              const i = raw.indexOf(o);
              return (
                <SelectItem key={`r${i}`} id={`r${i}`} textValue={o.label} className={fluidSelectItem}>
                  <FluidCatalogOptionRow option={o} showMakeBadge={showMakeBadge} />
                </SelectItem>
              );
            })}

            {otherMatchesQuery ? (
              <SelectItem id={OTHER_OPTION_ID} textValue="Other…" className={fluidSelectItem}>
                Other…
              </SelectItem>
            ) : null}

            {!loading &&
            renderedCurated.length === 0 &&
            renderedRaw.length === 0 &&
            !otherMatchesQuery ? (
              <SelectItem
                id="__no_results__"
                isDisabled
                textValue="No matches"
                className={cn(fluidSelectItem, "text-muted-foreground")}
              >
                No matches
              </SelectItem>
            ) : null}
          </SelectListBox>
          {hasMoreRaw ? (
            <div
              className="border-t border-primary/10 p-1.5"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => setRawShown((n) => n + FLUID_CATALOG_PAGE)}
                className="flex h-8 w-full items-center justify-center gap-1 rounded-md text-[12px] font-medium text-primary transition-colors hover:bg-primary/5"
              >
                Show more
                <span className="text-muted-foreground">
                  ({Math.min(rawShown, filteredRaw.length)}/{filteredRaw.length})
                </span>
              </button>
            </div>
          ) : null}
        </SelectPopover>
      </Select>
      {isOther ? (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={otherPlaceholder}
          className={fluidOtherInput}
        />
      ) : null}
    </div>
  );
}
