"use client";

// Data · Sources & Cache — /data/sources (Data spec §7). Four tabs:
// Registry (reliability formula on hover, "nearing block" filter pinned) ·
// Blocked (manual unblock = ceremony) · URL Patterns (deterministic scrape
// registry) · Cache (TTL groups, expiring-soon, per-vehicle clear).
// The auto-block rule is rendered as law; the enforcement lives in
// services/sourceScoring.ts (accuracy <40% after 20+ observations).

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession, useCan } from "../../portal-session";
import { Ceremony } from "@/components/portal/Ceremony";
import { MiniBar } from "@/components/portal/MiniBar";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";

// Client-side mirrors of the dataSources return shapes (generated api typing
// collapses in this repo — see convex/dataOverview.ts header).
type RegistryRow = {
  id: string;
  domain: string;
  source_type: string;
  make: string | null;
  url_template: string | null;
  slug_count: number;
  total_observations: number;
  accuracy_rate: number | null;
  reliability_score: number | null;
  is_blocked: boolean;
  block_reason: string | null;
  last_scraped_at: number | null;
  last_scrape_success: boolean | null;
};
type BlockedRow = {
  id: string;
  domain: string;
  reason: string | null;
  blocked_by: string;
  accuracy_at_block: number | null;
  blocked_at: number | null;
};
type CacheGroup = {
  source_type: string;
  count: number;
  ttl_days: number | null;
  newest_scraped_at: number | null;
  success_count: number;
};

const TABS = ["Registry", "Blocked", "URL Patterns", "Cache"] as const;
type Tab = (typeof TABS)[number];

const fmtPct = (n: number | null | undefined) =>
  n == null ? "—" : `${Math.round(n * 100)}%`;
const fmtDate = (ms: number | null | undefined) =>
  ms == null ? "—" : new Date(ms).toLocaleDateString();

