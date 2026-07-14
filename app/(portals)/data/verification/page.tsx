"use client";

// Data · Verification & Variance — /data/verification (Data spec §10.3).
// Four tabs: Verifications (Tier 3 stream, milestone chips) · Variances
// (flagged-first, reviewed toggle) · Confirmations · Empirical (shared labor
// ledger). Live volume is near-zero today — every count renders honestly.

import { useState } from "react";
import { useMutation, useQuery, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession, useCan } from "../../portal-session";
import { Ceremony } from "@/components/portal/Ceremony";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";

// Client-side mirrors of dataVerification return shapes.
type VerificationRow = {
  id: string;
  mechanic: string | null;
  config_key: string | null;
  service: string | null;
  status: string | null;
  overall_accuracy: number | null;
  actual_labor_hours: number | null;
  parts_used_correct: boolean | null;
  field_verdicts: { field: string; verdict: string; old_value?: string; new_value?: string }[];
  milestones: string[];
  at: number;
};
type VarianceRow = {
  id: string;
  engine: string | null;
  service: string | null;
  predicted_labor_hours: number | null;
  actual_labor_hours: number | null;
  predicted_parts_cost: number | null;
  actual_parts_cost: number | null;
  variance_percentage: number | null;
  flagged: boolean;
  reviewed_at: number | null;
  notes: string | null;
  at: number;
};
type ConfirmationRow = {
  id: string;
  service: string | null;
  confirmed_accurate: boolean;
  feedback: string | null;
  at: number;
};
type EmpiricalRow = {
  id: string;
  config_key: string | null;
  service: string | null;
  empirical_hours: number;
  sample_size: number;
  p25: number | null;
  p75: number | null;
  book_hours: number | null;
};

const TABS = ["Verifications", "Variances", "Confirmations", "Empirical"] as const;
type Tab = (typeof TABS)[number];

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString();
const fmtH = (h: number | null) => (h == null ? "—" : `${h.toFixed(1)}h`);
const fmtUsd = (n: number | null) => (n == null ? "—" : `$${n.toFixed(0)}`);

