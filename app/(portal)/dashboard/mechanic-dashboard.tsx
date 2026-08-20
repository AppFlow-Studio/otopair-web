"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ArrowRight, Loader2 } from "lucide-react";
import JobActualsDialog, { type JobActualsPayload } from "@/components/job-actuals-dialog";
import MultiPointInspectionDialog, {
  type InspectionInputPayload,
} from "@/components/multi-point-inspection-dialog";
import PostJobSurveyDialog from "@/components/post-job-survey-dialog";
import { useLockedQuote } from "@/lib/use-locked-quote";
import DiagnosticChecklistDialog from "@/components/diagnostic-checklist-dialog";
import ConfirmationDialog from "@/components/confirmation-dialog";
import { templateForSystem } from "@/lib/diagnostic-checklist-templates";
import type {
  PostJobSurveyPayload,
  CustomJobOutcome,
  PreJobSurveyPayload,
} from "@/lib/vehicle-passport";
import {
  GreetingHeader,
  MetricRow,
  Metric,
  SectionLabel,
  CommandList,
  CommandRow,
  EmptyRow,
  useListKeyboard,
  type CommandAction,
  type Tone,
} from "@/components/dashboard/command-deck";

/** A shape the mechanic "Needs you now" list can render and drive by keyboard. */
type NeedItem = {
  key: string;
  kind: "active" | "ready" | "diagnostic" | "actuals";
  dot: Tone;
  primary: string;
  secondary?: string;
  meta?: string;
  action?: CommandAction;
  onOpen: () => void;
};

