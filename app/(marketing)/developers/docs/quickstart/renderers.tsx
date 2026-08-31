"use client";

// =============================================================================
// Structured renderers for the quickstart playground — the "beautiful output"
// half of the Pretty / Raw toggle. One dispatcher (PrettyResponse) reads the
// response's `object` discriminator and hands off to a purpose-built view:
// spec tables with layer chips + confidence bars, priced-parts cards, tire
// fitment, interval rows, and so on. Falls back to the JSON viewer for anything
// unrecognised. Reuses the shared LayerChip so provenance reads identically to
// the Reference.
// =============================================================================

import { useState } from "react";
import { LayerChip, LAYER_CHIP, CopyButton } from "../../shared";
import type { LayerLetter } from "@/convex/lib/dataLayers";

// ── tiny primitives ──────────────────────────────────────────────────────────
const DATA_CARD = "rounded-xl border border-slate-200 bg-white p-4";

function fmtDate(ms: number | null | undefined): string {
  if (ms == null) return "—";
  try {
    return new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return String(ms);
  }
}

function ConfBar({ conf }: { conf: number | null | undefined }) {
  if (conf == null) return <span className="text-[11px] text-slate-400">n/a</span>;
  const pct = Math.round(conf * 100);
  const tone = pct >= 80 ? "bg-emerald-500" : pct >= 60 ? "bg-amber-500" : "bg-rose-500";
  return (
    <span className="inline-flex items-center gap-1.5" title={`confidence ${conf}`}>
      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-slate-200">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="text-[11px] tabular-nums text-slate-500">{pct}%</span>
    </span>
  );
}

function Chip({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "blue" | "emerald" | "amber" | "rose" }) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-600",
    blue: "bg-blue-100 text-blue-700",
    emerald: "bg-emerald-100 text-emerald-700",
    amber: "bg-amber-100 text-amber-700",
    rose: "bg-rose-100 text-rose-700",
  };
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${tones[tone]}`}>{children}</span>;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{children}</div>;
}

// ── config header — shown atop most responses ────────────────────────────────
type AnyRec = Record<string, unknown>;
function pick(o: unknown, k: string): unknown {
  return o && typeof o === "object" ? (o as AnyRec)[k] : undefined;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
}

function ConfigHeader({ config }: { config: unknown }) {
  if (!config || typeof config !== "object") return null;
  const c = config as AnyRec;
  const engine = c.engine as AnyRec | string | null;
  const engineLabel = typeof engine === "string" ? engine : str(pick(engine, "label"));
  const enr = c.enrichment as AnyRec | undefined;
  const title = [c.year, c.make, c.model, c.trim].filter(Boolean).join(" ") || "Vehicle";
  const facts: Array<[string, string | null]> = [
    ["Engine", engineLabel],
    ["Drivetrain", str(c.drivetrain)],
    ["Transmission", str(c.transmission)],
    ["Chassis", str(c.chassis_code)],
    ["config_key", str(c.config_key)],
  ];
  return (
    <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-slate-900 to-slate-800 p-4 text-white">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[17px] font-semibold">{title}</h3>
        {enr && (
          <span className="ml-auto flex items-center gap-2 text-[11px]">
            {enr.status != null && <Chip tone={enr.status === "complete" || enr.status === "verified" ? "emerald" : "amber"}>{String(enr.status)}</Chip>}
            {enr.fill_rate != null && <span className="text-slate-300">{String(enr.fill_rate)}% filled</span>}
            {enr.confidence_avg != null && <span className="text-slate-400">· conf {String(enr.confidence_avg)}</span>}
          </span>
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
        {facts.filter(([, v]) => v).map(([k, v]) => (
          <div key={k} className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-slate-400">{k}</div>
            <div className="truncate font-mono text-[12px] text-slate-100" title={v ?? ""}>{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── spec-field table (fluids / specs / maintenance) ──────────────────────────
type SpecField = { field: string; label: string; group?: string; value: unknown; layer?: string; confidence?: number | null; source_domain?: string | null };

function SpecTable({ fields, groupBy = true }: { fields: SpecField[]; groupBy?: boolean }) {
  if (!fields || fields.length === 0) return <Empty>No fields served for this vehicle.</Empty>;
  const groups = groupBy
    ? Array.from(new Set(fields.map((f) => f.group ?? "Fields")))
    : ["Fields"];
  return (
    <div className="space-y-4">
      {groups.map((g) => {
        const rows = groupBy ? fields.filter((f) => (f.group ?? "Fields") === g) : fields;
        return (
          <div key={g} className={DATA_CARD}>
            <SectionLabel>{g}</SectionLabel>
            <div className="divide-y divide-slate-100">
              {rows.map((f) => (
                <div key={f.field} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-slate-800">{f.label}</div>
                    <div className="font-mono text-[10px] text-slate-400">{f.field}</div>
                  </div>
                  <div className="max-w-[42%] shrink-0 text-right">
                    <div className="truncate text-[13px] font-semibold text-slate-900" title={String(f.value ?? "")}>
                      {f.value == null || f.value === "" ? <span className="text-slate-300">—</span> : String(f.value)}
                    </div>
                    {f.source_domain && <div className="truncate text-[10px] text-slate-400">{f.source_domain}</div>}
                  </div>
                  <div className="flex w-24 shrink-0 items-center justify-end gap-1.5">
                    <ConfBar conf={f.confidence} />
                    <LayerChip letter={(f.layer as LayerLetter) ?? "unknown"} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ExcludedList({ excluded }: { excluded: Array<{ field: string; label?: string; blocking_layer?: string; reason?: string }> }) {
  const [open, setOpen] = useState(false);
  if (!excluded || excluded.length === 0) return null;
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 text-left">
        <span className="text-[12px] font-semibold text-rose-700">Withheld by the gate · {excluded.length}</span>
        <span className="text-[11px] text-rose-500">licensed / flagged rows — visible, not silent</span>
        <span className="ml-auto text-[11px] text-rose-400">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <div className="mt-2 divide-y divide-rose-100">
          {excluded.map((e) => (
            <div key={e.field} className="flex items-center gap-2 py-1.5">
              <span className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold ${LAYER_CHIP[e.blocking_layer ?? "unknown"] ?? LAYER_CHIP.unknown}`}>
                {e.blocking_layer ?? "?"}
              </span>
              <span className="text-[12px] font-medium text-slate-700">{e.label ?? e.field}</span>
              <span className="ml-auto truncate text-[11px] text-slate-400" title={e.reason ?? ""}>{e.reason}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MetaStrip({ meta }: { meta: unknown }) {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as AnyRec;
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-500">
      {m.gate != null && <div>{String(m.gate)}</div>}
      {m.generated_at != null && <div className="mt-0.5 text-slate-400">Generated {fmtDate(Number(m.generated_at))}</div>}
    </div>
  );
}

