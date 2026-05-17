"use client";

import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Loader2, Hash } from "lucide-react";

/**
 * Inline editor for a booking's shop-assigned invoice / work-order number.
 * When set, this string is surfaced on schedule day-cards and in scheduling
 * notifications instead of the auto-generated #LAST6 booking handle.
 */
export default function InvoiceNumberField({
  bookingId,
  initialValue,
}: {
  bookingId: Id<"bookings">;
  initialValue: string | null;
}) {
  const [value, setValue] = useState(initialValue ?? "");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const setInvoice = useMutation((api as any).bookings.setBookingInvoiceNumber);

  useEffect(() => {
    setValue(initialValue ?? "");
  }, [initialValue, bookingId]);

  const handleSave = async () => {
    const trimmed = value.trim();
    if (trimmed === (initialValue ?? "")) return;
    setSaving(true);
    try {
      await setInvoice({ bookingId, invoiceNumber: trimmed });
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-3">
      <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Hash className="h-3.5 w-3.5" />
        Invoice / Work-order #
      </label>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={handleSave}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
          maxLength={32}
          placeholder="auto (uses booking ID)"
          className="flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-sm font-semibold outline-none focus:border-primary"
        />
        {saving ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : savedAt && Date.now() - savedAt < 2000 ? (
          <span className="text-xs text-green-600">Saved</span>
        ) : null}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Shown on the schedule card and in scheduling alerts. Leave blank to use the auto handle.
      </p>
    </div>
  );
}
