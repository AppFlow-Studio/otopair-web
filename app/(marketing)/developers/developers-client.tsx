"use client";

// Developer portal (client half). Signed out: marketing-brand landing with
// Clerk sign-up/sign-in (modal). Signed in: the dashboard — key card
// (mint/rotate/revoke, plaintext shown exactly once), quickstart cURL,
// 30-day usage chart, and the full endpoint Reference (reused verbatim from
// the internal sandbox — same docs, same response shapes).

import { useState } from "react";
import { SignedIn, SignedOut, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Reference } from "@/app/(portals)/data/api-sandbox/Reference";
import { baseUrl } from "@/app/(portals)/data/api-sandbox/shared";

const ink = "#1a1a1a";
const muted = "#6b655d";
const CARD = "rounded-2xl border border-[#dcd8d0] bg-[#f7f5f1] p-6";
const BTN_PRIMARY =
  "rounded-xl bg-gradient-to-r from-[rgba(59,130,246,1)] to-[rgba(37,99,235,1)] px-6 py-3 text-[15px] font-semibold text-white shadow-md transition hover:brightness-110";

type DevKeyInfo = {
  id: string;
  prefix: string;
  scopes: string[];
  rate_limit_per_min: number;
  created_at: number;
  last_used_at: number | null;
  request_count: number;
  requests_24h: number;
} | null;
type DevUsageDay = { date: string; requests: number; errors: number };

export function DevelopersClient() {
  return (
    <main className="min-h-screen w-full bg-[#eceae6] px-4 pb-24 pt-28 md:pt-32">
      <div className="mx-auto max-w-4xl">
        <SignedOut>
          <Landing />
        </SignedOut>
        <SignedIn>
          <Dashboard />
        </SignedIn>
      </div>
    </main>
  );
}

function Landing() {
  return (
    <div className="text-center">
      <h1
        className="text-4xl leading-tight md:text-5xl"
        style={{ fontFamily: "var(--font-Lora)", color: ink }}
      >
        Build on real car data.
      </h1>
      <p className="mx-auto mt-4 max-w-xl text-[15px]" style={{ color: muted }}>
        Maintenance specs, OEM service intervals, exact-fit parts, real-world labor times
        and vehicle images — by VIN, year/make/model, or config key. Every value carries
        tracked provenance. Sign up and mint your key in under a minute.
      </p>
      <div className="mt-8 flex justify-center gap-3">
        <SignUpButton mode="modal">
          <button className={BTN_PRIMARY}>Create free account</button>
        </SignUpButton>
        <SignInButton mode="modal">
          <button
            className="rounded-xl border border-[#1a1a1a] px-6 py-3 text-[15px] font-semibold transition hover:bg-[#1a1a1a] hover:text-white"
            style={{ color: ink }}
          >
            Sign in
          </button>
        </SignInButton>
      </div>
      <p className="mt-3 text-[12px]" style={{ color: muted }}>
        Free tier: one key · all read scopes · 60 requests/min. No card required.
      </p>

      {/* The docs are the sales pitch — show them signed-out too. */}
      <div className="mt-14 text-left">
        <h2 className="mb-4 text-xl" style={{ fontFamily: "var(--font-Lora)", color: ink }}>
          The API
        </h2>
        <Reference />
      </div>
    </div>
  );
}