// ── tires ────────────────────────────────────────────────────────────────────
function TiresView({ tires }: { tires: unknown }) {
  if (!tires || typeof tires !== "object") return <Empty>No tire package for this vehicle.</Empty>;
  const t = tires as AnyRec;
  const flags: Array<[string, unknown]> = [
    ["Front", t.front_size],
    ["Rear", t.rear_size],
    ["Front PSI", t.pressure_front_psi],
    ["Rear PSI", t.pressure_rear_psi],
    ["Battery CCA", t.battery_cca],
  ];
  return (
    <div className={DATA_CARD}>
      <div className="flex flex-wrap gap-2">
        {t.is_staggered ? <Chip tone="amber">staggered</Chip> : <Chip tone="emerald">square fitment</Chip>}
        {t.is_run_flat ? <Chip tone="amber">run-flat</Chip> : <Chip>standard</Chip>}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {flags.filter(([, v]) => v != null).map(([k, v]) => (
          <div key={k} className="rounded-lg bg-slate-50 p-3">
            <div className="text-[10px] uppercase tracking-wider text-slate-400">{k}</div>
            <div className="font-mono text-[15px] font-semibold text-slate-900">{String(v)}</div>
          </div>
        ))}
      </div>
      {Array.isArray(t.options) && t.options.length > 0 && (
        <div className="mt-3">
          <SectionLabel>OEM options</SectionLabel>
          <div className="space-y-1.5">
            {(t.options as AnyRec[]).map((o, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 px-3 py-2 text-[12px]">
                <span className="font-mono font-semibold text-slate-800">{String(o.oem_name ?? o.size_front ?? "—")}</span>
                {o.load_index != null && <Chip>LI {String(o.load_index)}</Chip>}
                {o.speed_rating != null && <Chip>SR {String(o.speed_rating)}</Chip>}
                {o.is_oem_standard ? <Chip tone="emerald">OEM standard</Chip> : null}
              </div>
            ))}
          </div>
        </div>
      )}
      {typeof t.source === "string" && (
        <a href={t.source} target="_blank" rel="noreferrer" className="mt-3 inline-block truncate text-[11px] text-blue-600 hover:underline">
          source: {t.source}
        </a>
      )}
    </div>
  );
}

