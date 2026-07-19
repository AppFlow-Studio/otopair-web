"use client";

// Zone 2 (right rail) — the unified triage inbox. Read-only by design:
// every item deep-links to the page that owns the fix (role-safe for
// readonly directors; no duplicated confirm flows).

import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { PILL, timeAgo, Skeleton } from "./shared";

type Attention = FunctionReturnType<typeof api.directorData.attention> | undefined;

const DOMAIN_PILLS: { key: keyof NonNullable<Attention>["counts"]; label: string }[] = [
  { key: "failed_payments_24h", label: "payments" },
  { key: "stuck_bookings", label: "stuck" },
  { key: "open_disputes", label: "disputes" },
  { key: "pending_deletions", label: "deletions" },
  { key: "review_queue", label: "review q" },
  { key: "incidents", label: "incidents" },
  { key: "open_bugs", label: "bugs" },
  { key: "open_feedback", label: "feedback" },
];

export function AttentionRail({ attention }: { attention: Attention }) {
  return (
    <section id="attention" className="rounded-xl border border-amber-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-slate-900">Needs attention</h2>

      {attention === undefined ? (
        <div className="mt-4 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {DOMAIN_PILLS.map(({ key, label }) => {
              const n = attention.counts[key];
              return (
                <span
                  key={key}
                  className={`${PILL} ${n > 0 ? "bg-amber-50 text-amber-700" : "bg-slate-50 text-slate-400"}`}
                >
                  {label} {n}
                </span>
              );
            })}
          </div>

          {attention.items.length === 0 ? (
            <p className="mt-4 flex items-center gap-2 text-[13px] text-emerald-700">
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-100 text-[10px]">
                ✓
              </span>
              Nothing needs attention right now.
            </p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {attention.items.map((item) => (
                <li
                  key={item.key}
                  className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-[13px] ${
                    item.severity === "red" ? "bg-red-50 text-red-900" : "bg-amber-50 text-amber-900"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate">{item.label}</span>
                    <span className="text-[11px] opacity-60">{timeAgo(item.at)}</span>
                  </span>
                  <Link
                    href={item.href}
                    className="shrink-0 text-[12px] font-semibold text-blue-600 hover:underline"
                  >
                    Fix →
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