function Dashboard() {
  const key = useQuery(api.devPortal.myKey, {}) as DevKeyInfo | undefined;
  const usage = useQuery(api.devPortal.myUsageSeries, {}) as DevUsageDay[] | undefined;
  const mint = useAction(api.devPortal.mintKey);
  const revoke = useMutation(api.devPortal.revokeMyKey);

  const [minted, setMinted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const doMint = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await mint({});
      setMinted(res.key);
      setBusy(false);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "Minting failed — try again.");
    }
  };

  const doRevoke = async () => {
    if (!window.confirm("Revoke your key? Requests using it fail immediately.")) return;
    setBusy(true);
    setError("");
    try {
      await revoke({});
      setMinted(null);
      setBusy(false);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "Revoke failed.");
    }
  };

  const curl = `curl "${baseUrl()}/v0/vehicle?year=2021&make=Toyota&model=Camry" \\\n  -H "Authorization: Bearer ${minted ?? (key ? `${key.prefix}…` : "otp_live_…")}"`;

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-3">
        <h1 className="text-3xl" style={{ fontFamily: "var(--font-Lora)", color: ink }}>
          Developer dashboard
        </h1>
        <span className="ml-auto">
          <UserButton />
        </span>
      </div>

      {/* Key card */}
      <div className={CARD}>
        <h2 className="text-[15px] font-semibold" style={{ color: ink }}>
          Your API key
        </h2>
        {key === undefined ? (
          <div className="mt-3 h-14 animate-pulse rounded-xl bg-[#e5e1da]" />
        ) : minted ? (
          <div className="mt-3">
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4">
              <div className="text-[12px] font-semibold text-emerald-800">
                Copy it now — this is the ONLY time the full key is shown. We store only
                its hash.
              </div>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 overflow-x-auto rounded-lg bg-white px-3 py-2 font-mono text-[13px] text-slate-800">
                  {minted}
                </code>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(minted);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                  className="shrink-0 rounded-lg bg-slate-900 px-3 py-2 text-[13px] font-semibold text-white"
                >
                  {copied ? "Copied ✓" : "Copy"}
                </button>
              </div>
            </div>
          </div>
        ) : key === null ? (
          <div className="mt-3">
            <p className="text-[14px]" style={{ color: muted }}>
              No live key. Mint one — free tier is one key, all read scopes
              (maintenance · labor · media), 60 requests/min.
            </p>
            <button onClick={doMint} disabled={busy} className={`mt-3 ${BTN_PRIMARY} disabled:opacity-60`}>
              {busy ? "Minting…" : "Mint my key"}
            </button>
          </div>
        ) : (
          <div className="mt-3">
            <div className="flex flex-wrap items-center gap-3">
              <code className="rounded-lg bg-white px-3 py-2 font-mono text-[13px] text-slate-800">
                {key.prefix}••••••••••••••••••••••••
              </code>
              <span className="text-[12px]" style={{ color: muted }}>
                {key.scopes.join(" · ")} · {key.rate_limit_per_min} req/min ·{" "}
                {key.request_count.toLocaleString("en-US")} lifetime requests ·{" "}
                {key.requests_24h} in 24h
              </span>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={doMint}
                disabled={busy}
                className="rounded-lg border border-[#1a1a1a] px-4 py-2 text-[13px] font-semibold transition hover:bg-[#1a1a1a] hover:text-white disabled:opacity-60"
                style={{ color: ink }}
              >
                {busy ? "Working…" : "Rotate key"}
              </button>
              <button
                onClick={doRevoke}
                disabled={busy}
                className="rounded-lg border border-red-400 px-4 py-2 text-[13px] font-semibold text-red-600 transition hover:bg-red-600 hover:text-white disabled:opacity-60"
              >
                Revoke
              </button>
            </div>
            <p className="mt-2 text-[11px]" style={{ color: muted }}>
              Rotating mints a new key and revokes this one instantly. The plaintext of the
              current key cannot be shown again.
            </p>
          </div>
        )}
        {error && <p className="mt-2 text-[13px] font-medium text-red-600">{error}</p>}
      </div>

      {/* Quickstart */}
      <div className={CARD}>
        <h2 className="text-[15px] font-semibold" style={{ color: ink }}>
          Quickstart
        </h2>
        <pre className="mt-3 overflow-x-auto rounded-xl bg-slate-900 p-4 font-mono text-[12px] leading-5 text-slate-100">
          {curl}
        </pre>
      </div>

      {/* Usage */}
      <div className={CARD}>
        <h2 className="text-[15px] font-semibold" style={{ color: ink }}>
          Usage — last 30 days
        </h2>
        {usage === undefined ? (
          <div className="mt-3 h-20 animate-pulse rounded-xl bg-[#e5e1da]" />
        ) : usage.length === 0 ? (
          <p className="mt-3 text-[14px]" style={{ color: muted }}>
            No requests yet — the chart draws with your first call.
          </p>
        ) : (
          <div className="mt-4 flex items-end gap-1 overflow-x-auto pb-1">
            {usage.map((d) => {
              const max = Math.max(...usage.map((x) => x.requests), 1);
              return (
                <div
                  key={d.date}
                  className="flex w-5 shrink-0 flex-col items-center"
                  title={`${d.date}: ${d.requests} requests, ${d.errors} errors`}
                >
                  <div
                    className="w-3.5 rounded-t-sm bg-blue-500"
                    style={{ height: 4 + (d.requests / max) * 70 }}
                  />
                  {d.errors > 0 && <div className="mt-0.5 h-1 w-3.5 rounded-sm bg-red-500" />}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Reference */}
      <div>
        <h2 className="mb-4 text-xl" style={{ fontFamily: "var(--font-Lora)", color: ink }}>
          Reference
        </h2>
        <Reference />
      </div>
    </div>
  );
}
