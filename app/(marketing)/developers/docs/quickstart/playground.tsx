"use client";

// =============================================================================
// The interactive API console for the quickstart. Paste a key → pick an
// endpoint → edit the identifier + params → Run against this deployment → read
// the answer as a structured render OR raw JSON. Every endpoint ships with a
// baked-in sample (real 2019 CR-V data), so the console is fully populated and
// explorable before a single request fires; a live call swaps the sample out.
//
// The key lives ONLY in localStorage (this browser) — mint it on /developers.
// Requests go straight to {CONVEX_SITE}/v0|v1/… which returns CORS * and echoes
// the same layer-gated payload the OpenAPI reference documents.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { baseUrl, MONO, CopyButton, LayerChip } from "../../shared";
import { ENDPOINTS, endpointById, DEFAULT_IDENTIFIER, type Endpoint, type Mode } from "./catalog";
import { PrettyResponse, JsonView } from "./renderers";
import { YmmtPicker } from "./ymmt-picker";
import { ServicePicker } from "./service-picker";

const ink = "#1a1a1a";
const muted = "#6b655d";
const INPUT =
  "w-full rounded-lg border border-[#dcd8d0] bg-white px-3 py-2 text-[13px] text-slate-800 outline-none placeholder:text-slate-300 focus:border-[#2f7bff]";
const MODE_LABEL: Record<Mode, string> = { ymmt: "Year / Make / Model", vin: "VIN", config_key: "config_key" };

const KEY_STORE = "otp_dev_api_key";

type LiveResult = { status: number; body: unknown; ms: number };

function MethodBadge({ method }: { method: string }) {
  return (
    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700">
      {method}
    </span>
  );
}

// Compact A/C/D/E served · B/X withheld legend so the chips in the output read.
function LayerLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
      <span className="font-semibold uppercase tracking-wider text-slate-400">Layers</span>
      {(["A", "C", "D", "E"] as const).map((l) => (
        <span key={l} className="inline-flex items-center gap-1"><LayerChip letter={l} />{" "}
          {l === "A" ? "OEM" : l === "C" ? "sourced" : l === "D" ? "empirical" : "verified"}</span>
      ))}
      <span className="text-slate-300">·</span>
      {(["B", "X"] as const).map((l) => (
        <span key={l} className="inline-flex items-center gap-1 opacity-70"><LayerChip letter={l} />{" "}
          {l === "B" ? "licensed" : "flagged"} — withheld</span>
      ))}
    </div>
  );
}

