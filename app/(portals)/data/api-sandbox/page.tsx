"use client";

// Data · API console — /data/api-sandbox (Data spec §12).
// A full developer console: log in → mint your personal sandbox key → test
// everything. Sections (sticky in-page sub-nav): hero w/ personal key banner
// → Reference docs → live Playground → key management → usage. Backed by
// convex/dataApi.ts; the /v0 HTTP API is hit for real from the playground.

import { useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { ApiKeyRow, UsageRow } from "@/convex/dataApi";
import { usePortalSession, useCan } from "../../portal-session";
import { Ceremony } from "@/components/portal/Ceremony";
import { CARD, MONO, PILL, INPUT, TH, CopyButton, KeyReveal, StatusPill, ago, baseUrl } from "./shared";
import { Reference } from "./Reference";
import { Playground } from "./Playground";

// ─── Hero: personal sandbox key banner ───────────────────────────────────────

function PersonalKeyBanner({ onMinted }: { onMinted: (plaintext: string) => void }) {
  const { token } = usePortalSession();
  const mine: FunctionReturnType<typeof api.dataApi.myPersonalKey> | undefined = useQuery(
    api.dataApi.myPersonalKey,
    { token },
  );
  const mint = useAction(api.dataApi.createPersonalKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [minted, setMinted] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);

  const doMint = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await mint({ token });
      setMinted(res.key);
      onMinted(res.key);
      setConfirmRotate(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "minting failed");
    }
    setBusy(false);
  };

  if (minted) {
    return (
      <div className="mt-4">
        <KeyReveal
          plaintext={minted}
          note="Only its hash is stored — this key cannot be shown again. It's already auto-filled in the playground below."
          onDismiss={() => setMinted(null)}
        />
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-white/15 bg-white/5 p-4">
      {mine === undefined ? (
        <div className="h-9 animate-pulse rounded bg-white/10" />
      ) : mine === null ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-white">You don&apos;t have a sandbox key yet</div>
            <p className="mt-0.5 text-[12px] text-slate-400">
              One click mints your personal key (both scopes, 60 req/min) and auto-fills the playground.
            </p>
          </div>
          <button
            disabled={busy}
            onClick={() => void doMint()}
            className="rounded-lg bg-emerald-500 px-4 py-2 text-[13px] font-semibold text-white hover:bg-emerald-400 disabled:opacity-50"
          >
            {busy ? "Minting…" : "Mint my sandbox key"}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Your sandbox key</div>
              <div className={`${MONO} mt-0.5 text-slate-100`}>{mine.prefix}…</div>
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Requests · 24h</div>
              <div className="mt-0.5 tabular-nums text-[13px] font-semibold text-slate-100">{mine.requests_24h}</div>
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Created</div>
              <div className="mt-0.5 text-[13px] text-slate-200">{new Date(mine.created_at).toLocaleDateString()}</div>
            </div>
          </div>
          {confirmRotate ? (
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-amber-300">Rotate? The old key is revoked immediately.</span>
              <button
                disabled={busy}
                onClick={() => void doMint()}
                className="rounded-lg bg-amber-500 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-amber-400 disabled:opacity-50"
              >
                {busy ? "Rotating…" : "Yes, rotate"}
              </button>
              <button
                onClick={() => setConfirmRotate(false)}
                className="rounded-lg border border-white/20 px-3 py-1.5 text-[12px] font-semibold text-slate-300 hover:bg-white/10"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmRotate(true)}
              className="rounded-lg border border-white/20 px-3 py-1.5 text-[12px] font-semibold text-slate-200 hover:bg-white/10"
            >
              Rotate key
            </button>
          )}
        </div>
      )}
      {error && <div className="mt-2 text-[12px] font-medium text-red-400">{error}</div>}
    </div>
  );
}

// ─── Keys: admin create panel ────────────────────────────────────────────────

const SCOPES = ["maintenance:read", "labor:read"] as const;
type Scope = (typeof SCOPES)[number];

