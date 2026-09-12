import { describe, expect, test } from "vitest";
import {
  classifyBookingLifecycleActor,
  getBookingWorkflowUnavailableNotice,
} from "../lib/booking-workflow-state";

const inProgress = {
  status: "in_progress",
  latestLifecycleEvent: null,
};

describe("getBookingWorkflowUnavailableNotice", () => {
  test("keeps a workflow open while its booking detail is loading", () => {
    expect(getBookingWorkflowUnavailableNotice(undefined, ["in_progress"])).toBeNull();
  });

  test("keeps a workflow open in an allowed state", () => {
    expect(getBookingWorkflowUnavailableNotice(inProgress, ["in_progress"])).toBeNull();
  });

  test("explains a customer cancellation", () => {
    expect(
      getBookingWorkflowUnavailableNotice(
        {
          status: "cancelled",
          latestLifecycleEvent: {
            status: "cancelled",
            reason: "user_cancelled",
            actor: "customer",
            actorName: null,
          },
        },
        ["in_progress"],
      ),
    ).toBe("This booking is no longer available. It was cancelled by the customer.");
  });

  test("explains a cancellation by known shop staff", () => {
    expect(
      getBookingWorkflowUnavailableNotice(
        {
          status: "cancelled",
          latestLifecycleEvent: {
            status: "cancelled",
            reason: "cancelled_by_shop",
            actor: "shop_member",
            actorName: "Maria Chen",
          },
        },
        ["in_progress"],
      ),
    ).toBe("This booking is no longer available. It was cancelled by Maria Chen.");
  });

  test("uses neutral copy when a cancellation actor is unknown", () => {
    expect(
      getBookingWorkflowUnavailableNotice(
        {
          status: "cancelled",
          latestLifecycleEvent: {
            status: "cancelled",
            reason: "auto_cancelled",
            actor: "unknown",
            actorName: null,
          },
        },
        ["in_progress"],
      ),
    ).toBe("This booking is no longer available.");
  });

  test("uses the reschedule notice even if pending customer acceptance is allowed", () => {
    expect(
      getBookingWorkflowUnavailableNotice(
        {
          status: "pending_customer_acceptance",
          latestLifecycleEvent: {
            status: "pending_customer_acceptance",
            reason: "reschedule_proposed_by_shop",
            actor: "shop_member",
            actorName: "Maria Chen",
          },
        },
        ["vehicle_at_shop", "pending_customer_acceptance"],
      ),
    ).toBe("This booking is no longer available. It has been rescheduled.");
  });

  test("explains completion by another session", () => {
    expect(
      getBookingWorkflowUnavailableNotice(
        { status: "completed", latestLifecycleEvent: null },
        ["in_progress"],
      ),
    ).toBe("This booking is no longer available. It has already been completed.");
  });

  test("uses neutral copy for a missing booking", () => {
    expect(getBookingWorkflowUnavailableNotice(null, ["in_progress"])).toBe(
      "This booking is no longer available.",
    );
  });
});

describe("classifyBookingLifecycleActor", () => {
  test("classifies the booking owner as the customer", () => {
    expect(
      classifyBookingLifecycleActor({
        bookingUserId: "customer-id",
        changedBy: "customer-id",
        changedByName: "Aubrey Becker",
      }),
    ).toEqual({ actor: "customer", actorName: null });
  });

  test("classifies a resolved different user as shop staff", () => {
    expect(
      classifyBookingLifecycleActor({
        bookingUserId: "customer-id",
        changedBy: "staff-id",
        changedByName: "Maria Chen",
      }),
    ).toEqual({ actor: "shop_member", actorName: "Maria Chen" });
  });

  test("uses neutral attribution without a resolved actor", () => {
    expect(
      classifyBookingLifecycleActor({
        bookingUserId: "customer-id",
        changedBy: undefined,
        changedByName: null,
      }),
    ).toEqual({ actor: "unknown", actorName: null });
  });
});
