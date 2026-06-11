"use client";

/**
 * Developer / Test Tools panel — dev-gated.
 *
 * Surfaces Setup + Trigger button pairs for each new booking-lifecycle feature
 * so QA can exercise the flows without waiting real minutes:
 *   - Early check-in
 *   - Early end
 *   - Customer late (3-tier escalation)
 *   - Reschedule notification
 *   - Mechanic active job
 *   - Job overrun (blocking/non-blocking cascade)
 *
 * Date + time inputs on each card are editable before AND after Setup so you
 * can specify exactly what slot the test booking lands in.
 */

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import {
  AlertTriangle,
  Bell,
  CarFront,
  CheckCircle2,
  Clock,
  Loader2,
  Play,
  RotateCcw,
  Sparkles,
  Timer,
  Trash2,
  UserCheck,
  Wrench,
} from "lucide-react";

type ScenarioKey =
  | "earlyCheckin"
  | "earlyEnd"
  | "customerLate"
  | "reschedule"
  | "mechanicActiveJob"
  | "jobOverrun";

type ScenarioState = {
  bookingId: Id<"bookings"> | null;
  /** Second booking — used by jobOverrun for the downstream confirmed slot. */
  secondaryBookingId: Id<"bookings"> | null;
  mechanicId: Id<"mechanics"> | null;
  /** Confirmed date/time from the last successful Setup call (display only). */
  scheduledDate: string | null;
  scheduledTime: string | null;
  /** User-editable inputs sent to the Setup mutation. */
  inputDate: string;
  inputTime: string;
  /** jobOverrun only: editable downstream slot time. */
  inputDownstreamTime: string;
  message: string;
  busy: boolean;
};

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nowPlusHHMM(offsetMinutes: number) {
  const d = new Date(Date.now() + offsetMinutes * 60 * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function makeEmptyState(inputDate: string, inputTime: string, inputDownstreamTime = ""): ScenarioState {
  return {
    bookingId: null,
    secondaryBookingId: null,
    mechanicId: null,
    scheduledDate: null,
    scheduledTime: null,
    inputDate,
    inputTime,
    inputDownstreamTime,
    message: "",
    busy: false,
  };
}

export default function DevTestTools({ shopId }: { shopId: Id<"shops"> }) {
  const mechanics = useQuery(api.test_helpers.listMechanicsForShop, { shopId });

  const setupEarlyCheckin = useMutation(api.test_helpers.setupEarlyCheckinScenario);
  const setupEarlyEnd = useMutation(api.test_helpers.setupEarlyEndScenario);
  const setupCustomerLate = useMutation(api.test_helpers.setupCustomerLateScenario);
  const setupReschedule = useMutation(api.test_helpers.setupRescheduleScenario);
  const setupMechanicActiveJob = useMutation(api.test_helpers.setupMechanicActiveJobScenario);
  const setupJobOverrun = useMutation(api.test_helpers.setupJobOverrunScenario);

  const triggerEarlyCheckin = useMutation(api.test_helpers.triggerEarlyCheckin);
  const triggerEarlyEnd = useMutation(api.test_helpers.triggerEarlyEnd);
  const triggerCustomerLateAdvance = useMutation(api.test_helpers.triggerCustomerLateAdvance);
  const triggerRescheduleProposal = useMutation(api.test_helpers.triggerRescheduleProposal);
  const triggerMechanicJobStart = useMutation(api.test_helpers.triggerMechanicJobStart);
  const triggerJobOverrun = useMutation(api.test_helpers.triggerJobOverrun);
  const clearTestArtifacts = useMutation(api.test_helpers.clearTestArtifacts);

  const [scenarios, setScenarios] = useState<Record<ScenarioKey, ScenarioState>>(() => ({
    earlyCheckin:     makeEmptyState(todayISO(), nowPlusHHMM(30)),
    earlyEnd:         makeEmptyState(todayISO(), nowPlusHHMM(-10)),
    customerLate:     makeEmptyState(todayISO(), nowPlusHHMM(0)),
    reschedule:       makeEmptyState(tomorrowISO(), "12:00"),
    mechanicActiveJob: makeEmptyState(todayISO(), nowPlusHHMM(0)),
    jobOverrun:       makeEmptyState(todayISO(), nowPlusHHMM(0), nowPlusHHMM(30)),
  }));
  const [selectedMechanicId, setSelectedMechanicId] =
    useState<Id<"mechanics"> | null>(null);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearMessage, setClearMessage] = useState("");

  function patch(key: ScenarioKey, next: Partial<ScenarioState>) {
    setScenarios((prev) => ({ ...prev, [key]: { ...prev[key], ...next } }));
  }

  async function withBusy<T>(
    key: ScenarioKey,
    label: string,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    patch(key, { busy: true, message: `${label}…` });
    try {
      const result = await fn();
      patch(key, { busy: false, message: `${label} ✓` });
      return result;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      patch(key, { busy: false, message: `${label} failed: ${msg}` });
      return null;
    }
  }

  async function handleSetupEarlyCheckin() {
    const s = scenarios.earlyCheckin;
    const result = await withBusy("earlyCheckin", "Setup", () =>
      setupEarlyCheckin({ shopId, scheduledDate: s.inputDate, scheduledTime: s.inputTime }),
    );
    if (result) {
      patch("earlyCheckin", {
        bookingId: result.bookingId,
        mechanicId: result.mechanicId,
        scheduledDate: result.scheduledDate,
        scheduledTime: result.scheduledTime,
      });
    }
  }

  async function handleSetupEarlyEnd() {
    const s = scenarios.earlyEnd;
    const result = await withBusy("earlyEnd", "Setup", () =>
      setupEarlyEnd({ shopId, scheduledDate: s.inputDate, scheduledTime: s.inputTime }),
    );
    if (result) {
      patch("earlyEnd", {
        bookingId: result.bookingId,
        mechanicId: result.mechanicId,
        scheduledDate: result.scheduledDate,
        scheduledTime: result.scheduledTime,
      });
    }
  }

  async function handleSetupCustomerLate() {
    const s = scenarios.customerLate;
    const result = await withBusy("customerLate", "Setup", () =>
      setupCustomerLate({ shopId, scheduledDate: s.inputDate, scheduledTime: s.inputTime }),
    );
    if (result) {
      patch("customerLate", {
        bookingId: result.bookingId,
        mechanicId: result.mechanicId,
        scheduledDate: result.scheduledDate,
        scheduledTime: result.scheduledTime,
      });
    }
  }

  async function handleSetupReschedule() {
    const s = scenarios.reschedule;
    const result = await withBusy("reschedule", "Setup", () =>
      setupReschedule({ shopId, scheduledDate: s.inputDate, scheduledTime: s.inputTime }),
    );
    if (result) {
      patch("reschedule", {
        bookingId: result.bookingId,
        mechanicId: result.mechanicId,
        scheduledDate: result.scheduledDate,
        scheduledTime: result.scheduledTime,
      });
    }
  }

  async function handleSetupMechanicActiveJob() {
    if (!selectedMechanicId) {
      patch("mechanicActiveJob", { message: "Pick a mechanic first." });
      return;
    }
    const s = scenarios.mechanicActiveJob;
    const result = await withBusy("mechanicActiveJob", "Setup", () =>
      setupMechanicActiveJob({
        shopId,
        mechanicId: selectedMechanicId,
        scheduledDate: s.inputDate,
        scheduledTime: s.inputTime,
      }),
    );
    if (result) {
      patch("mechanicActiveJob", {
        bookingId: result.bookingId,
        mechanicId: result.mechanicId,
        scheduledDate: result.scheduledDate,
        scheduledTime: result.scheduledTime,
      });
    }
  }

  async function handleSetupJobOverrun() {
    if (!selectedMechanicId) {
      patch("jobOverrun", { message: "Pick a mechanic first." });
      return;
    }
    const s = scenarios.jobOverrun;
    const result = await withBusy("jobOverrun", "Setup", () =>
      setupJobOverrun({
        shopId,
        mechanicId: selectedMechanicId,
        scheduledDate: s.inputDate,
        upstreamTime: s.inputTime,
        downstreamTime: s.inputDownstreamTime || undefined,
      }),
    );
    if (result) {
      patch("jobOverrun", {
        bookingId: result.bookingId,
        secondaryBookingId: result.downstreamBookingId,
        mechanicId: result.mechanicId,
        scheduledDate: result.scheduledDate,
        scheduledTime: result.scheduledTime,
      });
    }
  }

  async function handleClearAll() {
    setClearBusy(true);
    setClearMessage("Clearing…");
    try {
      const result = await clearTestArtifacts({ shopId });
      setClearMessage(
        `Cleared ${result.deletedBookings} bookings, ${result.deletedOutbox} outbox rows, ${result.deletedMonitors} monitors, ${result.deletedCheckins} check-ins.`,
      );
      setScenarios({
        earlyCheckin:      makeEmptyState(todayISO(), nowPlusHHMM(30)),
        earlyEnd:          makeEmptyState(todayISO(), nowPlusHHMM(-10)),
        customerLate:      makeEmptyState(todayISO(), nowPlusHHMM(0)),
        reschedule:        makeEmptyState(tomorrowISO(), "12:00"),
        mechanicActiveJob: makeEmptyState(todayISO(), nowPlusHHMM(0)),
        jobOverrun:        makeEmptyState(todayISO(), nowPlusHHMM(0), nowPlusHHMM(30)),
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      setClearMessage(`Clear failed: ${msg}`);
    } finally {
      setClearBusy(false);
    }
  }

  return (
    <div className="bg-white rounded-xl border-2 border-amber-300 p-6">
      <div className="flex items-center gap-2 mb-1">
        <Sparkles className="h-4 w-4 text-amber-600" />
        <h2 className="text-sm font-semibold text-amber-900 uppercase tracking-wide">
          Developer / Test Tools
        </h2>
      </div>
      <p className="text-xs text-gray-500 mb-5">
        Dev-only. Visible because <code className="font-mono">NODE_ENV === &quot;development&quot;</code>.
        Each card sets up a fresh test booking then fires the named feature so
        QA can verify the flow without waiting real minutes. Use the Clear
        button at the bottom to purge all test artifacts.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ScenarioCard
          icon={<CarFront className="h-4 w-4 text-blue-600" />}
          title="Early check-in"
          description="Customer arrives before scheduled start. Sets vehicle_arrived_at_ms, transitions confirmed → vehicle_at_shop."
          state={scenarios.earlyCheckin}
          onSetup={handleSetupEarlyCheckin}
          onDateChange={(d) => patch("earlyCheckin", { inputDate: d })}
          onTimeChange={(t) => patch("earlyCheckin", { inputTime: t })}
          triggers={[
            {
              label: "Trigger check-in",
              icon: <UserCheck className="h-3.5 w-3.5" />,
              onClick: () =>
                withBusy("earlyCheckin", "Trigger", () =>
                  triggerEarlyCheckin({
                    bookingId: scenarios.earlyCheckin.bookingId!,
                  }),
                ),
            },
          ]}
        />

        <ScenarioCard
          icon={<CheckCircle2 className="h-4 w-4 text-green-600" />}
          title="Early end"
          description="Booking marked complete before scheduled_end. Patches completed_at_ms on job_actuals and transitions to completed."
          state={scenarios.earlyEnd}
          onSetup={handleSetupEarlyEnd}
          onDateChange={(d) => patch("earlyEnd", { inputDate: d })}
          onTimeChange={(t) => patch("earlyEnd", { inputTime: t })}
          triggers={[
            {
              label: "Trigger complete",
              icon: <CheckCircle2 className="h-3.5 w-3.5" />,
              onClick: () =>
                withBusy("earlyEnd", "Trigger", () =>
                  triggerEarlyEnd({
                    bookingId: scenarios.earlyEnd.bookingId!,
                  }),
                ),
            },
          ]}
        />

        <ScenarioCard
          icon={<Clock className="h-4 w-4 text-orange-600" />}
          title="Customer late"
          description="3-tier escalation: +11 push, +21 SMS, +31 front-desk decision. Runs processCustomerLateMonitors after each warp."
          state={scenarios.customerLate}
          onSetup={handleSetupCustomerLate}
          onDateChange={(d) => patch("customerLate", { inputDate: d })}
          onTimeChange={(t) => patch("customerLate", { inputTime: t })}
          triggers={[
            {
              label: "+11 (push)",
              icon: <Bell className="h-3.5 w-3.5" />,
              onClick: () =>
                withBusy("customerLate", "Push reminder", () =>
                  triggerCustomerLateAdvance({
                    bookingId: scenarios.customerLate.bookingId!,
                    advanceMinutes: 11,
                  }),
                ),
            },
            {
              label: "+21 (SMS)",
              icon: <Bell className="h-3.5 w-3.5" />,
              onClick: () =>
                withBusy("customerLate", "SMS reminder", () =>
                  triggerCustomerLateAdvance({
                    bookingId: scenarios.customerLate.bookingId!,
                    advanceMinutes: 21,
                  }),
                ),
            },
            {
              label: "+31 (front desk)",
              icon: <AlertTriangle className="h-3.5 w-3.5" />,
              onClick: () =>
                withBusy("customerLate", "Front-desk decision", () =>
                  triggerCustomerLateAdvance({
                    bookingId: scenarios.customerLate.bookingId!,
                    advanceMinutes: 31,
                  }),
                ),
            },
          ]}
        />

        <ScenarioCard
          icon={<RotateCcw className="h-4 w-4 text-purple-600" />}
          title="Reschedule notification"
          description="Owner proposes a new time. Enqueues a booking_reschedule_proposed outbox row to the customer."
          state={scenarios.reschedule}
          onSetup={handleSetupReschedule}
          onDateChange={(d) => patch("reschedule", { inputDate: d })}
          onTimeChange={(t) => patch("reschedule", { inputTime: t })}
          triggers={[
            {
              label: "Trigger propose",
              icon: <RotateCcw className="h-3.5 w-3.5" />,
              onClick: () =>
                withBusy("reschedule", "Propose reschedule", () =>
                  triggerRescheduleProposal({
                    bookingId: scenarios.reschedule.bookingId!,
                  }),
                ),
            },
          ]}
        />

        <div className="lg:col-span-2">
          <ScenarioCard
            icon={<Wrench className="h-4 w-4 text-cyan-700" />}
            title="Mechanic active job flow"
            description="Pick a mechanic, then start a job assigned to them. Active-job-strip will surface reactively when that mechanic signs in."
            state={scenarios.mechanicActiveJob}
            onSetup={handleSetupMechanicActiveJob}
            onDateChange={(d) => patch("mechanicActiveJob", { inputDate: d })}
            onTimeChange={(t) => patch("mechanicActiveJob", { inputTime: t })}
            extraHeader={
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500">Mechanic:</label>
                <select
                  value={selectedMechanicId ?? ""}
                  onChange={(event) =>
                    setSelectedMechanicId(
                      event.target.value
                        ? (event.target.value as Id<"mechanics">)
                        : null,
                    )
                  }
                  className="text-xs rounded border border-gray-200 px-2 py-1"
                >
                  <option value="">Select…</option>
                  {(mechanics ?? []).map((m: any) => (
                    <option key={m._id} value={m._id}>
                      {m.first_name} {m.last_name}
                      {m.is_active ? "" : " (inactive)"}
                    </option>
                  ))}
                </select>
              </div>
            }
            triggers={[
              {
                label: "Trigger start",
                icon: <Play className="h-3.5 w-3.5" />,
                onClick: () =>
                  withBusy("mechanicActiveJob", "Start job", () =>
                    triggerMechanicJobStart({
                      bookingId: scenarios.mechanicActiveJob.bookingId!,
                    }),
                  ),
              },
            ]}
          />
        </div>

        <div className="lg:col-span-2">
          <ScenarioCard
            icon={<Timer className="h-4 w-4 text-orange-600" />}
            title="Job overrun — blocking/non-blocking cascade"
            description="Creates an in-progress upstream job + a confirmed downstream job on the same mechanic. Trigger fires the overrun prompt on the mechanic dashboard. Use the bay-free toggle to test the non-blocking path (nothing moves) vs blocking (downstream shifts)."
            state={scenarios.jobOverrun}
            onSetup={handleSetupJobOverrun}
            onDateChange={(d) => patch("jobOverrun", { inputDate: d })}
            onTimeChange={(t) => patch("jobOverrun", { inputTime: t })}
            downstreamTime={scenarios.jobOverrun.inputDownstreamTime}
            onDownstreamTimeChange={(t) => patch("jobOverrun", { inputDownstreamTime: t })}
            secondaryBookingId={scenarios.jobOverrun.secondaryBookingId}
            extraHeader={
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500">Mechanic:</label>
                <select
                  value={selectedMechanicId ?? ""}
                  onChange={(event) =>
                    setSelectedMechanicId(
                      event.target.value
                        ? (event.target.value as Id<"mechanics">)
                        : null,
                    )
                  }
                  className="text-xs rounded border border-gray-200 px-2 py-1"
                >
                  <option value="">Select…</option>
                  {(mechanics ?? []).map((m: any) => (
                    <option key={m._id} value={m._id}>
                      {m.first_name} {m.last_name}
                      {m.is_active ? "" : " (inactive)"}
                    </option>
                  ))}
                </select>
              </div>
            }
            triggers={[
              {
                label: "Trigger overrun",
                icon: <Timer className="h-3.5 w-3.5" />,
                onClick: () =>
                  withBusy("jobOverrun", "Trigger overrun", () =>
                    triggerJobOverrun({
                      bookingId: scenarios.jobOverrun.bookingId!,
                    }),
                  ),
              },
            ]}
          />
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-amber-100 pt-4">
        <button
          type="button"
          onClick={() => void handleClearAll()}
          disabled={clearBusy}
          className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors disabled:opacity-60"
        >
          {clearBusy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          Clear all test artifacts
        </button>
        {clearMessage && (
          <p className="text-xs text-gray-600">{clearMessage}</p>
        )}
      </div>
    </div>
  );
}

function ScenarioCard({
  icon,
  title,
  description,
  state,
  onSetup,
  triggers,
  extraHeader,
  onDateChange,
  onTimeChange,
  downstreamTime,
  onDownstreamTimeChange,
  secondaryBookingId,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  state: ScenarioState;
  onSetup: () => Promise<void>;
  triggers: Array<{
    label: string;
    icon: React.ReactNode;
    onClick: () => Promise<unknown>;
  }>;
  extraHeader?: React.ReactNode;
  onDateChange?: (date: string) => void;
  onTimeChange?: (time: string) => void;
  /** jobOverrun only: downstream slot time. */
  downstreamTime?: string;
  onDownstreamTimeChange?: (time: string) => void;
  secondaryBookingId?: Id<"bookings"> | null;
}) {
  const hasBooking = state.bookingId !== null;
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        </div>
        {extraHeader}
      </div>
      <p className="text-xs text-gray-500 mb-3 leading-relaxed">{description}</p>

      {/* Editable date + time inputs — visible before and after setup */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="text-xs text-gray-500 shrink-0">
          {downstreamTime !== undefined ? "Upstream date:" : "Date:"}
        </label>
        <input
          type="date"
          value={state.inputDate}
          onChange={(e) => onDateChange?.(e.target.value)}
          disabled={state.busy}
          className="rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 disabled:opacity-50"
        />
        <label className="text-xs text-gray-500 shrink-0">
          {downstreamTime !== undefined ? "Upstream time:" : "Time:"}
        </label>
        <input
          type="time"
          value={state.inputTime}
          onChange={(e) => onTimeChange?.(e.target.value)}
          disabled={state.busy}
          className="rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 disabled:opacity-50"
        />
        {downstreamTime !== undefined && (
          <>
            <label className="text-xs text-gray-500 shrink-0">Downstream time:</label>
            <input
              type="time"
              value={downstreamTime}
              onChange={(e) => onDownstreamTimeChange?.(e.target.value)}
              disabled={state.busy}
              className="rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 disabled:opacity-50"
            />
          </>
        )}
      </div>

      {/* Booking IDs shown after a successful Setup */}
      {hasBooking && (
        <div className="mb-3 space-y-1">
          <div className="rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700">
            <span className="text-gray-400 mr-1">
              {secondaryBookingId != null ? "Upstream:" : "Booking:"}
            </span>
            <span className="font-mono">{String(state.bookingId).slice(-8)}</span>
            {state.scheduledDate && (
              <span className="ml-2 text-gray-500">
                {state.scheduledDate} {state.scheduledTime}
              </span>
            )}
          </div>
          {secondaryBookingId != null && (
            <div className="rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700">
              <span className="text-gray-400 mr-1">Downstream:</span>
              <span className="font-mono">{String(secondaryBookingId).slice(-8)}</span>
              {downstreamTime && (
                <span className="ml-2 text-gray-500">{downstreamTime}</span>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void onSetup()}
          disabled={state.busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {state.busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          Setup
        </button>
        {triggers.map((t) => (
          <button
            key={t.label}
            type="button"
            onClick={() => void t.onClick()}
            disabled={!hasBooking || state.busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {state.message && (
        <p className="mt-2 text-xs text-gray-600">{state.message}</p>
      )}
    </div>
  );
}