export default function VerificationPage() {
  const { token } = usePortalSession();
  const canWrite = useCan("data.write");
  const [tab, setTab] = useState<Tab>("Verifications");
  const [reviewTarget, setReviewTarget] = useState<VarianceRow | null>(null);

  const verifs = usePaginatedQuery(
    api.dataVerification.verificationStream,
    { token },
    { initialNumItems: 25 },
  );
  const varData = useQuery(api.dataVerification.variances, { token });
  const confs = useQuery(api.dataVerification.confirmations, { token });
  const empirical = usePaginatedQuery(
    api.dataVerification.empiricalLedger,
    { token },
    { initialNumItems: 50 },
  );
  const markReviewed = useMutation(api.dataVerification.markVarianceReviewed);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Verification &amp; Variance</h1>
        {/* Write semantics (V8) — static explainer; the confidences live in the
            enrichment writer, not per row. */}
        <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-[12px] font-medium text-slate-600">
          Write semantics: confirmed → evidence at 0.98 · corrected → prior evidence
          is_latest=false, corrected value at 0.99 · actual hours → empirical rolling average
          (promoted at 3+ samples) · config verified at 3+ verifications.
        </div>
      </div>

      <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-3.5 py-1.5 text-sm font-medium ${
              tab === t ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ---- Verifications ---- */}
      {tab === "Verifications" && (
        <div className="space-y-3">
          {verifs.status === "LoadingFirstPage" ? (
            <Skeleton rows={4} />
          ) : verifs.results.length === 0 ? (
            <Empty text="0 mechanic verifications on this deployment — the honest number. The stream fills as Tier 3 (post-job verification) goes live." />
          ) : (
            <>
              {(verifs.results as VerificationRow[]).map((r) => (
                <div key={r.id} className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-slate-900">
                      {r.mechanic ?? "Unknown mechanic"}
                    </span>
                    {r.config_key && (
                      <span className="font-mono text-[12px] text-slate-500">{r.config_key}</span>
                    )}
                    {r.service && (
                      <span className={`${pill} bg-slate-100 text-slate-600`}>{r.service}</span>
                    )}
                    {r.status && (
                      <span
                        className={`${pill} ${
                          r.status === "accepted"
                            ? "bg-emerald-50 text-emerald-700"
                            : r.status === "rejected"
                              ? "bg-red-50 text-red-700"
                              : "bg-amber-50 text-amber-700"
                        }`}
                      >
                        {r.status}
                      </span>
                    )}
                    <span className="ml-auto text-[12px] text-slate-400">{fmtDate(r.at)}</span>
                  </div>
                  {r.field_verdicts.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {r.field_verdicts.map((fv, i) => (
                        <span
                          key={i}
                          className={`${pill} ${
                            fv.verdict.startsWith("correct") && fv.new_value
                              ? "bg-amber-50 text-amber-700"
                              : "bg-emerald-50 text-emerald-700"
                          }`}
                          title={
                            fv.old_value || fv.new_value
                              ? `${fv.old_value ?? "?"} → ${fv.new_value ?? "?"}`
                              : undefined
                          }
                        >
                          {fv.field}: {fv.verdict}
                          {fv.new_value ? ` (${fv.old_value ?? "?"} → ${fv.new_value})` : ""}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-slate-500">
                    {r.actual_labor_hours != null && <span>actual {fmtH(r.actual_labor_hours)}</span>}
                    {r.overall_accuracy != null && (
                      <span>accuracy {Math.round(r.overall_accuracy * 100)}%</span>
                    )}
                    {r.milestones.map((m) => (
                      <span key={m} className={`${pill} bg-yellow-50 text-yellow-800`}>
                        ★ {m}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              {verifs.status === "CanLoadMore" && (
                <button
                  onClick={() => verifs.loadMore(25)}
                  className="w-full rounded-lg border border-slate-200 bg-white py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                >
                  Load more
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* ---- Variances ---- */}
      {tab === "Variances" &&
        (varData === undefined ? (
          <Skeleton rows={4} />
        ) : (
          <div className="space-y-4">
            {varData.medians_by_service.length > 0 && (
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <h2 className="text-sm font-semibold text-slate-900">Median variance by service</h2>
                <div className="mt-2 flex flex-wrap gap-2">
                  {varData.medians_by_service.map((m: { service: string; median_variance: number; n: number }) => (
                    <span key={m.service} className={`${pill} bg-slate-100 text-slate-700`}>
                      {m.service}: {m.median_variance.toFixed(1)}% (n={m.n})
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-slate-400">{varData.window_note}</p>
              </div>
            )}
            {varData.flagged.length === 0 && varData.recent.length === 0 ? (
              <Empty text="No spec variances recorded on this deployment — the stream fills as post-job surveys go live." />
            ) : (
              <VarianceTable
                title={`Flagged for review (${varData.flagged.length})`}
                rows={varData.flagged}
                canWrite={canWrite}
                onReview={setReviewTarget}
              />
            )}
            {varData.recent.length > 0 && (
              <VarianceTable
                title="Recent (last 100)"
                rows={varData.recent.filter((r: VarianceRow) => !r.flagged)}
                canWrite={canWrite}
                onReview={setReviewTarget}
              />
            )}
          </div>
        ))}

      {/* ---- Confirmations ---- */}
      {tab === "Confirmations" &&
        (confs === undefined ? (
          <Skeleton rows={3} />
        ) : confs.length === 0 ? (
          <Empty text="No post-job spec confirmations yet — 0 is the honest number until the survey stream is live." />
        ) : (
          <div className="rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-2">Service</th>
                  <th className="px-2 py-2">Verdict</th>
                  <th className="px-2 py-2">Feedback</th>
                  <th className="px-2 py-2">When</th>
                </tr>
              </thead>
              <tbody>
                {(confs as ConfirmationRow[]).map((c) => (
                  <tr key={c.id} className="border-b border-slate-50">
                    <td className="px-4 py-2 text-slate-800">{c.service ?? "—"}</td>
                    <td className="px-2 py-2">
                      <span
                        className={`${pill} ${
                          c.confirmed_accurate
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-red-50 text-red-700"
                        }`}
                      >
                        {c.confirmed_accurate ? "accurate" : "disconfirmed"}
                      </span>
                    </td>
                    <td className="max-w-md truncate px-2 py-2 text-slate-500" title={c.feedback ?? ""}>
                      {c.feedback ?? "—"}
                    </td>
                    <td className="px-2 py-2 text-slate-500">{fmtDate(c.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {/* ---- Empirical ---- */}
      {tab === "Empirical" && (
        <div className="space-y-3">
          {empirical.status === "LoadingFirstPage" ? (
            <Skeleton rows={4} />
          ) : empirical.results.length === 0 ? (
            <Empty text="No empirical labor rows yet — rows appear as post-job actuals accumulate (promoted at 3+ samples). This is the shared ledger also rendered in the Labor Command Center." />
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                    <th className="px-4 py-2">Config</th>
                    <th className="px-2 py-2">Service</th>
                    <th className="px-2 py-2">Empirical</th>
                    <th className="px-2 py-2">n</th>
                    <th className="px-2 py-2">p25 / p75</th>
                    <th className="px-2 py-2">Book</th>
                  </tr>
                </thead>
                <tbody>
                  {(empirical.results as EmpiricalRow[]).map((r) => {
                    const thin = r.sample_size < 5;
                    return (
                      <tr key={r.id} className={`border-b border-slate-50 ${thin ? "opacity-60" : ""}`}>
                        <td className="px-4 py-2 font-mono text-[12px] text-slate-700">
                          {r.config_key ?? "—"}
                        </td>
                        <td className="px-2 py-2 text-slate-700">{r.service ?? "—"}</td>
                        <td className="px-2 py-2 font-semibold text-slate-900">
                          {fmtH(r.empirical_hours)}
                        </td>
                        <td className="px-2 py-2 text-slate-600">
                          {r.sample_size}
                          {thin && (
                            <span className="ml-1 text-[11px] text-slate-400">
                              (insufficient sample)
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-slate-600">
                          {thin ? "—" : `${fmtH(r.p25)} / ${fmtH(r.p75)}`}
                        </td>
                        <td className="px-2 py-2 text-slate-500">{fmtH(r.book_hours)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {empirical.status === "CanLoadMore" && (
            <button
              onClick={() => empirical.loadMore(50)}
              className="w-full rounded-lg border border-slate-200 bg-white py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Load more
            </button>
          )}
        </div>
      )}

      {/* Reviewed-toggle ceremony */}
      <Ceremony
        open={reviewTarget !== null}
        onOpenChange={(o) => !o && setReviewTarget(null)}
        title="Mark variance reviewed"
        summary={
          <>
            {reviewTarget?.service ?? "This variance"} ({reviewTarget?.engine ?? "engine ?"}) —
            predicted {fmtH(reviewTarget?.predicted_labor_hours ?? null)} vs actual{" "}
            {fmtH(reviewTarget?.actual_labor_hours ?? null)} — will be marked reviewed.
          </>
        }
        onConfirm={async (reason) => {
          if (!reviewTarget) return;
          await markReviewed({ token, reason, id: reviewTarget.id as Id<"spec_variances"> });
        }}
      />
    </div>
  );
}

function VarianceTable({
  title,
  rows,
  canWrite,
  onReview,
}: {
  title: string;
  rows: VarianceRow[];
  canWrite: boolean;
  onReview: (r: VarianceRow) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900">
        {title}
      </div>
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
            <th className="px-4 py-2">Engine</th>
            <th className="px-2 py-2">Service</th>
            <th className="px-2 py-2">Labor pred → actual</th>
            <th className="px-2 py-2">Parts pred → actual</th>
            <th className="px-2 py-2">Variance</th>
            <th className="px-2 py-2">Status</th>
            {canWrite && <th className="px-2 py-2" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-slate-50">
              <td className="px-4 py-2 font-mono text-[12px] text-slate-700">{r.engine ?? "—"}</td>
              <td className="px-2 py-2 text-slate-700">{r.service ?? "—"}</td>
              <td className="px-2 py-2 text-slate-600">
                {fmtH(r.predicted_labor_hours)} → {fmtH(r.actual_labor_hours)}
              </td>
              <td className="px-2 py-2 text-slate-600">
                {fmtUsd(r.predicted_parts_cost)} → {fmtUsd(r.actual_parts_cost)}
              </td>
              <td className="px-2 py-2 font-semibold text-slate-900">
                {r.variance_percentage == null ? "—" : `${r.variance_percentage.toFixed(1)}%`}
              </td>
              <td className="px-2 py-2">
                {r.reviewed_at != null ? (
                  <span className={`${pill} bg-slate-100 text-slate-500`}>reviewed</span>
                ) : r.flagged ? (
                  <span className={`${pill} bg-red-50 text-red-700`}>flagged</span>
                ) : (
                  <span className={`${pill} bg-slate-100 text-slate-600`}>new</span>
                )}
              </td>
              {canWrite && (
                <td className="px-2 py-2">
                  {r.reviewed_at == null && (
                    <button
                      onClick={() => onReview(r)}
                      className="rounded-md px-2 py-1 text-[12px] font-medium text-blue-600 hover:bg-blue-50"
                    >
                      Mark reviewed
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100" />
      ))}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
      {text}
    </div>
  );
}