export function Playground({
  selectedId,
  onSelectId,
}: {
  selectedId: string;
  onSelectId: (id: string) => void;
}) {
  const base = baseUrl();
  const ep: Endpoint = endpointById(selectedId) ?? ENDPOINTS[0];

  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [mode, setMode] = useState<Mode>(ep.modes[0]);
  const [idv, setIdv] = useState({ ...DEFAULT_IDENTIFIER });
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [live, setLive] = useState<LiveResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"pretty" | "raw">("pretty");

  // Hydrate the key from localStorage once mounted (avoids SSR mismatch).
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(KEY_STORE);
      if (saved) setApiKey(saved);
    } catch {
      /* private mode / storage disabled — fine, just no persistence */
    }
  }, []);

  const saveKey = (v: string) => {
    setApiKey(v);
    try {
      if (v) window.localStorage.setItem(KEY_STORE, v);
      else window.localStorage.removeItem(KEY_STORE);
    } catch {
      /* ignore */
    }
  };

  // Selecting a new endpoint resets the live result and snaps the mode to one
  // the endpoint accepts (e.g. /v1/configs is YMMT-only, service-history VIN-only).
  useEffect(() => {
    setLive(null);
    setExtra({});
    setMode((m) => (ep.modes.includes(m) ? m : ep.modes[0]));
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const path = useMemo(() => {
    const params = new URLSearchParams();
    if (mode === "ymmt") {
      if (idv.year) params.set("year", idv.year);
      if (idv.make) params.set("make", idv.make);
      if (idv.model) params.set("model", idv.model);
      if (idv.trim) params.set("trim", idv.trim);
    } else if (mode === "vin") {
      if (idv.vin) params.set("vin", idv.vin);
    } else if (mode === "config_key") {
      if (idv.config_key) params.set("config_key", idv.config_key);
    }
    for (const p of ep.extra ?? []) {
      const val = extra[p.name]?.trim();
      if (val) params.set(p.name, val);
    }
    const qs = params.toString();
    return `${ep.path}${qs ? `?${qs}` : ""}`;
  }, [ep, mode, idv, extra]);

  const fullUrl = `${base}${path}`;
  const curl = `curl '${fullUrl}' \\\n  -H 'Authorization: Bearer $OTOPAIR_KEY'`;

  const run = useCallback(async () => {
    if (!apiKey.trim()) return;
    setLoading(true);
    const started = performance.now();
    try {
      const res = await fetch(fullUrl, { headers: { Authorization: `Bearer ${apiKey.trim()}` } });
      const ms = Math.round(performance.now() - started);
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      setLive({ status: res.status, body, ms });
      setTab("pretty");
    } catch (e) {
      setLive({
        status: 0,
        body: { error: "network_error", message: e instanceof Error ? e.message : "Request failed (network or CORS)." },
        ms: Math.round(performance.now() - started),
      });
    } finally {
      setLoading(false);
    }
  }, [apiKey, fullUrl]);

  const shownData = live ? live.body : ep.sample;
  const shownStatus = live?.status;
  const isSample = live === null;
  const hasKey = apiKey.trim().length > 0;

  return (
    <div className="space-y-4">
      {/* ── Key bar ───────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-[#dcd8d0] bg-[#f7f5f1] p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[15px] font-semibold" style={{ color: ink }}>
            Your API key
          </h3>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${hasKey ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${hasKey ? "bg-emerald-500" : "bg-amber-500"}`} />
            {hasKey ? "Ready to run" : "No key yet"}
          </span>
          <Link href="/developers" className="ml-auto text-[13px] font-semibold hover:opacity-70" style={{ color: "#2f7bff" }}>
            Mint a free key →
          </Link>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(e) => saveKey(e.target.value)}
            placeholder="otp_live_…  (paste your key — it never leaves this browser)"
            autoComplete="off"
            spellCheck={false}
            className={`${INPUT} flex-1 font-mono`}
          />
          <button
            onClick={() => setShowKey((s) => !s)}
            className="rounded-lg border border-[#dcd8d0] bg-white px-3 py-2 text-[12px] font-semibold text-slate-600 hover:bg-slate-50"
          >
            {showKey ? "Hide" : "Show"}
          </button>
          {hasKey && (
            <button
              onClick={() => saveKey("")}
              className="rounded-lg border border-[#dcd8d0] bg-white px-3 py-2 text-[12px] font-semibold text-slate-600 hover:bg-slate-50"
            >
              Clear
            </button>
          )}
        </div>
        <p className="mt-2 text-[12px]" style={{ color: muted }}>
          Stored only in <code className={MONO}>localStorage</code> on this device — we never see it. Free tier: all read
          scopes, 60 req/min.
        </p>
      </div>

      {/* ── Endpoint picker ──────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-[#dcd8d0] bg-[#f7f5f1] p-5">
        <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: muted }}>
          Endpoint
        </div>
        {(["v1", "v0"] as const).map((ver) => {
          const eps = ENDPOINTS.filter((e) => e.version === ver);
          if (eps.length === 0) return null;
          return (
            <div key={ver} className="mt-2">
              <div className="mb-1.5 text-[11px] text-slate-400">
                {ver === "v1" ? "v1 · granular, group-scoped" : "v0 · flagship & specialised"}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {eps.map((e) => {
                  const active = e.id === ep.id;
                  return (
                    <button
                      key={e.id}
                      onClick={() => onSelectId(e.id)}
                      title={e.summary}
                      className={
                        active
                          ? "rounded-lg border border-[#1a1a1a] bg-[#1a1a1a] px-2.5 py-1.5 text-[12px] font-semibold text-white"
                          : "rounded-lg border border-[#dcd8d0] bg-white px-2.5 py-1.5 text-[12px] font-medium text-slate-600 hover:border-[#2f7bff]"
                      }
                    >
                      <span className={MONO}>{e.path}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
          <div className="flex flex-wrap items-center gap-2">
            <MethodBadge method={ep.method} />
            <span className={`text-[13px] font-semibold ${MONO}`} style={{ color: ink }}>{ep.path}</span>
            <span className="text-[12px] font-medium text-slate-500">{ep.summary}</span>
            {!ep.freeTier && (
              <span className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                needs {ep.scope}
              </span>
            )}
          </div>
          <p className="mt-1.5 text-[12px] leading-5" style={{ color: muted }}>{ep.description}</p>
        </div>
      </div>

      {/* ── Params + Run ─────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-[#dcd8d0] bg-[#f7f5f1] p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: muted }}>
            Identify the vehicle
          </span>
          {ep.modes.length > 1 && (
            <div className="ml-auto inline-flex rounded-lg border border-[#dcd8d0] bg-white p-0.5">
              {ep.modes.map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={
                    mode === m
                      ? "rounded-md bg-[#1a1a1a] px-2.5 py-1 text-[12px] font-semibold text-white"
                      : "rounded-md px-2.5 py-1 text-[12px] font-medium text-slate-500 hover:text-slate-800"
                  }
                >
                  {MODE_LABEL[m]}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-3">
          {mode === "ymmt" && (
            <YmmtPicker
              value={{ year: idv.year, make: idv.make, model: idv.model, trim: idv.trim }}
              onChange={(patch) => setIdv((prev) => ({ ...prev, ...patch }))}
            />
          )}
          {mode === "vin" && (
            <label className="block">
              <span className="mb-1 block text-[11px] text-slate-400">vin</span>
              <input value={idv.vin} onChange={(e) => setIdv({ ...idv, vin: e.target.value.toUpperCase() })} className={`${INPUT} font-mono`} placeholder="2HKRW2H85KH612345" maxLength={17} />
            </label>
          )}
          {mode === "config_key" && (
            <label className="block">
              <span className="mb-1 block text-[11px] text-slate-400">config_key</span>
              <input value={idv.config_key} onChange={(e) => setIdv({ ...idv, config_key: e.target.value })} className={`${INPUT} font-mono`} placeholder="2019_honda_cr_v_ex_l15be" />
            </label>
          )}
        </div>

        {ep.extra && ep.extra.length > 0 && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {ep.extra.map((p) => (
              <label key={p.name} className="block">
                <span className="mb-1 block text-[11px] text-slate-400">
                  {p.label} <span className="text-slate-300">· {p.help}</span>
                </span>
                {p.kind === "service" ? (
                  <ServicePicker
                    value={extra[p.name] ?? ""}
                    onChange={(v) => setExtra((prev) => ({ ...prev, [p.name]: v }))}
                  />
                ) : (
                  <input
                    value={extra[p.name] ?? ""}
                    onChange={(e) => setExtra({ ...extra, [p.name]: e.target.value })}
                    className={`${INPUT} font-mono`}
                    placeholder={p.placeholder}
                  />
                )}
              </label>
            ))}
          </div>
        )}

        {/* Request line */}
        <div className="mt-4 flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2">
          <MethodBadge method={ep.method} />
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] text-slate-100">{path}</code>
          <CopyButton text={fullUrl} label="URL" dark />
          <CopyButton text={curl} label="cURL" dark />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            onClick={run}
            disabled={!hasKey || loading}
            className="rounded-xl bg-gradient-to-r from-[rgba(59,130,246,1)] to-[rgba(37,99,235,1)] px-5 py-2.5 text-[14px] font-semibold text-white shadow-md transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Running…" : hasKey ? "Run request ▶" : "Paste a key to run"}
          </button>
          {live && (
            <span className="inline-flex items-center gap-2 text-[12px]">
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                  live.status >= 200 && live.status < 300
                    ? "bg-emerald-100 text-emerald-700"
                    : live.status === 0
                      ? "bg-slate-200 text-slate-600"
                      : "bg-rose-100 text-rose-700"
                }`}
              >
                {live.status === 0 ? "network" : live.status}
              </span>
              <span className="text-slate-400">{live.ms} ms</span>
            </span>
          )}
          {!hasKey && (
            <span className="text-[12px]" style={{ color: muted }}>
              — or explore the sample below, no key needed.
            </span>
          )}
        </div>
      </div>

      {/* ── Output ───────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-[#dcd8d0] bg-[#f7f5f1] p-5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-[#dcd8d0] bg-white p-0.5">
            <button
              onClick={() => setTab("pretty")}
              className={tab === "pretty" ? "rounded-md bg-[#1a1a1a] px-3 py-1 text-[12px] font-semibold text-white" : "rounded-md px-3 py-1 text-[12px] font-medium text-slate-500 hover:text-slate-800"}
            >
              Structured
            </button>
            <button
              onClick={() => setTab("raw")}
              className={tab === "raw" ? "rounded-md bg-[#1a1a1a] px-3 py-1 text-[12px] font-semibold text-white" : "rounded-md px-3 py-1 text-[12px] font-medium text-slate-500 hover:text-slate-800"}
            >
              Raw JSON
            </button>
          </div>
          {isSample ? (
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600">Sample response</span>
          ) : (
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-700">Live · {ep.path}</span>
          )}
          <div className="ml-auto"><LayerLegend /></div>
        </div>

        <div className="mt-3">
          {tab === "pretty" ? (
            <PrettyResponse data={shownData} status={shownStatus} onPickConfig={(k) => { setMode("config_key"); setIdv((v) => ({ ...v, config_key: k })); }} />
          ) : (
            <JsonView value={shownData} />
          )}
        </div>
      </div>
    </div>
  );
}