// ── intervals ────────────────────────────────────────────────────────────────
function IntervalsView({ intervals }: { intervals: unknown }) {
  const rows = Array.isArray(intervals) ? (intervals as AnyRec[]) : [];
  if (rows.length === 0) return <Empty>No service intervals for this vehicle.</Empty>;
  return (
    <div className={DATA_CARD}>
      <div className="divide-y divide-slate-100">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-slate-800">{String(r.name ?? r.service)}</div>
              <div className="font-mono text-[10px] text-slate-400">{String(r.service)}</div>
            </div>
            <div className="shrink-0 font-mono text-[13px] font-semibold text-slate-900">
              {String(r.display ?? ([r.interval_miles && `${r.interval_miles} mi`, r.interval_months && `${r.interval_months} mo`].filter(Boolean).join(" / ") || "—"))}
            </div>
            <div className="flex w-24 shrink-0 items-center justify-end gap-1.5">
              <ConfBar conf={typeof r.confidence === "number" ? r.confidence : null} />
              {r.mechanic_verified ? <Chip tone="emerald">verified</Chip> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── parts + labor per service ────────────────────────────────────────────────
function money(n: unknown): string {
  return typeof n === "number" ? `$${n.toFixed(2)}` : "—";
}
function PartsView({ services }: { services: unknown }) {
  const rows = Array.isArray(services) ? (services as AnyRec[]) : [];
  if (rows.length === 0) return <Empty>No priced services for this vehicle.</Empty>;
  return (
    <div className="space-y-3">
      {rows.map((s, i) => {
        const parts = Array.isArray(s.parts) ? (s.parts as AnyRec[]) : [];
        const labor = s.labor as AnyRec | undefined;
        return (
          <div key={i} className={DATA_CARD}>
            <div className="flex items-center gap-2">
              <h4 className="text-[14px] font-semibold text-slate-800">{String(s.name ?? s.service)}</h4>
              {s.applicable === false ? <Chip tone="rose">n/a for this car</Chip> : <Chip tone="emerald">applicable</Chip>}
              {labor?.hours != null && (
                <span className="ml-auto text-[12px] text-slate-500">
                  labor <span className="font-semibold text-slate-800">{String(labor.hours)} h</span>
                  <span className="text-slate-400"> · {String(labor.source ?? "")}</span>
                </span>
              )}
            </div>
            {parts.length > 0 && (
              <div className="mt-2 divide-y divide-slate-100">
                {parts.map((p, j) => (
                  <div key={j} className="flex flex-wrap items-center gap-2 py-2">
                    <span className="font-mono text-[12px] font-semibold text-slate-900">{String(p.oem_part_number ?? "—")}</span>
                    {p.name ? <span className="text-[12px] text-slate-600">{String(p.name)}</span> : null}
                    {p.role ? <Chip>{String(p.role)}</Chip> : null}
                    {p.position ? <Chip tone="blue">{String(p.position)}</Chip> : null}
                    {p.quantity != null && <Chip>×{String(p.quantity)}</Chip>}
                    {p.mechanic_verified ? <Chip tone="emerald">verified</Chip> : null}
                    <span className="ml-auto text-right">
                      <span className="text-[13px] font-semibold text-slate-900">{money(pick(p.price, "amount"))}</span>
                      {pick(p.price, "msrp") != null && (
                        <span className="ml-1.5 text-[11px] text-slate-400 line-through">{money(pick(p.price, "msrp"))}</span>
                      )}
                      {pick(p.price, "source_domain") != null && (
                        <div className="text-[10px] text-slate-400">
                          {String(pick(p.price, "source_domain"))} · {fmtDate(pick(p.price, "as_of") as number)}
                        </div>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── labor (v0) ───────────────────────────────────────────────────────────────
function LaborView({ data }: { data: AnyRec }) {
  const services = Array.isArray(data.services) ? (data.services as AnyRec[]) : [];
  const estimates = Array.isArray(data.estimates) ? (data.estimates as AnyRec[]) : [];
  return (
    <div className="space-y-3">
      {services.length > 0 && (
        <div className={DATA_CARD}>
          <SectionLabel>Empirical — measured from completed jobs</SectionLabel>
          <div className="divide-y divide-slate-100">
            {services.map((s, i) => (
              <div key={i} className="flex items-center gap-3 py-2 text-[12px]">
                <span className="min-w-0 flex-1 font-medium text-slate-800">{String(s.name ?? s.service)}</span>
                <span className="font-mono font-semibold text-slate-900">{String(s.empirical_hours)} h</span>
                {(s.p25_hours != null || s.p75_hours != null) && (
                  <span className="text-slate-400">p25–p75 {String(s.p25_hours ?? "?")}–{String(s.p75_hours ?? "?")}</span>
                )}
                {s.sample_size != null && <Chip>n={String(s.sample_size)}</Chip>}
              </div>
            ))}
          </div>
        </div>
      )}
      {estimates.length > 0 && (
        <div className={DATA_CARD}>
          <SectionLabel>Estimates — every applicable service {data.tier ? `· tier ${String(data.tier)}` : ""}</SectionLabel>
          <div className="divide-y divide-slate-100">
            {estimates.map((s, i) => (
              <div key={i} className="flex items-center gap-3 py-2 text-[12px]">
                <span className="min-w-0 flex-1 font-medium text-slate-800">{String(s.name ?? s.service)}</span>
                <span className="font-mono font-semibold text-slate-900">{String(s.estimated_hours)} h</span>
                <Chip tone={s.estimate_source === "empirical" ? "emerald" : "amber"}>{String(s.estimate_source)}</Chip>
                <ConfBar conf={typeof s.estimate_confidence === "number" ? s.estimate_confidence : null} />
              </div>
            ))}
          </div>
        </div>
      )}
      {data.note ? <p className="px-1 text-[11px] text-slate-400">{String(data.note)}</p> : null}
    </div>
  );
}

// ── image ────────────────────────────────────────────────────────────────────
function ImageView({ data }: { data: AnyRec }) {
  const img = data.image as AnyRec | null;
  if (!img) return <Empty>No cached render for this vehicle yet.</Empty>;
  return (
    <div className={DATA_CARD}>
      {typeof img.url === "string" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={img.url} alt="Vehicle render" className="w-full rounded-lg bg-slate-100 object-contain" />
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        {img.media_source ? <Chip tone="blue">{String(img.media_source)}</Chip> : null}
        {img.licensing_note ? <span>{String(img.licensing_note)}</span> : null}
      </div>
    </div>
  );
}

// ── service history ──────────────────────────────────────────────────────────
function HistoryView({ data }: { data: AnyRec }) {
  const records = Array.isArray(data.records) ? (data.records as AnyRec[]) : [];
  const sourceTone: Record<string, "blue" | "amber" | "slate"> = { shop_visit: "blue", owner_reported: "amber", document: "slate" };
  return (
    <div className="space-y-2">
      {data.vin ? <div className="font-mono text-[11px] text-slate-400">VIN {String(data.vin)}</div> : null}
      {records.length === 0 ? (
        <Empty>No service records for this VIN.</Empty>
      ) : (
        records.map((r, i) => (
          <div key={i} className={DATA_CARD}>
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold text-slate-800">{r.date ? fmtDate(Date.parse(String(r.date))) : "Undated"}</span>
              {r.mileage != null && <span className="text-[12px] text-slate-500">{Number(r.mileage).toLocaleString("en-US")} mi</span>}
              <Chip tone={sourceTone[String(r.source)] ?? "slate"}>{String(r.source)}</Chip>
              {r.confidence != null && <span className="ml-auto text-[11px] text-slate-400">conf {String(r.confidence)}</span>}
            </div>
            {Array.isArray(r.services) && r.services.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(r.services as unknown[]).map((s, j) => <Chip key={j}>{String(s)}</Chip>)}
              </div>
            )}
            {Array.isArray(r.parts) && r.parts.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {(r.parts as AnyRec[]).map((p, j) => (
                  <span key={j} className="font-mono text-[11px] text-slate-500">{String(p.oem_part_number ?? p.name ?? "")}</span>
                ))}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

// ── decode / config list / enrichment ────────────────────────────────────────
function ConfigListView({ data, onPick }: { data: AnyRec; onPick?: (configKey: string) => void }) {
  const configs = Array.isArray(data.configs) ? (data.configs as AnyRec[]) : [];
  return (
    <div className="space-y-2">
      <div className="text-[12px] text-slate-500">{String(data.count ?? configs.length)} config(s) for {[data.year, data.make, data.model].filter(Boolean).join(" ")}</div>
      {configs.map((c, i) => (
        <div key={i} className={`${DATA_CARD} flex flex-wrap items-center gap-2`}>
          <button
            onClick={() => onPick?.(String(c.config_key))}
            className="font-mono text-[12px] font-semibold text-blue-700 hover:underline"
            title="Use this config_key"
          >
            {String(c.config_key)}
          </button>
          {c.trim ? <Chip tone="blue">{String(c.trim)}</Chip> : null}
          {c.engine ? <Chip>{String(c.engine)}</Chip> : null}
          {c.drivetrain ? <Chip>{String(c.drivetrain)}</Chip> : null}
          <span className="ml-auto flex items-center gap-2">
            {c.enrichment_status ? <Chip tone={c.enrichment_status === "complete" ? "emerald" : "amber"}>{String(c.enrichment_status)}</Chip> : null}
            {c.fill_rate != null && <span className="text-[11px] text-slate-400">{String(c.fill_rate)}%</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

function EnrichmentView({ data }: { data: AnyRec }) {
  const status = String(data.status ?? "unknown");
  const tone = status === "complete" ? "emerald" : status === "failed" ? "rose" : "amber";
  return (
    <div className={DATA_CARD}>
      <div className="flex items-center gap-2">
        <Chip tone={tone}>{status}</Chip>
        {data.config_key ? <span className="font-mono text-[12px] text-slate-600">{String(data.config_key)}</span> : null}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3 text-[12px]">
        {data.fill_rate != null && <div><span className="text-slate-400">fill rate</span> <span className="font-semibold text-slate-800">{String(data.fill_rate)}%</span></div>}
        {data.last_enriched_at != null && <div><span className="text-slate-400">last enriched</span> <span className="font-semibold text-slate-800">{fmtDate(Number(data.last_enriched_at))}</span></div>}
        {data.enrichment_status != null && <div><span className="text-slate-400">raw status</span> <span className="font-mono text-slate-700">{String(data.enrichment_status)}</span></div>}
      </div>
      {data.poll != null && <p className="mt-2 text-[11px] text-slate-400">Poll {String(pick(data.poll, "url"))} every {String(pick(data.poll, "interval_seconds"))}s.</p>}
    </div>
  );
}

// ── shared states ────────────────────────────────────────────────────────────
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-200 bg-white p-6 text-center text-[13px] text-slate-400">{children}</div>;
}

function ErrorView({ data, status }: { data: AnyRec; status?: number }) {
  const matches = Array.isArray(data.matches) ? (data.matches as AnyRec[]) : null;
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
      <div className="flex items-center gap-2">
        {status != null && <Chip tone="rose">{status}</Chip>}
        <span className="font-mono text-[12px] font-semibold text-rose-700">{String(data.error ?? "error")}</span>
      </div>
      {data.message ? <p className="mt-1.5 text-[13px] text-rose-800">{String(data.message)}</p> : null}
      {matches && (
        <div className="mt-3 space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-rose-500">Candidate configs — retry with one</div>
          {matches.map((m, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg bg-white px-3 py-1.5">
              <span className="font-mono text-[12px] text-slate-800">{String(m.config_key)}</span>
              {m.label ? <span className="text-[11px] text-slate-400">{String(m.label)}</span> : null}
              <span className="ml-auto"><CopyButton text={String(m.config_key)} label="Copy" /></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── raw JSON viewer with lightweight syntax highlighting ─────────────────────
function highlightJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2) ?? "null";
  const esc = json.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(
    /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = "text-emerald-300"; // number
      if (/^"/.test(match)) cls = /:$/.test(match) ? "text-sky-300" : "text-amber-200";
      else if (match === "true" || match === "false") cls = "text-purple-300";
      else if (match === "null") cls = "text-slate-500";
      return `<span class="${cls}">${match}</span>`;
    },
  );
}

export function JsonView({ value }: { value: unknown }) {
  return (
    <div className="relative">
      <div className="absolute right-2 top-2 z-10">
        <CopyButton text={JSON.stringify(value, null, 2)} label="Copy JSON" dark />
      </div>
      <pre
        className="max-h-[520px] overflow-auto rounded-xl bg-slate-900 p-4 font-mono text-[12px] leading-5 text-slate-100"
        dangerouslySetInnerHTML={{ __html: highlightJson(value) }}
      />
    </div>
  );
}

// ── the dispatcher ───────────────────────────────────────────────────────────
export function PrettyResponse({
  data,
  status,
  onPickConfig,
}: {
  data: unknown;
  status?: number;
  onPickConfig?: (configKey: string) => void;
}) {
  if (data == null || typeof data !== "object") return <JsonView value={data} />;
  const d = data as AnyRec;

  // Errors (any non-2xx JSON body carries `error`) + the 409 matches shape.
  if (d.error != null || (status != null && status >= 400)) return <ErrorView data={d} status={status} />;

  const object = String(d.object ?? "");
  switch (object) {
    case "vehicle":
      return (
        <div className="space-y-3">
          <ConfigHeader config={d.config} />
          {Array.isArray(d.specs) && d.specs.length > 0 && <SpecTable fields={d.specs as SpecField[]} />}
          {Array.isArray(d.excluded) && <ExcludedList excluded={d.excluded as never} />}
          {d.tires != null && (<div><SectionLabel>Tires & wheels</SectionLabel><TiresView tires={d.tires} /></div>)}
          {Array.isArray(d.intervals) && d.intervals.length > 0 && (<div><SectionLabel>Maintenance schedule</SectionLabel><IntervalsView intervals={d.intervals} /></div>)}
          {Array.isArray(d.services) && d.services.length > 0 && (<div><SectionLabel>Parts & labor</SectionLabel><PartsView services={d.services} /></div>)}
          {d.history != null && (<div><SectionLabel>Service history</SectionLabel><HistoryView data={d.history as AnyRec} /></div>)}
          <MetaStrip meta={d.meta} />
        </div>
      );
    case "specs":
    case "maintenance_specs":
      return (
        <div className="space-y-3">
          <ConfigHeader config={d.config} />
          <SpecTable fields={(d.fields as SpecField[]) ?? []} />
          <ExcludedList excluded={(d.excluded as never) ?? []} />
          <MetaStrip meta={d.meta} />
        </div>
      );
    case "fluids":
      return (
        <div className="space-y-3">
          <ConfigHeader config={d.config} />
          <SpecTable fields={(d.fields as SpecField[]) ?? []} groupBy={false} />
          <MetaStrip meta={d.meta} />
        </div>
      );
    case "tires":
      return (
        <div className="space-y-3">
          <ConfigHeader config={d.config} />
          <TiresView tires={d.tires} />
          <MetaStrip meta={d.meta} />
        </div>
      );
    case "maintenance_schedule":
      return (
        <div className="space-y-3">
          <ConfigHeader config={d.config} />
          <IntervalsView intervals={d.intervals} />
          <MetaStrip meta={d.meta} />
        </div>
      );
    case "parts":
      return (
        <div className="space-y-3">
          <ConfigHeader config={d.config} />
          <PartsView services={d.services} />
          <MetaStrip meta={d.meta} />
        </div>
      );
    case "decode":
      return <ConfigHeader config={d.config} />;
    case "config_list":
      return <ConfigListView data={d} onPick={onPickConfig} />;
    case "empirical_labor":
      return (
        <div className="space-y-3">
          {d.config_key ? <div className="font-mono text-[11px] text-slate-400">{String(d.config_key)}</div> : null}
          <LaborView data={d} />
        </div>
      );
    case "vehicle_image":
      return (
        <div className="space-y-3">
          <ConfigHeader config={d.config} />
          <ImageView data={d} />
          <MetaStrip meta={d.meta} />
        </div>
      );
    case "service_history":
      return <HistoryView data={d} />;
    case "enrichment":
    case "enrichment_status":
      return <EnrichmentView data={d} />;
    default:
      return <JsonView value={data} />;
  }
}
