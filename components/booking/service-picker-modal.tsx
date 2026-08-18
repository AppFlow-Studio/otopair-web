"use client";

/**
 * ServicePickerModal — search the catalog, or keep what you typed.
 *
 * Extracted from post-job-survey-dialog so the Flag Issue sheet can use the
 * SAME picker rather than growing a second one. This codebase has already been
 * bitten by two copies of a form drifting apart, and a picker is exactly the
 * kind of component that accumulates rules — the match gate, the vehicle-match
 * ordering, the cross-shop name band — in one copy and not the other.
 *
 * The two suggestion bands underneath do different jobs. ServiceSuggestions
 * offers CATALOG services, and taking one is strictly better: it's bookable and
 * it earns the driver maintenance credit. KnownNameSuggestions offers what
 * other shops call this work when the catalog has nothing, so a name typed
 * forty ways doesn't become forty clusters.
 */

import { useState } from "react";
import { useQuery } from "convex/react";
import { Loader2, Search, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import ServiceSuggestions from "@/components/booking/service-suggestions";
import KnownNameSuggestions from "@/components/booking/known-name-suggestions";

export type ServicePicked =
  | {
      kind: "service";
      id: string;
      name: string;
      slug: string | null;
      has_options: boolean;
    }
  | {
      kind: "freeform";
      name: string;
      /** Present when the name came from another shop's cluster — their
       *  tagging carries across so this mechanic isn't re-answering a
       *  question the cluster already settled. */
      system_tags?: string[];
      work_type?: string | null;
    };


/** Catalog matches for what's typed, plus the typed name itself as a valid
 *  answer. Matches are options, never a question to answer. */
function CustomNameGate({
  typed,
  onPick,
}: {
  typed: string;
  onPick: (picked: ServicePicked) => void;
}) {
  return (
    <div className="mt-3 space-y-2 border-t border-primary/10 pt-3">
      <ServiceSuggestions
        typed={typed}
        onPick={(svc) =>
          onPick({
            kind: "service",
            id: String(svc.serviceId),
            name: svc.name,
            slug: svc.slug,
            has_options: svc.has_options,
          })
        }
      />
      <button
        type="button"
        onClick={() => onPick({ kind: "freeform", name: typed })}
        className="w-full rounded-lg border border-dashed border-primary/30 px-3 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-primary/5"
      >
        Use &ldquo;<span className="font-semibold">{typed}</span>&rdquo; as typed
      </button>
    </div>
  );
}

export default function ServicePickerModal({
  engineId,
  initialQuery,
  onClose,
  onPick,
}: {
  engineId: string | null;
  initialQuery: string;
  onClose: () => void;
  onPick: (
    picked:
      | {
          kind: "service";
          id: string;
          name: string;
          slug: string | null;
          has_options: boolean;
        }
      | {
          kind: "freeform";
          name: string;
          /** Present when the name came from another shop's cluster — their
           *  tagging carries across so this mechanic isn't re-answering a
           *  question the cluster already settled. */
          system_tags?: string[];
          work_type?: string | null;
        },
  ) => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const results = useQuery(api.services.listForVehicle, {
    engineId: (engineId ?? undefined) as never,
    query,
    limit: 25,
  });
  const trimmed = query.trim();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Pick a service"
      className="fixed inset-0 z-[60] flex items-end justify-center bg-foreground/40 px-3 pb-3 sm:items-center sm:pb-0"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-primary/10 bg-background shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-primary/10 px-4 py-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Pick a service
            </p>
            <p className="text-[13px] font-semibold">
              Vehicle-matched first
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/5 hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="border-b border-primary/10 px-4 py-2.5">
          <div className="flex items-center gap-2 rounded-lg border border-primary/15 bg-background px-2.5 py-2 focus-within:border-primary">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search the service catalog…"
              autoFocus
              className="flex-1 bg-transparent text-[13px] outline-none"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {results === undefined ? (
            <div className="flex items-center justify-center py-8 text-[12px] text-muted-foreground">
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              Searching…
            </div>
          ) : (
            <>
              {results.length === 0 ? (
                <div className="py-6 text-center text-[12px] text-muted-foreground">
                  No matching services.
                </div>
              ) : (
                <ul className="space-y-1">
                  {results.map((svc) => (
                    <li key={svc._id}>
                      <button
                        type="button"
                        onClick={() =>
                          onPick({
                            kind: "service",
                            id: svc._id,
                            name: svc.name,
                            slug: (svc as any).slug ?? null,
                            has_options: Boolean((svc as any).has_options),
                          })
                        }
                        className="flex w-full items-center justify-between gap-2 rounded-lg border border-transparent px-3 py-2 text-left transition-colors hover:border-primary/15 hover:bg-primary/5"
                      >
                        <span className="truncate text-[13px] font-medium text-foreground">
                          {svc.name}
                        </span>
                        {svc.is_vehicle_match ? (
                          <span className="inline-flex shrink-0 items-center rounded-md bg-primary/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-primary">
                            Fits car
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {trimmed.length >= 2 ? (
                <div className="space-y-2 px-1">
                  <CustomNameGate
                    typed={trimmed}
                    onPick={onPick}
                  />
                  {/* Work that isn't in the catalog but that other shops have
                      already named. Picking one keeps the cluster together
                      rather than opening a fortieth spelling of it. */}
                  <KnownNameSuggestions
                    typed={trimmed}
                    onPick={(s) =>
                      onPick({
                        kind: "freeform",
                        name: s.name,
                        system_tags: s.system_tags,
                        work_type: s.work_type,
                      })
                    }
                  />
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
