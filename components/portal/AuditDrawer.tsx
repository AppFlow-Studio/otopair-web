"use client";

// Slide-over drawer showing the audit trail for one entity (or the global
// recent feed when no entity is given). Reads the gated audit_log queries.

import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "@/app/(portals)/portal-session";

function ts(created_at: number): string {
  return new Date(created_at).toLocaleString();
}

export function AuditDrawer({
  open,
  onOpenChange,
  entityType,
  entityId,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType?: string;
  entityId?: string;
  title?: string;
}) {
  const { token } = usePortalSession();
  const scoped = Boolean(entityType && entityId);

  const byEntity = useQuery(
    api.audit_log.listByEntity,
    open && scoped ? { entity_type: entityType!, entity_id: entityId!, token } : "skip",
  );
  const recent = useQuery(api.audit_log.listRecent, open && !scoped ? { token } : "skip");

  const rows = scoped ? byEntity : recent;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/40" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col bg-white shadow-2xl focus:outline-none">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <div>
              <Dialog.Title className="text-sm font-semibold text-slate-900">
                {title ?? (scoped ? "Audit trail" : "Recent activity")}
              </Dialog.Title>
              {scoped && (
                <div className="mt-0.5 font-mono text-[11px] text-slate-400">
                  {entityType} · {entityId}
                </div>
              )}
            </div>
            <Dialog.Close className="rounded-md px-2 py-1 text-sm text-slate-400 hover:bg-slate-100">
              ✕
            </Dialog.Close>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-3">
            {rows === undefined && <div className="py-8 text-center text-sm text-slate-400">Loading…</div>}
            {rows !== undefined && rows.length === 0 && (
              <div className="py-8 text-center text-sm text-slate-400">
                No audit entries{scoped ? " for this entity yet" : " yet"}.
              </div>
            )}
            {rows !== undefined &&
              [...rows]
                .sort((a, b) => b.created_at - a.created_at)
                .map((r) => (
                  <div key={r._id} className="border-b border-slate-50 py-2.5 last:border-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[13px] font-semibold text-slate-800">{r.action}</span>
                      <span className="shrink-0 text-[11px] text-slate-400">{ts(r.created_at)}</span>
                    </div>
                    <div className="mt-0.5 text-[12px] text-slate-500">
                      {r.actor}
                      {!scoped && (
                        <span className="text-slate-400">
                          {" · "}
                          {r.entity_type}/{r.entity_id}
                        </span>
                      )}
                    </div>
                    {r.detail && <div className="mt-1 text-[12px] text-slate-600">{r.detail}</div>}
                  </div>
                ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
