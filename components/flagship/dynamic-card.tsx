"use client";

import { Check, Sparkles, X } from "lucide-react";
import { CARD } from "./demo-cards";
import type { InfoCardPayload } from "./info-card";
import { Step } from "./shared";

/* ------------------------------------------------------------------ */
/* Generic agent-driven "info card" — render layer.                    */
/*                                                                     */
/* The agent supplies the content (validated/clamped by                */
/* ./info-card#sanitizeInfoCard); this component owns the layout,      */
/* styling, and the same multi-step "assemble in" entrance as the      */
/* hand-built demo cards. All values are plain text — React escapes    */
/* them, so there's no injection surface.                              */
/* ------------------------------------------------------------------ */

function Bullets({ items, ordered }: { items: string[]; ordered?: boolean }) {
  return (
    <div className="mt-4 space-y-2">
      {items.map((it, i) => (
        <Step
          key={`${i}-${it}`}
          delay={0.16 + i * 0.07}
          className={
            ordered
              ? "flex items-start gap-3 rounded-xl bg-[#1a1a1a]/[0.04] px-4 py-2.5"
              : "flex items-start gap-2 text-[13px] leading-snug text-[#1a1a1a]"
          }
        >
          {ordered ? (
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#1a1a1a] text-[11px] font-semibold text-white">
              {i + 1}
            </span>
          ) : (
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#2f7bff]" />
          )}
          <span className="text-[13px] leading-snug text-[#1a1a1a]">{it}</span>
        </Step>
      ))}
    </div>
  );
}

function Rows({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <div className="mt-4 space-y-1">
      {rows.map((row, i) => (
        <Step
          key={`${i}-${row.label}`}
          delay={0.16 + i * 0.08}
          className="flex items-center justify-between gap-4 rounded-xl bg-[#1a1a1a]/[0.04] px-4 py-2.5"
        >
          <span className="text-[13.5px] text-[#1a1a1a]">{row.label}</span>
          <span className="shrink-0 text-[13.5px] font-medium text-[#1a1a1a]">{row.value}</span>
        </Step>
      ))}
    </div>
  );
}

function Stats({ stats }: { stats: { value: string; label: string }[] }) {
  return (
    <div className="mt-4 grid grid-cols-2 gap-2">
      {stats.map((s, i) => (
        <Step key={`${i}-${s.label}`} delay={0.16 + i * 0.09} className="rounded-xl bg-[#1a1a1a]/[0.04] px-4 py-3">
          <p className="text-[22px] font-semibold leading-none text-[#1a1a1a]">{s.value}</p>
          <p className="mt-1.5 text-[11.5px] leading-snug text-[#1a1a1a]/55">{s.label}</p>
        </Step>
      ))}
    </div>
  );
}

function CompareCol({
  heading,
  items,
  positive,
  base,
}: {
  heading: string;
  items: string[];
  positive: boolean;
  base: number;
}) {
  return (
    <div>
      <Step delay={base}>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1a1a1a]/45">
          {heading}
        </p>
      </Step>
      <ul className="space-y-1.5">
        {items.map((it, i) => (
          <Step
            key={`${i}-${it}`}
            delay={base + 0.06 + i * 0.06}
            className={`flex items-start gap-2 text-[12.5px] leading-snug ${
              positive ? "text-[#1a1a1a]" : "text-[#1a1a1a]/55"
            }`}
          >
            {positive ? (
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#2f7bff]" />
            ) : (
              <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#1a1a1a]/30" />
            )}
            {it}
          </Step>
        ))}
      </ul>
    </div>
  );
}

export function DynamicCard({ payload }: { payload: InfoCardPayload }) {
  const { title, summary, layout, items, rows, stats, pros, cons, footnote } = payload;
  return (
    <div className={CARD}>
      <Step delay={0.05}>
        <div className="flex items-center gap-2">
          <Sparkles className="h-[18px] w-[18px] text-[#1a1a1a]" strokeWidth={1.6} />
          <h3 className="text-[19px] text-[#1a1a1a]" style={{ fontFamily: "var(--font-Petrona)" }}>
            {title}
          </h3>
        </div>
        {summary && <p className="mt-1 text-[12px] leading-snug text-[#1a1a1a]/55">{summary}</p>}
      </Step>

      {layout === "list" && items && <Bullets items={items} />}
      {layout === "steps" && items && <Bullets items={items} ordered />}
      {layout === "rows" && rows && <Rows rows={rows} />}
      {layout === "stats" && stats && <Stats stats={stats} />}
      {layout === "compare" && (pros?.length || cons?.length) ? (
        <div className="mt-4 grid grid-cols-2 gap-4">
          {pros?.length ? <CompareCol heading="What it does" items={pros} positive base={0.16} /> : null}
          {cons?.length ? <CompareCol heading="What it doesn't" items={cons} positive={false} base={0.2} /> : null}
        </div>
      ) : null}

      {footnote && (
        <Step delay={0.55}>
          <p className="mt-4 text-[11px] leading-relaxed text-[#1a1a1a]/45">{footnote}</p>
        </Step>
      )}
    </div>
  );
}
