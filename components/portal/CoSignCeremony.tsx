"use client";

// Co-signed write ceremony (Data spec §9.3 — pricing-lever changes need a
// second Data Admin / Super Admin). Extends the standard reason-required
// ceremony with the co-signer's email + live TOTP code; the backing ACTION
// verifies both signers before anything writes. Both names land in the audit
// row and fallback snapshot.

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";

export type CoSignCeremonyProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  summary: React.ReactNode;
  /** e.g. 'affects 384 configs" fallback prices' — rendered as the red line. */
  blastRadius?: React.ReactNode;
  onConfirm: (reason: string, cosignEmail: string, cosignCode: string) => Promise<void>;
};

export function CoSignCeremony({
  open,
  onOpenChange,
  title,
  summary,
  blastRadius,
  onConfirm,
}: CoSignCeremonyProps) {
  const [reason, setReason] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const close = (next: boolean) => {
    if (busy) return;
    if (!next) {
      setReason("");
      setEmail("");
      setCode("");
      setError("");
    }
    onOpenChange(next);
  };

  const confirm = async () => {
    if (reason.trim().length < 4) {
      setError("A reason is required (at least a few words).");
      return;
    }
    if (!email.trim().includes("@")) {
      setError("Co-signer email is required.");
      return;
    }
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Co-signer TOTP code must be 6 digits.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onConfirm(reason.trim(), email.trim(), code.trim());
      setBusy(false);
      close(false);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "The action failed. Nothing was changed.");
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border-2 border-red-200 bg-white p-6 shadow-2xl focus:outline-none">
          <Dialog.Title className="text-base font-semibold text-slate-900">{title}</Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-2 text-sm text-slate-600">{summary}</div>
          </Dialog.Description>
          {blastRadius && (
            <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-[13px] font-medium text-red-700">
              {blastRadius}
            </div>
          )}

          <label className="mt-4 block text-xs font-semibold text-slate-600">
            Reason <span className="font-normal text-slate-400">(recorded in the audit log)</span>
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            autoFocus
            disabled={busy}
            placeholder="Why is this pricing lever moving?"
            className="mt-1.5 w-full resize-none rounded-lg border-[1.5px] border-slate-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500"
          />

          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="text-xs font-semibold text-slate-600">
              Co-signer{" "}
              <span className="font-normal text-slate-400">
                (a different director with data.write — their live TOTP code)
              </span>
            </div>
            <div className="mt-2 flex gap-2">
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
                placeholder="cosigner@otopair.com"
                className="w-full rounded-lg border-[1.5px] border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500"
              />
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                disabled={busy}
                placeholder="123456"
                inputMode="numeric"
                className="w-28 rounded-lg border-[1.5px] border-slate-200 px-3 py-2 text-center font-mono text-sm tracking-widest outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {error && <div className="mt-2 text-[13px] font-medium text-red-600">{error}</div>}

          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={() => close(false)}
              disabled={busy}
              className="rounded-lg px-3.5 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              onClick={() => void confirm()}
              disabled={busy}
              className="rounded-lg bg-red-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
            >
              {busy ? "Verifying co-sign…" : "Apply with co-sign"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
