"use client";

/**
 * VinRepairPrompt — "we don't have this car's VIN" (Off-Catalog Work spec, §5).
 *
 * A walk-in entered without a valid VIN is living on a placeholder identity. It
 * bills fine, which is exactly why nobody notices: the cost is deferred and
 * invisible. No decoded engine or options, no parts fitment, and when the
 * customer later adds the same car properly in their own account it becomes a
 * SECOND car with a separate history — this shop's work stranded on the
 * placeholder.
 *
 * The mechanic has the car in front of them, so they are the only person who can
 * fix this cheaply. This renders only when the booking actually needs it, and
 * disappears the moment it's supplied.
 *
 * Handles one non-obvious outcome explicitly: if the VIN belongs to a car we
 * already know, this is a merge of two identities rather than a re-key, and the
 * server refuses. That's surfaced as "contact support", not as a retry, because
 * retrying will never work.
 */

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Loader2, ScanLine } from "lucide-react";

export default function VinRepairPrompt({
  bookingId,
  onDone,
}: {
  bookingId: string;
  onDone?: (message: string) => void;
}) {
  const status = useQuery(api.walkinVinRepair.bookingNeedsVin, {
    bookingId: bookingId as Id<"bookings">,
  });
  const submit = useMutation(api.walkinVinRepair.submitVinForBooking);

  const [open, setOpen] = useState(false);
  const [vin, setVin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!status?.needsVin) return null;

  // Same structural test the server uses, so the button can't be enabled for
  // something the mutation will reject: 17 chars, no I/O/Q.
  const candidate = vin.trim().toUpperCase();
  const looksValid = /^[A-HJ-NPR-Z0-9]{17}$/.test(candidate);

  async function handleSubmit() {
    setBusy(true);
    setError("");
    try {
      const res: any = await submit({
        bookingId: bookingId as Id<"bookings">,
        vin: candidate,
      });
      if (res?.ok === false) {
        setError(
          res.reason === "target_known"
            ? "That VIN is already on another car in Otopair. Contact support so the two records can be merged properly — re-entering it won't help."
            : "That VIN couldn't be applied. Double-check the digits.",
        );
        return;
      }
      onDone?.("VIN saved — this car is now properly identified");
      setOpen(false);
      setVin("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not save that VIN.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <ScanLine className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-foreground">
            No VIN on file{status.label ? ` for this ${status.label}` : ""}
          </p>
          {!open ? (
            <>
              <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                Without it we can&apos;t pull exact parts, and this visit
                won&apos;t connect if the customer adds the car themselves later.
              </p>
              <button
                type="button"
                onClick={() => setOpen(true)}
                className="mt-1.5 text-[12px] font-semibold text-amber-700 underline decoration-amber-700/40 underline-offset-2 hover:decoration-amber-700"
              >
                Add it now
              </button>
            </>
          ) : (
            <div className="mt-2 space-y-2">
              <input
                type="text"
                value={vin}
                autoFocus
                maxLength={17}
                onChange={(e) => setVin(e.target.value.toUpperCase())}
                placeholder="17-digit VIN from the door jamb or windscreen"
                className="w-full rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs uppercase outline-none focus:border-primary"
              />
              {error ? (
                <p className="text-[12px] leading-relaxed text-red-600">{error}</p>
              ) : null}
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!looksValid || busy}
                  onClick={handleSubmit}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  Save VIN
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setError("");
                  }}
                  className="rounded-md px-3 py-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground"
                >
                  Not now
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
