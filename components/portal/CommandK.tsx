"use client";

// ⌘K command palette (cmdk) — searches users/shops/bookings via the gated
// portalSearch.search query and navigates to the entity's detail route.

import { useEffect, useState } from "react";
import { Command } from "cmdk";
import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "@/app/(portals)/portal-session";
import { stashGoto } from "@/app/(director-panel)/director/components/directorNav";

export function CommandK({
  open,
  onOpenChange,
  onNavigate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (href: string) => void;
}) {
  const { token } = usePortalSession();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 180);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const results = useQuery(
    api.portalSearch.search,
    open && debounced.trim().length >= 2 ? { token, q: debounced } : "skip",
  ) as FunctionReturnType<typeof api.portalSearch.search> | undefined;

  const go = (href: string) => {
    onOpenChange(false);
    onNavigate(href);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/40" />
        <Dialog.Content className="fixed left-1/2 top-24 z-50 w-full max-w-lg -translate-x-1/2 overflow-hidden rounded-xl bg-white shadow-2xl focus:outline-none">
          <Dialog.Title className="sr-only">Search</Dialog.Title>
          <Command shouldFilter={false} label="Search">
            <Command.Input
              value={q}
              onValueChange={setQ}
              autoFocus
              placeholder="Search users by email, shops by name, or paste any ID…"
              className="w-full border-b border-slate-100 px-4 py-3.5 text-[15px] text-slate-900 outline-none placeholder:text-slate-400"
            />
            <Command.List className="max-h-80 overflow-y-auto p-2">
              {debounced.trim().length < 2 && (
                <div className="px-3 py-6 text-center text-[13px] text-slate-400">
                  Type at least two characters.
                </div>
              )}
              {results && (
                <>
                  {results.users.length === 0 &&
                    results.shops.length === 0 &&
                    results.bookings.length === 0 && (
                      <Command.Empty className="px-3 py-6 text-center text-[13px] text-slate-400">
                        No matches.
                      </Command.Empty>
                    )}
                  {results.users.length > 0 && (
                    <Command.Group
                      heading="Users"
                      className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-group-heading]]:text-slate-400"
                    >
                      {results.users.map((u) => (
                        <Command.Item
                          key={u.id}
                          value={`user-${u.id}`}
                          onSelect={() => go(`/ops/users/${u.id}`)}
                          className="flex cursor-pointer items-baseline justify-between rounded-md px-3 py-2 text-[13px] text-slate-800 data-[selected=true]:bg-blue-50"
                        >
                          <span className="font-medium">{u.label}</span>
                          <span className="text-[12px] text-slate-400">{u.sub}</span>
                        </Command.Item>
                      ))}
                    </Command.Group>
                  )}
                  {results.shops.length > 0 && (
                    <Command.Group
                      heading="Shops"
                      className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-group-heading]]:text-slate-400"
                    >
                      {results.shops.map((s) => (
                        <Command.Item
                          key={s.id}
                          value={`shop-${s.id}`}
                          onSelect={() => {
                            // Shops portal merged into /director#shops.
                            stashGoto("shops", s.id);
                            go("/director#shops");
                          }}
                          className="flex cursor-pointer items-baseline justify-between rounded-md px-3 py-2 text-[13px] text-slate-800 data-[selected=true]:bg-blue-50"
                        >
                          <span className="font-medium">{s.label}</span>
                          <span className="text-[12px] text-slate-400">{s.sub}</span>
                        </Command.Item>
                      ))}
                    </Command.Group>
                  )}
                  {results.bookings.length > 0 && (
                    <Command.Group
                      heading="Bookings"
                      className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-group-heading]]:text-slate-400"
                    >
                      {results.bookings.map((b) => (
                        <Command.Item
                          key={b.id}
                          value={`booking-${b.id}`}
                          onSelect={() => go(`/ops/bookings/${b.id}`)}
                          className="flex cursor-pointer items-baseline justify-between rounded-md px-3 py-2 text-[13px] text-slate-800 data-[selected=true]:bg-blue-50"
                        >
                          <span className="font-medium">{b.label}</span>
                          <span className="text-[12px] text-slate-400">{b.sub}</span>
                        </Command.Item>
                      ))}
                    </Command.Group>
                  )}
                </>
              )}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
