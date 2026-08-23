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
  ChevronLeft,
  ChevronRight,
  Flag,
  Loader2,
  MessageSquare,
  Pause,
  Phone,
  Play,
  Plus,
  X,
} from "lucide-react";
import ElapsedTimer from "./elapsed-timer";
import FlagIssueSheet from "./flag-issue-sheet";
import MidJobScopeDialog from "@/components/booking/mid-job-scope-dialog";
import OverrunExtendCard from "./overrun-extend-card";
import ExtraWorkStatus from "@/components/booking/extra-work-status";

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

const normServiceName = (s: string) => s.trim().toLowerCase();

type ServiceStatus = "confirmed" | "pending" | "declined" | "draft";

const MAX_PHOTOS = 6;
const NOTES_DEBOUNCE_MS = 800;

export function NowWorkingPane({
  bookingId,
  onBack,
  onClose,
  onMarkComplete,
  onToast,
  dense = false,
}: {
  bookingId: Id<"bookings">;
  /** When present, renders a "‹ All jobs" control that returns to the picker. */
  onBack?: () => void;
  onClose: () => void;
  onMarkComplete: (bookingId: Id<"bookings">) => void;
  onToast?: (message: string) => void;
  dense?: boolean;
}) {
  const job = useQuery(api.bookings.getJobDetail, { bookingId });
  const generateUploadUrl = useMutation(
    api.bookings.generatePostjobPhotoUploadUrl,
  );
  const saveDraft = useMutation(api.bookings.saveInProgressDraft);

  const [paused, setPaused] = useState(false);
  const [flagOpen, setFlagOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [addingFinding, setAddingFinding] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /* Open blockers on this job (Flag Issue spec, §5). Rendered as a banner so a
     stalled job is visibly stalled rather than looking like it's being worked. */
  const blockers = useQuery(api.jobBlockers.listForBooking, { bookingId });
  const resolveBlocker = useMutation(api.jobBlockers.resolveBlocker);
  /* Server-derived: covers clock-stopping blockers AND a mid-job re-quote the
     customer hasn't answered. Don't recompute this from `blockers[]` here —
     that predicate missed the re-quote case and drifted between surfaces. */
  const clockPaused = Boolean(blockers?.clockPaused);
  const blockedMs = (blockers?.blockedMinutes ?? 0) * 60_000;

  /* Inspection findings nothing has acted on yet — see the "Flagged, not
     addressed" block below. The query owns the four exclusion paths. */
  const unaddressedFindings = useQuery(
    api.inspections.getUnaddressedFindingsForBooking,
    { bookingId },
  );
  const addToJob = useMutation(api.customJobs.addMidJobCustomService);

  /* Mid-job extra-work state — drives the per-service status dots in the work
     order. Same query the EXTRA WORK card (top-right) uses; Convex shares the
     subscription so this isn't a second network read. */
  const scopeChanges = useQuery(api.booking_approvals.getMidJobScopeChanges, {
    bookingId,
  }) as
    | Array<{
        state: "pending" | "accepted" | "auto_confirmed" | "declined";
        addedServiceNames: string[];
      }>
    | undefined;

  // Off-catalog lines on this booking (drafts + agreed extras). A line the
  // mechanic just added but hasn't sent for confirmation has no scope change
  // yet — that's a draft, and it should read gray in the work order, not the
  // green of agreed work.
  const customJobsList = useQuery(api.customJobs.listForBooking, {
    bookingId,
  }) as Array<{ name: string }> | undefined;

  const serviceStatusList = useMemo(() => {
    const changes = scopeChanges ?? [];
    const pending = new Set<string>();
    // Every name carried by a *submitted* scope change, whatever its state.
    // A custom line absent from this set was never sent to the customer.
    const submitted = new Set<string>();
    for (const c of changes) {
      for (const n of c.addedServiceNames ?? []) submitted.add(normServiceName(n));
      if (c.state !== "pending") continue;
      for (const n of c.addedServiceNames ?? []) pending.add(normServiceName(n));
    }
    // Draft = an off-catalog line the mechanic added mid-job that hasn't been
    // submitted for approval yet.
    const draft = new Set<string>();
    for (const cj of customJobsList ?? []) {
      const n = normServiceName(cj.name);
      if (!submitted.has(n)) draft.add(n);
    }
    const baseNames: string[] = job?.serviceNames ?? [];
    const list: Array<{ name: string; status: ServiceStatus }> = baseNames.map(
      (name) => {
        const n = normServiceName(name);
        const status: ServiceStatus = pending.has(n)
          ? "pending"
          : draft.has(n)
            ? "draft"
            : "confirmed";
        return { name, status };
      },
    );
    // Declined lines are stripped from the booking's services, so re-add them
    // as red/struck entries — the work order should still show what was turned
    // down, not silently drop it.
    for (const c of changes) {
      if (c.state !== "declined") continue;
      for (const n of c.addedServiceNames ?? []) {
        if (!list.some((x) => normServiceName(x.name) === normServiceName(n))) {
          list.push({ name: n, status: "declined" });
        }
      }
    }
    return list;
  }, [scopeChanges, customJobsList, job?.serviceNames]);

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

  const [notes, setNotes] = useState<string>(serverNotes);
  const [transientPhotos, setTransientPhotos] = useState<TransientPhoto[]>([]);

  const seededForBookingRef = useRef<string | null>(null);
  useEffect(() => {
    const id = String(bookingId);
    if (id !== seededForBookingRef.current) {
      seededForBookingRef.current = id;
      setNotes(serverNotes);
      setTransientPhotos([]);
    }
  }, [bookingId, serverNotes]);

  const notesRef = useRef(notes);
  notesRef.current = notes;

  /* Notes are kept as one newline-joined string on the server (unchanged
     contract — the post-job report reads it verbatim), but entered one at a
     time: write a note, add it, write the next. Each non-empty line is one
     entry, so the list survives a reload and any legacy free-text note just
     shows up as its existing lines. */
  const [draftNote, setDraftNote] = useState("");
  const noteEntries = useMemo(
    () =>
      notes
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    [notes],
  );

  function addNote() {
    const text = draftNote.trim();
    if (!text) return;
    setNotes((prev) => {
      const base = prev.trim();
      return base ? `${base}\n${text}` : text;
    });
    setDraftNote("");
  }

  function removeNoteAt(index: number) {
    setNotes((prev) =>
      prev
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((_, i) => i !== index)
        .join("\n"),
    );
  }

  const flushNotes = async () => {
    try {
      await saveDraft({ bookingId, notes: notesRef.current });
    } catch (error) {
      onToast?.(
        error instanceof Error ? error.message : "Could not save notes",
      );
    }
  };

  useEffect(() => {
    if (notes === serverNotes) return;
    const timeoutId = setTimeout(() => {
      void flushNotes();
    }, NOTES_DEBOUNCE_MS);
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, bookingId, serverNotes]);

  useEffect(() => {
    return () => {
      // On unmount: flush any pending notes immediately.
      if (notesRef.current !== serverNotes) {
        void flushNotes();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const containerClass = dense
    ? "mx-auto flex h-full max-w-none flex-col px-5 py-4"
    : "mx-auto flex h-full max-w-[1200px] flex-col px-8 py-6";
  const elapsedTimerClass = dense
    ? "font-mono text-5xl font-semibold tracking-tight text-white tabular-nums"
    : "font-mono text-6xl font-semibold tracking-tight text-white tabular-nums";
  const summarySectionClass = dense
    ? "flex flex-col items-start gap-4 border-b border-white/10 py-5"
    : "flex items-start justify-between gap-6 border-b border-white/10 py-8";

  return (
    <div className={containerClass}>
      <header className="flex items-center justify-between border-b border-white/10 pb-5">
        <div className="flex min-w-0 items-center gap-3">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 py-2 pl-2 pr-3 text-sm font-medium text-slate-100 transition-colors hover:bg-white/10"
            >
              <ChevronLeft className="h-4 w-4" /> All jobs
            </button>
          ) : null}
          <span className="inline-flex h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-400" />
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-emerald-300/80">
            Now working
          </p>
          <span className="rounded-md border border-white/15 bg-white/5 px-2 py-0.5 text-xs font-mono text-slate-300">
            {shortBookingCode(String(bookingId))}
          </span>
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
            aria-label="Close pane"
            className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm font-medium text-slate-100 transition-colors hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* An open blocker has to be visible on the job itself, or the pane keeps
          saying "Now working" about a car nobody is touching. Resolving it here
          is what closes the clock span (Flag Issue spec, §5). */}
      {blockers && blockers.openCount > 0 ? (
        <div className="mt-4 space-y-2">
          {blockers.blockers
            .filter((b) => b.resolved_at == null)
            .map((b) => (
              <div
                key={String(b._id)}
                className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-amber-200">
                    {b.label}
                    {b.stops_clock ? (
                      <span className="ml-2 rounded bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-100">
                        clock paused
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-amber-100/80">
                    {b.note}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await resolveBlocker({ blockerId: b._id });
                      onToast?.("Unblocked — clock running again");
                    } catch (err: unknown) {
                      onToast?.(
                        err instanceof Error ? err.message : "Could not resolve",
                      );
                    }
                  }}
                  className="shrink-0 rounded-lg border border-amber-300/40 bg-amber-300/10 px-3 py-1.5 text-[13px] font-semibold text-amber-100 transition-colors hover:bg-amber-300/20"
                >
                  Unblocked
                </button>
              </div>
            ))}
        </div>
      ) : null}

      {/* Findings the inspection flagged that nothing has acted on yet. Without
          this, a mechanic who notices the wipers mid-job has to retype the
          finding they already recorded — through Flag Issue → Extra work — to
          get it onto the bill (Aug 20 session, decision D1). Tapping one seeds
          the same scope dialog that button opens, so the customer still
          confirms before any of it becomes billable. */}
      {unaddressedFindings && unaddressedFindings.length > 0 ? (
        <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Flagged, not addressed
          </p>
          <div className="mt-2 space-y-2">
            {unaddressedFindings.map((f) => (
              <div
                key={f.key}
                className="flex flex-wrap items-start justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-slate-100">
                    {f.serviceName ?? f.label}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {f.reasons.join(" · ")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    setAddingFinding(f.key);
                    try {
                      await addToJob({
                        bookingId,
                        name: f.serviceName ?? f.label,
                        complaint: f.reasons.join("; ") || undefined,
                      });
                      setScopeOpen(true);
                    } catch (err: unknown) {
                      onToast?.(
                        err instanceof Error
                          ? err.message
                          : "Could not add that to the job",
                      );
                    } finally {
                      setAddingFinding(null);
                    }
                  }}
                  disabled={addingFinding !== null}
                  className="shrink-0 rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-1.5 text-[12px] font-semibold text-emerald-200 transition-colors hover:bg-emerald-400/20 disabled:opacity-50"
                >
                  {addingFinding === f.key ? "Adding…" : "Add to this job"}
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

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
          <section className={summarySectionClass}>
            <div className="flex min-w-0 flex-col items-start gap-2">
              <p className="text-sm text-slate-400">Elapsed</p>
              <ElapsedTimer
                startedAtMs={startedAt}
                // Stopped time is excluded by blockedMs, not by `paused` —
                // `paused` only freezes the tick. This is the worked-minutes
                // figure the server records, so the two can't contradict.
                paused={paused || clockPaused}
                blockedMs={blockedMs}
                className={elapsedTimerClass}
              />
              <p className="text-sm text-slate-400">
                {startedAt != null
                  ? `Started ${formatClockTime(startedAt)}`
                  : "Not started yet"}
                {etaMs != null ? ` · ETA ${formatClockTime(etaMs)}` : ""}
                {clockPaused
                  ? " · Paused (blocked)"
                  : paused
                    ? " · Paused"
                    : ""}
              </p>
              <p className="mt-2 text-lg font-medium text-slate-100">
                {job.vehicle}
              </p>
              <p className="text-sm text-slate-400">
                {job.serviceNames.join(" · ")}
              </p>
            </div>

            {/* Extra work sits across from the timer — full detail lives here:
                waiting / approved / declined, the price delta, the SLA, and any
                denied parts. Empty state keeps the space intentional. */}
            <div className={dense ? "w-full" : "w-[360px] shrink-0"}>
              <ExtraWorkStatus
                bookingId={bookingId}
                variant="dark"
                showWhenEmpty
              />
            </div>
          </section>

          {job.status === "in_progress" && (
            <div className="pt-4">
              <OverrunExtendCard
                bookingId={bookingId}
                onFinishEarly={() => onMarkComplete(bookingId)}
                onToast={onToast}
                variant="dark"
              />
            </div>
          )}

          <div
            className={
              dense
                ? "grid gap-4 overflow-y-auto py-4"
                : "grid gap-6 overflow-y-auto py-6 md:grid-cols-2"
            }
          >
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
                {serviceStatusList.length === 0 ? (
                  <li className="text-sm text-slate-500">No services listed.</li>
                ) : (
                  serviceStatusList.map((svc, index) => {
                    // Dot mirrors the service's approval state: green when it's
                    // agreed (base booking or approved extra), yellow while the
                    // customer hasn't confirmed submitted work, gray for a draft
                    // the mechanic hasn't sent yet, red when declined.
                    const dotClass =
                      svc.status === "pending"
                        ? "bg-amber-400"
                        : svc.status === "declined"
                          ? "bg-red-400"
                          : svc.status === "draft"
                            ? "bg-slate-500"
                            : "bg-emerald-400";
                    return (
                      <li
                        key={`${svc.name}-${index}`}
                        className="flex items-start gap-2 text-sm text-slate-100"
                      >
                        <span
                          className={`mt-1.5 inline-flex h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`}
                          title={
                            svc.status === "pending"
                              ? "Awaiting customer confirmation"
                              : svc.status === "declined"
                                ? "Declined by customer"
                                : svc.status === "draft"
                                  ? "Draft — not submitted yet"
                                  : "Confirmed"
                          }
                        />
                        <span
                          className={
                            svc.status === "declined"
                              ? "text-slate-500 line-through"
                              : svc.status === "draft"
                                ? "text-slate-400"
                                : ""
                          }
                        >
                          {svc.name}
                        </span>
                        {svc.status === "pending" ? (
                          <span className="ml-1 rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-amber-200">
                            Pending
                          </span>
                        ) : svc.status === "declined" ? (
                          <span className="ml-1 rounded bg-red-400/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-red-200">
                            Declined
                          </span>
                        ) : svc.status === "draft" ? (
                          <span className="ml-1 rounded bg-slate-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-300">
                            Draft
                          </span>
                        ) : null}
                      </li>
                    );
                  })
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

            <section
              className={
                dense
                  ? "rounded-2xl border border-white/10 bg-white/[0.03] p-5"
                  : "rounded-2xl border border-white/10 bg-white/[0.03] p-5 md:col-span-2"
              }
            >
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Working notes
                </h3>
                <p className="text-[11px] text-slate-500">
                  Saved automatically · carried into post-job report
                </p>
              </div>

              {noteEntries.length > 0 ? (
                <ul className="mt-3 space-y-2">
                  {noteEntries.map((entry, index) => (
                    <li
                      key={`${index}-${entry}`}
                      className="flex items-start gap-2 rounded-xl border border-white/10 bg-slate-900/40 px-3 py-2.5"
                    >
                      <span className="mt-1.5 inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400/70" />
                      <span className="flex-1 whitespace-pre-wrap break-words text-sm text-slate-100">
                        {entry}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeNoteAt(index)}
                        aria-label="Delete note"
                        className="shrink-0 rounded-md p-1 text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              <div className="mt-3">
                <textarea
                  value={draftNote}
                  onChange={(event) => setDraftNote(event.target.value)}
                  onKeyDown={(event) => {
                    // Enter files the note; Shift+Enter keeps a line break for
                    // the occasional longer one.
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      addNote();
                    }
                  }}
                  placeholder={
                    noteEntries.length > 0
                      ? "Add another note…"
                      : "Jot down what you find as you work — torque values, surprises, what you replaced…"
                  }
                  rows={2}
                  className="w-full rounded-xl border border-white/10 bg-slate-900/40 p-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-400/50 focus:outline-none"
                />
                <div className="mt-2 flex items-center justify-between gap-3">
                  <p className="text-[11px] text-slate-500">
                    Enter to add · Shift+Enter for a line break
                  </p>
                  <button
                    type="button"
                    onClick={addNote}
                    disabled={draftNote.trim().length === 0}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-100 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add note
                  </button>
                </div>
              </div>

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
                <div
                  className={
                    dense
                      ? "mt-3 grid grid-cols-3 gap-3 sm:grid-cols-4"
                      : "mt-3 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6"
                  }
                >
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
              onClick={() => setFlagOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3.5 py-2 text-sm font-medium text-slate-100 transition-colors hover:bg-white/10"
            >
              <Flag className="h-4 w-4" /> Flag issue
            </button>
            <button
              type="button"
              onClick={() => onMarkComplete(bookingId)}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-emerald-950 transition-colors hover:bg-emerald-400"
            >
              <CheckCircle2 className="h-4 w-4" /> Mark complete
            </button>
          </footer>
        </>
      )}

      {flagOpen ? (
        <FlagIssueSheet
          bookingId={bookingId}
          onClose={() => setFlagOpen(false)}
          onAddScope={() => setScopeOpen(true)}
          onToast={onToast}
        />
      ) : null}

      {/* The same dialog the booking detail panel opens for "Add unforeseen
          scope" — one component owns the quote seeding, so the two entry points
          can't drift (MidJobScopeDialog). */}
      <MidJobScopeDialog
        open={scopeOpen}
        bookingId={bookingId}
        onClose={() => setScopeOpen(false)}
        onSubmitted={(msg) => {
          setScopeOpen(false);
          onToast?.(msg);
        }}
      />
    </div>
  );
}

/** One active-in-the-bay job, as the picker needs to render it. */
export type ActiveJobRow = {
  bookingId: Id<"bookings">;
  mechanicName: string;
  vehicle: string;
  serviceSummary: string;
  startedAt: number | null;
  /** YYYY-MM-DD the job was scheduled for; anything but today reads as overrun. */
  scheduledDate: string | null;
  /** Minutes the work clock was stopped — excluded from the row's timer. */
  blockedMinutes?: number;
  /** Whether the clock is stopped right now (blocker or unanswered re-quote). */
  clockPaused?: boolean;
};

function localTodayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * The picker a busy front desk lands on: every car in the bay, one tap to focus.
 * Timers keep ticking for all of them — you're choosing which one to drive, not
 * pausing the rest.
 */
function ActiveJobsList({
  jobs,
  onSelect,
  onClose,
}: {
  jobs: ActiveJobRow[];
  onSelect: (bookingId: Id<"bookings">) => void;
  onClose: () => void;
}) {
  const today = localTodayString();

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-6 py-6">
      <header className="flex items-center justify-between border-b border-white/10 pb-5">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-400" />
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-emerald-300/80">
            Active jobs
          </p>
          <span className="rounded-md border border-white/15 bg-white/5 px-2 py-0.5 text-xs font-mono text-slate-300">
            {jobs.length} in the bay
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="inline-flex items-center rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm font-medium text-slate-100 transition-colors hover:bg-white/10"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <p className="mt-4 text-sm text-slate-400">
        Pick a car to focus on — the clock keeps running for every job in the bay.
      </p>

      <div className="mt-4 flex-1 space-y-3 overflow-y-auto pb-6">
        {jobs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-slate-400">
            Nothing in the bay right now.
          </div>
        ) : (
          jobs.map((job) => {
            const overrun =
              !!job.scheduledDate && job.scheduledDate !== today;
            return (
              <button
                key={String(job.bookingId)}
                type="button"
                onClick={() => onSelect(job.bookingId)}
                className="flex w-full items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4 text-left transition-colors hover:border-emerald-400/40 hover:bg-white/[0.06]"
              >
                <span className="inline-flex h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-emerald-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-semibold text-slate-100">
                    {[job.mechanicName, job.vehicle].filter(Boolean).join(" · ")}
                  </p>
                  <p className="mt-0.5 truncate text-sm text-slate-400">
                    {job.serviceSummary || "No services listed"}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <ElapsedTimer
                    startedAtMs={job.startedAt}
                    paused={job.clockPaused}
                    blockedMs={(job.blockedMinutes ?? 0) * 60_000}
                    className="font-mono text-lg font-semibold tabular-nums text-emerald-300"
                  />
                  {overrun ? (
                    <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200">
                      from {job.scheduledDate}
                    </span>
                  ) : job.clockPaused ? (
                    <span className="text-[11px] text-amber-300">paused</span>
                  ) : (
                    <span className="text-[11px] text-slate-500">in progress</span>
                  )}
                </div>
                <ChevronRight className="h-5 w-5 shrink-0 text-slate-500" />
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

export default function NowWorkingOverlay({
  open,
  jobs,
  onClose,
  onMarkComplete,
  onToast,
}: {
  open: boolean;
  jobs: ActiveJobRow[];
  onClose: () => void;
  onMarkComplete: (bookingId: Id<"bookings">) => void;
  onToast?: (message: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<Id<"bookings"> | null>(null);
  const multiple = jobs.length > 1;

  // On open, land straight in the focus view when there's a single car in the
  // bay; otherwise show the picker. On close, forget the selection so the next
  // open re-decides.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      wasOpenRef.current = true;
      setSelectedId(jobs.length === 1 ? jobs[0].bookingId : null);
    } else if (!open && wasOpenRef.current) {
      wasOpenRef.current = false;
      setSelectedId(null);
    }
  }, [open, jobs]);

  // If the focused job leaves the bay (completed elsewhere, reassigned), drop
  // back to the picker instead of rendering a pane for a stale booking.
  useEffect(() => {
    if (
      selectedId &&
      !jobs.some((job) => String(job.bookingId) === String(selectedId))
    ) {
      setSelectedId(null);
    }
  }, [jobs, selectedId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Let a focused input/textarea keep its own Escape (clearing a field).
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      // Step back one level: focus → picker → closed.
      if (selectedId && multiple) {
        setSelectedId(null);
      } else {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, selectedId, multiple, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] bg-slate-950/95 text-slate-50">
      {selectedId ? (
        <div className="h-full w-full overflow-hidden">
          <NowWorkingPane
            bookingId={selectedId}
            onBack={multiple ? () => setSelectedId(null) : undefined}
            onClose={onClose}
            onMarkComplete={onMarkComplete}
            onToast={onToast}
          />
        </div>
      ) : (
        <ActiveJobsList
          jobs={jobs}
          onSelect={(id) => setSelectedId(id)}
          onClose={onClose}
        />
      )}
    </div>,
    document.body,
  );
}
