"use client";

// Data · API console — live playground. Request builder (endpoint toggle,
// YMMT inputs OR config_key typeahead OR raw VIN, optional labor service slug,
// API key) → real fetch against /v0 with status + latency, structured 200
// rendering for all three endpoints (vehicle is the flagship + default), 409
// multiple_matches disambiguation with clickable re-send, raw JSON, and a
// session-local history strip.

import { useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type {
  MaintenanceResponse,
  LaborResponse,
  VehicleResponse,
  MaintenanceField,
  ExcludedField,
} from "@/convex/dataApi";
import { usePortalSession } from "../../portal-session";
import { CARD, MONO, PILL, INPUT, TH, CopyButton, LayerChip, StatusPill, baseUrl } from "./shared";

type MaintOk = NonNullable<MaintenanceResponse>;
type LaborOk = NonNullable<LaborResponse>;
type VehicleOk = Extract<NonNullable<VehicleResponse>, { object: "vehicle" }>;
type YmmtMatch = Extract<NonNullable<VehicleResponse>, { object: "multiple_matches" }>["matches"][number];

type Endpoint = "/v0/vehicle" | "/v0/maintenance" | "/v0/labor";
type IdMode = "ymmt" | "vin" | "config_key";

/** Loose view of one OEM tire-fitment option (tires.options is unknown[] on the wire). */
type TireOption = {
  oem_name?: string | null;
  size_front?: string | null;
  size_rear?: string | null;
  pressure_front_psi?: number | null;
  pressure_rear_psi?: number | null;
  is_oem_standard?: boolean | null;
  wheel_spec?: string | null;
};

type SentRequest = {
  at: number;
  endpoint: Endpoint;
  params: string; // human-readable query summary
  status: number;
  latencyMs: number;
  body: unknown;
};

// ─── Small render helpers ────────────────────────────────────────────────────

function SectionHead({ children }: { children: ReactNode }) {
  return <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">{children}</div>;
}

function EmptyLine({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-slate-100 px-3 py-3 text-center text-[12px] text-slate-400">{children}</p>
  );
}

function VerifiedPill({ verified }: { verified: boolean }) {
  return verified ? (
    <span className={`${PILL} bg-emerald-50 text-emerald-700`}>verified</span>
  ) : (
    <span className={`${PILL} bg-slate-100 text-slate-500`}>unverified</span>
  );
}

/** Served-fields list + amber excluded panel — shared by /v0/maintenance and
 *  the specs section of /v0/vehicle. */
function SpecsBlock({ fields, excluded }: { fields: MaintenanceField[]; excluded: ExcludedField[] }) {
  return (
    <>
      <div>
        <SectionHead>Served fields · {fields.length}</SectionHead>
        <div className="overflow-hidden rounded-lg border border-slate-100">
          {fields.map((f) => (
            <div key={f.field} className="flex items-center gap-2 border-b border-slate-50 px-3 py-1.5 last:border-0">
              <LayerChip letter={f.layer} />
              <span className="w-44 shrink-0 text-[12px] text-slate-500">{f.label}</span>
              <span className="min-w-0 flex-1 text-[13px] font-medium text-slate-900">{f.value}</span>
              <span className={`${MONO} shrink-0 text-slate-400`}>{f.confidence?.toFixed(2) ?? "—"}</span>
              <span className={`${MONO} hidden w-36 shrink-0 truncate text-right text-slate-400 sm:inline`}>
                {f.source_domain ?? ""}
              </span>
            </div>
          ))}
          {fields.length === 0 && (
            <div className="px-3 py-4 text-center text-[12px] text-slate-400">
              Nothing on this config clears the gate yet.
            </div>
          )}
        </div>
      </div>
      <div>
        <SectionHead>Excluded by the gate · {excluded.length}</SectionHead>
        <div className="overflow-hidden rounded-lg border border-amber-100 bg-amber-50/40">
          {excluded.map((f) => (
            <div key={f.field} className="flex items-center gap-2 border-b border-amber-100/60 px-3 py-1.5 last:border-0">
              <LayerChip letter={f.blocking_layer} />
              <span className="w-44 shrink-0 text-[12px] text-slate-500">{f.label}</span>
              <span className="min-w-0 flex-1 text-[12px] text-amber-800">{f.reason}</span>
            </div>
          ))}
          {excluded.length === 0 && (
            <div className="px-3 py-3 text-center text-[12px] text-slate-400">Nothing excluded.</div>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Vehicle sections ────────────────────────────────────────────────────────

function VehicleView({ v }: { v: VehicleOk }) {
  const cfg = v.config;
  return (
    <div className="mt-3 space-y-4">
      {/* Identity header line */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[13px] font-semibold text-slate-800">
          {cfg.year} {cfg.make} {cfg.model} {cfg.trim ?? ""}
        </span>
        <span className="text-[13px] text-slate-400">
          {[cfg.engine?.label, cfg.drivetrain].filter(Boolean).join(" · ")}
        </span>
        {cfg.enrichment.status && (
          <span className={`${PILL} bg-blue-50 text-blue-700`}>{cfg.enrichment.status}</span>
        )}
        {cfg.enrichment.fill_rate != null && (
          <span className={`${PILL} bg-slate-100 text-slate-600`}>
            {Math.round(cfg.enrichment.fill_rate * 100)}% filled
          </span>
        )}
      </div>

      {/* Specs — same gate rendering as /v0/maintenance */}
      <SpecsBlock fields={v.specs} excluded={v.excluded} />

      {/* Tires */}
      <div>
        <SectionHead>Tires</SectionHead>
        {v.tires === null ? (
          <EmptyLine>No tire fitment data yet.</EmptyLine>
        ) : (
          <div className="rounded-lg border border-slate-100 p-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
              <span>
                <span className="text-slate-400">front </span>
                <span className={`${MONO} font-semibold text-slate-900`}>{v.tires.front_size ?? "—"}</span>
                {v.tires.pressure_front_psi != null && (
                  <span className="ml-1 tabular-nums text-slate-500">{v.tires.pressure_front_psi} psi</span>
                )}
              </span>
              <span>
                <span className="text-slate-400">rear </span>
                <span className={`${MONO} font-semibold text-slate-900`}>{v.tires.rear_size ?? "—"}</span>
                {v.tires.pressure_rear_psi != null && (
                  <span className="ml-1 tabular-nums text-slate-500">{v.tires.pressure_rear_psi} psi</span>
                )}
              </span>
              {v.tires.is_staggered && <span className={`${PILL} bg-purple-50 text-purple-700`}>staggered</span>}
              {v.tires.is_run_flat && <span className={`${PILL} bg-amber-50 text-amber-700`}>run-flat</span>}
              {v.tires.battery_cca != null && (
                <span className="tabular-nums text-slate-500">battery {v.tires.battery_cca} CCA</span>
              )}
              {v.tires.source && <span className={`${MONO} text-slate-400`}>{v.tires.source}</span>}
            </div>
            {v.tires.options && v.tires.options.length > 0 && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className={TH}>
                      <th className="pb-2 pr-4">OEM fitment</th>
                      <th className="pb-2 pr-4">Front</th>
                      <th className="pb-2 pr-4">Rear</th>
                      <th className="pb-2 pr-4">Pressure</th>
                      <th className="pb-2 pr-4">Standard</th>
                      <th className="pb-2">Wheel</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.tires.options.map((raw, i) => {
                      const o = raw as TireOption;
                      return (
                        <tr key={i} className="border-b border-slate-50 last:border-0">
                          <td className="py-2 pr-4 font-medium text-slate-900">{o.oem_name ?? "—"}</td>
                          <td className={`py-2 pr-4 ${MONO} text-slate-600`}>{o.size_front ?? "—"}</td>
                          <td className={`py-2 pr-4 ${MONO} text-slate-600`}>{o.size_rear ?? "—"}</td>
                          <td className="py-2 pr-4 tabular-nums text-slate-500">
                            {o.pressure_front_psi != null || o.pressure_rear_psi != null
                              ? `${o.pressure_front_psi ?? "—"} / ${o.pressure_rear_psi ?? "—"} psi`
                              : "—"}
                          </td>
                          <td className="py-2 pr-4">
                            {o.is_oem_standard ? (
                              <span className={`${PILL} bg-emerald-50 text-emerald-700`}>OEM standard</span>
                            ) : (
                              <span className={`${PILL} bg-slate-100 text-slate-500`}>option</span>
                            )}
                          </td>
                          <td className={`py-2 ${MONO} text-slate-500`}>{o.wheel_spec ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Intervals */}
      <div>
        <SectionHead>Intervals · {v.intervals.length}</SectionHead>
        {v.intervals.length === 0 ? (
          <EmptyLine>No intervals enriched yet.</EmptyLine>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-100 px-3">
            <table className="w-full text-[13px]">
              <thead>
                <tr className={TH}>
                  <th className="pb-2 pt-2 pr-4">Service</th>
                  <th className="pb-2 pt-2 pr-4">Interval</th>
                  <th className="pb-2 pt-2 pr-4">Conf.</th>
                  <th className="pb-2 pt-2">Verified</th>
                </tr>
              </thead>
              <tbody>
                {v.intervals.map((iv) => (
                  <tr key={iv.service} className="border-b border-slate-50 last:border-0">
                    <td className="py-2 pr-4">
                      <span className="font-medium text-slate-900">{iv.name}</span>
                      <span className={`${MONO} ml-2 text-slate-400`}>{iv.service}</span>
                    </td>
                    <td className="py-2 pr-4 tabular-nums text-slate-700">
                      {iv.display ??
                        ([
                          iv.interval_miles != null ? `${iv.interval_miles.toLocaleString()} mi` : null,
                          iv.interval_months != null ? `${iv.interval_months} mo` : null,
                        ]
                          .filter(Boolean)
                          .join(" / ") ||
                          "—")}
                    </td>
                    <td className={`py-2 pr-4 ${MONO} tabular-nums text-slate-400`}>
                      {iv.confidence?.toFixed(2) ?? "—"}
                    </td>
                    <td className="py-2">
                      <VerifiedPill verified={iv.mechanic_verified} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Services: stacked cards — booking-grade labor + parts per service */}
      <div>
        <SectionHead>Services · {v.services.length}</SectionHead>
        {v.services.length === 0 ? (
          <EmptyLine>No services enriched yet.</EmptyLine>
        ) : (
          <div className="space-y-2">
            {v.services.map((s) => {
              const sourceTone: Record<string, string> = {
                empirical: "bg-emerald-50 text-emerald-700",
                tier_estimate: "bg-amber-50 text-amber-700",
                service_default: "bg-slate-100 text-slate-500",
              };
              return (
                <div key={s.service} className="rounded-lg border border-slate-100 p-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className={`${MONO} font-semibold text-slate-900`}>{s.name ?? s.service}</span>
                    {s.labor.hours != null ? (
                      <>
                        <span className="tabular-nums text-[13px] font-semibold text-slate-700">
                          {s.labor.hours.toFixed(2)}h
                        </span>
                        <span
                          className={`${PILL} ${sourceTone[s.labor.source] ?? "bg-blue-50 text-blue-700"}`}
                          title={`confidence ${s.labor.confidence ?? "n/a"}${s.labor.sample_size != null ? ` · n=${s.labor.sample_size}` : ""}`}
                        >
                          {s.labor.source}
                          {s.labor.sample_size != null ? ` n=${s.labor.sample_size}` : ""}
                        </span>
                        {s.labor.tier_floor_applied && (
                          <span className={`${PILL} bg-violet-50 text-violet-700`} title="raw hours were below the tier floor — floor substituted">
                            floor
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-[12px] text-red-500">no labor resolved</span>
                    )}
                    {!s.applicable && (
                      <span className={`${PILL} bg-slate-100 text-slate-500`} title="parts exist but the applicability rules exclude this service for this vehicle">
                        not applicable
                      </span>
                    )}
                  </div>
                  {s.parts.length === 0 ? (
                    <p className="mt-2 text-[12px] text-slate-400">No parts mapped for this service yet.</p>
                  ) : (
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full text-[13px]">
                        <thead>
                          <tr className={TH}>
                            <th className="pb-2 pr-4">OEM #</th>
                            <th className="pb-2 pr-4">Part</th>
                            <th className="pb-2 pr-4">Role</th>
                            <th className="pb-2 pr-4">Qty</th>
                            <th className="pb-2 pr-4">Verified</th>
                            <th className="pb-2">Price</th>
                          </tr>
                        </thead>
                        <tbody>
                          {s.parts.map((p) => (
                            <tr key={p.oem_part_number} className="border-b border-slate-50 last:border-0">
                              <td className={`py-2 pr-4 ${MONO} text-slate-700`}>{p.oem_part_number}</td>
                              <td className="py-2 pr-4">
                                <span className="font-medium text-slate-900">{p.name ?? "—"}</span>
                                {p.position && <span className="ml-2 text-[11px] text-slate-400">{p.position}</span>}
                              </td>
                              <td className="py-2 pr-4">
                                {p.role ? (
                                  <span className={`${PILL} bg-slate-100 text-slate-600`}>{p.role}</span>
                                ) : (
                                  <span className="text-slate-400">—</span>
                                )}
                              </td>
                              <td className="py-2 pr-4 tabular-nums text-slate-500">{p.quantity ?? "—"}</td>
                              <td className="py-2 pr-4">
                                <VerifiedPill verified={p.mechanic_verified} />
                              </td>
                              <td className="py-2 whitespace-nowrap">
                                {p.price ? (
                                  <>
                                    <span className="tabular-nums font-semibold text-slate-900">
                                      ${p.price.amount.toFixed(2)}
                                    </span>
                                    {p.price.msrp != null && p.price.msrp > p.price.amount && (
                                      <span className="ml-1.5 tabular-nums text-slate-400 line-through">
                                        ${p.price.msrp.toFixed(2)}
                                      </span>
                                    )}
                                    {p.price.source_domain && (
                                      <span className={`${MONO} ml-1.5 text-slate-400`}>{p.price.source_domain}</span>
                                    )}
                                  </>
                                ) : (
                                  <span className="text-slate-400">—</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* History — VIN lookups only */}
      {v.history !== null && (
        <div>
          <SectionHead>History · VIN lookup</SectionHead>
          <div className="rounded-lg border border-slate-100 p-3">
            {v.history.passport ? (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
                <span>
                  <span className="text-slate-400">mileage </span>
                  <span className="tabular-nums font-semibold text-slate-900">
                    {v.history.passport.mileage != null ? v.history.passport.mileage.toLocaleString() : "—"}
                  </span>
                </span>
                <span>
                  <span className="text-slate-400">last shop-confirmed </span>
                  <span className="text-slate-700">
                    {v.history.passport.last_shop_confirmed_at != null
                      ? new Date(v.history.passport.last_shop_confirmed_at).toLocaleDateString()
                      : "never"}
                  </span>
                </span>
              </div>
            ) : (
              <p className="text-[12px] text-slate-400">No passport on this vehicle yet.</p>
            )}
            {v.history.visits.length === 0 ? (
              <p className="mt-2 text-[12px] text-slate-400">No visits recorded yet.</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className={TH}>
                      <th className="pb-2 pr-4">Date</th>
                      <th className="pb-2 pr-4">Status</th>
                      <th className="pb-2 pr-4">Services</th>
                      <th className="pb-2">Shop</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.history.visits.map((visit, i) => (
                      <tr key={i} className="border-b border-slate-50 last:border-0">
                        <td className="py-2 pr-4 whitespace-nowrap text-slate-700">{visit.date ?? "—"}</td>
                        <td className="py-2 pr-4">
                          <span className={`${PILL} bg-slate-100 text-slate-600`}>{visit.status}</span>
                        </td>
                        <td className={`py-2 pr-4 ${MONO} text-slate-600`}>
                          {visit.services.length > 0 ? visit.services.join(", ") : "—"}
                        </td>
                        <td className="py-2 text-slate-500">{visit.shop ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Playground ──────────────────────────────────────────────────────────────

export function Playground({
  apiKey,
  onApiKeyChange,
}: {
  apiKey: string;
  onApiKeyChange: (k: string) => void;
}) {
  const { token } = usePortalSession();
  const [endpoint, setEndpoint] = useState<Endpoint>("/v0/vehicle");
  const [idMode, setIdMode] = useState<IdMode>("ymmt");
  const [search, setSearch] = useState("");
  const [configKey, setConfigKey] = useState("");
  const [vin, setVin] = useState("");
  const [year, setYear] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [trim, setTrim] = useState("");
  const [service, setService] = useState("");
  const [busy, setBusy] = useState(false);
  const [resp, setResp] = useState<{ status: number; latencyMs: number; body: unknown } | null>(null);
  const [history, setHistory] = useState<SentRequest[]>([]);

  const configs: FunctionReturnType<typeof api.dataLabor.searchConfigs> | undefined = useQuery(
    api.dataLabor.searchConfigs,
    idMode === "config_key" && search.trim().length >= 2 ? { token, search: search.trim() } : "skip",
  );

  // YMMT exists only on /v0/vehicle — switching endpoints falls back to config_key.
  const pickEndpoint = (e: Endpoint) => {
    setEndpoint(e);
    if (e !== "/v0/vehicle" && idMode === "ymmt") setIdMode("config_key");
  };
  const idModes: IdMode[] = endpoint === "/v0/vehicle" ? ["ymmt", "vin", "config_key"] : ["config_key", "vin"];

  const identifier = idMode === "config_key" ? configKey : vin.trim();
  const ymmtReady = Boolean(year.trim() && make.trim() && model.trim());
  const params = new URLSearchParams();
  if (idMode === "ymmt") {
    if (year.trim()) params.set("year", year.trim());
    if (make.trim()) params.set("make", make.trim());
    if (model.trim()) params.set("model", model.trim());
    if (trim.trim()) params.set("trim", trim.trim());
  } else if (identifier) {
    params.set(idMode, identifier);
  }
  if (endpoint === "/v0/labor" && service.trim()) params.set("service", service.trim());
  const query = params.toString();
  const queryPlaceholder = idMode === "ymmt" ? "year=…&make=…&model=…" : `${idMode}=…`;
  const url = `${baseUrl()}${endpoint}?${query || queryPlaceholder}`;
  const curl = `curl '${url}' \\\n  -H 'Authorization: Bearer ${apiKey || "otp_live_…"}'`;

  const ready = Boolean(apiKey && (idMode === "ymmt" ? ymmtReady : identifier));

  /** overrideQuery lets the 409-disambiguation buttons re-send with a chosen
   *  config_key before React state has flushed. */
  const send = async (overrideQuery?: string) => {
    const q = overrideQuery ?? query;
    if (busy || !apiKey || !q) return;
    setBusy(true);
    setResp(null);
    const started = Date.now();
    let entry: SentRequest;
    try {
      const r = await fetch(`${baseUrl()}${endpoint}?${q}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const body: unknown = await r.json().catch(() => ({ error: "invalid_json", message: "Response body was not JSON." }));
      entry = {
        at: started,
        endpoint,
        params: q,
        status: r.status,
        latencyMs: Date.now() - started,
        body,
      };
    } catch (e) {
      entry = {
        at: started,
        endpoint,
        params: q,
        status: 0,
        latencyMs: Date.now() - started,
        body: { error: "network_error", message: String(e) },
      };
    }
    setResp({ status: entry.status, latencyMs: entry.latencyMs, body: entry.body });
    setHistory((h) => [entry, ...h].slice(0, 20));
    setBusy(false);
  };

  const pickMatch = (m: YmmtMatch) => {
    if (!m.config_key) return;
    setIdMode("config_key");
    setConfigKey(m.config_key);
    setSearch(m.config_key);
    const p = new URLSearchParams({ config_key: m.config_key });
    void send(p.toString());
  };

  const bodyObj = resp?.body as { object?: string; error?: string; message?: string } | undefined;
  const maint = resp?.status === 200 && bodyObj?.object === "maintenance_specs" ? (resp.body as MaintOk) : null;
  const labor = resp?.status === 200 && bodyObj?.object === "empirical_labor" ? (resp.body as LaborOk) : null;
  const vehicle = resp?.status === 200 && bodyObj?.object === "vehicle" ? (resp.body as VehicleOk) : null;
  const multi =
    resp?.status === 409 && bodyObj?.error === "multiple_matches"
      ? (resp.body as { message?: string; matches?: YmmtMatch[] })
      : null;
  const isError = resp !== null && resp.status !== 200 && !multi;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[38fr_62fr]">
        {/* ── Request builder ── */}
        <div className={CARD}>
          <h3 className="text-sm font-semibold text-slate-900">Request</h3>

          <label className="mt-3 block text-[11px] font-semibold text-slate-500">Endpoint</label>
          <div className="mt-1 flex flex-wrap gap-2">
            {(["/v0/vehicle", "/v0/maintenance", "/v0/labor"] as const).map((e) => (
              <button
                key={e}
                onClick={() => pickEndpoint(e)}
                className={`rounded-lg border px-2.5 py-1.5 ${MONO} ${
                  endpoint === e ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-500 hover:bg-slate-50"
                }`}
              >
                GET {e}
              </button>
            ))}
          </div>

          <label className="mt-4 block text-[11px] font-semibold text-slate-500">API key</label>
          <input
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder="otp_live_…  (mint your sandbox key above — it auto-fills here)"
            className={`mt-1 w-full ${INPUT} ${MONO}`}
          />

          <label className="mt-4 block text-[11px] font-semibold text-slate-500">Identify the vehicle by</label>
          <div className="mt-1 flex gap-2">
            {idModes.map((m) => (
              <button
                key={m}
                onClick={() => setIdMode(m)}
                className={`rounded-lg border px-2.5 py-1.5 text-[12px] font-medium ${
                  idMode === m ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-500 hover:bg-slate-50"
                }`}
              >
                {m === "ymmt" ? "year / make / model" : m}
              </button>
            ))}
          </div>

          {idMode === "ymmt" ? (
            <>
              <div className="mt-2 flex gap-2">
                <input
                  value={year}
                  onChange={(e) => setYear(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="2015"
                  inputMode="numeric"
                  className={`w-20 ${INPUT} tabular-nums`}
                />
                <input
                  value={make}
                  onChange={(e) => setMake(e.target.value)}
                  placeholder="Hyundai"
                  className={`min-w-0 flex-1 ${INPUT}`}
                />
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="Veloster"
                  className={`min-w-0 flex-1 ${INPUT}`}
                />
              </div>
              <input
                value={trim}
                onChange={(e) => setTrim(e.target.value)}
                placeholder="trim (optional) — e.g. Turbo"
                className={`mt-2 w-full ${INPUT}`}
              />
              <p className="mt-1 text-[11px] text-slate-400">
                Names are case-insensitive words. Ambiguous? The 409 response lists matches — click one to re-send.
              </p>
            </>
          ) : idMode === "config_key" ? (
            <>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="search configs — e.g. camry or bmw (min 2 chars)"
                className={`mt-2 w-full ${INPUT}`}
              />
              {search.trim().length >= 2 && configs === undefined && (
                <div className="mt-1 h-8 animate-pulse rounded-lg bg-slate-100" />
              )}
              {configs && configs.results.length === 0 && (
                <p className="mt-1 text-[12px] text-slate-400">No configs match “{search.trim()}”.</p>
              )}
              {configs && configs.results.length > 0 && (
                <div className="mt-1 max-h-36 overflow-y-auto rounded-lg border border-slate-100">
                  {configs.results.slice(0, 8).map((c) => (
                    <button
                      key={String(c.id)}
                      onClick={() => {
                        setConfigKey(c.config_key);
                        setSearch(c.config_key);
                      }}
                      className={`block w-full px-3 py-1.5 text-left ${MONO} hover:bg-blue-50 ${
                        configKey === c.config_key ? "bg-blue-50 text-blue-700" : "text-slate-700"
                      }`}
                    >
                      {c.config_key}
                      <span className="ml-2 text-[10px] text-slate-400">
                        {c.year} · {c.enrichment_status}
                      </span>
                    </button>
                  ))}
                  {configs.truncated && (
                    <div className="px-3 py-1 text-[11px] text-slate-400">More matches — keep typing.</div>
                  )}
                </div>
              )}
              {configKey && (
                <div className={`mt-2 ${MONO} truncate rounded bg-slate-50 px-2 py-1 text-slate-600`}>
                  config_key={configKey}
                </div>
              )}
            </>
          ) : (
            <input
              value={vin}
              onChange={(e) => setVin(e.target.value)}
              placeholder="17-character VIN, e.g. 4T1B11HK5KU123456"
              className={`mt-2 w-full ${INPUT} ${MONO}`}
            />
          )}

          {endpoint === "/v0/labor" && (
            <>
              <label className="mt-4 block text-[11px] font-semibold text-slate-500">
                Service slug <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <input
                value={service}
                onChange={(e) => setService(e.target.value)}
                placeholder="e.g. front-brake-pads — leave empty for all"
                className={`mt-1 w-full ${INPUT} ${MONO}`}
              />
            </>
          )}

          <button
            onClick={() => void send()}
            disabled={busy || !ready}
            className="mt-4 w-full rounded-lg bg-blue-600 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40"
          >
            {busy ? "Sending…" : "Send request"}
          </button>
          {!ready && (
            <p className="mt-1.5 text-center text-[11px] text-slate-400">
              {!apiKey
                ? "Paste or mint an API key first."
                : idMode === "ymmt"
                  ? "Enter year, make and model to send."
                  : `Pick a ${idMode} to send.`}
            </p>
          )}

          <div className="mt-4">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-slate-500">cURL</span>
              <CopyButton text={curl} />
            </div>
            <pre className={`mt-1 overflow-x-auto rounded-lg bg-slate-900 p-3 ${MONO} leading-5 text-slate-100`}>
              {curl}
            </pre>
          </div>
        </div>

        {/* ── Response viewer ── */}
        <div className={CARD}>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Response</h3>
            {resp && (
              <div className="flex items-center gap-2">
                <span className={`${MONO} text-slate-400`}>{resp.latencyMs} ms</span>
                <StatusPill status={resp.status} />
              </div>
            )}
          </div>

          {!resp && !busy && (
            <p className="mt-8 pb-8 text-center text-[13px] text-slate-400">
              Mint a key, pick a vehicle, and send a request — the layer gate renders here.
            </p>
          )}
          {busy && <div className="mt-4 h-40 animate-pulse rounded-lg bg-slate-100" />}

          {isError && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-4">
              <div className={`${MONO} font-semibold text-red-700`}>
                {resp.status || "network"} · {bodyObj?.error ?? "error"}
              </div>
              <p className="mt-1 text-[13px] text-red-800">{bodyObj?.message ?? "Request failed."}</p>
            </div>
          )}

          {multi && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
              <div className={`${MONO} font-semibold text-amber-800`}>409 · multiple_matches</div>
              <p className="mt-1 text-[13px] text-amber-800">
                {multi.message ?? "More than one config matched — pick one to re-send with its config_key."}
              </p>
              <div className="mt-2 space-y-1">
                {(multi.matches ?? []).map((m, i) => (
                  <button
                    key={`${m.config_key ?? m.label}-${i}`}
                    onClick={() => pickMatch(m)}
                    disabled={busy || !m.config_key}
                    className={`block w-full rounded-lg border border-amber-200 bg-white px-3 py-1.5 text-left ${MONO} text-slate-700 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50`}
                  >
                    {m.label}
                    {m.config_key && <span className="ml-2 text-[10px] text-slate-400">send as config_key →</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          {vehicle && <VehicleView v={vehicle} />}

          {maint && (
            <div className="mt-3 space-y-4">
              <div className="text-[13px] font-semibold text-slate-800">
                {maint.config.year} {maint.config.make} {maint.config.model} {maint.config.trim ?? ""}
                <span className="ml-2 font-normal text-slate-400">
                  {maint.config.engine ?? ""} {maint.config.drivetrain ?? ""}
                </span>
              </div>
              <SpecsBlock fields={maint.fields} excluded={maint.excluded} />
            </div>
          )}

          {labor && (
            <div className="mt-3 space-y-3">
              <div className={`${MONO} text-slate-500`}>config_key={labor.config_key ?? "—"}</div>
              {labor.services.length === 0 ? (
                <p className="rounded-lg border border-slate-100 px-3 py-4 text-center text-[12px] text-slate-400">
                  No empirical labor measurements for this config yet.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className={TH}>
                        <th className="pb-2 pr-4">Service</th>
                        <th className="pb-2 pr-4">Hours</th>
                        <th className="pb-2 pr-4">n</th>
                        <th className="pb-2">p25 – p75</th>
                      </tr>
                    </thead>
                    <tbody>
                      {labor.services.map((s) => (
                        <tr key={s.service} className="border-b border-slate-50 last:border-0">
                          <td className="py-2 pr-4">
                            <span className="font-medium text-slate-900">{s.name}</span>
                            <span className={`${MONO} ml-2 text-slate-400`}>{s.service}</span>
                          </td>
                          <td className="py-2 pr-4 tabular-nums font-semibold text-slate-900">
                            {s.empirical_hours.toFixed(1)}h
                          </td>
                          <td className="py-2 pr-4 tabular-nums text-slate-500">{s.sample_size ?? "—"}</td>
                          <td className="py-2 tabular-nums text-slate-500">
                            {s.p25_hours != null && s.p75_hours != null
                              ? `${s.p25_hours.toFixed(1)} – ${s.p75_hours.toFixed(1)}h`
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-[11px] text-slate-400">{labor.note}</p>
            </div>
          )}

          {resp && (
            <details className="mt-4" open={!maint && !labor && !vehicle}>
              <summary className="cursor-pointer text-[11px] font-semibold text-slate-500 hover:text-slate-700">
                Raw JSON
              </summary>
              <pre className={`mt-2 max-h-96 overflow-auto rounded-lg bg-slate-900 p-3 ${MONO} leading-5 text-emerald-200`}>
                {JSON.stringify(resp.body, null, 2)}
              </pre>
            </details>
          )}
        </div>
      </div>

      {/* ── Session history ── */}
      <div className={CARD}>
        <h3 className="text-sm font-semibold text-slate-900">
          This session&apos;s requests
          <span className="ml-2 text-[11px] font-normal text-slate-400">client-side only · click a row to reload its response</span>
        </h3>
        {history.length === 0 ? (
          <p className="mt-3 text-[13px] text-slate-400">Nothing sent yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className={TH}>
                  <th className="pb-2 pr-4">Time</th>
                  <th className="pb-2 pr-4">Endpoint</th>
                  <th className="pb-2 pr-4">Params</th>
                  <th className="pb-2 pr-4">Latency</th>
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr
                    key={`${h.at}-${i}`}
                    onClick={() => setResp({ status: h.status, latencyMs: h.latencyMs, body: h.body })}
                    className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-blue-50/40"
                  >
                    <td className="py-2 pr-4 text-slate-500">{new Date(h.at).toLocaleTimeString()}</td>
                    <td className={`py-2 pr-4 ${MONO} text-slate-700`}>{h.endpoint}</td>
                    <td className={`py-2 pr-4 ${MONO} max-w-72 truncate text-slate-400`}>{h.params}</td>
                    <td className={`py-2 pr-4 ${MONO} tabular-nums text-slate-500`}>{h.latencyMs} ms</td>
                    <td className="py-2">
                      <StatusPill status={h.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
