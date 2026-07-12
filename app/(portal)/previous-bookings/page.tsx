"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Briefcase, Disc3, Circle, Loader2 } from "lucide-react";
import { usePortalSidebar } from "../portal-context";
import BookingDetailPanel from "@/components/booking-detail-panel";
import type { JobDetailPanelHandle } from "@/components/booking-detail-panel";
import RescheduleConfirmationDialog, {
  type RescheduleConfirmationProposal,
} from "@/components/reschedule-confirmation-dialog";
import { StatusPill } from "@/components/status-pill";
import { formatJobDate } from "../bookings/booking-list-shared";

type Segment = "bookings" | "quotes";

type QuoteOutcome = "open" | "pending" | "won" | "lost" | "closed";

const OUTCOME_STYLES: Record<QuoteOutcome, { label: string; className: string }> = {
  open: { label: "Open", className: "bg-blue-50 text-blue-700" },
  pending: { label: "Bid sent", className: "bg-amber-50 text-amber-700" },
  won: { label: "Won", className: "bg-emerald-50 text-emerald-700" },
  lost: { label: "Lost", className: "bg-gray-100 text-gray-500" },
  closed: { label: "Closed", className: "bg-gray-100 text-gray-500" },
};

function formatDateMs(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function PreviousBookingsPage() {
  const [segment, setSegment] = useState<Segment>("bookings");
  const [selectedJobId, setSelectedJobId] = useState<Id<"bookings"> | null>(null);
  const [successMessage, setSuccessMessage] = useState("");
  const [rescheduleProposal, setRescheduleProposal] =
    useState<RescheduleConfirmationProposal | null>(null);
  const [rescheduleError, setRescheduleError] = useState("");
  const [isRescheduling, setIsRescheduling] = useState(false);
  const jobDetailRef = useRef<JobDetailPanelHandle>(null);

  const context = useQuery(api.bookings.getMyShopJobContext);
  const shopId = context?.shopId as Id<"shops"> | undefined;

  const archive = useQuery(api.bookings.listBookingArchive, {});
  const quoteJobs = useQuery(
    api.bookings.listQuoteJobsForShop,
    shopId ? { shopId } : "skip",
  );

  const selectedJob = useQuery(
    api.bookings.getJobDetail,
    selectedJobId ? { bookingId: selectedJobId } : "skip",
  );
  const hasScheduledDate = !!selectedJob?.scheduledDate;
  const selectedJobDayBookings = useQuery(
    api.schedule.getBookingsForRange,
    selectedJob && hasScheduledDate
      ? { dateFrom: selectedJob.scheduledDate, dateTo: selectedJob.scheduledDate }
      : "skip",
  );
  const selectedJobDayBlockedSlots = useQuery(
    api.schedule.getBlockedSlots,
    selectedJob && hasScheduledDate
      ? { dateFrom: selectedJob.scheduledDate, dateTo: selectedJob.scheduledDate }
      : "skip",
  );
  const proposeReschedule = useMutation(api.bookings.proposeReschedule);

  const mechanics = useMemo(() => context?.mechanics ?? [], [context?.mechanics]);

  // Newest-first ordering for the booking archive.
  const bookings = useMemo(() => {
    if (!archive) return undefined;
    const sortKey = (j: (typeof archive.jobs)[number]) =>
      j.scheduledDate ? `${j.scheduledDate}T${j.scheduledTime || "00:00"}` : "";
    return [...archive.jobs].sort((a, b) => {
      const ka = sortKey(a);
      const kb = sortKey(b);
      if (ka && kb && ka !== kb) return kb.localeCompare(ka);
      return b._creationTime - a._creationTime;
    });
  }, [archive]);

  const drawerOpen = !!selectedJobId;
  const { setSidebarCompact } = usePortalSidebar();

  useEffect(() => {
    setSidebarCompact(drawerOpen);
    return () => setSidebarCompact(false);
  }, [drawerOpen, setSidebarCompact]);

  useEffect(() => {
    if (!successMessage) return;
    const timeout = setTimeout(() => setSuccessMessage(""), 3000);
    return () => clearTimeout(timeout);
  }, [successMessage]);

  const handleProposeReschedule = useCallback(
    (proposal: RescheduleConfirmationProposal) => {
      setRescheduleProposal(proposal);
      setRescheduleError("");
    },
    [],
  );

  async function handleConfirmReschedule() {
    if (!rescheduleProposal) return;
    setIsRescheduling(true);
    setRescheduleError("");
    try {
      await proposeReschedule({
        bookingId: rescheduleProposal.eventId as Id<"bookings">,
        newScheduledDate: rescheduleProposal.newDate,
        newScheduledTime: rescheduleProposal.newTime,
        newMechanicId: rescheduleProposal.newMechanicId
          ? (rescheduleProposal.newMechanicId as Id<"mechanics">)
          : undefined,
      });
      setRescheduleProposal(null);
      setSuccessMessage("Reschedule proposed — awaiting customer approval");
    } catch (error: unknown) {
      setRescheduleError(
        error instanceof Error ? error.message : "Could not propose reschedule.",
      );
    } finally {
      setIsRescheduling(false);
    }
  }

  if (context === undefined) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
        <Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin text-blue-600" />
        Loading previous bookings…
      </div>
    );
  }

  if (!context) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
        This page is only available to shop accounts.
      </div>
    );
  }

  const bookingsCount = bookings?.length;
  const quotesCount = quoteJobs?.length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Previous Bookings</h1>
        <p className="text-sm text-muted-foreground">
          {archive?.isMechanicScope
            ? "Every booking assigned to you, plus the shop's quote jobs."
            : `Every booking and quote job at ${context.shopName}.`}
        </p>
      </div>

      {/* Segment toggle */}
      <div className="border-b border-border">
        <div className="flex gap-1">
          <TabButton
            label="Bookings"
            icon={<Briefcase className="h-4 w-4" strokeWidth={2} />}
            active={segment === "bookings"}
            count={bookingsCount}
            onClick={() => setSegment("bookings")}
          />
          <TabButton
            label="Quote Jobs"
            icon={<Disc3 className="h-4 w-4" strokeWidth={2} />}
            active={segment === "quotes"}
            count={quotesCount}
            onClick={() => setSegment("quotes")}
          />
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card">
        <div className="flex items-start">
          <div className="min-w-0 flex-1 overflow-x-auto">
            {segment === "bookings" ? (
              <BookingsTable
                bookings={bookings}
                selectedJobId={selectedJobId}
                onSelect={(id) =>
                  setSelectedJobId((prev) => (prev === id ? null : id))
                }
              />
            ) : (
              <QuoteJobsTable
                quoteJobs={quoteJobs}
                selectedJobId={selectedJobId}
                onSelect={(id) =>
                  setSelectedJobId((prev) => (prev === id ? null : id))
                }
              />
            )}
          </div>

          <div
            className={`flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-out ${
              drawerOpen ? "w-[552px]" : "w-0"
            }`}
          >
            <div
              className={`fixed right-6 top-20 z-20 flex h-[calc(100vh-6.5rem)] max-h-[calc(100vh-6.5rem)] w-[528px] flex-col overflow-hidden rounded-xl border border-border bg-card transition-all duration-200 ease-out ${
                drawerOpen
                  ? "translate-x-0 opacity-100"
                  : "pointer-events-none translate-x-6 opacity-0"
              }`}
            >
              <BookingDetailPanel
                ref={jobDetailRef}
                job={selectedJob}
                mechanics={mechanics}
                scheduleConflicts={{
                  bookings: selectedJobDayBookings ?? [],
                  blockedSlots: selectedJobDayBlockedSlots ?? [],
                }}
                onRequestRescheduleConfirmation={handleProposeReschedule}
                onClose={() => setSelectedJobId(null)}
                onSuccess={setSuccessMessage}
                hideDisclosedRange
              />
            </div>
          </div>
        </div>
      </div>

      <RescheduleConfirmationDialog
        proposal={rescheduleProposal}
        error={rescheduleError}
        isSubmitting={isRescheduling}
        onCancel={() => setRescheduleProposal(null)}
        onConfirm={() => void handleConfirmReschedule()}
        reserveOriginalSlotMessage="The original time will be reserved until the customer responds. If they don't respond within 24 hours, the original booking slot will be restored automatically."
      />

      {successMessage && !rescheduleProposal ? (
        <div className="fixed bottom-6 right-6 z-[70] rounded-lg border border-border bg-card px-4 py-3 text-sm text-foreground shadow-lg">
          {successMessage}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Bookings table                                                      */
/* ------------------------------------------------------------------ */

function BookingsTable({
  bookings,
  selectedJobId,
  onSelect,
}: {
  bookings:
    | {
        _id: Id<"bookings">;
        _creationTime: number;
        status: string;
        scheduledDate?: string;
        scheduledTime?: string;
        customerName: string;
        vehicle: string;
        serviceNames: string[];
        totalCost?: number;
      }[]
    | undefined;
  selectedJobId: Id<"bookings"> | null;
  onSelect: (id: Id<"bookings">) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
          <th className="pl-5 pr-3 py-3">Customer</th>
          <th className="px-3 py-3">Vehicle</th>
          <th className="px-3 py-3">Service</th>
          <th className="px-3 py-3">Status</th>
          <th className="px-3 py-3">When</th>
          <th className="px-3 py-3 text-right pr-5">Total</th>
        </tr>
      </thead>
      <tbody>
        {bookings === undefined ? (
          <tr>
            <td colSpan={6} className="px-5 py-12 text-center text-muted-foreground">
              Loading…
            </td>
          </tr>
        ) : bookings.length === 0 ? (
          <tr>
            <td colSpan={6} className="px-5 py-14">
              <div className="flex flex-col items-center gap-2">
                <Briefcase className="h-9 w-9 text-muted-foreground opacity-40" />
                <p className="text-sm font-medium text-muted-foreground">
                  No bookings yet
                </p>
              </div>
            </td>
          </tr>
        ) : (
          bookings.map((job) => {
            const isSelected = selectedJobId === job._id;
            return (
              <tr
                key={String(job._id)}
                onClick={() => onSelect(job._id)}
                className={`cursor-pointer border-b border-border transition-colors last:border-b-0 ${
                  isSelected ? "bg-primary/5" : "hover:bg-muted/50"
                }`}
              >
                <td className="pl-5 pr-3 py-4">
                  <p className="font-medium text-foreground">{job.customerName}</p>
                </td>
                <td className="px-3 py-4 text-foreground">{job.vehicle}</td>
                <td className="max-w-56 truncate px-3 py-4 text-foreground">
                  {job.serviceNames.join(", ")}
                </td>
                <td className="px-3 py-4">
                  <StatusPill status={job.status} />
                </td>
                <td className="px-3 py-4 text-muted-foreground">
                  {job.scheduledDate
                    ? formatJobDate(job.scheduledDate, job.scheduledTime ?? "")
                    : "—"}
                </td>
                <td className="px-3 py-4 text-right pr-5 font-medium text-foreground">
                  ${(job.totalCost ?? 0).toFixed(2)}
                </td>
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------------ */
/*  Quote Jobs table                                                    */
/* ------------------------------------------------------------------ */

function QuoteJobsTable({
  quoteJobs,
  selectedJobId,
  onSelect,
}: {
  quoteJobs:
    | {
        _id: Id<"bookings">;
        customerName: string;
        vehicle: string;
        kind: "tire" | "rotor";
        specSummary: string;
        yourBidTotal: number | null;
        outcome: QuoteOutcome;
        submittedAt: number;
      }[]
    | undefined;
  selectedJobId: Id<"bookings"> | null;
  onSelect: (id: Id<"bookings">) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
          <th className="pl-5 pr-3 py-3">Customer</th>
          <th className="px-3 py-3">Vehicle</th>
          <th className="px-3 py-3">Type</th>
          <th className="px-3 py-3">Spec</th>
          <th className="px-3 py-3 text-right">Your bid</th>
          <th className="px-3 py-3">Outcome</th>
          <th className="px-3 py-3 pr-5">Date</th>
        </tr>
      </thead>
      <tbody>
        {quoteJobs === undefined ? (
          <tr>
            <td colSpan={7} className="px-5 py-12 text-center text-muted-foreground">
              Loading…
            </td>
          </tr>
        ) : quoteJobs.length === 0 ? (
          <tr>
            <td colSpan={7} className="px-5 py-14">
              <div className="flex flex-col items-center gap-2">
                <Disc3 className="h-9 w-9 text-muted-foreground opacity-40" />
                <p className="text-sm font-medium text-muted-foreground">
                  No quote jobs yet
                </p>
              </div>
            </td>
          </tr>
        ) : (
          quoteJobs.map((row) => {
            const isSelected = selectedJobId === row._id;
            const outcome = OUTCOME_STYLES[row.outcome];
            return (
              <tr
                key={String(row._id)}
                onClick={() => onSelect(row._id)}
                className={`cursor-pointer border-b border-border transition-colors last:border-b-0 ${
                  isSelected ? "bg-primary/5" : "hover:bg-muted/50"
                }`}
              >
                <td className="pl-5 pr-3 py-4">
                  <p className="font-medium text-foreground">{row.customerName}</p>
                </td>
                <td className="px-3 py-4 text-foreground">{row.vehicle}</td>
                <td className="px-3 py-4">
                  <span className="inline-flex items-center gap-1.5 text-foreground">
                    {row.kind === "tire" ? (
                      <Circle className="h-3.5 w-3.5" strokeWidth={2} />
                    ) : (
                      <Disc3 className="h-3.5 w-3.5" strokeWidth={2} />
                    )}
                    {row.kind === "tire" ? "Tire" : "Rotor"}
                  </span>
                </td>
                <td className="max-w-56 truncate px-3 py-4 text-muted-foreground">
                  {row.specSummary}
                </td>
                <td className="px-3 py-4 text-right font-medium text-foreground">
                  {row.yourBidTotal != null
                    ? `$${row.yourBidTotal.toFixed(2)}`
                    : "—"}
                </td>
                <td className="px-3 py-4">
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${outcome.className}`}
                  >
                    {outcome.label}
                  </span>
                </td>
                <td className="px-3 py-4 pr-5 text-muted-foreground">
                  {formatDateMs(row.submittedAt)}
                </td>
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab button (matches the Quotes page strip)                          */
/* ------------------------------------------------------------------ */

function TabButton({
  label,
  icon,
  active,
  count,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors " +
        (active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40")
      }
    >
      {icon}
      {label}
      {count !== undefined && count > 0 ? (
        <span
          className={
            "ml-1 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[11px] font-semibold tabular-nums " +
            (active
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground")
          }
        >
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </button>
  );
}
