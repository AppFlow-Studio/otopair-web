"use client";

// Data · Tire Intelligence — /data/tires (Data spec §10.1). Four tabs:
// Brands (tier pills; brand-level tiering is the MVP call — Goodyear Eagle F1
// caveat pinned) · Models & Pricing (fill % vs the 94% benchmark; every price
// is a ceiling reference, never a quote) · Sizes (per-trim OEM sizes, rim
// diameter only) · Quote Guardrails (scraped-market ceiling breaches).
// Honest notes: wheelsize.com calls are NOT metered anywhere in this codebase
// (300/day free tier is a static fact card); tire tables are empty on
// deployments that haven't run the scrapers — empty states do the work.

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession, useCan } from "@/app/(portals)/portal-session";
import { Ceremony } from "@/components/portal/Ceremony";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString();

type TireBrandRow = {
  id: string;
  brand: string;
  tier: "elite" | "select" | "standard" | "unlisted";
  parent_company: string | null;
  is_sub_brand: boolean;
  appearance_count: number | null;
  review_flagged: boolean;
};
type TireModelRow = {
  id: string;
  brand: string;
  model: string;
  size: string;
  tier: string | null;
  tire_type: string | null;
  prices: { source: string; price_per_tire: number; scraped_at: number; fresh: boolean }[];
};
type TrimSizeRow = {
  id: string;
  trim: string | null;
  config_key: string | null;
  size_front: string | null;
  size_rear: string | null;
  staggered: boolean;
  rim_diameter_in: number | null;
  options: number;
  source: string | null;
};
type GuardrailRow = {
  quote_id: string;
  booking_id: string;
  shop_id: string;
  tire_brand: string;
  tire_model: string | null;
  per_tire_price: number;
  quantity: number;
  size: string | null;
  ceiling: number | null;
  breach: boolean;
  at: number;
};

const TABS = ["Brands", "Models & Pricing", "Sizes", "Quote Guardrails"] as const;
type Tab = (typeof TABS)[number];

const TIER_STYLE: Record<TireBrandRow["tier"], string> = {
  elite: "border border-yellow-400 bg-yellow-50 text-yellow-800",
  select: "bg-blue-50 text-blue-700",
  standard: "bg-slate-100 text-slate-600",
  unlisted: "bg-slate-50 text-slate-400",
};
const tierLabel = (t: TireBrandRow["tier"]) => (t === "select" ? "Select (mid)" : t);

