"use client";

// The account island on /developers (2026-09-05). The public half of the
// page is now the hand-off to OtoIndex and is server-rendered in page.tsx;
// this file only carries what needs Clerk and Convex:
//
//   signed out  → one line for people who already hold a key minted here
//   signed in   → the dashboard: key card (mint/rotate/revoke, plaintext
//                 shown exactly once), quickstart cURL, 30-day usage chart
//                 and the endpoint Reference
//
// Key minting stays here for existing holders. OtoIndex owns issuing keys
// from launch; nothing about the Convex devPortal contract changed.

import { useState } from "react";
import { SignedIn, SignedOut, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Reference } from "./Reference";
import { baseUrl } from "./shared";
import { OTOINDEX } from "@/lib/otoindex";

const ink = "#1a1a1a";
const muted = "#6b655d";
const serif = { fontFamily: "var(--font-Petrona)", fontWeight: 400 } as const;
const CARD = "rounded-[28px] bg-[#f7f6f3] p-6 shadow-[inset_0_0_0_1px_rgba(26,26,26,0.06)] tab:p-8";
const BTN_PRIMARY = "inline-flex h-12 items-center justify-center rounded-full bg-[#1a1a1a] px-6 text-[15px] font-medium text-white transition-[transform,box-shadow] duration-300 hover:-translate-y-px hover:shadow-[0_16px_36px_-14px_rgba(26,26,26,0.55)]";
const BTN_OUTLINE_SM = "inline-flex h-11 items-center justify-center rounded-full border border-[#1a1a1a]/20 bg-white px-5 text-[14px] font-medium text-[#1a1a1a] transition-colors hover:border-[#1a1a1a]";

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
    <div className="w-full min-w-0 [&_.grid>*]:min-w-0 [&_pre]:max-w-full">
      <SignedOut>
        <SignedOutNote />
      </SignedOut>
      <SignedIn>
        <Dashboard />
      </SignedIn>
    </div>
  );
}

/** Signed out: the page above has already handed the reader to OtoIndex, so
 *  this is only for someone who minted a key here before that. */
function SignedOutNote() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-[#1a1a1a]/10 pt-8">
      <p className="text-[15px]" style={{ color: muted }}>
        Already hold a key issued through Otopair?
      </p>
      <SignInButton mode="modal">
        <button className={BTN_OUTLINE_SM}>Sign in to manage it</button>
      </SignInButton>
      <SignUpButton mode="modal">
        <button className="text-[14px] text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">
          Create an account
        </button>
      </SignUpButton>
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
      setError(e instanceof Error ? e.message : "Minting failed. Try again.");
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
        <h2 className="text-[28px]" style={{ ...serif, color: ink }}>
          Your developer account
        </h2>
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
          <div className="mt-3 h-14 animate-pulse rounded-[16px] bg-[#1a1a1a]/[0.05]" />
        ) : minted ? (
          <div className="mt-3">
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4">
              <div className="text-[12px] font-semibold text-emerald-800">
                Copy it now. This is the only time the full key is shown; we store only
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
                  className="shrink-0 rounded-full bg-[#1a1a1a] px-4 py-2 text-[13px] font-medium text-white"
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
              <button onClick={doMint} disabled={busy} className={`${BTN_OUTLINE_SM} disabled:opacity-60`}>
                {busy ? "Working…" : "Rotate key"}
              </button>
              <button
                onClick={doRevoke}
                disabled={busy}
                className="inline-flex h-11 items-center justify-center rounded-full border border-[#b04a3a]/40 px-5 text-[14px] font-medium text-[#b04a3a] transition-colors hover:border-[#b04a3a] disabled:opacity-60"
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
          Usage, last 30 days
        </h2>
        {usage === undefined ? (
          <div className="mt-3 h-20 animate-pulse rounded-[16px] bg-[#1a1a1a]/[0.05]" />
        ) : usage.length === 0 ? (
          <p className="mt-3 text-[14px]" style={{ color: muted }}>
            No requests yet. The chart draws with your first call.
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
                    className="w-3.5 rounded-t-sm bg-[#4B82A5]"
                    style={{ height: 4 + (d.requests / max) * 70 }}
                  />
                  {d.errors > 0 && <div className="mt-0.5 h-1 w-3.5 rounded-sm bg-[#b04a3a]" />}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Reference. OtoIndex owns the public docs; this copy stays for the
          people signed in here, with the canonical link on top. */}
      <div>
        <h2 className="serif-display mb-3 text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] tab:text-[38px]">
          Reference
        </h2>
        <p className="mb-6 text-[15px]" style={{ color: muted }}>
          The interactive reference, with authentication, errors and rate limits, lives on{" "}
          <a
            href={OTOINDEX.docs}
            className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]"
          >
            the OtoIndex docs
          </a>
          .
        </p>
        <Reference />
      </div>
    </div>
  );
}
