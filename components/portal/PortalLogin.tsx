"use client";

// Email + TOTP login for the internal portals. Same auth backend as the
// legacy director panel (api.director_auth.loginWithEmail), restyled with
// Tailwind for the portal shell.

import { useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";

type Phase = { id: "email" } | { id: "code"; email: string };

export function PortalLogin({
  onLogin,
}: {
  onLogin: (token: string, user: { name: string; role: string; userId: string }) => void;
}) {
  const loginWithEmail = useAction(api.director_auth.loginWithEmail);

  const [phase, setPhase] = useState<Phase>({ id: "email" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setError("");
    const t = setTimeout(
      () => (phase.id === "email" ? emailRef.current : codeRef.current)?.focus(),
      60,
    );
    if (phase.id === "code") setCode("");
    return () => clearTimeout(t);
  }, [phase.id]);

  const handleEmailSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    setPhase({ id: "code", email: trimmed });
  };

  const handleCodeChange = (v: string) => {
    const d = v.replace(/\D/g, "").slice(0, 6);
    setCode(d);
    if (d.length === 6) void submitCode(d);
  };

  const submitCode = async (digits: string) => {
    if (phase.id !== "code") return;
    setBusy(true);
    setError("");
    const res = await loginWithEmail({ email: phase.email, code: digits });
    setBusy(false);
    if (res.success) {
      const { token, name, role, userId } = res as {
        token: string;
        name: string;
        role: string;
        userId: string;
      };
      onLogin(token, { name, role, userId });
    } else {
      setError((res as { error?: string }).error ?? "Invalid email or code");
      setCode("");
      setTimeout(() => codeRef.current?.focus(), 60);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-[420px] overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="border-b border-slate-100 px-7 pb-5 pt-6">
          <div className="mb-3.5 flex items-center gap-3">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-lg font-bold text-white">
              O
            </span>
            <div>
              <div className="text-[15px] font-bold text-slate-900">Otopair Internal</div>
              <div className="text-[11px] text-slate-500">Ops · Shops · Data</div>
            </div>
          </div>
          <div className="text-xl font-semibold text-slate-900">
            {phase.id === "email" ? "Sign in" : "Verify your identity"}
          </div>
          <div className="mt-1 text-[13px] text-slate-500">
            {phase.id === "email"
              ? "Enter your director email to continue."
              : "Enter the 6-digit code from your authenticator app."}
          </div>
        </div>

        <div className="px-7 pb-7 pt-5">
          {phase.id === "email" && (
            <form onSubmit={handleEmailSubmit} noValidate>
              <label className="mb-1.5 block text-xs font-semibold text-slate-600">
                Email address
              </label>
              <input
                ref={emailRef}
                type="email"
                autoComplete="email"
                placeholder="you@otopair.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={`w-full rounded-lg border-[1.5px] px-3 py-2.5 text-[15px] text-slate-900 outline-none ${
                  error ? "border-red-400" : "border-slate-200 focus:border-blue-500"
                }`}
              />
              {error && <div className="mt-2 text-[13px] font-medium text-red-600">{error}</div>}
              <button
                type="submit"
                className="mt-4 w-full rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
              >
                Continue →
              </button>
            </form>
          )}

          {phase.id === "code" && (
            <div>
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <span className="text-[13px] text-slate-500">Signing in as</span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-900">
                  {phase.email}
                </span>
              </div>
              <label className="mb-2 block text-xs font-semibold text-slate-600">
                Authenticator code
              </label>
              <input
                ref={codeRef}
                type="text"
                inputMode="numeric"
                placeholder="000000"
                maxLength={6}
                value={code}
                onChange={(e) => handleCodeChange(e.target.value)}
                disabled={busy}
                className={`w-full rounded-xl border-2 py-3.5 text-center font-mono text-3xl font-bold tracking-[0.5em] text-slate-900 outline-none ${
                  error ? "border-red-400" : "border-slate-200 focus:border-blue-500"
                } ${busy ? "bg-slate-50" : "bg-white"}`}
              />
              {error && (
                <div className="mt-2.5 text-center text-[13px] font-medium text-red-600">{error}</div>
              )}
              {busy && <div className="mt-2.5 text-center text-[13px] text-slate-400">Verifying…</div>}
              <button
                onClick={() => setPhase({ id: "email" })}
                className="mt-4 w-full py-2.5 text-[13px] text-slate-500 underline"
              >
                ← Use a different email
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
