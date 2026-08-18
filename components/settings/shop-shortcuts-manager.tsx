"use client";

/**
 * ShopShortcutsManager — edit and retire the shop's off-catalog shortcuts.
 *
 * Shortcuts were creatable from the booking drawer but nothing could ever change
 * or remove one, so a typo made on a busy Tuesday was permanent and a shortcut
 * for work the shop stopped doing sat in the picker forever.
 *
 * Two things are deliberately absent:
 *
 *   RENAME. A shortcut's name is its identity — `match_key` derives from it, and
 *   forty past jobs are recorded under it. Renaming would retroactively change
 *   what that work was called. Retire and make a new one instead.
 *
 *   DELETE. Retiring hides it from the picker and keeps the row, because past
 *   custom_jobs rows still point at it. A hard delete would orphan them.
 */

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Loader2 } from "lucide-react";

export default function ShopShortcutsManager({
  shopId,
}: {
  shopId: Id<"shops"> | undefined;
}) {
  const shortcuts = useQuery(
    api.shopCustomServices.listForShop,
    shopId ? { shopId, limit: 50 } : "skip",
  );
  const updateDefaults = useMutation(api.shopCustomServices.updateDefaults);
  const retire = useMutation(api.shopCustomServices.retire);

  const [editing, setEditing] = useState<string | null>(null);
  const [minutes, setMinutes] = useState("");
  const [busy, setBusy] = useState(false);

  if (!shopId) return null;
  // Nothing to manage until the shop has actually saved one.
  if (shortcuts && shortcuts.length === 0) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">Custom work you reuse</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Saved from the booking screen when you tick &ldquo;Save for next
        time&rdquo;. These aren&apos;t bookable services — customers never see
        them. Names can&apos;t be changed because past jobs are recorded under
        them; retire one and make a new one instead.
      </p>

      {!shortcuts ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {shortcuts.map((s: any) => {
            const id = String(s._id);
            const isEditing = editing === id;
            return (
              <li key={id} className="py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {s.name}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      used {s.use_count}×
                      {s.default_minutes ? ` · ${s.default_minutes}m default` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {isEditing ? null : (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(id);
                            setMinutes(
                              s.default_minutes ? String(s.default_minutes) : "",
                            );
                          }}
                          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                        >
                          Edit time
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true);
                            try {
                              await retire({ id: s._id });
                            } finally {
                              setBusy(false);
                            }
                          }}
                          className="rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-destructive disabled:opacity-40"
                        >
                          Retire
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {isEditing ? (
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      autoFocus
                      value={minutes}
                      onChange={(e) => setMinutes(e.target.value)}
                      placeholder="Minutes"
                      className="w-28 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          const n = Number(minutes);
                          await updateDefaults({
                            id: s._id,
                            defaultMinutes:
                              Number.isFinite(n) && n > 0 ? n : undefined,
                          });
                          setEditing(null);
                        } finally {
                          setBusy(false);
                        }
                      }}
                      className="rounded-md bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-40"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      className="px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
