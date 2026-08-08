/**
 * notification-config.ts — the role-differentiated catalog of notification
 * categories shown on the /notifications "Preferences" tab, plus helpers to
 * humanize history/outbox category keys.
 *
 * The preferences object persisted via
 * `api.notificationPreferences.updateMyNotificationPreferences` is a flat map:
 *   { [categoryKey]: { inApp: boolean; email: boolean } }
 *
 * `inAppLocked` categories are actionable work the user must see in-app — the
 * in-app channel can't be turned off, only email can be added.
 */

export type NotifChannelPrefs = { inApp: boolean; email: boolean };

export type NotifCategory = {
  key: string;
  label: string;
  description: string;
  /** In-app delivery is mandatory (actionable work); only email is optional. */
  inAppLocked?: boolean;
};

/** Shop-wide roles: owner / manager / admin / front-desk. */
export const OWNER_CATEGORIES: NotifCategory[] = [
  {
    key: "new_booking",
    label: "New bookings",
    description: "A customer requests or books an appointment at your shop.",
    inAppLocked: true,
  },
  {
    key: "tire_quote",
    label: "Tire quote requests",
    description: "Open tire quote requests waiting for your price.",
  },
  {
    key: "rotor_quote",
    label: "Rotor quote requests",
    description: "Open rotor / brake quote requests waiting for your price.",
  },
  {
    key: "no_show",
    label: "No-show decisions",
    description:
      "A customer is past the grace window and needs a keep-or-cancel call.",
    inAppLocked: true,
  },
  {
    key: "overrun",
    label: "Overrun escalations",
    description: "A job is running long and needs an extension decision.",
  },
  {
    key: "manual_scheduling",
    label: "Manual scheduling reviews",
    description: "A booking couldn't auto-place and needs manual scheduling.",
  },
  {
    key: "late_start",
    label: "Late-start decisions",
    description: "An earlier job ran over and threatens later appointments.",
  },
  {
    key: "booking_never_started",
    label: "Never-started jobs",
    description: "A confirmed job's start time passed without a check-in.",
  },
];

/** Mechanic roles — own-scoped work only. */
export const MECHANIC_CATEGORIES: NotifCategory[] = [
  {
    key: "new_job_assigned",
    label: "Jobs assigned to me",
    description: "A booking is assigned to you.",
    inAppLocked: true,
  },
  {
    key: "on_my_way",
    label: "Customer en route",
    description: "A customer for one of your jobs is on the way.",
  },
  {
    key: "overrun",
    label: "Overrun on my jobs",
    description: "One of your jobs is running long and may need an extension.",
  },
  {
    key: "late_start",
    label: "Late start affecting me",
    description: "An earlier job ran over and may push your schedule back.",
  },
];

export const DEFAULT_CHANNELS: NotifChannelPrefs = { inApp: true, email: false };

export function categoriesForScope(isMechanic: boolean): NotifCategory[] {
  return isMechanic ? MECHANIC_CATEGORIES : OWNER_CATEGORIES;
}

/**
 * Merge the stored preferences object with the role-appropriate defaults so a
 * category the user has never touched still renders with sane channel state.
 */
export function resolvePrefs(
  isMechanic: boolean,
  stored: Record<string, { inApp?: boolean; email?: boolean }> | null | undefined,
): Record<string, NotifChannelPrefs> {
  const out: Record<string, NotifChannelPrefs> = {};
  for (const cat of categoriesForScope(isMechanic)) {
    const s = stored?.[cat.key];
    out[cat.key] = {
      // Locked categories are always in-app on regardless of stored value.
      inApp: cat.inAppLocked ? true : s?.inApp ?? DEFAULT_CHANNELS.inApp,
      email: s?.email ?? DEFAULT_CHANNELS.email,
    };
  }
  return out;
}

/** Human label for a notification_outbox `category` key (History tab). */
const OUTBOX_CATEGORY_LABELS: Record<string, string> = {
  new_booking: "New booking",
  new_quote_request: "Quote request",
  new_job_assigned: "Job assigned",
  booking_never_started: "Job never started",
  booking_reschedule_proposed: "Reschedule proposed",
  booking_forced_delay_proposed: "Delay proposed",
};

export function humanizeOutboxCategory(category: string): string {
  return (
    OUTBOX_CATEGORY_LABELS[category] ??
    category
      .split("_")
      .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ")
  );
}
