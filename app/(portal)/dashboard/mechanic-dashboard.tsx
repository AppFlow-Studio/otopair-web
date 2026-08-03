"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  AlertCircle,
  ArrowRight,
  Bell,
  Car,
  Loader2,
  PlayCircle,
  Star,
  Wrench,
} from "lucide-react";
import { StatusPill } from "@/components/status-pill";
import JobActualsDialog, { type JobActualsPayload } from "@/components/job-actuals-dialog";
import MultiPointInspectionDialog, {
  type InspectionInputPayload,
} from "@/components/multi-point-inspection-dialog";
import PostJobSurveyDialog from "@/components/post-job-survey-dialog";
import DiagnosticChecklistDialog from "@/components/diagnostic-checklist-dialog";
import ConfirmationDialog from "@/components/confirmation-dialog";
import { templateForSystem } from "@/lib/diagnostic-checklist-templates";
import type {
  PostJobSurveyPayload,
  PreJobSurveyPayload,
} from "@/lib/vehicle-passport";

const avatarColors = [
  "bg-blue-100 text-blue-600",
  "bg-green-100 text-green-600",
  "bg-orange-100 text-orange-600",
  "bg-amber-100 text-amber-700",
];

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function formatTime(time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatDate(dateString: string) {
  return new Date(`${dateString}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatMinutes(minutes?: number | null) {
  if (!minutes) return "Est. TBD";
  const total = Math.round(minutes);
  if (total < 60) return `Est. ${total} min`;
  const h = Math.floor(total / 60);
  const m = total - h * 60;
  if (m === 0) return `Est. ${h} hr`;
  return `Est. ${h} hr ${m} min`;
}

function getInitials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";
}

function DashboardCard({
  label,
  value,
  sublabel,
}: {
  label: string;
  value: string;
  sublabel?: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-[0_2px_8px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.06)]">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-3 text-3xl font-bold text-foreground">{value}</p>
      {sublabel ? (
        <p className="mt-1 text-sm text-muted-foreground">{sublabel}</p>
      ) : null}
    </div>
  );
}

export default function MechanicDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dashboard = useQuery(api.bookings.getMyMechanicDashboard, {
    localDate: new Date().toLocaleDateString("en-CA"),
  });
  const customerOnMyWay = useQuery(api.bookings.getCustomerOnMyWayMonitors);
  const customerLateNotificationSent = useQuery(api.bookings.getCustomerLateNotificationSentMonitors);

  const onMyWayIds = useMemo(() => new Set((customerOnMyWay ?? []).map((a: any) => String(a.bookingId))), [customerOnMyWay]);
  const notifiedIds = useMemo(() => new Set((customerLateNotificationSent ?? []).map((a: any) => String(a.bookingId))), [customerLateNotificationSent]);
  const diagnosticsNeedingFollowUp = useQuery(
    api.bookings.getDiagnosticsNeedingFollowUp,
  );
  const savePrejob = useMutation(api.bookings.savePrejob);
  const startWithPrejob = useMutation(api.bookings.startWithPrejob);
  const commitInspectionAndAwaitEstimate = useMutation(
    api.bookings.commitInspectionAndAwaitEstimate,
  );
  const completeWithPostjob = useMutation(api.bookings.completeWithPostjob);

  const saveActualsDraft = useMutation(api.job_actuals.saveDraft);
  const finalizeActuals = useMutation(api.job_actuals.finalizeByBooking);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [toast, setToast] = useState<string>("");
  const [workflowBookingId, setWorkflowBookingId] = useState<Id<"bookings"> | null>(null);
  const [workflowMode, setWorkflowMode] = useState<
    "prejob" | "prejob_estimate" | "postjob" | null
  >(null);
  const [pendingActiveBlock, setPendingActiveBlock] = useState<{
    activeBookingId: string;
    activeVehicle: string;
    activeCustomer: string;
  } | null>(null);
  const [actualsBookingId, setActualsBookingId] = useState<Id<"bookings"> | null>(null);
  const [actualsDialogMode, setActualsDialogMode] = useState<"complete" | "edit">("complete");
  const selectedWorkflowBooking = useQuery(
    api.bookings.getJobDetail,
    workflowBookingId ? { bookingId: workflowBookingId } : "skip"
  );
  const selectedWorkflowPassport = useQuery(
    api.bookings.getVehiclePassportForBooking,
    workflowBookingId ? { bookingId: workflowBookingId } : "skip"
  );
  const workflowPrefill = useQuery(
    api.job_actuals.getPrefillData,
    workflowBookingId ? { bookingId: workflowBookingId } : "skip"
  );
  const selectedBooking = useQuery(
    api.bookings.getJobDetail,
    actualsBookingId ? { bookingId: actualsBookingId } : "skip"
  );
  const actualsPrefill = useQuery(
    api.job_actuals.getPrefillData,
    actualsBookingId ? { bookingId: actualsBookingId } : "skip"
  );

  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timeout);
  }, [toast]);

  const groupedUpcoming = useMemo(() => {
    if (!dashboard?.upcomingJobs) return [];
    const groups = new Map<
      string,
      Array<(typeof dashboard.upcomingJobs)[number]>
    >();
    for (const job of dashboard.upcomingJobs) {
      const existing = groups.get(job.scheduledDate) ?? [];
      existing.push(job);
      groups.set(job.scheduledDate, existing);
    }
    return Array.from(groups.entries());
  }, [dashboard]);

  // Header overlay's Mark complete routes here with ?postjob=<id>.
  // Open the post-job dialog for that booking, then strip the param.
  useEffect(() => {
    const postjobId = searchParams.get("postjob");
    if (!postjobId) return;
    openWorkflowDialog(postjobId, "postjob");
    router.replace("/dashboard");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  function openWorkflowDialog(
    bookingId: string,
    mode: "prejob" | "prejob_estimate" | "postjob",
  ) {
    setWorkflowBookingId(bookingId as Id<"bookings">);
    setWorkflowMode(mode);
  }

  /**
   * Pre-flight for the mechanic's Start button. If the mechanic already has
   * another booking in_progress today, route through a confirmation dialog
   * so they finish that one first (server enforces this same invariant).
   *
   * Pre-Job Approval flow: if the booking already has an approval state set
   * (mechanic already submitted the estimate after inspection), skip the
   * inspection re-run and route straight into the estimate dialog — the
   * dialog's auto-flip effect lands on the right status panel.
   */
  function tryStartBooking(bookingId: string) {
    const active = dashboard?.todaysJobs.find(
      (j: any) => j.status === "in_progress" && String(j._id) !== bookingId,
    );
    if (active) {
      setPendingActiveBlock({
        activeBookingId: String(active._id),
        activeVehicle: active.vehicle,
        activeCustomer: active.customerDisplayName,
      });
      return;
    }
    const target = dashboard?.todaysJobs.find(
      (j: any) => String(j._id) === bookingId,
    );
    const pas = (target as any)?.paymentApprovalState as string | undefined;
    const alreadyEstimated =
      (target as any)?.hasDisclosedRange &&
      pas != null &&
      pas !== "none";
    openWorkflowDialog(
      bookingId,
      alreadyEstimated ? "prejob_estimate" : "prejob",
    );
  }

  function closeWorkflowDialog() {
    setWorkflowBookingId(null);
    setWorkflowMode(null);
  }

  function openActualsDialog(bookingId: string, mode: "complete" | "edit") {
    setActualsBookingId(bookingId as Id<"bookings">);
    setActualsDialogMode(mode);
  }

  function closeActualsDialog() {
    setActualsBookingId(null);
    setActualsDialogMode("complete");
  }

  async function handleStartAction(
    payload: PreJobSurveyPayload,
    inspection: InspectionInputPayload,
    action: "close" | "start"
  ) {
    if (!workflowBookingId) return;

    // Pre-Job Approval flow: new-cycle bookings (with a disclosed range) must
    // submit a pre-job estimate before the booking can transition to
    // in_progress. We park the booking at inspection_complete and auto-chain
    // the estimate dialog.
    const isNewCycle = (selectedWorkflowBooking as any)?.hasDisclosedRange === true;

    setBusyAction(`start:${String(workflowBookingId)}`);
    try {
      if (action === "close") {
        await savePrejob({
          bookingId: workflowBookingId,
          prejob: payload,
          inspection,
        });
        setToast("Pre-job inspection saved");
        closeWorkflowDialog();
      } else if (isNewCycle) {
        await commitInspectionAndAwaitEstimate({
          bookingId: workflowBookingId,
          prejob: payload,
          inspection,
        });
        // Swap dialog body to the estimate form — same workflow booking id,
        // new mode. Do NOT close.
        setWorkflowMode("prejob_estimate");
      } else {
        await startWithPrejob({
          bookingId: workflowBookingId,
          prejob: payload,
          inspection,
        });
        setToast("Booking started");
        closeWorkflowDialog();
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "";
      if (message.startsWith("MECHANIC_HAS_ACTIVE_JOB:")) {
        closeWorkflowDialog();
        setToast(
          "Finish your current in-progress job first — then start this one.",
        );
      } else {
        setToast(
          message ||
            (action === "close"
              ? "Could not save the pre-job vehicle check"
              : "Could not start booking"),
        );
        throw error;
      }
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCompleteAction(payload: PostJobSurveyPayload) {
    if (!workflowBookingId) return;

    setBusyAction(`complete:${String(workflowBookingId)}`);
    try {
      await completeWithPostjob({
        bookingId: workflowBookingId,
        postjob: payload,
      });
      setToast("Booking completed");
      closeWorkflowDialog();
    } catch (error: unknown) {
      setToast(error instanceof Error ? error.message : "Could not complete booking");
      throw error;
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSaveActualsDraft(payload: JobActualsPayload) {
    if (!actualsBookingId) return;

    setBusyAction(`draft:${String(actualsBookingId)}`);
    try {
      await saveActualsDraft({
        bookingId: actualsBookingId,
        actuals: payload,
      });
      setToast("Actuals draft saved.");
      closeActualsDialog();
    } catch (error: unknown) {
      setToast(error instanceof Error ? error.message : "Could not save actuals");
      throw error;
    } finally {
      setBusyAction(null);
    }
  }

  async function handleFinalizeActuals(payload: JobActualsPayload) {
    if (!actualsBookingId) return;

    setBusyAction(`finalize:${String(actualsBookingId)}`);
    try {
      await finalizeActuals({
        bookingId: actualsBookingId,
        actuals: payload,
      });
      setToast("Actuals finalized.");
      closeActualsDialog();
    } catch (error: unknown) {
      setToast(error instanceof Error ? error.message : "Could not finalize actuals");
      throw error;
    } finally {
      setBusyAction(null);
    }
  }



  if (dashboard === undefined) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="rounded-2xl border border-border bg-card p-8 text-center text-muted-foreground">
        Mechanic dashboard data is not available for this account.
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 rounded-[28px] border border-border bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.12),_transparent_40%),linear-gradient(180deg,_rgba(255,255,255,0.98),_rgba(248,250,252,0.98))] p-7 shadow-[0_10px_30px_rgba(15,23,42,0.06)] sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-primary/80">
            {dashboard.shopName}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">
            {getGreeting()}, {dashboard.firstName}
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Today has {dashboard.stats.todayCount} assigned booking
            {dashboard.stats.todayCount === 1 ? "" : "s"} and{" "}
            {dashboard.needsActuals.length} completed booking
            {dashboard.needsActuals.length === 1 ? "" : "s"} still need finalized actuals.
          </p>
        </div>
        <Link
          href="/my-bookings"
          className="inline-flex items-center gap-2 self-start rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          My Bookings
          <ArrowRight className="w-4 h-4" />
        </Link>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <DashboardCard
          label="Today's Bookings"
          value={String(dashboard.stats.todayCount)}
          sublabel="Assigned to you"
        />
        <DashboardCard
          label="This Week"
          value={String(dashboard.stats.weekCompletedCount)}
          sublabel="Completed bookings"
        />
        <DashboardCard
          label="My Rating"
          value={dashboard.stats.rating.toFixed(1)}
          sublabel={`${dashboard.stats.reviewCount} review${dashboard.stats.reviewCount === 1 ? "" : "s"}`}
        />
      </div>

      {diagnosticsNeedingFollowUp && diagnosticsNeedingFollowUp.length > 0 ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50/40 p-6">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-amber-900">
              Diagnostics needing follow-up
            </h2>
            <p className="text-sm text-amber-900/80">
              {diagnosticsNeedingFollowUp.length} diagnostic
              {diagnosticsNeedingFollowUp.length === 1 ? "" : "s"} still waiting on a
              recommendation or more info.
            </p>
          </div>
          <div className="space-y-2">
            {diagnosticsNeedingFollowUp.map((job: any) => (
              <button
                key={String(job._id)}
                type="button"
                onClick={() => openWorkflowDialog(String(job._id), "postjob")}
                className="flex w-full items-start justify-between gap-3 rounded-xl border border-amber-200 bg-white px-3 py-2.5 text-left hover:bg-amber-50"
              >
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground">
                    {job.customerName} · {job.vehicle}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {job.serviceNames.join(", ")}
                    {job.diagnosticSystem ? ` · ${job.diagnosticSystem}` : ""}
                  </div>
                  {job.followupState === "awaiting_info" && job.awaitingInfoNote ? (
                    <div className="mt-1 text-xs text-cyan-800">
                      Waiting on: {job.awaitingInfoNote}
                    </div>
                  ) : null}
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${
                    job.followupState === "awaiting_info"
                      ? "bg-cyan-100 text-cyan-900"
                      : "bg-amber-100 text-amber-900"
                  }`}
                >
                  {job.followupState === "awaiting_info" ? "Awaiting info" : "Pending"}
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="rounded-2xl border border-border bg-card p-6 shadow-[0_2px_8px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.06)]">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Today&apos;s Schedule</h2>
            <p className="text-sm text-muted-foreground">
              Focused on your confirmed and active work for today.
            </p>
          </div>
          <div className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
            <PlayCircle className="w-3.5 h-3.5" />
            Live actions
          </div>
        </div>

        {dashboard.todaysJobs.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-dashed border-border bg-muted/30 px-6 py-10 text-center">
            <p className="text-base font-medium text-foreground">
              No bookings scheduled for today.
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Check your upcoming queue or return to My Bookings later.
            </p>
          </div>
        ) : (
          <div className="mt-6 grid gap-4 xl:grid-cols-2">
            {dashboard.todaysJobs.map((job, index) => {
              const actionKeyStart = `start:${job._id}`;
              const actionKeyComplete = `complete:${job._id}`;
              const initials = getInitials(job.customerDisplayName);
              return (
                <div
                  key={String(job._id)}
                  className="rounded-2xl border border-border bg-background p-5"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 items-start gap-3">
                      <div
                        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${avatarColors[index % avatarColors.length]}`}
                      >
                        {initials}
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-base font-semibold text-foreground">
                            {formatTime(job.scheduledTime)}
                          </p>
                          <StatusPill status={job.status} />
                          {onMyWayIds.has(String(job._id)) && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                              <Car className="h-2.5 w-2.5" />
                              En route
                            </span>
                          )}
                          {!onMyWayIds.has(String(job._id)) && notifiedIds.has(String(job._id)) && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-0.5 text-[10px] font-semibold text-yellow-700">
                              <Bell className="h-2.5 w-2.5" />
                              Notified
                            </span>
                          )}
                          {((job as any).paymentApprovalState === "pre_job_pending" ||
                            (job as any).paymentApprovalState === "mid_job_pending" ||
                            (job as any).paymentApprovalState === "post_job_pending" ||
                            (job as any).paymentApprovalState === "pre_job_declined" ||
                            (job as any).paymentApprovalState === "sla_expired") && (
                            <button
                              type="button"
                              onClick={() =>
                                openWorkflowDialog(String(job._id), "prejob_estimate")
                              }
                              className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800 transition-colors hover:bg-amber-200"
                              title="Reopen the estimate workflow"
                            >
                              {(job as any).paymentApprovalState === "post_job_pending"
                                ? "Customer reviewing final billing"
                                : "Pending customer confirmation"}
                            </button>
                          )}
                          {(job as any).paymentApprovalState === "reauth_required" && (
                            <span
                              className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-800"
                              title="The customer's card needs reauthorization before work can proceed."
                            >
                              <AlertCircle className="h-2.5 w-2.5" />
                              Hold reauthorization needed
                            </span>
                          )}
                        </div>
                        <p className="mt-1 truncate text-sm font-medium text-foreground">
                          {job.customerDisplayName}
                        </p>
                        <p className="truncate text-sm text-muted-foreground">
                          {job.vehicle}
                        </p>
                        <p className="mt-2 text-sm text-muted-foreground">
                          {job.serviceNames.join(", ")}
                        </p>
                      </div>
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      {formatMinutes(job.estimatedLaborMinutes)}
                    </div>
                  </div>

                  <div className="mt-5 flex flex-wrap gap-2">
                    {job.status === "confirmed" ? (
                      <button
                        disabled
                        className={`inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-medium opacity-70 ${
                          onMyWayIds.has(String(job._id))
                            ? "border-emerald-200 text-emerald-700"
                            : "border-border text-muted-foreground"
                        }`}
                      >
                        {onMyWayIds.has(String(job._id)) ? (
                          <><Car className="h-3.5 w-3.5" />Customer en route</>
                        ) : (
                          "Awaiting vehicle"
                        )}
                      </button>
                    ) : null}

                    {job.status === "vehicle_at_shop" ? (
                      <button
                        onClick={() => tryStartBooking(String(job._id))}
                        disabled={
                          busyAction === actionKeyStart ||
                          job.vehiclePassportComplete === false
                        }
                        title={
                          job.vehiclePassportComplete === false
                            ? "Open the booking details panel to confirm the required vehicle passport fields first."
                            : undefined
                        }
                        className="inline-flex items-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                      >
                        {busyAction === actionKeyStart ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <PlayCircle className="w-4 h-4" />
                        )}
                        {(() => {
                          if (job.vehiclePassportComplete === false)
                            return "Confirm Specs in Details";
                          const pas = (job as any).paymentApprovalState as
                            | string
                            | undefined;
                          if (pas === "reauth_required")
                            return "Waiting on customer reauth";
                          if (pas === "in_range" || pas === "pre_job_approved")
                            return "Open & start work";
                          if (
                            pas === "pre_job_pending" ||
                            pas === "pre_job_declined" ||
                            pas === "sla_expired"
                          )
                            return "Open estimate";
                          return "Start Booking";
                        })()}
                      </button>
                    ) : null}

                    {job.status === "in_progress" ? (
                      <button
                        onClick={() => openWorkflowDialog(String(job._id), "postjob")}
                        disabled={busyAction === actionKeyComplete}
                        className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                          (job as any).diagnosticSystem
                            ? "border border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
                            : "border border-border text-foreground hover:bg-muted"
                        }`}
                      >
                        {busyAction === actionKeyComplete ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Wrench className="w-4 h-4" />
                        )}
                        {(job as any).diagnosticSystem
                          ? "Run diagnostic checklist"
                          : "Complete Booking"}
                      </button>
                    ) : null}

                    <Link
                      href={`/my-bookings?highlight=${job._id}`}
                      className="inline-flex items-center gap-2 rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                    >
                      View Details
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.3fr_0.9fr]">
        <section className="rounded-2xl border border-border bg-card p-6 shadow-[0_2px_8px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.06)]">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Upcoming</h2>
              <p className="text-sm text-muted-foreground">
                Confirmed bookings over the next seven days.
              </p>
            </div>
            <Star className="w-4 h-4 text-amber-500" />
          </div>

          {groupedUpcoming.length === 0 ? (
            <p className="mt-6 text-sm text-muted-foreground">
              No confirmed upcoming bookings right now.
            </p>
          ) : (
            <div className="mt-6 space-y-5">
              {groupedUpcoming.map(([date, jobs]) => (
                <div key={date}>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {formatDate(date)}
                  </p>
                  <div className="mt-3 space-y-3">
                    {jobs.map((job) => (
                      <Link
                        key={String(job._id)}
                        href={`/my-bookings?highlight=${job._id}`}
                        className="flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3 transition-colors hover:bg-muted/40"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">
                            {formatTime(job.scheduledTime)} • {job.customerDisplayName}
                          </p>
                          <p className="truncate text-sm text-muted-foreground">
                            {job.vehicle} • {job.serviceNames.join(", ")}
                          </p>
                        </div>
                        <ArrowRight className="w-4 h-4 shrink-0 text-muted-foreground" />
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-border bg-card p-6 shadow-[0_2px_8px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.06)]">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-600" />
            <div>
              <h2 className="text-lg font-semibold text-foreground">Needs Attention</h2>
              <p className="text-sm text-muted-foreground">
                Completed bookings missing finalized actuals.
              </p>
            </div>
          </div>

          {dashboard.needsActuals.length === 0 ? (
            <p className="mt-6 text-sm text-muted-foreground">
              Nothing waiting on follow-up right now.
            </p>
          ) : (
            <div className="mt-6 space-y-3">
              {dashboard.needsActuals.map((job) => (
                <div
                  key={String(job._id)}
                  className="rounded-xl border border-border bg-amber-50/50 px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        {job.customerDisplayName}
                      </p>
                      <p className="truncate text-sm text-muted-foreground">
                        {job.vehicle}
                      </p>
                      <p className="mt-1 text-xs text-amber-700">
                        Completed {formatDate(job.scheduledDate)} at {formatTime(job.scheduledTime)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => openActualsDialog(String(job._id), "edit")}
                        className="rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100"
                      >
                        Finalize actuals
                      </button>
                      <Link
                        href={`/my-bookings?highlight=${job._id}`}
                        className="inline-flex items-center text-amber-700 transition-colors hover:text-amber-900"
                      >
                        <ArrowRight className="mt-0.5 w-4 h-4" />
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <ConfirmationDialog
        open={pendingActiveBlock !== null}
        title="Finish your current job first"
        onClose={() => setPendingActiveBlock(null)}
        primaryAction={{
          label: "Got it",
          onAction: () => setPendingActiveBlock(null),
          variant: "primary",
        }}
      >
        {pendingActiveBlock ? (
          <p className="text-sm text-foreground">
            You&apos;re already working on{" "}
            <span className="font-medium">{pendingActiveBlock.activeVehicle}</span>{" "}
            for{" "}
            <span className="font-medium">{pendingActiveBlock.activeCustomer}</span>
            . Complete that booking — including the post-job report — before
            starting a new one.
          </p>
        ) : null}
      </ConfirmationDialog>

      <MultiPointInspectionDialog
        open={workflowBookingId !== null && workflowMode === "prejob"}
        bookingId={workflowBookingId ? String(workflowBookingId) : null}
        bookingLabel={selectedWorkflowBooking?.vehicle ?? "Vehicle"}
        bookingSubLabel={
          selectedWorkflowBooking
            ? `${selectedWorkflowBooking.customerName} · ${selectedWorkflowBooking.serviceNames.join(", ")} · ${formatDate(
                selectedWorkflowBooking.scheduledDate,
              )} ${formatTime(selectedWorkflowBooking.scheduledTime)}`
            : ""
        }
        bookingServices={selectedWorkflowBooking?.serviceNames ?? []}
        tireReplacementPositions={
          selectedWorkflowBooking?.tireSpecs?.positions ?? []
        }
        passportData={selectedWorkflowPassport ?? null}
        prefillData={selectedWorkflowBooking?.jobActuals?.prejobReport ?? null}
        isSubmitting={
          workflowBookingId !== null &&
          busyAction === `start:${String(workflowBookingId)}`
        }
        onClose={closeWorkflowDialog}
        onSubmit={handleStartAction}
        onSaveDraft={async (payload, inspection) => {
          if (!workflowBookingId) return;
          await savePrejob({
            bookingId: workflowBookingId,
            prejob: payload,
            inspection,
          });
        }}
      />

      <DiagnosticChecklistDialog
        open={
          workflowBookingId !== null &&
          workflowMode === "postjob" &&
          !!selectedWorkflowBooking?.diagnosticSystem
        }
        bookingId={workflowBookingId}
        bookingLabel={selectedWorkflowBooking?.vehicle ?? "Vehicle"}
        bookingSubLabel={
          selectedWorkflowBooking
            ? `${selectedWorkflowBooking.customerName} · ${selectedWorkflowBooking.serviceNames.join(", ")} · ${formatDate(
                selectedWorkflowBooking.scheduledDate,
              )} ${formatTime(selectedWorkflowBooking.scheduledTime)}`
            : ""
        }
        system={(selectedWorkflowBooking?.diagnosticSystem ?? "not_sure") as any}
        checklist={
          selectedWorkflowBooking?.diagnosticChecklist &&
          selectedWorkflowBooking.diagnosticChecklist.length > 0
            ? selectedWorkflowBooking.diagnosticChecklist
            : selectedWorkflowBooking?.diagnosticSystem
              ? templateForSystem(selectedWorkflowBooking.diagnosticSystem as any)
              : []
        }
        customerNotes={selectedWorkflowBooking?.customerNotes ?? null}
        findingsNote={(selectedWorkflowBooking as any)?.diagnosticFindingsNote ?? null}
        recommendationState={selectedWorkflowBooking?.recommendationState ?? null}
        recommendedServiceName={selectedWorkflowBooking?.recommendedServiceName ?? null}
        recommendedServiceNote={selectedWorkflowBooking?.recommendedServiceNote ?? null}
        followupState={selectedWorkflowBooking?.diagnosticFollowupState ?? null}
        awaitingInfoNote={selectedWorkflowBooking?.awaitingInfoNote ?? null}
        onClose={closeWorkflowDialog}
        onCompleted={() => {
          setToast("Diagnostic completed");
          closeWorkflowDialog();
        }}
        onError={(msg) => setToast(msg)}
      />

      <PostJobSurveyDialog
        open={
          workflowBookingId !== null &&
          workflowMode === "postjob" &&
          !selectedWorkflowBooking?.diagnosticSystem
        }
        bookingId={workflowBookingId ? String(workflowBookingId) : null}
        bookingLabel={selectedWorkflowBooking?.vehicle ?? "Vehicle"}
        bookingSubLabel={
          selectedWorkflowBooking
            ? `${selectedWorkflowBooking.customerName} · ${selectedWorkflowBooking.serviceNames.join(", ")} · ${formatDate(
                selectedWorkflowBooking.scheduledDate,
              )} ${formatTime(selectedWorkflowBooking.scheduledTime)}`
            : ""
        }
        passportData={selectedWorkflowPassport ?? null}
        estimatedLaborMinutes={selectedWorkflowBooking?.estimatedLaborMinutes ?? null}
        prefillData={workflowPrefill ?? null}
        isSubmitting={
          workflowBookingId !== null &&
          busyAction === `complete:${String(workflowBookingId)}`
        }
        onClose={closeWorkflowDialog}
        onSubmit={handleCompleteAction}
        initialTechnicianNotes={
          (selectedWorkflowBooking?.jobActuals as any)?.inProgressNotes ?? ""
        }
        initialPhotos={
          ((selectedWorkflowBooking?.jobActuals as any)?.inProgressPhotos ?? []).map(
            (p: any) => ({
              id: p.storageId,
              storageId: p.storageId,
              previewUrl: p.url ?? "",
              caption: p.caption ?? "",
              status: "ready" as const,
            }),
          )
        }
        lockBilling
      />

      {/* Pre-Job Approval — auto-chained from the inspection dialog. Same
          PostJobSurveyDialog component, this time with cycle="pre_job" so it
          routes submit through booking_approvals.submitPreJobEstimate and
          renders the live ApprovalStatusPanel after send. */}
      <PostJobSurveyDialog
        open={workflowBookingId !== null && workflowMode === "prejob_estimate"}
        bookingId={workflowBookingId ? String(workflowBookingId) : null}
        bookingLabel={selectedWorkflowBooking?.vehicle ?? "Vehicle"}
        bookingSubLabel={
          selectedWorkflowBooking
            ? `${selectedWorkflowBooking.customerName} · ${selectedWorkflowBooking.serviceNames.join(", ")} · ${formatDate(
                selectedWorkflowBooking.scheduledDate,
              )} ${formatTime(selectedWorkflowBooking.scheduledTime)}`
            : ""
        }
        passportData={selectedWorkflowPassport ?? null}
        estimatedLaborMinutes={selectedWorkflowBooking?.estimatedLaborMinutes ?? null}
        prefillData={workflowPrefill ?? null}
        isSubmitting={false}
        onClose={closeWorkflowDialog}
        onSubmit={async () => {
          // Cycle submit path runs inside the dialog itself; this callback is
          // only invoked on the legacy actuals path which is gated by cycle.
        }}
        cycle="pre_job"
        onApprovalSubmitted={() => {
          setToast("Estimate sent for confirmation");
        }}
        laborRateCents={(selectedWorkflowBooking as any)?.shopLaborRateCents ?? null}
        laborCostDollars={(selectedWorkflowBooking as any)?.laborCost ?? null}
        shopState={(selectedWorkflowBooking as any)?.shopState ?? null}
        shopZip={(selectedWorkflowBooking as any)?.shopZip ?? null}
      />

      <JobActualsDialog
        open={actualsBookingId !== null}
        mode={actualsDialogMode}
        estimatedLaborMinutes={selectedBooking?.estimatedLaborMinutes ?? null}
        jobActuals={selectedBooking?.jobActuals ?? null}
        prefillData={actualsPrefill ?? null}
        onClose={closeActualsDialog}
        onSaveDraft={handleSaveActualsDraft}
        onFinalize={handleFinalizeActuals}
      />

      {toast ? (
        <div className="fixed bottom-6 right-6 z-[70] rounded-lg border border-border bg-card px-4 py-3 text-sm text-foreground shadow-lg">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