export default function SourcesPage() {
  const { token } = usePortalSession();
  const canWrite = useCan("data.write");
  const [tab, setTab] = useState<Tab>("Registry");
  const [nearingOnly, setNearingOnly] = useState(true);

  const registry = useQuery(api.dataSources.listRegistry, { token });
  const blocked = useQuery(api.dataSources.listBlocked, { token });
  const cache = useQuery(api.dataSources.cacheOverview, { token });
  const hitRate = useQuery(api.dataSources.cacheHitRate30d, { token });

  const blockDomain = useMutation(api.dataSources.blockDomain);
  const unblockDomain = useMutation(api.dataSources.unblockDomain);

  const [blockTarget, setBlockTarget] = useState<string>("");
  const [unblockTarget, setUnblockTarget] = useState<BlockedRow | null>(null);
  const [blockOpen, setBlockOpen] = useState(false);

  // "Nearing block" (spec §7): accuracy 40–50% with 15+ observations.
  const nearing = useMemo(() => {
    const rows: RegistryRow[] = registry?.rows ?? [];
    return rows.filter(
      (r) =>
        !r.is_blocked &&
        r.accuracy_rate != null &&
        r.accuracy_rate >= 0.4 &&
        r.accuracy_rate <= 0.5 &&
        r.total_observations >= 15,
    );
  }, [registry]);

  const registryRows: RegistryRow[] = useMemo(() => {
    const rows: RegistryRow[] = registry?.rows ?? [];
    return nearingOnly && nearing.length > 0 ? nearing : rows;
  }, [registry, nearingOnly, nearing]);

  const patternRows = useMemo(
    () => (registry?.rows ?? []).filter((r: RegistryRow) => r.url_template != null),
    [registry],
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Sources &amp; Cache</h1>
        {/* The auto-block law (V8 / Apr 2) — rendered, not hidden */}
        <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-[12px] font-medium text-slate-600">
          Auto-block law: accuracy &lt; 40% after 20+ observations → blocked
          (blocked_by <span className="font-mono">auto_accuracy</span>), enforced in the
          enrichment path. Manual block/unblock below is the CRM-style override — every
          use is a ceremony.
        </div>
      </div>

      {/* Tab bar */}
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
            {t === "Blocked" && blocked ? ` (${blocked.length})` : ""}
          </button>
        ))}
      </div>

      {/* ---- Registry ---- */}
      {tab === "Registry" &&
        (registry === undefined ? (
          <Skeleton rows={6} />
        ) : registry.rows.length === 0 ? (
          <Empty text="The source registry is empty on this deployment." />
        ) : (
          <div className="rounded-xl border border-slate-200 bg-white">
            <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-2.5">
              <label className="flex items-center gap-2 text-[13px] font-medium text-slate-600">
                <input
                  type="checkbox"
                  checked={nearingOnly}
                  onChange={(e) => setNearingOnly(e.target.checked)}
                />
                Nearing block only (40–50% accuracy, 15+ obs) — {nearing.length} match
                {nearing.length === 1 ? "" : "es"}
              </label>
              {nearingOnly && nearing.length === 0 && (
                <span className="text-[12px] text-slate-400">
                  none nearing block — showing all {registry.rows.length}
                </span>
              )}
              {registry.truncated && (
                <span className={`${pill} ml-auto bg-amber-50 text-amber-700`}>
                  window truncated at 500
                </span>
              )}
            </div>
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-2">Domain</th>
                  <th className="px-2 py-2">Type / Make</th>
                  <th className="px-2 py-2">Obs</th>
                  <th className="px-2 py-2">Accuracy (40% line)</th>
                  <th className="px-2 py-2" title={registry.formula}>
                    Reliability*
                  </th>
                  <th className="px-2 py-2">Last scrape</th>
                  <th className="px-2 py-2">Status</th>
                  {canWrite && <th className="px-2 py-2" />}
                </tr>
              </thead>
              <tbody>
                {registryRows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-50">
                    <td className="px-4 py-2 font-mono text-[12px] text-slate-800">{r.domain}</td>
                    <td className="px-2 py-2 text-slate-600">
                      {r.source_type}
                      {r.make ? ` · ${r.make}` : ""}
                    </td>
                    <td className="px-2 py-2 text-slate-600">{r.total_observations}</td>
                    <td className="px-2 py-2">
                      <MiniBar
                        value={r.accuracy_rate ?? 0}
                        threshold={0.4}
                        title={`accuracy ${fmtPct(r.accuracy_rate)} — history begins when snapshots exist`}
                      />
                      <span className="ml-2 text-slate-600">{fmtPct(r.accuracy_rate)}</span>
                    </td>
                    <td className="px-2 py-2 text-slate-600" title={registry.formula}>
                      {r.reliability_score == null ? "—" : r.reliability_score.toFixed(2)}
                    </td>
                    <td className="px-2 py-2 text-slate-500">
                      {fmtDate(r.last_scraped_at)}
                      {r.last_scrape_success === false && (
                        <span className={`${pill} ml-1.5 bg-red-50 text-red-700`}>failed</span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {r.is_blocked ? (
                        <span className={`${pill} bg-red-50 text-red-700`}>blocked</span>
                      ) : (
                        <span className={`${pill} bg-emerald-50 text-emerald-700`}>active</span>
                      )}
                    </td>
                    {canWrite && (
                      <td className="px-2 py-2">
                        {!r.is_blocked && (
                          <button
                            onClick={() => {
                              setBlockTarget(r.domain);
                              setBlockOpen(true);
                            }}
                            className="rounded-md px-2 py-1 text-[12px] font-medium text-red-600 hover:bg-red-50"
                          >
                            Block
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-4 py-2 text-[11px] text-slate-400">
              * {registry.formula} — recomputed live when the stored score is missing.
              Accuracy bars show the current value against the 40% auto-block line;
              a trend line begins when accuracy snapshots exist.
            </div>
          </div>
        ))}

      {/* ---- Blocked ---- */}
      {tab === "Blocked" &&
        (blocked === undefined ? (
          <Skeleton rows={3} />
        ) : blocked.length === 0 ? (
          <Empty text="No blocked domains on this deployment." />
        ) : (
          <div className="rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-2">Domain</th>
                  <th className="px-2 py-2">Reason</th>
                  <th className="px-2 py-2">Blocked by</th>
                  <th className="px-2 py-2">Accuracy at block</th>
                  <th className="px-2 py-2">When</th>
                  {canWrite && <th className="px-2 py-2" />}
                </tr>
              </thead>
              <tbody>
                {blocked.map((b: BlockedRow) => (
                  <tr key={b.id} className="border-b border-slate-50">
                    <td className="px-4 py-2 font-mono text-[12px] text-slate-800">{b.domain}</td>
                    <td className="px-2 py-2 text-slate-600">{b.reason ?? "—"}</td>
                    <td className="px-2 py-2">
                      <span
                        className={`${pill} ${
                          b.blocked_by === "auto_accuracy"
                            ? "bg-red-50 text-red-700"
                            : b.blocked_by === "seed"
                              ? "bg-slate-100 text-slate-600"
                              : "bg-amber-50 text-amber-700"
                        }`}
                      >
                        {b.blocked_by}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-slate-600">{fmtPct(b.accuracy_at_block)}</td>
                    <td className="px-2 py-2 text-slate-500">{fmtDate(b.blocked_at)}</td>
                    {canWrite && (
                      <td className="px-2 py-2">
                        <button
                          onClick={() => setUnblockTarget(b)}
                          className="rounded-md px-2 py-1 text-[12px] font-medium text-blue-600 hover:bg-blue-50"
                        >
                          Unblock
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {/* ---- URL Patterns ---- */}
      {tab === "URL Patterns" &&
        (registry === undefined ? (
          <Skeleton rows={4} />
        ) : (
          <div className="space-y-3">
            {patternRows.length === 0 ? (
              <Empty text="No URL-pattern rows in the registry on this deployment." />
            ) : (
              patternRows.map((r: RegistryRow) => (
                <div key={r.id} className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-slate-900">{r.domain}</span>
                    {r.make && <span className={`${pill} bg-slate-100 text-slate-600`}>{r.make}</span>}
                    <span className={`${pill} bg-slate-100 text-slate-600`}>
                      {r.slug_count} slug{r.slug_count === 1 ? "" : "s"}
                    </span>
                    <span className="ml-auto text-[12px] text-slate-500">
                      last scrape {fmtDate(r.last_scraped_at)}
                      {r.last_scrape_success === false ? " (failed)" : ""}
                    </span>
                  </div>
                  <div className="mt-2 overflow-x-auto rounded-md bg-slate-50 px-3 py-2 font-mono text-[12px] text-slate-700">
                    {r.url_template}
                  </div>
                  <div className="mt-1.5 text-[11px] text-slate-400">
                    Fallback chain: year-specific → generic → skip to Batch 2 (gap fill).
                  </div>
                </div>
              ))
            )}
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-[13px] font-semibold text-slate-900">
                Code-level blocklists (hardcoded at the API layer)
              </div>
              <p className="mt-1 text-[12px] text-slate-500">
                Beyond the rows above, the enrichment path carries static
                domain lists in{" "}
                <span className="font-mono">convex/vehicleEnrichment/sourceRegistry.ts</span>{" "}
                (BLOCKED_DOMAINS, MARKETPLACE_DOMAINS). They are code, not data — changing
                them is a deploy, not a ceremony. Rendered here so the registry view is
                complete.
              </p>
            </div>
          </div>
        ))}

      {/* ---- Cache ---- */}
      {tab === "Cache" &&
        (cache === undefined ? (
          <Skeleton rows={4} />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-2xl font-bold text-slate-900">{cache.total}</div>
                <div className="mt-1 text-xs font-medium text-slate-500">
                  cached scrapes{cache.truncated ? " (window truncated at 500)" : ""}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-2xl font-bold text-slate-900">
                  {hitRate === undefined ? "…" : hitRate.rate == null ? "—" : fmtPct(hitRate.rate)}
                </div>
                <div className="mt-1 text-xs font-medium text-slate-500">
                  cache hit rate, 30d ({hitRate?.samples ?? 0} runs carrying the flag)
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-2xl font-bold text-slate-900">{cache.expiring_soon.length}</div>
                <div className="mt-1 text-xs font-medium text-slate-500">expiring within 7 days</div>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-slate-900">By source type</h2>
              {cache.groups.length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">Cache is empty on this deployment.</p>
              ) : (
                <div className="mt-3 space-y-2">
                  {cache.groups.map((g: CacheGroup) => (
                    <div
                      key={g.source_type}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 px-3 py-2"
                    >
                      <span className="text-[13px] font-medium text-slate-800">{g.source_type}</span>
                      <span className={`${pill} bg-slate-100 text-slate-600`}>
                        TTL {g.ttl_days ?? "?"}d
                      </span>
                      <span className="text-[12px] text-slate-500">
                        {g.count} rows · {g.success_count} successful · newest{" "}
                        {fmtDate(g.newest_scraped_at)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-3 text-[11px] text-slate-400">
                TTLs per source type: parts 30d · manuals 90d · pricing 7d. Per-vehicle cache
                clear lives on the config workspace flow (ceremony — cache clears cost real
                money downstream); the mutation is{" "}
                <span className="font-mono">dataSources.clearVehicleCache</span>.
              </p>
            </div>

            {cache.by_domain.length > 0 && (
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <h2 className="text-sm font-semibold text-slate-900">
                  Measured success % by domain (from cached scrapes)
                </h2>
                <div className="mt-3 grid grid-cols-1 gap-1.5 md:grid-cols-2">
                  {cache.by_domain.map((d: { domain: string; count: number; success: number }) => (
                    <div key={d.domain} className="flex items-center gap-2 text-[13px]">
                      <span className="w-56 truncate font-mono text-[12px] text-slate-700">
                        {d.domain}
                      </span>
                      <MiniBar value={d.count > 0 ? d.success / d.count : 0} threshold={0.4} />
                      <span className="text-slate-500">
                        {d.success}/{d.count}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}

      {/* Block ceremony */}
      <Ceremony
        open={blockOpen}
        onOpenChange={setBlockOpen}
        title={`Block ${blockTarget}`}
        destructive
        summary={
          <>
            <span className="font-mono">{blockTarget}</span> will be excluded from all future
            scrapes (manual block — the Apr 2 CRM-style override). Its registry row is marked
            blocked and a <span className="font-mono">blocked_domains</span> row is written.
          </>
        }
        onConfirm={async (reason) => {
          await blockDomain({ token, reason, domain: blockTarget });
        }}
      />
      {/* Unblock ceremony */}
      <Ceremony
        open={unblockTarget !== null}
        onOpenChange={(o) => !o && setUnblockTarget(null)}
        title={`Unblock ${unblockTarget?.domain ?? ""}`}
        summary={
          <>
            Manual override: <span className="font-mono">{unblockTarget?.domain}</span> (blocked
            by <span className="font-mono">{unblockTarget?.blocked_by}</span>
            {unblockTarget?.accuracy_at_block != null
              ? ` at ${Math.round(unblockTarget.accuracy_at_block * 100)}% accuracy`
              : ""}
            ) returns to the scrape pool immediately.
          </>
        }
        onConfirm={async (reason) => {
          if (!unblockTarget) return;
          await unblockDomain({
            token,
            reason,
            id: unblockTarget.id as Id<"blocked_domains">,
          });
        }}
      />
    </div>
  );
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-12 animate-pulse rounded-lg bg-slate-100" />
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
