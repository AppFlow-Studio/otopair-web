"use client";

// Entity chip — the connective tissue between portals (Ops Atlas "Entity
// Chips"). Inline rounded chip: entity-icon letter + label. Hover (150ms
// delay) opens a small summary card fed by entitySummaries.get; click deep-
// links to the entity's detail route. Unknown/deleted id → lock tooltip
// instead of a dead link. Dependency-free: absolute-positioned popover.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "@/app/(portals)/portal-session";

export type EntityChipType = "user" | "shop" | "booking" | "payment";

const META: Record<
  EntityChipType,
  { letter: string; iconClass: string; route: (id: string) => string; noun: string }
> = {
  user: {
    letter: "U",
    iconClass: "bg-blue-100 text-blue-700",
    route: (id) => `/ops/users/${id}`,
    noun: "User",
  },
  shop: {
    letter: "S",
    iconClass: "bg-emerald-100 text-emerald-700",
    route: (id) => `/shops/all/${id}`,
    noun: "Shop",
  },
  booking: {
    letter: "B",
    iconClass: "bg-violet-100 text-violet-700",
    route: (id) => `/ops/bookings/${id}`,
    noun: "Booking",
  },
  payment: {
    letter: "P",
    iconClass: "bg-amber-100 text-amber-700",
    route: (id) => `/ops/payments/${id}`,
    noun: "Payment",
  },
};

function statusPillClass(status: string): string {
  const s = status.toLowerCase();
  const base = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ";
  if (["completed", "succeeded", "captured", "paid", "active"].includes(s))
    return base + "bg-emerald-50 text-emerald-700";
  if (["pending", "pending_quote", "quotes_ready", "vehicle_at_shop", "requires_action", "pending deletion"].includes(s))
    return base + "bg-amber-50 text-amber-700";
  if (["cancelled", "no_show", "failed", "refunded", "inactive"].includes(s))
    return base + "bg-red-50 text-red-700";
  return base + "bg-slate-100 text-slate-600";
}

export function EntityChip({
  type,
  id,
  label,
}: {
  type: EntityChipType;
  id: string;
  label?: string;
}) {
  const { token } = usePortalSession();
  const router = useRouter();
  const meta = META[type];

  const [hovered, setHovered] = useState(false);
  const [fetched, setFetched] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Once hovered we keep the subscription alive (`fetched`) so re-hovers are
  // instant; the popover itself only shows while `hovered`.
  const summary = useQuery(
    api.entitySummaries.get,
    fetched ? { token, type, id } : "skip",
  );
  const notFound = summary === null;

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const onEnter = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setFetched(true);
      setHovered(true);
    }, 150);
  };
  const onLeave = () => {
    if (timer.current) clearTimeout(timer.current);
    setHovered(false);
  };

  return (
    <span
      className="relative inline-block align-middle"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <button
        type="button"
        onClick={() => {
          if (!notFound) router.push(meta.route(id));
        }}
        title={notFound ? `${meta.noun} not found` : undefined}
        className={`inline-flex max-w-[220px] items-center gap-1.5 rounded-full border border-slate-200 bg-white py-0.5 pl-1 pr-2.5 text-[12px] font-medium text-slate-700 transition-colors ${
          notFound ? "cursor-not-allowed opacity-60" : "hover:border-slate-300 hover:bg-slate-50"
        }`}
      >
        <span
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${meta.iconClass}`}
        >
          {notFound ? "🔒" : meta.letter}
        </span>
        <span className="truncate">
          {label ?? summary?.title ?? `${meta.noun} …${id.slice(-6)}`}
        </span>
      </button>

      {hovered && (
        <span className="absolute left-0 top-full z-50 mt-1.5 block w-64 rounded-xl border border-slate-200 bg-white p-3 text-left shadow-lg">
          {summary === undefined && (
            <span className="block py-2 text-center text-[12px] text-slate-400">
              Loading…
            </span>
          )}
          {notFound && (
            <span className="block py-2 text-center text-[12px] text-slate-400">
              🔒 {meta.noun} not found — it may have been deleted.
            </span>
          )}
          {summary && (
            <span className="block">
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-[13px] font-semibold text-slate-900">
                  {summary.title}
                </span>
                {summary.status && (
                  <span className={statusPillClass(summary.status)}>
                    {summary.status}
                  </span>
                )}
              </span>
              <span className="mt-2 block">
                {summary.facts.map((f: { label: string; value: string }) => (
                  <span
                    key={f.label}
                    className="flex items-baseline justify-between gap-3 py-0.5"
                  >
                    <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                      {f.label}
                    </span>
                    <span className="truncate text-[12px] text-slate-700">
                      {f.value}
                    </span>
                  </span>
                ))}
              </span>
            </span>
          )}
        </span>
      )}
    </span>
  );
}
