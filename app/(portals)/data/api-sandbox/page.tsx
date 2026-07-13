"use client";

// Data · API Sandbox — /data/api-sandbox (Data spec §12).
// Zones: hero (base URL + the layer gate, stated plainly) → API keys
// (create / revoke, plaintext shown exactly once) → endpoint reference with
// live playground (real requests against /v0, gate rendered visibly:
// included fields carry layer chips, excluded fields listed with their
// blocking layer) → recent usage meter.

import { useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession, useCan } from "../../portal-session";
import { Ceremony } from "@/components/portal/Ceremony";
import { LAYER_FORMULA, type LayerLetter } from "@/convex/lib/dataLayers";

const CARD = "rounded-xl border border-slate-200 bg-white p-5";
const PILL = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const MONO = "font-mono text-[12px]";

const LAYER_CHIP: Record<string, string> = {
  A: "bg-blue-100 text-blue-700",
  B: "bg-slate-200 text-slate-700",
  C: "bg-amber-100 text-amber-700",
  D: "bg-emerald-100 text-emerald-700",
  E: "bg-purple-100 text-purple-700",
  X: "bg-red-100 text-red-700",
  unknown: "bg-slate-100 text-slate-500",
};

function LayerChip({ letter }: { letter: LayerLetter | "unknown" }) {
  return (
    <span
      className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold ${LAYER_CHIP[letter]}`}
      title={`Layer ${letter} — ${LAYER_FORMULA}`}
    >
      {letter === "unknown" ? "?" : letter}
    </span>
  );
}

function baseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_CONVEX_SITE_URL ??
    (process.env.NEXT_PUBLIC_CONVEX_URL ?? "").replace(".convex.cloud", ".convex.site")
  );
}

function ago(ms: number | null): string {
  if (ms == null) return "never";
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
    >
      {copied ? "Copied ✓" : (label ?? "Copy")}
    </button>
  );
}

// ─── Create-key flow ─────────────────────────────────────────────────────────

function CreateKeyPanel({ onDone }: { onDone: () => void }) {
  const { token } = usePortalSession();
  const createKey = useAction(api.dataApi.createKey);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<("maintenance:read" | "labor:read")[]>(["maintenance:read"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [minted, setMinted] = useState<{ key: string; prefix: string } | null>(null);

  const toggle = (s: "maintenance:read" | "labor:read") =>
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  if (minted) {
    return (
      <div className="rounded-xl border-2 border-emerald-200 bg-emerald-50/60 p-5">
        <div className="text-sm font-semibold text-emerald-900">Key created — copy it now</div>
        <p className="mt-1 text-[12px] text-emerald-800">
          This is the only time the full key is shown. Only its hash is stored.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <code className={`${MONO} flex-1 overflow-x-auto rounded-lg border border-emerald-200 bg-white px-3 py-2 text-slate-800`}>
            {minted.key}
          </code>
          <CopyButton text={minted.key} />
        </div>
        <button
          onClick={() => {
            setMinted(null);
            onDone();
          }}
          className="mt-3 rounded-lg bg-emerald-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-emerald-700"
        >
          I've stored it safely
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/50 p-5">
      <div className="text-sm font-semibold text-slate-900">Create a key</div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-[11px] font-semibold text-slate-500">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Acme pilot"
            className="mt-1 w-56 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[13px] outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-slate-500">Scopes</label>
          <div className="mt-1 flex gap-2">
            {(["maintenance:read", "labor:read"] as const).map((s) => (
              <button
                key={s}
                onClick={() => toggle(s)}
                className={`rounded-lg border px-2.5 py-1.5 text-[12px] font-medium ${
                  scopes.includes(s)
                    ? "border-blue-300 bg-blue-50 text-blue-700"
                    : "border-slate-200 bg-white text-slate-500"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              const res = await createKey({ token, name, scopes });
              setMinted(res);
              setName("");
            } catch (e) {
              setError(e instanceof Error ? e.message : "failed");
            }
            setBusy(false);
          }}
          className="rounded-lg bg-slate-900 px-4 py-2 text-[13px] font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {busy ? "Minting…" : "Create key"}
        </button>
      </div>
      {error && <div className="mt-2 text-[12px] font-medium text-red-600">{error}</div>}
    </div>
  );
}

// ─── Playground ──────────────────────────────────────────────────────────────

import type { MaintenanceResponse } from "@/convex/dataApi";
type MaintenanceResp = NonNullable<MaintenanceResponse>;