export default function TiresPage() {
  const { token } = usePortalSession();
  const canWrite = useCan("data.write");
  const [tab, setTab] = useState<Tab>("Brands");
  const [modelFilter, setModelFilter] = useState<{ size?: string; brand?: string }>({});
  const [tierTarget, setTierTarget] = useState<{ row: TireBrandRow; tier: TireBrandRow["tier"] } | null>(null);

  const brands = useQuery(api.dataTires.listBrands, { token });
  const models = useQuery(api.dataTires.modelsBySizeOrBrand, {
    token,
    size: modelFilter.size,
    brand: modelFilter.brand,
  });
  const sizes = useQuery(api.dataTires.sizesHealth, { token });
  const guardrails = useQuery(api.dataTires.quoteGuardrails, { token });
  const pricingStat = useQuery(api.portalStats.getStats, {
    token,
    keys: ["data.tires.pricing_summary"],
  });
  const updateTier = useMutation(api.dataTires.updateBrandTier);

  const summary = pricingStat?.["data.tires.pricing_summary"];
  const summaryMeta = (summary?.meta ?? null) as {
    models_with_price?: number;
    fill_pct?: number;
    benchmark_pct?: number;
    per_source?: { source: string; n: number; newest: number }[];
  } | null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Tire Intelligence</h1>
        <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-[12px] font-medium text-slate-600">
          Prices here are ceiling references for quotes — quality tier is the signal (Apr
          20/23). Aftermarket sizes are custom-button, shop-confirmed, no quote (Jun 22).
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

      {/* ---- Brands ---- */}
      {tab === "Brands" && (
        <div className="space-y-4">
          {/* Pinned MVP-call note (Apr 18 / spec §10.1) */}
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-[13px] text-amber-800">
            <span className="font-semibold">Standing note:</span> brand-level tiering is the
            MVP call — the same brand spans quality levels (Goodyear Eagle F1 is
            Elite-quality under a Mid brand). Refine to model-level post-launch.
          </div>
          {brands === undefined ? (
            <Skeleton rows={5} />
          ) : brands.rows.length === 0 ? (
            <Empty text="No tire brands on this deployment — the 272-brand tiered set lives where the scrapers have run. This page fills the day it's seeded." />
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                    <th className="px-4 py-2">Brand</th>
                    <th className="px-2 py-2">Tier</th>
                    <th className="px-2 py-2">Parent company</th>
                    <th className="px-2 py-2">Appearances</th>
                    {canWrite && <th className="px-2 py-2">Set tier</th>}
                  </tr>
                </thead>
                <tbody>
                  {(brands.rows as TireBrandRow[]).map((b) => (
                    <tr key={b.id} className="border-b border-slate-50">
                      <td className="px-4 py-2 font-medium text-slate-800">
                        {b.brand}
                        {b.review_flagged && (
                          <span className={`${pill} ml-2 bg-red-50 text-red-700`}>
                            review flagged
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        <span className={`${pill} ${TIER_STYLE[b.tier]}`}>{tierLabel(b.tier)}</span>
                      </td>
                      <td className="px-2 py-2 text-slate-600">
                        {b.parent_company ?? "—"}
                        {b.is_sub_brand && (
                          <span className={`${pill} ml-1.5 bg-slate-100 text-slate-500`}>
                            sub-brand
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-slate-600">{b.appearance_count ?? "—"}</td>
                      {canWrite && (
                        <td className="px-2 py-2">
                          <select
                            value=""
                            onChange={(e) => {
                              const t = e.target.value as TireBrandRow["tier"];
                              if (t) setTierTarget({ row: b, tier: t });
                            }}
                            className="rounded-md border border-slate-200 px-2 py-1 text-[12px] text-slate-600"
                          >
                            <option value="">change…</option>
                            {(["elite", "select", "standard", "unlisted"] as const)
                              .filter((t) => t !== b.tier)
                              .map((t) => (
                                <option key={t} value={t}>
                                  {tierLabel(t)}
                                </option>
                              ))}
                          </select>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-4 py-2 text-[11px] text-slate-400">
                Scrub provenance: the full set was Yassin-scrubbed (trucks / motorcycles /
                non-USA purged) — recorded here as provenance, not a per-row flag (none exists).
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---- Models & Pricing ---- */}
      {tab === "Models & Pricing" && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-2xl font-bold text-slate-900">
                {summary == null ? "—" : summary.value}
              </div>
              <div className="mt-1 text-xs font-medium text-slate-500">
                tire models (daily stat{summary ? `, ${fmtDate(summary.computed_at)}` : ""})
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-2xl font-bold text-slate-900">
                {summaryMeta?.fill_pct == null
                  ? "—"
                  : `${Math.round(summaryMeta.fill_pct * 100)}%`}
              </div>
              <div className="mt-1 text-xs font-medium text-slate-500">
                price fill vs the {Math.round((summaryMeta?.benchmark_pct ?? 0.94) * 100)}%
                benchmark (BMW 320i, Apr)
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap gap-1.5">
                {(summaryMeta?.per_source ?? []).length === 0 ? (
                  <span className="text-sm text-slate-500">no scrape sources yet</span>
                ) : (
                  summaryMeta!.per_source!.map((s) => (
                    <span key={s.source} className={`${pill} bg-slate-100 text-slate-600`}>
                      {s.source}: {s.n} · {fmtDate(s.newest)}
                    </span>
                  ))
                )}
              </div>
              <div className="mt-1 text-xs font-medium text-slate-500">
                per-source rows &amp; freshest scrape (SimpleTire / Walmart / Tire Rack)
              </div>
            </div>
          </div>

          <div className="flex gap-2">
            <input
              value={modelFilter.size ?? ""}
              onChange={(e) =>
                setModelFilter(e.target.value ? { size: e.target.value } : {})
              }
              placeholder='Filter by size — e.g. "245/40R19"'
              className="w-56 rounded-lg border-[1.5px] border-slate-200 px-3 py-1.5 font-mono text-[13px] outline-none focus:border-blue-500"
            />
            <input
              value={modelFilter.brand ?? ""}
              onChange={(e) =>
                setModelFilter(e.target.value ? { brand: e.target.value } : {})
              }
              placeholder="…or by brand"
              className="w-40 rounded-lg border-[1.5px] border-slate-200 px-3 py-1.5 text-[13px] outline-none focus:border-blue-500"
            />
          </div>

          {models === undefined ? (
            <Skeleton rows={5} />
          ) : models.rows.length === 0 ? (
            <Empty text="No tire models match on this deployment — models land when the three-source scrape pipeline runs." />
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                    <th className="px-4 py-2">Brand / Model</th>
                    <th className="px-2 py-2">Size</th>
                    <th className="px-2 py-2">Type</th>
                    <th className="px-2 py-2">Prices (ceiling reference)</th>
                  </tr>
                </thead>
                <tbody>
                  {(models.rows as TireModelRow[]).map((m) => (
                    <tr key={m.id} className="border-b border-slate-50">
                      <td className="px-4 py-2">
                        <span className="font-medium text-slate-800">{m.brand}</span>{" "}
                        <span className="text-slate-600">{m.model}</span>
                      </td>
                      <td className="px-2 py-2 font-mono text-[12px] text-slate-700">{m.size}</td>
                      <td className="px-2 py-2 text-slate-600">{m.tire_type ?? "—"}</td>
                      <td className="px-2 py-2">
                        {m.prices.length === 0 ? (
                          <span className="text-slate-400">no prices</span>
                        ) : (
                          <span className="flex flex-wrap gap-1.5">
                            {m.prices.map((p, i) => (
                              <span
                                key={i}
                                className={`${pill} bg-slate-100 text-slate-700`}
                                title={`scraped ${fmtDate(p.scraped_at)}`}
                              >
                                <span
                                  className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${
                                    p.fresh ? "bg-emerald-500" : "bg-slate-300"
                                  }`}
                                />
                                {p.source} ${p.price_per_tire.toFixed(0)}
                              </span>
                            ))}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ---- Sizes ---- */}
      {tab === "Sizes" && (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="text-[13px] font-semibold text-slate-900">
              wheelsize.com source status
            </div>
            <p className="mt-1 text-[12px] text-slate-500">
              Free tier: 300 calls/day ($500/yr production decision pending usage). Calls are{" "}
              <span className="font-semibold">not metered anywhere in this codebase yet</span> —
              this card states the limit rather than inventing a count.
            </p>
          </div>
          {sizes === undefined ? (
            <Skeleton rows={5} />
          ) : sizes.trims.length === 0 ? (
            <Empty text="No trim-level tire specs on this deployment (tire data lives under trims — Apr 18)." />
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                    <th className="px-4 py-2">Trim / Config</th>
                    <th className="px-2 py-2">OEM size</th>
                    <th className="px-2 py-2">Rim</th>
                    <th className="px-2 py-2">Options</th>
                    <th className="px-2 py-2">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {(sizes.trims as TrimSizeRow[]).map((t) => (
                    <tr key={t.id} className="border-b border-slate-50">
                      <td className="px-4 py-2 text-slate-700">
                        {t.trim ?? t.config_key ?? "—"}
                      </td>
                      <td className="px-2 py-2">
                        {t.size_front ? (
                          <span className="flex flex-wrap gap-1.5">
                            <span className={`${pill} bg-slate-100 font-mono text-slate-700`}>
                              {t.staggered ? `F ${t.size_front}` : t.size_front}
                            </span>
                            {t.staggered && t.size_rear && (
                              <span className={`${pill} bg-slate-100 font-mono text-slate-700`}>
                                R {t.size_rear}
                              </span>
                            )}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-2 py-2 text-slate-600">
                        {t.rim_diameter_in != null ? `${t.rim_diameter_in}"` : "—"}
                      </td>
                      <td className="px-2 py-2 text-slate-600">{t.options}</td>
                      <td className="px-2 py-2 text-slate-500">{t.source ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {sizes.size_cache.length > 0 && (
                <div className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
                  tire_size_cache: {sizes.size_cache.length} sizes cached, freshest{" "}
                  {fmtDate(Math.max(...sizes.size_cache.map((c: { scraped_at: number }) => c.scraped_at)))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ---- Quote Guardrails ---- */}
      {tab === "Quote Guardrails" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-[12px] font-medium text-slate-600">
            Policy (Jun 22): aftermarket / custom sizes are shop-confirmed via the custom
            button — never quoted. Ceiling = max scraped market price for the OEM size.
          </div>
          {guardrails === undefined ? (
            <Skeleton rows={4} />
          ) : guardrails.rows.length === 0 ? (
            <Empty text="No tire quotes in the window — breaches list here as tire bookings flow." />
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                    <th className="px-4 py-2">Quote</th>
                    <th className="px-2 py-2">Size</th>
                    <th className="px-2 py-2">Per tire</th>
                    <th className="px-2 py-2">Ceiling</th>
                    <th className="px-2 py-2">Verdict</th>
                    <th className="px-2 py-2">When</th>
                  </tr>
                </thead>
                <tbody>
                  {(guardrails.rows as GuardrailRow[]).map((g) => (
                    <tr key={g.quote_id} className="border-b border-slate-50">
                      <td className="px-4 py-2 text-slate-700">
                        {g.tire_brand}
                        {g.tire_model ? ` ${g.tire_model}` : ""} ×{g.quantity}
                      </td>
                      <td className="px-2 py-2 font-mono text-[12px] text-slate-600">
                        {g.size ?? "—"}
                      </td>
                      <td className="px-2 py-2 font-semibold text-slate-900">
                        ${g.per_tire_price.toFixed(0)}
                      </td>
                      <td className="px-2 py-2 text-slate-600">
                        {g.ceiling != null ? `$${g.ceiling.toFixed(0)}` : "no market data"}
                      </td>
                      <td className="px-2 py-2">
                        {g.breach ? (
                          <span className={`${pill} bg-red-50 text-red-700`}>ceiling breach</span>
                        ) : g.ceiling != null ? (
                          <span className={`${pill} bg-emerald-50 text-emerald-700`}>within</span>
                        ) : (
                          <span className={`${pill} bg-slate-100 text-slate-500`}>unscored</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-slate-500">{fmtDate(g.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-4 py-2 text-[11px] text-slate-400">
                window: last {guardrails.window} quotes
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tier-edit ceremony */}
      <Ceremony
        open={tierTarget !== null}
        onOpenChange={(o) => !o && setTierTarget(null)}
        title={`Re-tier ${tierTarget?.row.brand ?? ""}`}
        summary={
          tierTarget && (
            <>
              {tierTarget.row.brand}: {tierLabel(tierTarget.row.tier)} →{" "}
              {tierLabel(tierTarget.tier)}. Tier drives selection order in tire quotes
              (Elite / Select / Standard by brand quality, not price point).
            </>
          )
        }
        onConfirm={async (reason) => {
          if (!tierTarget) return;
          await updateTier({
            token,
            reason,
            brandId: tierTarget.row.id as Id<"tire_brands">,
            tier: tierTarget.tier,
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
