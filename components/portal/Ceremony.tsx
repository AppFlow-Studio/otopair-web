"use client";

// Write-ceremony modal (Ops spec §4 — the standard all three portals
// inherit). Every portal mutation flows through this: the dialog states what
// will change, requires a reason, and the caller passes {token, reason} to a
// gated Convex mutation that writes the audit row atomically.

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";

export type CeremonyProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** e.g. "Restore user", "Change hourly rate" */
  title: string;
  /** Human sentence describing exactly what will change. */
  summary: React.ReactNode;
  /** Red styling + stronger verb for irreversible actions. */
  destructive?: boolean;
  confirmLabel?: string;
  /** Runs the gated mutation; throw to surface an error inside the dialog. */
  onConfirm: (reason: string) => Promise<void>;
};

export function Ceremony({
  open,
  onOpenChange,
  title,
  summary,
  destructive = false,
  confirmLabel,
  onConfirm,
}: CeremonyProps) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const close = (next: boolean) => {
    if (busy) return;
    if (!next) {
      setReason("");
      setError("");
    }
    onOpenChange(next);
  };

  const confirm = async () => {
    if (reason.trim().length < 4) {
      setError("A reason is required (at least a few words).");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onConfirm(reason.trim());
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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-6 shadow-2xl focus:outline-none">
          <Dialog.Title className="text-base font-semibold text-slate-900">{title}</Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-2 text-sm text-slate-600">{summary}</div>
          </Dialog.Description>

          <label className="mt-4 block text-xs font-semibold text-slate-600">
            Reason <span className="font-normal text-slate-400">(recorded in the audit log)</span>
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            autoFocus
            disabled={busy}
            placeholder="Why is this change being made?"
            className={`mt-1.5 w-full resize-none rounded-lg border-[1.5px] px-3 py-2 text-sm text-slate-900 outline-none ${
              error ? "border-red-400" : "border-slate-200 focus:border-blue-500"
            }`}
          />
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
              className={`rounded-lg px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-60 ${
                destructive ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"
              }`}
            >
              {busy ? "Applying…" : (confirmLabel ?? (destructive ? "Confirm & apply" : "Apply"))}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