function CreateKeyPanel() {
  const { token } = usePortalSession();
  const createKey = useAction(api.dataApi.createKey);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["maintenance:read"]);
  const [rateLimit, setRateLimit] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [minted, setMinted] = useState<string | null>(null);

  const toggle = (s: Scope) =>
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  if (minted) {
    return (
      <KeyReveal
        plaintext={minted}
        note="Hand this to the integrator over a secure channel. Only its hash is stored — it cannot be shown again."
        onDismiss={() => setMinted(null)}
      />
    );
  }

  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/50 p-5">
      <div className="text-sm font-semibold text-slate-900">Create a customer key</div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-[11px] font-semibold text-slate-500">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Acme pilot"
            className={`mt-1 w-56 ${INPUT}`}
          />
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-slate-500">Scopes</label>
          <div className="mt-1 flex gap-2">
            {SCOPES.map((s) => (
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
        <div>
          <label className="block text-[11px] font-semibold text-slate-500">
            Rate limit <span className="font-normal text-slate-400">(req/min, default 60)</span>
          </label>
          <input
            value={rateLimit}
            onChange={(e) => setRateLimit(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="60"
            inputMode="numeric"
            className={`mt-1 w-28 ${INPUT} tabular-nums`}
          />
        </div>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              const res = await createKey({
                token,
                name,
                scopes,
                ...(rateLimit ? { rate_limit_per_min: Number(rateLimit) } : {}),
              });
              setMinted(res.key);
              setName("");
              setRateLimit("");
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

// ─── Keys table ──────────────────────────────────────────────────────────────

function KeysSection() {
  const { token } = usePortalSession();
  const canManage = useCan("admin.manage");
  const keys: ApiKeyRow[] | undefined = useQuery(api.dataApi.listKeys, { token });
  const revokeKey = useMutation(api.dataApi.revokeKey);
  const [revoking, setRevoking] = useState<{ id: Id<"api_keys">; name: string } | null>(null);
  const [chartFor, setChartFor] = useState<{ id: Id<"api_keys">; name: string } | null>(null);

  return (
    <div className="space-y-3">
      {canManage ? (
        <CreateKeyPanel />
      ) : (
        <p className="text-[12px] text-slate-400">
          Customer key management requires the super-admin role — your personal sandbox key lives in the banner up top.
        </p>
      )}
      <div className={CARD}>
        {keys === undefined ? (
          <div className="space-y-2">
            <div className="h-8 animate-pulse rounded bg-slate-100" />
            <div className="h-8 animate-pulse rounded bg-slate-100" />
            <div className="h-8 animate-pulse rounded bg-slate-100" />
          </div>
        ) : keys.length === 0 ? (
          <p className="py-4 text-center text-[13px] text-slate-400">
            No keys yet — mint your sandbox key in the banner above.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className={TH}>
                  <th className="pb-2 pr-4">Key</th>
                  <th className="pb-2 pr-4">Scopes</th>
                  <th className="pb-2 pr-4">Rate</th>
                  <th className="pb-2 pr-4">Requests</th>
                  <th className="pb-2 pr-4">24h</th>
                  <th className="pb-2 pr-4">Last used</th>
                  <th className="pb-2 pr-4">Created</th>
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
                    <td className="py-2.5 pr-4 whitespace-nowrap">
                      {k.scopes.map((s) => (
                        <span key={s} className={`${PILL} mr-1 bg-slate-100 text-slate-600`}>
                          {s}
                        </span>
                      ))}
                    </td>
                    <td className={`py-2.5 pr-4 ${MONO} tabular-nums text-slate-500`}>{k.rate_limit_per_min}/min</td>
                    <td className="py-2.5 pr-4 tabular-nums">{k.request_count.toLocaleString()}</td>
                    <td className="py-2.5 pr-4 tabular-nums">{k.requests_24h}</td>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-slate-500">{ago(k.last_used_at)}</td>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-slate-500">
                      {new Date(k.created_at).toLocaleDateString()}
                    </td>
                    <td className="py-2.5 pr-4">
                      {k.revoked_at ? (
                        <span className={`${PILL} bg-red-50 text-red-700`}>revoked</span>
                      ) : (
                        <span className={`${PILL} bg-emerald-50 text-emerald-700`}>active</span>
                      )}
                    </td>
                    <td className="py-2.5 text-right whitespace-nowrap">
                      <button
                        onClick={() =>
                          setChartFor(
                            chartFor?.id === k.id ? null : { id: k.id, name: k.name },
                          )
                        }
                        className="mr-3 text-[12px] font-semibold text-blue-600 hover:underline"
                      >
                        {chartFor?.id === k.id ? "hide chart" : "chart"}
                      </button>
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
          </div>
        )}
      </div>

      {chartFor && <KeyUsageChart id={chartFor.id} name={chartFor.name} />}

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

// Per-key daily request sparkline (spec §12 "usage chart per key").
function KeyUsageChart({ id, name }: { id: Id<"api_keys">; name: string }) {
  const { token } = usePortalSession();
  const series = useQuery(api.dataApi.usageSeriesByKey, { token, id });
  return (
    <div className={CARD}>
      <div className="text-[13px] font-semibold text-slate-900">
        {name} — requests by day (30d)
      </div>
      {series === undefined ? (
        <div className="mt-2 h-16 animate-pulse rounded bg-slate-100" />
      ) : series.length === 0 ? (
        <p className="mt-2 text-[13px] text-slate-400">No requests in the window.</p>
      ) : (
        <div className="mt-3 flex items-end gap-1 overflow-x-auto pb-1">
          {series.map((d: { date: string; requests: number; errors: number }) => {
            const maxR = Math.max(...series.map((x: { requests: number }) => x.requests), 1);
            return (
              <div
                key={d.date}
                className="flex w-5 shrink-0 flex-col items-center"
                title={`${d.date}: ${d.requests} requests, ${d.errors} errors`}
              >
                <div
                  className="w-3.5 rounded-t-sm bg-blue-500"
                  style={{ height: 3 + (d.requests / maxR) * 56 }}
                />
                {d.errors > 0 && <div className="mt-0.5 h-1 w-3.5 rounded-sm bg-red-500" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// P2 exit-test harness (spec p.22): top-25 configs by fill rate through the
// live gate path — zero served licensed-B/X fields = clean.
function GateCheckPanel() {
  const { token } = usePortalSession();
  const [armed, setArmed] = useState(false);
  const check = useQuery(api.dataApi.gateCheck, armed ? { token } : "skip");
  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <div className="text-[13px] font-semibold text-slate-900">
          Gate check — P2 exit test
        </div>
        {check && (
          <span
            className={`${PILL} ${check.all_clean ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}
          >
            {check.all_clean ? "CLEAN — no B/X served" : "LEAK DETECTED"}
          </span>
        )}
        <button
          onClick={() => setArmed(true)}
          className="ml-auto rounded-lg bg-slate-900 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-slate-700"
        >
          {armed ? "Re-run" : "Run over top-25 configs"}
        </button>
      </div>
      <p className="mt-1 text-[12px] text-slate-500">
        Runs the /v0/maintenance gate path over the 25 highest-fill configs and asserts no
        licensed-B or X field would be served. Excluded-B totals reconcile with the
        provenance page&apos;s Layer-B exposure stat (same derivation).
      </p>
      {armed &&
        (check === undefined ? (
          <div className="mt-3 h-24 animate-pulse rounded bg-slate-100" />
        ) : (
          <div className="mt-3 overflow-x-auto">
            <div className="mb-2 text-[12px] text-slate-500">
              total excluded-B across the set: {check.total_excluded_b}
            </div>
            <table className="w-full text-[13px]">
              <thead>
                <tr className={TH}>
                  <th className="pb-2 pr-4">Config</th>
                  <th className="pb-2 pr-4">Served</th>
                  <th className="pb-2 pr-4">Excluded B</th>
                  <th className="pb-2 pr-4">Excluded X</th>
                  <th className="pb-2">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {check.rows.map(
                  (r: {
                    config_key: string;
                    served: number;
                    excluded_b: number;
                    excluded_x: number;
                    clean: boolean;
                  }) => (
                    <tr key={r.config_key} className="border-b border-slate-50 last:border-0">
                      <td className={`py-1.5 pr-4 ${MONO} text-slate-700`}>{r.config_key}</td>
                      <td className="py-1.5 pr-4 tabular-nums">{r.served}</td>
                      <td className="py-1.5 pr-4 tabular-nums">{r.excluded_b}</td>
                      <td className="py-1.5 pr-4 tabular-nums">{r.excluded_x}</td>
                      <td className="py-1.5">
                        <span
                          className={`${PILL} ${r.clean ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}
                        >
                          {r.clean ? "clean" : "LEAK"}
                        </span>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}

// ─── Usage ───────────────────────────────────────────────────────────────────

function UsageSection() {
  const { token } = usePortalSession();
  const usage: UsageRow[] | undefined = useQuery(api.dataApi.recentUsage, { token });

  const stats = useMemo(() => {
    if (!usage || usage.length === 0) return null;
    const ok = usage.filter((u) => u.status >= 200 && u.status < 300).length;
    const clientErr = usage.filter((u) => u.status >= 400 && u.status < 500 && u.status !== 429).length;
    const rateLimited = usage.filter((u) => u.status === 429).length;
    return {
      total: usage.length,
      successRate: Math.round((ok / usage.length) * 100),
      clientErr,
      rateLimited,
    };
  }, [usage]);

  return (
    <div className="space-y-3">
      {usage === undefined ? (
        <div className="grid gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={`${CARD} h-20 animate-pulse`} />
          ))}
        </div>
      ) : stats ? (
        <div className="grid gap-3 sm:grid-cols-4">
          <div className={CARD}>
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Requests shown</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{stats.total}</div>
          </div>
          <div className={CARD}>
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Success rate</div>
            <div
              className={`mt-1 text-2xl font-semibold tabular-nums ${
                stats.successRate >= 90 ? "text-emerald-600" : "text-amber-600"
              }`}
            >
              {stats.successRate}%
            </div>
          </div>
          <div className={CARD}>
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">4xx errors</div>
            <div className={`mt-1 text-2xl font-semibold tabular-nums ${stats.clientErr > 0 ? "text-red-600" : "text-slate-900"}`}>
              {stats.clientErr}
            </div>
          </div>
          <div className={CARD}>
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">429 rate-limited</div>
            <div className={`mt-1 text-2xl font-semibold tabular-nums ${stats.rateLimited > 0 ? "text-amber-600" : "text-slate-900"}`}>
              {stats.rateLimited}
            </div>
          </div>
        </div>
      ) : null}

      <div className={CARD}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">Recent requests</h3>
          <span className="text-[11px] text-slate-400">latest 50 across all keys — not a full log</span>
        </div>
        {usage === undefined ? (
          <div className="mt-3 h-24 animate-pulse rounded bg-slate-100" />
        ) : usage.length === 0 ? (
          <p className="py-4 text-center text-[13px] text-slate-400">
            No API traffic yet — send a playground request to see it land here.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className={TH}>
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
                    <td className="py-2 pr-4 whitespace-nowrap text-slate-500">{ago(u.created_at)}</td>
                    <td className={`py-2 pr-4 ${MONO} text-slate-500`}>{u.key_prefix}…</td>
                    <td className={`py-2 pr-4 ${MONO} text-slate-700`}>{u.endpoint}</td>
                    <td className={`py-2 pr-4 ${MONO} max-w-64 truncate text-slate-400`}>{u.config_key ?? "—"}</td>
                    <td className="py-2">
                      <StatusPill status={u.status} />
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

// ─── Page ────────────────────────────────────────────────────────────────────

const SECTIONS = [
  { id: "reference", label: "Reference" },
  { id: "playground", label: "Playground" },
  { id: "keys", label: "Keys" },
  { id: "usage", label: "Usage" },
] as const;

export default function ApiSandboxPage() {
  const base = useMemo(baseUrl, []);
  // Lifted playground key so a fresh personal-key mint lands there directly:
  // log in → mint → test, zero friction.
  const [playgroundKey, setPlaygroundKey] = useState("");

  return (
    <div className="space-y-8">
      {/* Hero */}
      <div className="overflow-hidden rounded-2xl bg-slate-900 p-6 text-white">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Otopair Data API</h1>
            <p className="mt-1 max-w-xl text-[13px] leading-5 text-slate-300">
              Key-authed access to the enriched vehicle catalog — maintenance specs and empirical
              labor times, with the provenance gate applied visibly on every response.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Base URL</div>
              <div className={`${MONO} mt-0.5 text-slate-100`}>{base}</div>
            </div>
            <CopyButton text={base} dark />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <span className={`${PILL} bg-white/10 text-slate-200`}>GET /v0/vehicle?vin=…|year=&make=&model=…|config_key=…</span>
          <span className={`${PILL} bg-white/10 text-slate-200`}>GET /v0/maintenance?config_key=…|vin=…</span>
          <span className={`${PILL} bg-white/10 text-slate-200`}>GET /v0/labor?config_key=…|vin=…[&service=…]</span>
          <span className={`${PILL} bg-white/10 text-slate-200`}>Authorization: Bearer otp_live_…</span>
          <span className={`${PILL} bg-white/10 text-slate-200`}>60 req/min per key</span>
        </div>
        <PersonalKeyBanner onMinted={setPlaygroundKey} />
      </div>

      {/* Sticky in-page sub-nav */}
      <nav className="sticky top-2 z-20 -my-2 flex gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white/90 p-1.5 backdrop-blur">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="rounded-lg px-3 py-1.5 text-[13px] font-semibold text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          >
            {s.label}
          </a>
        ))}
      </nav>

      <section id="reference" className="scroll-mt-16 space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">Reference</h2>
        <Reference />
      </section>

      <section id="playground" className="scroll-mt-16 space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">Playground</h2>
        <Playground apiKey={playgroundKey} onApiKeyChange={setPlaygroundKey} />
      </section>

      <section id="keys" className="scroll-mt-16 space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">API keys</h2>
        <KeysSection />
      </section>

      <section id="usage" className="scroll-mt-16 space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">Usage</h2>
        <UsageSection />
        <GateCheckPanel />
      </section>
    </div>
  );
}
