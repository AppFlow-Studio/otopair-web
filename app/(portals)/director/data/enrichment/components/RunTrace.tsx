"use client";

// Per-run pipeline trace — replays one enrichment run stage by stage
// (NHTSA+VDB decode → scrape → Batch 1 → Batch 2 → finalize) with each batch's
// prompt (request) and raw+parsed model output (response). Backed by
// enrichment_run_steps; only runs enriched after the trace instrumentation
// shipped have rows.

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fmtNum } from "@/components/portal/ChartKit";
import { Panel, Empty, TableSkeleton, StatusPill, fmtDuration, fmtCost, fmtWhen } from "./helpers";

type StepRow = FunctionReturnType<typeof api.directorEnrichment.stepsForRun>[number];

const STEP_LABEL: Record<string, string> = {
  decode: "1 · NHTSA + VDB Decode",
  scrape: "2 · Scrape & Merge",
  batch1: "3 · Batch 1 — specs · parts · fluids",
  batch2: "4 · Batch 2 — gap-fill + pricing",
  finalize: "5 · Finalize",
};

function CodeBlock({ label, text }: { label: string; text: string }) {
  return (
    <details className="mt-2 rounded-lg border border-slate-200 bg-slate-50">
      <summary className="cursor-pointer select-none px-3 py-1.5 text-[12px] font-semibold text-slate-600">
        {label} <span className="font-normal text-slate-400">({fmtNum(text.length)} chars)</span>
      </summary>
      <pre className="max-h-96 overflow-auto border-t border-slate-200 bg-white px-3 py-2 text-[11px] leading-relaxed text-slate-700">
        {text}
      </pre>
    </details>
  );
}

function StepCard({ s }: { s: StepRow }) {
  const hasTokens = s.tokensIn != null || s.tokensOut != null;
  return (
    <li className="relative pl-6">
      {/* rail dot */}
      <span
        className={`absolute left-0 top-1.5 h-3 w-3 rounded-full border-2 border-white ring-1 ${
          s.status === "error"
            ? "bg-red-500 ring-red-300"
            : s.status === "timeout"
              ? "bg-amber-500 ring-amber-300"
              : s.status === "submitted"
                ? "bg-blue-400 ring-blue-200"
                : "bg-emerald-500 ring-emerald-300"
        }`}
      />
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold text-slate-900">
            {STEP_LABEL[s.step] ?? s.step}
          </span>
          {s.status && <StatusPill status={s.status} />}
          <span className="ml-auto flex items-center gap-3 text-[11px] text-slate-500">
            {s.durationMs != null && <span>{fmtDuration(s.durationMs)}</span>}
            {hasTokens && (
              <span>
                {fmtNum((s.tokensIn ?? 0) + (s.tokensOut ?? 0))} tok
                {s.webSearches ? ` · ${s.webSearches} search` : ""}
              </span>
            )}
            {s.costUsd > 0 && <span className="text-emerald-600">{fmtCost(s.costUsd)}</span>}
            {s.startedAt && <span className="text-slate-400">{fmtWhen(s.startedAt)}</span>}
          </span>
        </div>
        {s.summary && <div className="mt-1 text-[12px] text-slate-600">{s.summary}</div>}
        {s.truncated && (
          <div className="mt-1 text-[11px] text-amber-600">Captured text was truncated to fit.</div>
        )}
        {s.requestText && <CodeBlock label="Request / prompt" text={s.requestText} />}
        {s.responseText && <CodeBlock label="Response (raw + parsed)" text={s.responseText} />}
      </div>
    </li>
  );
}

export function RunTrace({ token, runId }: { token: string; runId: Id<"enrichment_runs"> | null }) {
  const steps = useQuery(
    api.directorEnrichment.stepsForRun,
    runId ? { token, enrichmentRunId: runId } : "skip",
  );

  return (
    <Panel title="Pipeline trace" sub="selected run, step by step">
      {!runId ? (
        <Empty>No run selected.</Empty>
      ) : steps === undefined ? (
        <TableSkeleton />
      ) : steps.length === 0 ? (
        <Empty>
          No stage trace for this run. Only runs enriched after the trace instrumentation shipped
          record per-stage prompts and responses — re-run this VIN to capture one.
        </Empty>
      ) : (
        <ol className="space-y-3 border-l border-slate-200">
          {steps.map((s) => (
            <StepCard key={String(s.id)} s={s} />
          ))}
        </ol>
      )}
    </Panel>
  );
}
