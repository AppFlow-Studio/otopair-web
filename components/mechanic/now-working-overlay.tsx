"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Camera,
  CheckCircle2,
  Flag,
  Loader2,
  MessageSquare,
  Pause,
  Phone,
  Play,
  X,
} from "lucide-react";
import ElapsedTimer from "./elapsed-timer";

type DraftPhoto = {
  id: string;
  storageId: string;
  previewUrl: string;
  caption: string;
  status: "uploading" | "ready" | "error";
};

type TransientPhoto = {
  id: string;
  previewUrl: string;
  status: "uploading" | "error";
};

function shortBookingCode(id: string) {
  return `BKG-${id.slice(-4).toUpperCase()}`;
}

function makePhotoId() {
  return `photo_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

function formatClockTime(ms: number) {
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatPhone(phone: string | null | undefined) {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "").slice(-10);
  if (digits.length < 10) return phone;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function formatMoney(value: number | null | undefined) {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

const MAX_PHOTOS = 6;
const NOTES_DEBOUNCE_MS = 800;

export default function NowWorkingOverlay({
  open,
  bookingId,
  onClose,
  onMarkComplete,
  onToast,
}: {
  open: boolean;
  bookingId: Id<"bookings"> | null;
  onClose: () => void;
  onMarkComplete: (bookingId: Id<"bookings">) => void;
  onToast?: (message: string) => void;
}) {
  const job = useQuery(
    api.bookings.getJobDetail,
    open && bookingId ? { bookingId } : "skip",
  );
  const generateUploadUrl = useMutation(
    api.bookings.generatePostjobPhotoUploadUrl,
  );
  const saveDraft = useMutation(api.bookings.saveInProgressDraft);

  const [paused, setPaused] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const serverNotes = job?.jobActuals?.inProgressNotes ?? "";
  const serverPhotos = useMemo(
    () => (job?.jobActuals?.inProgressPhotos ?? []) as Array<{
      storageId: string;
      caption: string | null;
      takenAt: number;
      url: string | null;
    }>,
    [job?.jobActuals?.inProgressPhotos],
  );

  const [notes, setNotes] = useState(serverNotes);
  const [transientPhotos, setTransientPhotos] = useState<TransientPhoto[]>([]);

  const seededForBookingRef = useRef<string | null>(null);
  useEffect(() => {
    const id = bookingId ? String(bookingId) : null;
    if (id !== seededForBookingRef.current) {
      seededForBookingRef.current = id;
      setNotes(serverNotes);
      setTransientPhotos([]);
    }
  }, [bookingId, serverNotes]);

  const notesRef = useRef(notes);
  notesRef.current = notes;

  const flushNotes = async () => {
    if (!bookingId) return;
    try {
      await saveDraft({ bookingId, notes: notesRef.current });
    } catch (error) {
      onToast?.(
        error instanceof Error ? error.message : "Could not save notes",
      );
    }
  };

  useEffect(() => {
    if (!open || !bookingId) return;
    if (notes === serverNotes) return;
    const timeoutId = setTimeout(() => {
      void flushNotes();
    }, NOTES_DEBOUNCE_MS);
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, open, bookingId, serverNotes]);

  useEffect(() => {
    if (!open) return;
    return () => {
      // On close: flush any pending notes immediately.
      if (bookingId && notesRef.current !== serverNotes) {
        void flushNotes();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Combined display list: server photos first, then in-flight transient ones.
  const displayPhotos: DraftPhoto[] = useMemo(() => {
    const fromServer: DraftPhoto[] = serverPhotos
      .filter((p) => p.url !== null)
      .map((p) => ({
        id: p.storageId,
        storageId: p.storageId,
        previewUrl: p.url as string,
        caption: p.caption ?? "",
        status: "ready" as const,
      }));
    const transient: DraftPhoto[] = transientPhotos.map((p) => ({
      id: p.id,
      storageId: "",
      previewUrl: p.previewUrl,
      caption: "",
      status: p.status,
    }));
    return [...fromServer, ...transient];
  }, [serverPhotos, transientPhotos]);

  const totalPhotoCount = displayPhotos.length;
  const remainingPhotoSlots = Math.max(0, MAX_PHOTOS - totalPhotoCount);

  if (!open || typeof document === "undefined") return null;

  const startedAt = job?.jobActuals?.startedAt ?? null;
  const estimatedMinutes = job?.estimatedLaborMinutes ?? null;
  const etaMs =
    startedAt != null && estimatedMinutes != null
      ? startedAt + estimatedMinutes * 60_000
      : null;

  const phone = job?.customerPhone ?? null;
  const phoneDigits = phone?.replace(/\D/g, "") ?? "";

  async function handleFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    if (!bookingId) {
      onToast?.("Cannot upload photos yet — booking not loaded.");
      return;
    }

    const accepted = files.slice(0, remainingPhotoSlots);

    for (const file of accepted) {
      const tempId = makePhotoId();
      const previewUrl = URL.createObjectURL(file);
      setTransientPhotos((curr) => [
        ...curr,
        { id: tempId, previewUrl, status: "uploading" },
      ]);
      try {
        const uploadUrl = await generateUploadUrl({ bookingId });
        const result = await fetch(uploadUrl, {
          method: "POST",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
          },
          body: file,
        });
        if (!result.ok) throw new Error("Upload failed");
        const { storageId } = (await result.json()) as { storageId?: string };
        if (!storageId) throw new Error("Upload did not return an id");

        const nextPhotos = [
          ...serverPhotos.map((p) => ({
            storage_id: p.storageId as Id<"_storage">,
            caption: p.caption,
            taken_at: p.takenAt,
          })),
          {
            storage_id: storageId as Id<"_storage">,
            caption: null,
            taken_at: Date.now(),
          },
        ];
        await saveDraft({ bookingId, photos: nextPhotos });

        setTransientPhotos((curr) => {
          const removed = curr.find((p) => p.id === tempId);
          if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
          return curr.filter((p) => p.id !== tempId);
        });
      } catch (uploadError) {
        setTransientPhotos((curr) =>
          curr.map((p) =>
            p.id === tempId ? { ...p, status: "error" as const } : p,
          ),
        );
        onToast?.(
          uploadError instanceof Error
            ? uploadError.message
            : "Photo upload failed",
        );
      }
    }
  }

  async function removeServerPhoto(storageId: string) {
    if (!bookingId) return;
    try {
      const nextPhotos = serverPhotos
        .filter((p) => p.storageId !== storageId)
        .map((p) => ({
          storage_id: p.storageId as Id<"_storage">,
          caption: p.caption,
          taken_at: p.takenAt,
        }));
      await saveDraft({ bookingId, photos: nextPhotos });
    } catch (error) {
      onToast?.(
        error instanceof Error ? error.message : "Could not remove photo",
      );
    }
  }

  function dismissTransient(id: string) {
    setTransientPhotos((curr) => {
      const removed = curr.find((p) => p.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return curr.filter((p) => p.id !== id);
    });
  }

  return createPortal(
    <div className="fixed inset-0 z-[60] bg-slate-950/95 text-slate-50">
      <div className="mx-auto flex h-full max-w-[1200px] flex-col px-8 py-6">
        <header className="flex items-center justify-between border-b border-white/10 pb-5">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-400" />
            <p className="text-sm font-medium uppercase tracking-[0.2em] text-emerald-300/80">
              Now working
            </p>
            <p className="text-sm text-slate-400">
              {bookingId ? shortBookingCode(String(bookingId)) : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPaused((p) => !p)}
              className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3.5 py-2 text-sm font-medium text-slate-100 transition-colors hover:bg-white/10"
            >
              {paused ? (
                <>
                  <Play className="h-4 w-4" /> Resume
                </>
              ) : (
                <>
                  <Pause className="h-4 w-4" /> Pause
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Collapse"
              className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm font-medium text-slate-100 transition-colors hover:bg-white/10"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        {job === undefined ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
          </div>
        ) : job === null ? (
          <div className="flex flex-1 items-center justify-center text-slate-400">
            We couldn&apos;t load that booking.
          </div>
        ) : (
          <>
            <section className="flex flex-col items-start gap-2 border-b border-white/10 py-8">
              <p className="text-sm text-slate-400">Elapsed</p>
              <ElapsedTimer
                startedAtMs={startedAt}
                paused={paused}
                className="font-mono text-6xl font-semibold tracking-tight text-white tabular-nums"
              />
              <p className="text-sm text-slate-400">
                {startedAt != null
                  ? `Started ${formatClockTime(startedAt)}`
                  : "Not started yet"}
                {etaMs != null ? ` · ETA ${formatClockTime(etaMs)}` : ""}
                {paused ? " · Paused" : ""}
              </p>
              <p className="mt-2 text-lg font-medium text-slate-100">
                {job.vehicle}
              </p>
              <p className="text-sm text-slate-400">
                {job.serviceNames.join(" · ")}
              </p>
            </section>

            <div className="grid gap-6 overflow-y-auto py-6 md:grid-cols-2">
              <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Customer
                </h3>
                <p className="mt-2 text-lg font-medium text-slate-100">
                  {job.customerName}
                </p>
                {phone ? (
                  <p className="mt-1 text-sm text-slate-400">
                    {formatPhone(phone)}
                  </p>
                ) : null}
                {phone ? (
                  <div className="mt-4 flex gap-2">
                    <a
                      href={`tel:${phoneDigits}`}
                      className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3.5 py-2 text-sm font-medium text-slate-100 transition-colors hover:bg-white/10"
                    >
                      <Phone className="h-4 w-4" /> Call
                    </a>
                    <a
                      href={`sms:${phoneDigits}`}
                      className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3.5 py-2 text-sm font-medium text-slate-100 transition-colors hover:bg-white/10"
                    >
                      <MessageSquare className="h-4 w-4" /> Text
                    </a>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-slate-500">
                    No phone on file.
                  </p>
                )}

                {job.customerNotes ? (
                  <div className="mt-5 rounded-xl border border-white/10 bg-slate-900/40 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Note from customer
                    </p>
                    <p className="mt-1 text-sm text-slate-200">
                      {job.customerNotes}
                    </p>
                  </div>
                ) : null}
              </section>

              <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Work order
                </h3>
                <ul className="mt-3 space-y-2">
                  {job.serviceNames.length === 0 ? (
                    <li className="text-sm text-slate-500">No services listed.</li>
                  ) : (
                    job.serviceNames.map((name: string, index: number) => (
                      <li
                        key={`${name}-${index}`}
                        className="flex items-start gap-2 text-sm text-slate-100"
                      >
                        <span className="mt-1 inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                        <span>{name}</span>
                      </li>
                    ))
                  )}
                </ul>
                <div className="mt-5 flex items-center justify-between border-t border-white/10 pt-4">
                  <p className="text-xs uppercase tracking-wider text-slate-400">
                    Estimated total
                  </p>
                  <p className="text-lg font-semibold text-slate-100">
                    {formatMoney(job.totalCost)}
                  </p>
                </div>
                {estimatedMinutes != null ? (
                  <p className="mt-1 text-right text-xs text-slate-500">
                    Est. {estimatedMinutes} min labor
                  </p>
                ) : null}
              </section>

              <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 md:col-span-2">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Working notes
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    Saved automatically · carried into post-job report
                  </p>
                </div>
                <textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Jot down what you find as you work — torque values, surprises, what you replaced..."
                  rows={3}
                  className="mt-3 w-full rounded-xl border border-white/10 bg-slate-900/40 p-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-400/50 focus:outline-none"
                />

                <div className="mt-5 flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Photos ({totalPhotoCount}/{MAX_PHOTOS})
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    capture="environment"
                    onChange={handleFilesSelected}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={remainingPhotoSlots === 0}
                    className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-100 transition-colors hover:bg-white/10 disabled:opacity-50"
                  >
                    <Camera className="h-3.5 w-3.5" />
                    Add photo
                  </button>
                </div>
                {displayPhotos.length === 0 ? (
                  <p className="mt-3 text-xs text-slate-500">
                    No photos yet — snap a few as evidence of the work.
                  </p>
                ) : (
                  <div className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
                    {displayPhotos.map((photo) => (
                      <div
                        key={photo.id}
                        className="relative overflow-hidden rounded-xl border border-white/10 bg-black/40"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={photo.previewUrl}
                          alt=""
                          className="aspect-square w-full object-cover"
                        />
                        {photo.status === "uploading" ? (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                            <Loader2 className="h-5 w-5 animate-spin text-white" />
                          </div>
                        ) : null}
                        {photo.status === "error" ? (
                          <div className="absolute inset-0 flex items-center justify-center bg-red-700/70 text-[10px] font-medium text-white">
                            Failed
                          </div>
                        ) : null}
                        <button
                          type="button"
                          onClick={() =>
                            photo.status === "ready"
                              ? void removeServerPhoto(photo.storageId)
                              : dismissTransient(photo.id)
                          }
                          aria-label="Remove photo"
                          className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white opacity-90 transition-opacity hover:opacity-100"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 py-5">
              <button
                type="button"
                onClick={() => onToast?.("Flag issue — coming soon")}
                className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3.5 py-2 text-sm font-medium text-slate-100 transition-colors hover:bg-white/10"
              >
                <Flag className="h-4 w-4" /> Flag issue
              </button>
              <button
                type="button"
                onClick={() => bookingId && onMarkComplete(bookingId)}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-emerald-950 transition-colors hover:bg-emerald-400"
              >
                <CheckCircle2 className="h-4 w-4" /> Mark complete
              </button>
            </footer>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