function Playground() {
  const { token } = usePortalSession();
  const [endpoint, setEndpoint] = useState<"/v0/maintenance" | "/v0/labor">("/v0/maintenance");
  const [apiKey, setApiKey] = useState("");
  const [search, setSearch] = useState("");
  const [configKey, setConfigKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [resp, setResp] = useState<{ status: number; body: unknown } | null>(null);

  const configs = useQuery(
    api.dataLabor.searchConfigs,
    search.trim().length >= 2 ? { token, search } : "skip",
  ) as FunctionReturnType<typeof api.dataLabor.searchConfigs> | undefined;

  const url = `${baseUrl()}${endpoint}?config_key=${encodeURIComponent(configKey || "…")}`;
  const curl = `curl '${url}' \\\n  -H 'Authorization: Bearer ${apiKey || "otp_live_…"}'`;

  const send = async () => {
    if (!apiKey || !configKey) return;
    setBusy(true);
    setResp(null);
    try {
      const r = await fetch(`${baseUrl()}${endpoint}?config_key=${encodeURIComponent(configKey)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      setResp({ status: r.status, body: await r.json() });
    } catch (e) {
      setResp({ status: 0, body: { error: "network_error", message: String(e) } });
    }
    setBusy(false);
  };

  const maint =
    resp?.status === 200 && (resp.body as { object?: string }).object === "maintenance_specs"
      ? (resp.body as MaintenanceResp)
      : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[38fr_62fr]">
      {/* Request builder */}
      <div className={CARD}>
        <h3 className="text-sm font-semibold text-slate-900">Request</h3>
        <label className="mt-3 block text-[11px] font-semibold text-slate-500">Endpoint</label>
        <div className="mt-1 flex gap-2">
          {(["/v0/maintenance", "/v0/labor"] as const).map((e) => (
            <button
              key={e}
              onClick={() => setEndpoint(e)}
              className={`rounded-lg border px-2.5 py-1.5 ${MONO} ${
                endpoint === e ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-500"
              }`}
            >
              GET {e}
            </button>
          ))}
        </div>

        <label className="mt-4 block text-[11px] font-semibold text-slate-500">API key</label>
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="otp_live_…  (paste a key minted above)"
          className={`mt-1 w-full rounded-lg border border-slate-200 px-3 py-1.5 ${MONO} outline-none focus:border-blue-500`}
        />

        <label className="mt-4 block text-[11px] font-semibold text-slate-500">
          Vehicle config <span className="font-normal text-slate-400">(config_key substring)</span>
        </label>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="e.g. camry or bmw"
          className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] outline-none focus:border-blue-500"
        />
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
              </button>
            ))}
          </div>
        )}
        {configKey && (
          <div className={`mt-2 ${MONO} truncate rounded bg-slate-50 px-2 py-1 text-slate-600`}>
            config_key={configKey}
          </div>
        )}

        <button
          onClick={() => void send()}
          disabled={busy || !apiKey || !configKey}
          className="mt-4 w-full rounded-lg bg-blue-600 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {busy ? "Sending…" : "Send request"}
        </button>

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

      {/* Response viewer */}
      <div className={CARD}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">Response</h3>
          {resp && (
            <span
              className={`${PILL} ${
                resp.status === 200 ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
              }`}
            >
              {resp.status || "network error"}
            </span>
          )}
        </div>

        {!resp && (
          <p className="mt-8 pb-8 text-center text-[13px] text-slate-400">
            Mint a key, pick a config, and send a request — the layer gate renders here.
          </p>
        )}

        {maint && (
          <div className="mt-3 space-y-4">
            <div className="text-[13px] font-semibold text-slate-800">
              {maint.config.year} {maint.config.make} {maint.config.model} {maint.config.trim ?? ""}
              <span className="ml-2 font-normal text-slate-400">{maint.config.engine}</span>
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
                    <span className="flex-1 text-[13px] font-medium text-slate-900">{f.value}</span>
                    <span className={`${MONO} text-slate-400`}>{f.confidence?.toFixed(2) ?? "—"}</span>
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
                    <span className="flex-1 text-[12px] text-amber-800">{f.reason}</span>
                  </div>
                ))}
                {maint.excluded.length === 0 && (
                  <div className="px-3 py-3 text-center text-[12px] text-slate-400">Nothing excluded.</div>
                )}
              </div>
            </div>
          </div>
        )}

        {resp && (
          <details className="mt-4" open={!maint}>
            <summary className="cursor-pointer text-[11px] font-semibold text-slate-500">Raw JSON</summary>
            <pre className={`mt-2 max-h-96 overflow-auto rounded-lg bg-slate-900 p-3 ${MONO} leading-5 text-emerald-200`}>
              {JSON.stringify(resp.body, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ApiSandboxPage() {
  const { token } = usePortalSession();
  const canManage = useCan("admin.manage");
  const keys = useQuery(api.dataApi.listKeys, { token });
  const usage = useQuery(api.dataApi.recentUsage, { token });
  const revokeKey = useMutation(api.dataApi.revokeKey);
  const [revoking, setRevoking] = useState<{ id: Id<"api_keys">; name: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  void refresh;

  const base = useMemo(baseUrl, []);

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="overflow-hidden rounded-2xl bg-slate-900 p-6 text-white">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Otopair Data API</h1>
            <p className="mt-1 max-w-xl text-[13px] leading-5 text-slate-300">
              Key-authed access to the enriched vehicle catalog. Every value is layer-gated:
              only <LayerChip letter="A" /> OEM, <LayerChip letter="D" /> empirical and{" "}
              <LayerChip letter="E" /> human-verified data is served — licensed{" "}
              <LayerChip letter="B" /> and web-derived <LayerChip letter="C" /> values are excluded
              and the exclusions are listed in every response.
            </p>
          </div>
          <div className="rounded-lg bg-white/10 px-3 py-2">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Base URL</div>
            <div className={`${MONO} mt-0.5 text-slate-100`}>{base}</div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <span className={`${PILL} bg-white/10 text-slate-200`}>GET /v0/maintenance?config_key=…|vin=…</span>
          <span className={`${PILL} bg-white/10 text-slate-200`}>GET /v0/labor?config_key=…[&service=…]</span>
          <span className={`${PILL} bg-white/10 text-slate-200`}>Bearer otp_live_…</span>
          <span className={`${PILL} bg-white/10 text-slate-200`}>60 req/min per key</span>
        </div>
      </div>

      {/* Keys */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">API keys</h2>
        {canManage ? (
          <CreateKeyPanel onDone={() => setRefresh((n) => n + 1)} />
        ) : (
          <p className="text-[12px] text-slate-400">Key management requires the super-admin role.</p>
        )}
        <div className={CARD}>
          {keys === undefined ? (
            <div className="h-16 animate-pulse rounded bg-slate-100" />
          ) : keys.length === 0 ? (
            <p className="py-4 text-center text-[13px] text-slate-400">
              No keys yet — mint the first one above.
            </p>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="pb-2 pr-4">Key</th>
                  <th className="pb-2 pr-4">Scopes</th>
                  <th className="pb-2 pr-4">Requests</th>
                  <th className="pb-2 pr-4">24h</th>
                  <th className="pb-2 pr-4">Last used</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} className="border-b border-slate-50 last:border-0">
                    <td className="py-2.5 pr-4">
                      <span className="font-medium text-slate-900">{k.name}</span>
                      <span className={`${MONO} ml-2 text-slate-400`}>{k.prefix}…</span>
                    </td>
                    <td className="py-2.5 pr-4">
                      {k.scopes.map((s) => (
                        <span key={s} className={`${PILL} mr-1 bg-slate-100 text-slate-600`}>
                          {s}
                        </span>
                      ))}
                    </td>
                    <td className="py-2.5 pr-4 tabular-nums">{k.request_count.toLocaleString()}</td>
                    <td className="py-2.5 pr-4 tabular-nums">{k.requests_24h}</td>
                    <td className="py-2.5 pr-4 text-slate-500">{ago(k.last_used_at)}</td>
                    <td className="py-2.5 pr-4">
                      {k.revoked_at ? (
                        <span className={`${PILL} bg-red-50 text-red-700`}>revoked</span>
                      ) : (
                        <span className={`${PILL} bg-emerald-50 text-emerald-700`}>active</span>
                      )}
                    </td>
                    <td className="py-2.5 text-right">
                      {!k.revoked_at && canManage && (
                        <button
                          onClick={() => setRevoking({ id: k.id, name: k.name })}
                          className="text-[12px] font-semibold text-red-600 hover:underline"
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Playground */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">Playground</h2>
        <Playground />
      </div>

      {/* Usage */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">Recent requests</h2>
        <div className={CARD}>
          {usage === undefined ? (
            <div className="h-16 animate-pulse rounded bg-slate-100" />
          ) : usage.length === 0 ? (
            <p className="py-4 text-center text-[13px] text-slate-400">No API traffic yet.</p>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="pb-2 pr-4">When</th>
                  <th className="pb-2 pr-4">Key</th>
                  <th className="pb-2 pr-4">Endpoint</th>
                  <th className="pb-2 pr-4">Config</th>
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((u, i) => (
                  <tr key={i} className="border-b border-slate-50 last:border-0">
                    <td className="py-2 pr-4 text-slate-500">{ago(u.created_at)}</td>
                    <td className={`py-2 pr-4 ${MONO} text-slate-500`}>{u.key_prefix}…</td>
                    <td className={`py-2 pr-4 ${MONO} text-slate-700`}>{u.endpoint}</td>
                    <td className={`py-2 pr-4 ${MONO} text-slate-400`}>{u.config_key ?? "—"}</td>
                    <td className="py-2">
                      <span
                        className={`${PILL} ${
                          u.status === 200 ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
                        }`}
                      >
                        {u.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <Ceremony
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Revoke API key"
        destructive
        summary={
          <span>
            Requests using <strong>{revoking?.name}</strong> will fail with 401 immediately. This
            cannot be undone — mint a new key to restore access.
          </span>
        }
        onConfirm={async (reason) => {
          if (revoking) await revokeKey({ token, reason, id: revoking.id });
          setRevoking(null);
        }}
      />
    </div>
  );
}
