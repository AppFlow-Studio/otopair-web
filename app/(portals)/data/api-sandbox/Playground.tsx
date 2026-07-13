"use client";

// Data · API console — live playground. Request builder (endpoint toggle,
// config_key typeahead OR raw VIN, optional labor service slug, API key) →
// real fetch against /v0 with status + latency, structured 200 rendering for
// both endpoints, raw JSON, and a session-local history strip.

import { useState } from "react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { MaintenanceResponse, LaborResponse } from "@/convex/dataApi";
import { usePortalSession } from "../../portal-session";
import { CARD, MONO, INPUT, TH, CopyButton, LayerChip, StatusPill, baseUrl } from "./shared";

type MaintOk = NonNullable<MaintenanceResponse>;
type LaborOk = NonNullable<LaborResponse>;

type Endpoint = "/v0/maintenance" | "/v0/labor";
type IdMode = "config_key" | "vin";

type SentRequest = {
  at: number;
  endpoint: Endpoint;
  params: string; // human-readable query summary
  status: number;
  latencyMs: number;
  body: unknown;
};

export function Playground({
  apiKey,
  onApiKeyChange,
}: {
  apiKey: string;
  onApiKeyChange: (k: string) => void;
}) {
  const { token } = usePortalSession();
  const [endpoint, setEndpoint] = useState<Endpoint>("/v0/maintenance");
  const [idMode, setIdMode] = useState<IdMode>("config_key");
  const [search, setSearch] = useState("");
  const [configKey, setConfigKey] = useState("");
  const [vin, setVin] = useState("");
  const [service, setService] = useState("");
  const [busy, setBusy] = useState(false);
  const [resp, setResp] = useState<{ status: number; latencyMs: number; body: unknown } | null>(null);
  const [history, setHistory] = useState<SentRequest[]>([]);

  const configs: FunctionReturnType<typeof api.dataLabor.searchConfigs> | undefined = useQuery(
    api.dataLabor.searchConfigs,
    idMode === "config_key" && search.trim().length >= 2 ? { token, search: search.trim() } : "skip",
  );

  const identifier = idMode === "config_key" ? configKey : vin.trim();
  const params = new URLSearchParams();
  if (identifier) params.set(idMode, identifier);
  if (endpoint === "/v0/labor" && service.trim()) params.set("service", service.trim());
  const query = params.toString();
  const url = `${baseUrl()}${endpoint}?${query || `${idMode}=…`}`;
  const curl = `curl '${url}' \\\n  -H 'Authorization: Bearer ${apiKey || "otp_live_…"}'`;

  const ready = Boolean(apiKey && identifier);

  const send = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setResp(null);
    const started = Date.now();
    let entry: SentRequest;
    try {
      const r = await fetch(`${baseUrl()}${endpoint}?${query}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const body: unknown = await r.json().catch(() => ({ error: "invalid_json", message: "Response body was not JSON." }));
      entry = {
        at: started,
        endpoint,
        params: query,
        status: r.status,
        latencyMs: Date.now() - started,
        body,
      };
    } catch (e) {
      entry = {
        at: started,
        endpoint,
        params: query,
        status: 0,
        latencyMs: Date.now() - started,
        body: { error: "network_error", message: String(e) },
      };
    }
    setResp({ status: entry.status, latencyMs: entry.latencyMs, body: entry.body });
    setHistory((h) => [entry, ...h].slice(0, 20));
    setBusy(false);
  };

  const bodyObj = resp?.body as { object?: string; error?: string; message?: string } | undefined;
  const maint = resp?.status === 200 && bodyObj?.object === "maintenance_specs" ? (resp.body as MaintOk) : null;
  const labor = resp?.status === 200 && bodyObj?.object === "empirical_labor" ? (resp.body as LaborOk) : null;
  const isError = resp !== null && resp.status !== 200;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[38fr_62fr]">
        {/* ── Request builder ── */}
        <div className={CARD}>
          <h3 className="text-sm font-semibold text-slate-900">Request</h3>

          <label className="mt-3 block text-[11px] font-semibold text-slate-500">Endpoint</label>
          <div className="mt-1 flex flex-wrap gap-2">
            {(["/v0/maintenance", "/v0/labor"] as const).map((e) => (
              <button
                key={e}
                onClick={() => setEndpoint(e)}
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
            {(["config_key", "vin"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setIdMode(m)}
                className={`rounded-lg border px-2.5 py-1.5 text-[12px] font-medium ${
                  idMode === m ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-500 hover:bg-slate-50"
                }`}
              >
                {m}
              </button>
            ))}
          </div>

          {idMode === "config_key" ? (
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
              {!apiKey ? "Paste or mint an API key first." : `Pick a ${idMode} to send.`}
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

          {maint && (
            <div className="mt-3 space-y-4">
              <div className="text-[13px] font-semibold text-slate-800">
                {maint.config.year} {maint.config.make} {maint.config.model} {maint.config.trim ?? ""}
                <span className="ml-2 font-normal text-slate-400">
                  {maint.config.engine ?? ""} {maint.config.drivetrain ?? ""}
                </span>
              </div>
              <div>
                <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Served fields · {maint.fields.length}
                </div>
                <div className="overflow-hidden rounded-lg border border-slate-100">
                  {maint.fields.map((f) => (
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
                  {maint.fields.length === 0 && (
                    <div className="px-3 py-4 text-center text-[12px] text-slate-400">
                      Nothing on this config clears the gate yet.
                    </div>
                  )}
                </div>
              </div>
              <div>
                <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Excluded by the gate · {maint.excluded.length}
                </div>
                <div className="overflow-hidden rounded-lg border border-amber-100 bg-amber-50/40">
                  {maint.excluded.map((f) => (
                    <div key={f.field} className="flex items-center gap-2 border-b border-amber-100/60 px-3 py-1.5 last:border-0">
                      <LayerChip letter={f.blocking_layer} />
                      <span className="w-44 shrink-0 text-[12px] text-slate-500">{f.label}</span>
                      <span className="min-w-0 flex-1 text-[12px] text-amber-800">{f.reason}</span>
                    </div>
                  ))}
                  {maint.excluded.length === 0 && (
                    <div className="px-3 py-3 text-center text-[12px] text-slate-400">Nothing excluded.</div>
                  )}
                </div>
              </div>
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
            <details className="mt-4" open={!maint && !labor}>
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
