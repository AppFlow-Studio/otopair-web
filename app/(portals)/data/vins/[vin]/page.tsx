"use client";

// Data · VIN Explorer (detail) — /data/vins/:vin (Data spec §4B).
// Left: decode card (all FKs as chips — a missing chip IS the decode gap) +
// metadata JSON (collapsed) + Re-decode (reuses the Control Room's re-enrich
// trigger through the ceremony). Right: vehicle image (IMAGIN — licensed,
// never export), passport link card, ownership dates (identity gated),
// recent booking chips (honest window — no by_vin index).

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession, useCan } from "../../../portal-session";
import { Ceremony } from "@/components/portal/Ceremony";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const fmtDate = (ms: number | null) => (ms == null ? "—" : new Date(ms).toLocaleDateString());

type VinDetail = {
  id: string;
  vin: string;
  year: number | null;
  image_url: string | null;
  config: { id: string; config_key: string } | null;
  links: { kind: string; id: string | null; label: string | null }[];
  metadata_json: string | null;
  passport: { vin: string; last_shop_confirmed_at: number | null } | null;
  ownership: { added_at: number | null; removed_at: number | null; status: string }[];
  bookings: { id: string; status: string; scheduled_date: string | null; created_at: number }[];
  bookings_window_note: string;
  queue: { status: string; error: string | null; queued_at: number | null } | null;
} | null;

export default function VinDetailPage() {
  const { token } = usePortalSession();
  const canTrigger = useCan("data.trigger");
  const params = useParams<{ vin: string }>();
  const vin = decodeURIComponent(params.vin ?? "");

  const detail = useQuery(api.dataVins.vinDetail, { token, vin }) as VinDetail | undefined;
  const reEnrich = useMutation(api.dataControlRoom.triggerReEnrich);
  const [metaOpen, setMetaOpen] = useState(false);
  const [redecodeOpen, setRedecodeOpen] = useState(false);

  if (detail === undefined) {
    return (
      <div className="space-y-3">
        <div className="h-8 w-72 animate-pulse rounded-lg bg-slate-100" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="h-64 animate-pulse rounded-xl bg-slate-100" />
          <div className="h-64 animate-pulse rounded-xl bg-slate-100" />
        </div>
      </div>
    );
  }
  if (detail === null) {
    return (
      <div className="rounded-xl border border-red-200 bg-white p-6 text-sm text-red-700">
        No decoded vehicle exists for VIN <span className="font-mono">{vin}</span>.{" "}
        <Link href="/data/vins" className="font-medium text-blue-600 hover:underline">
          Back to the explorer
        </Link>
        .
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-xl font-semibold text-slate-900">{detail.vin}</h1>
        {detail.year && <span className={`${pill} bg-slate-100 text-slate-600`}>{detail.year}</span>}
        {detail.config && (
          <Link
            href={`/data/catalog/${detail.config.id}`}
            className={`${pill} bg-blue-50 text-blue-700 hover:bg-blue-100`}
          >
            {detail.config.config_key} →
          </Link>
        )}
        {detail.queue && (
          <span
            className={`${pill} ${
              detail.queue.status === "complete"
                ? "bg-emerald-50 text-emerald-700"
                : detail.queue.status === "pending"
                  ? "bg-amber-50 text-amber-700"
                  : "bg-slate-100 text-slate-600"
            }`}
          >
            queue: {detail.queue.status}
          </span>
        )}
        {canTrigger && (
          <button
            onClick={() => setRedecodeOpen(true)}
            className="ml-auto rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Re-decode / re-enrich
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Left — decode card + metadata */}
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">Decode</h2>
            <div className="mt-3 space-y-2">
              {detail.links.map((l) => (
                <div key={l.kind} className="flex items-center gap-2 text-[13px]">
                  <span className="w-28 text-slate-500">{l.kind}</span>
                  {l.id == null ? (
                    <span className={`${pill} bg-amber-100 text-amber-800`}>
                      unlinked — decode gap
                    </span>
                  ) : (
                    <span className={`${pill} bg-slate-100 text-slate-700`}>
                      {l.label ?? l.id.slice(0, 10)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <button
              onClick={() => setMetaOpen((o) => !o)}
              className="flex w-full items-center justify-between text-sm font-semibold text-slate-900"
            >
              Decode metadata (raw JSON)
              <span className="text-slate-400">{metaOpen ? "▾" : "▸"}</span>
            </button>
            {metaOpen &&
              (detail.metadata_json ? (
                <pre className="mt-3 max-h-96 overflow-auto rounded-lg bg-slate-50 p-3 text-[11px] leading-snug text-slate-700">
                  {detail.metadata_json}
                </pre>
              ) : (
                <p className="mt-3 text-sm text-slate-500">No stored metadata.</p>
              ))}
          </div>
        </div>

        {/* Right — image, passport, ownership, bookings */}
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">Vehicle image</h2>
            {detail.image_url ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={detail.image_url}
                  alt={`Vehicle ${detail.vin}`}
                  className="mt-3 max-h-56 rounded-lg object-contain"
                />
                <p className="mt-2 text-[11px] text-slate-400">
                  IMAGIN — licensed, never export.
                </p>
              </>
            ) : (
              <p className="mt-3 text-sm text-slate-500">No image on file.</p>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">Passport</h2>
            {detail.passport ? (
              <div className="mt-3 flex items-center gap-3">
                <Link
                  href={`/data/vehicle-id/${detail.vin}`}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
                >
                  Open passport
                </Link>
                <span className="text-[12px] text-slate-500">
                  last shop touch {fmtDate(detail.passport.last_shop_confirmed_at)}
                </span>
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-500">No passport row for this VIN yet.</p>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">
              Ownership <span className="font-normal text-slate-400">(dates only — identity gated)</span>
            </h2>
            {detail.ownership.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">No platform owners.</p>
            ) : (
              <div className="mt-3 space-y-1.5">
                {detail.ownership.map((o, i) => (
                  <div key={i} className="flex items-center gap-2 text-[13px] text-slate-600">
                    <span className={`${pill} bg-slate-100 text-slate-600`}>{o.status}</span>
                    added {fmtDate(o.added_at)}
                    {o.removed_at != null && <> · removed {fmtDate(o.removed_at)}</>}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">Recent bookings</h2>
            {detail.bookings.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">None in the window.</p>
            ) : (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {detail.bookings.map((b) => (
                  <span key={b.id} className={`${pill} bg-slate-100 text-slate-700`}>
                    {b.status}
                    {b.scheduled_date ? ` · ${b.scheduled_date}` : ""}
                  </span>
                ))}
              </div>
            )}
            <p className="mt-2 text-[11px] text-slate-400">{detail.bookings_window_note}</p>
          </div>
        </div>
      </div>

      {/* Re-decode ceremony — reuses the Control Room trigger (cooldown + audit
          live in dataControlRoom.triggerReEnrich). */}
      <Ceremony
        open={redecodeOpen}
        onOpenChange={setRedecodeOpen}
        title={`Re-enrich ${detail.vin}`}
        summary={
          <>
            Queues a full Tier-1 re-enrichment for this VIN (the Jun 7 manual re-fetch
            lever). Respects the per-VIN cooldown; costs real money. The run links back
            to this VIN in the Control Room.
          </>
        }
        onConfirm={async (reason) => {
          await reEnrich({ token, reason, vin: detail.vin });
        }}
      />
    </div>
  );
}