function statusText(status: string): string {
  switch (status) {
    case "confirmed":
      return "Confirmed";
    case "vehicle_at_shop":
      return "Ready";
    case "in_progress":
      return "In progress";
    case "completed":
      return "Completed";
    case "pending":
    case "pending_shop_acceptance":
      return "Pending";
    default:
      return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

function statusDot(status: string): Tone {
  switch (status) {
    case "in_progress":
      return "success";
    case "vehicle_at_shop":
    case "confirmed":
      return "primary";
    case "pending":
    case "pending_shop_acceptance":
      return "warning";
    default:
      return "muted";
  }
}

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

export default function MechanicDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dashboard = useQuery(api.bookings.getMyMechanicDashboard, {
    localDate: new Date().toLocaleDateString("en-CA"),
  });
  const customerOnMyWay = useQuery(api.bookings.getCustomerOnMyWayMonitors);

  const onMyWayIds = useMemo(() => new Set((customerOnMyWay ?? []).map((a: any) => String(a.bookingId))), [customerOnMyWay]);
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
  // Customer-approved quote for the post-job "Confirm parts to use" step. Same
  // hook the owner's booking-detail-panel uses, so the mechanic's completion
  // dialog shows the AGREED parts + total (e.g. battery $350, oil filter $35,
  // not-used rows dropped, $726.69 total) instead of falling back to the
  // pre-approval snapshot (stale $0 parts, $103 total).
  const workflowLockedQuote = useLockedQuote(selectedWorkflowBooking);
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

  async function handleCompleteAction(
    payload: PostJobSurveyPayload,
    customJobOutcomes?: CustomJobOutcome[],
  ) {
    if (!workflowBookingId) return;

    setBusyAction(`complete:${String(workflowBookingId)}`);
    try {
      await completeWithPostjob({
        bookingId: workflowBookingId,
        postjob: payload,
        customJobOutcomes:
          customJobOutcomes && customJobOutcomes.length > 0
            ? customJobOutcomes
            : undefined,
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

  // The unified "Needs you now" queue — everything the mechanic must act on,
  // in the order they'd work it: finish the lift, start what's arrived, close
  // out diagnostics, then finalize actuals. Built before the early returns so
  // the keyboard hook below never runs conditionally (rules of hooks).
  const needItems = useMemo<NeedItem[]>(() => {
    if (!dashboard) return [];
    const items: NeedItem[] = [];

    // 1) In progress — finish what's on the lift.
    for (const job of dashboard.todaysJobs) {
      if (job.status !== "in_progress") continue;
      const id = String(job._id);
      const isDiag = !!(job as any).diagnosticSystem;
      items.push({
        key: `active-${id}`,
        kind: "active",
        dot: "success",
        primary: `${job.customerDisplayName} · ${job.vehicle}`,
        secondary: job.serviceNames.join(", ") || undefined,
        meta: "in progress",
        action: {
          label: isDiag ? "Diagnostic" : "Complete",
          tone: isDiag ? "warning" : "primary",
          run: () => openWorkflowDialog(id, "postjob"),
        },
        onOpen: () => openWorkflowDialog(id, "postjob"),
      });
    }

    // 2) Ready to start — the vehicle is here.
    for (const job of dashboard.todaysJobs) {
      if (job.status !== "vehicle_at_shop") continue;
      const id = String(job._id);
      const passportIncomplete = (job as any).vehiclePassportComplete === false;
      const enroute = onMyWayIds.has(id);
      items.push({
        key: `ready-${id}`,
        kind: "ready",
        dot: "primary",
        primary: `${job.customerDisplayName} · ${job.vehicle}`,
        secondary: job.serviceNames.join(", ") || undefined,
        meta: `${formatTime(job.scheduledTime)}${enroute ? " · en route" : ""}`,
        action: passportIncomplete
          ? {
              label: "Confirm specs",
              tone: "warning",
              run: () => router.push(`/my-bookings?highlight=${id}`),
            }
          : {
              label: "Start",
              tone: "primary",
              run: () => tryStartBooking(id),
            },
        onOpen: () =>
          passportIncomplete
            ? router.push(`/my-bookings?highlight=${id}`)
            : tryStartBooking(id),
      });
    }

    // 3) Diagnostics needing follow-up.
    for (const job of diagnosticsNeedingFollowUp ?? []) {
      const id = String(job._id);
      items.push({
        key: `diag-${id}`,
        kind: "diagnostic",
        dot: "warning",
        primary: `${job.customerName} · ${job.vehicle}`,
        secondary:
          `${job.serviceNames.join(", ")}${
            job.diagnosticSystem ? ` · ${job.diagnosticSystem}` : ""
          }` || undefined,
        meta: job.followupState === "awaiting_info" ? "awaiting info" : "pending",
        action: {
          label: "Follow up",
          tone: "warning",
          run: () => openWorkflowDialog(id, "postjob"),
        },
        onOpen: () => openWorkflowDialog(id, "postjob"),
      });
    }

    // 4) Completed but missing finalized actuals.
    for (const job of dashboard.needsActuals) {
      const id = String(job._id);
      items.push({
        key: `actuals-${id}`,
        kind: "actuals",
        dot: "muted",
        primary: `${job.customerDisplayName} · ${job.vehicle}`,
        secondary: `Completed ${formatDate(job.scheduledDate)}`,
        meta: "needs details",
        action: {
          label: "Finalize",
          tone: "muted",
          run: () => openActualsDialog(id, "edit"),
        },
        onOpen: () => openActualsDialog(id, "edit"),
      });
    }

    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard, diagnosticsNeedingFollowUp, onMyWayIds, router]);

  // List keyboard nav is live only when no workflow dialog is open.
  const listNavEnabled =
    workflowBookingId === null &&
    actualsBookingId === null &&
    pendingActiveBlock === null;
  const { focused, setFocused } = useListKeyboard({
    count: needItems.length,
    enabled: listNavEnabled,
    onOpen: (i) => needItems[i]?.onOpen(),
    onAccept: (i) => needItems[i]?.action?.run(),
    canAccept: (i) => !!needItems[i]?.action && !needItems[i]?.action?.disabled,
  });

  const inProgressCount =
    dashboard?.todaysJobs.filter((job: any) => job.status === "in_progress").length ?? 0;
  const readyCount =
    dashboard?.todaysJobs.filter((job: any) => job.status === "vehicle_at_shop").length ?? 0;

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
      <GreetingHeader
        greeting={getGreeting()}
        name={dashboard.firstName}
        dateLabel={new Date().toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
        })}
        subtitle={dashboard.shopName}
        right={
          <Link
            href="/my-bookings"
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            My Bookings
            <ArrowRight className="h-4 w-4" />
          </Link>
        }
      />

      <MetricRow>
        <Metric
          label="In the bay"
          value={String(inProgressCount)}
          sublabel={
            inProgressCount > 0
              ? "job in progress"
              : readyCount > 0
                ? `${readyCount} ready to start`
                : "nothing running"
          }
          tone={inProgressCount > 0 ? "success" : "muted"}
        />
        <Metric
          label="Awaiting you"
          value={String(needItems.length)}
          sublabel={needItems.length > 0 ? "to act on" : "all clear"}
          tone={needItems.length > 0 ? "danger" : "muted"}
          active={needItems.length > 0}
        />
        <Metric
          label="This week"
          value={String(dashboard.stats.weekCompletedCount)}
          sublabel="completed"
          tone="success"
        />
        <Metric
          label="Rating"
          value={
            dashboard.stats.reviewCount === 0
              ? "—"
              : dashboard.stats.rating.toFixed(1)
          }
          sublabel={
            dashboard.stats.reviewCount === 0
              ? "no reviews yet"
              : `${dashboard.stats.reviewCount} review${
                  dashboard.stats.reviewCount === 1 ? "" : "s"
                }`
          }
        />
      </MetricRow>

      {needItems.length > 0 ? (
        <section aria-label="Needs you now">
          <SectionLabel count={needItems.length}>Needs you now</SectionLabel>
          <CommandList
            footerHint={
              <span className="inline-flex flex-wrap items-center gap-x-1">
                <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">J</kbd>
                <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">K</kbd>
                <span>move</span>
                <span className="px-0.5">·</span>
                <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">Enter</kbd>
                <span>open</span>
                <span className="px-0.5">·</span>
                <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">A</kbd>
                <span>act</span>
              </span>
            }
          >
            {needItems.map((item, index) => (
              <CommandRow
                key={item.key}
                dot={item.dot}
                primary={item.primary}
                secondary={item.secondary}
                meta={item.meta}
                action={item.action}
                selected={listNavEnabled && focused === index}
                onOpen={item.onOpen}
                onFocus={() => setFocused(index)}
              />
            ))}
          </CommandList>
        </section>
      ) : null}

      <section aria-label="Today">
        <SectionLabel>Today</SectionLabel>
        <CommandList>
          {dashboard.todaysJobs.length === 0 ? (
            <EmptyRow>No bookings scheduled for today</EmptyRow>
          ) : (
            dashboard.todaysJobs.map((job) => {
              const id = String(job._id);
              return (
                <CommandRow
                  key={id}
                  dot={statusDot(job.status)}
                  code={formatTime(job.scheduledTime)}
                  primary={`${job.customerDisplayName} · ${job.vehicle}`}
                  secondary={job.serviceNames.join(", ") || undefined}
                  meta={statusText(job.status)}
                  onOpen={() => router.push(`/my-bookings?highlight=${id}`)}
                />
              );
            })
          )}
        </CommandList>
      </section>

      {groupedUpcoming.length > 0 ? (
        <section aria-label="Upcoming">
          <SectionLabel hint="Next 7 days">Upcoming</SectionLabel>
          <div className="mt-3 space-y-4">
            {groupedUpcoming.map(([date, jobs]) => (
              <div key={date}>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {formatDate(date)}
                </p>
                <CommandList>
                  {jobs.map((job) => {
                    const id = String(job._id);
                    return (
                      <CommandRow
                        key={id}
                        dot="muted"
                        code={formatTime(job.scheduledTime)}
                        primary={`${job.customerDisplayName} · ${job.vehicle}`}
                        secondary={job.serviceNames.join(", ") || undefined}
                        onOpen={() => router.push(`/my-bookings?highlight=${id}`)}
                      />
                    );
                  })}
                </CommandList>
              </div>
            ))}
          </div>
        </section>
      ) : null}
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
        layoverNotes={
          (selectedWorkflowBooking?.jobActuals as any)?.inProgressNotes ?? ""
        }
        layoverPhotos={
          ((selectedWorkflowBooking?.jobActuals as any)?.inProgressPhotos ?? []).map(
            (p: any) => ({
              id: p.storageId,
              storageId: p.storageId,
              previewUrl: p.url ?? "",
              caption: p.caption ?? "",
              status: "ready" as const,
              takenAt: p.takenAt ?? undefined,
            }),
          )
        }
        lockBilling={!workflowLockedQuote.isWalkIn}
        quotedParts={workflowLockedQuote.lockedQuoteParts}
        lockedQuote={workflowLockedQuote.lockedQuote}
        isFixedPrice={(selectedWorkflowBooking as any)?.isFixedPrice}
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
