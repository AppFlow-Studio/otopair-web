"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Bell,
  CalendarX,
  Check,
  CheckCheck,
  Inbox,
  Loader2,
  History as HistoryIcon,
  Settings2,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  NotificationCard,
  type NotificationItem,
} from "@/components/notifications/notification-card";
import { LiveAlertCard } from "@/components/notifications/live-alert-card";
import { useLiveAlerts } from "@/components/notifications/use-live-alerts";
import {
  SettingsCard,
  AlertBanner,
  BTN_PRIMARY,
} from "@/components/settings/primitives";
import {
  Select,
  SelectItem,
  SelectListBox,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  categoriesForScope,
  resolvePrefs,
  humanizeOutboxCategory,
  type NotifChannelPrefs,
} from "./notification-config";

type Tab = "inbox" | "history" | "preferences";
type InboxFilter = "all" | "live" | "confirm" | "tire" | "rotor";

const TABS: Array<{ id: Tab; label: string; icon: React.ElementType }> = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "history", label: "History", icon: HistoryIcon },
  { id: "preferences", label: "Preferences", icon: Settings2 },
];

function relativeTime(ts: number | null | undefined): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/* ------------------------------------------------------------------ */
/*  Small switch                                                        */
/* ------------------------------------------------------------------ */

function Toggle({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-primary" : "bg-gray-300",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Inbox                                                               */
/* ------------------------------------------------------------------ */

function InboxView({ isMechanic }: { isMechanic: boolean }) {
  const feed = useQuery(api.mechanicNotifications.getFeed);
  const { alerts: liveAlerts } = useLiveAlerts();
  const scheduleContext = useQuery(api.schedule.getScheduleContext);
  const markAllRead = useMutation(api.mechanicNotifications.markAllRead);
  // Durable record of customers who never arrived — the persistent counterpart
  // to the ephemeral live alert, so a missed no-show still leaves a trail even
  // if the live alert was dismissed. Only `booking_never_started` (the others
  // in this feed are already covered by the booking/quote feed above).
  const staffNotifications = useQuery(api.notifications.getShopStaffNotifications);
  const missedItems = ((staffNotifications ?? []) as any[]).filter(
    (n) => n.category === "booking_never_started",
  );

  const [filter, setFilter] = useState<InboxFilter>("all");
  const [mechanicFilter, setMechanicFilter] = useState<string>("all");
  const [skipped, setSkipped] = useState<Set<string>>(new Set());

  const items: NotificationItem[] = (feed?.items ?? []) as NotificationItem[];
  const mechanics = scheduleContext?.mechanics ?? [];

  const notSkipped = items.filter((i) => !skipped.has(String(i.bookingId)));

  const confirmCount = notSkipped.filter((i) => i.kind === "booking").length;
  const tireCount = notSkipped.filter((i) => i.kind === "tire_quote").length;
  const rotorCount = notSkipped.filter((i) => i.kind === "rotor_quote").length;
  const liveCount = liveAlerts.length;

  const byMechanic = (item: NotificationItem) => {
    if (mechanicFilter === "all") return true;
    // Only booking items carry an assignment; quote requests are unassigned
    // shop work, so a specific-mechanic filter hides them.
    if (item.kind !== "booking") return false;
    return String((item as any).mechanicId ?? "") === mechanicFilter;
  };

  const visibleItems = notSkipped
    .filter((i) => {
      if (filter === "confirm") return i.kind === "booking";
      if (filter === "tire") return i.kind === "tire_quote";
      if (filter === "rotor") return i.kind === "rotor_quote";
      if (filter === "live") return false;
      return true;
    })
    .filter(byMechanic);

  const visibleAlerts = liveAlerts.filter((a) => {
    if (mechanicFilter === "all") return true;
    return a.mechanicId ? String(a.mechanicId) === mechanicFilter : false;
  });

  const showAlerts =
    (filter === "all" || filter === "live") && visibleAlerts.length > 0;
  const showItems = filter !== "live";

  const chips: Array<{ id: InboxFilter; label: string; count?: number }> = [
    { id: "all", label: "All" },
    { id: "live", label: "Live", count: liveCount },
    { id: "confirm", label: "To confirm", count: confirmCount },
    { id: "tire", label: "Tire quotes", count: tireCount },
    { id: "rotor", label: "Rotor quotes", count: rotorCount },
  ];

  // Missed appointments show in the "All" and "Live" views (they're urgent),
  // never filtered away by the booking/quote chips.
  const showMissed =
    (filter === "all" || filter === "live") && missedItems.length > 0;

  const isLoading = feed === undefined;
  const nothingToShow =
    !showAlerts &&
    !showMissed &&
    (!showItems || visibleItems.length === 0);

  return (
    <div className="space-y-4">
      {/* Filter chips + owner mechanic filter */}
      <div className="flex flex-wrap items-center gap-2">
        {chips.map((chip) => {
          const active = filter === chip.id;
          return (
            <button
              key={chip.id}
              type="button"
              onClick={() => setFilter(chip.id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                active
                  ? "border-primary bg-primary text-white"
                  : "border-border bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {chip.label}
              {chip.count !== undefined && chip.count > 0 && (
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[10px] font-semibold leading-4",
                    active ? "bg-white/25 text-white" : "bg-muted text-foreground",
                  )}
                >
                  {chip.count}
                </span>
              )}
            </button>
          );
        })}

        {!isMechanic && mechanics.length > 0 && (
          <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <User className="h-3.5 w-3.5" />
            <Select
              selectedKey={mechanicFilter}
              onSelectionChange={(k) => setMechanicFilter(String(k))}
            >
              <SelectTrigger className="h-8 w-44 rounded-lg border-border bg-card px-3 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectPopover placement="bottom end">
                <SelectListBox shouldFocusWrap>
                  <SelectItem id="all" textValue="All mechanics">
                    All mechanics
                  </SelectItem>
                  {mechanics.map((m: any) => (
                    <SelectItem
                      key={String(m._id)}
                      id={String(m._id)}
                      textValue={m.name}
                    >
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectListBox>
              </SelectPopover>
            </Select>
          </div>
        )}
      </div>

      {/* Body */}
      {isLoading ? (
        <div className="flex items-center justify-center rounded-xl border border-border bg-card py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : nothingToShow ? (
        <div className="rounded-xl border border-border bg-card px-6 py-16 text-center">
          <Bell className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm font-medium text-foreground">
            You&rsquo;re all caught up
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {isMechanic
              ? "New jobs assigned to you and live alerts will show up here."
              : "New bookings, quote requests, and live alerts will show up here."}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {showAlerts && (
            <div className="bg-amber-50/40">
              <div className="border-b border-border px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-amber-700">
                Live now
              </div>
              <ul className="divide-y divide-border">
                {visibleAlerts.map((alert) => (
                  <LiveAlertCard key={alert.id} alert={alert} />
                ))}
              </ul>
            </div>
          )}
          {showMissed && (
            <div className="bg-red-50/40">
              <div className="border-b border-border px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-red-700">
                Missed appointments
              </div>
              <ul className="divide-y divide-border">
                {missedItems.map((n) => (
                  <li
                    key={String(n._id)}
                    className="flex items-start gap-3 px-4 py-3"
                  >
                    <CalendarX className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground">
                        {n.customerName ?? "Customer"} never arrived
                        {n.shortHandle ? (
                          <span className="ml-1 text-xs font-normal text-muted-foreground">
                            {n.shortHandle}
                          </span>
                        ) : null}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {[
                          n.vehicleLabel,
                          n.scheduledDate && n.scheduledTime
                            ? `${n.scheduledDate} · ${n.scheduledTime}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {showItems && visibleItems.length > 0 && (
            <ul className="divide-y divide-border">
              {visibleItems.map((item) => (
                <NotificationCard
                  key={String(item.bookingId)}
                  item={item}
                  onSkip={(id) =>
                    setSkipped((prev) => new Set(prev).add(id))
                  }
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {(feed?.unreadCount ?? 0) > 0 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => markAllRead({})}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <CheckCheck className="h-3.5 w-3.5" />
            Mark all read
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  History                                                             */
/* ------------------------------------------------------------------ */

function HistoryView() {
  const history = useQuery(api.notifications.getShopStaffNotificationHistory);

  if (history === undefined) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-border bg-card py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card px-6 py-16 text-center">
        <HistoryIcon className="mx-auto h-8 w-8 text-muted-foreground/50" />
        <p className="mt-3 text-sm font-medium text-foreground">
          No activity yet
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Past notifications — open and resolved — will be listed here.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <ul className="divide-y divide-border">
        {history.map((row: any) => {
          const open = row.resolved_at == null;
          const descriptor = [row.customerName, row.vehicleLabel]
            .filter(Boolean)
            .join(" · ");
          return (
            <li
              key={String(row._id)}
              className="flex items-start justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {humanizeOutboxCategory(row.category)}
                  </span>
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                      open
                        ? "bg-amber-50 text-amber-700"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {open ? "Open" : "Resolved"}
                  </span>
                </div>
                {descriptor && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {descriptor}
                    {row.shortHandle ? (
                      <span className="ml-1 text-muted-foreground/70">
                        {row.shortHandle}
                      </span>
                    ) : null}
                  </p>
                )}
              </div>
              <span className="shrink-0 text-xs text-muted-foreground/70">
                {relativeTime(row.created_at)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Preferences                                                         */
/* ------------------------------------------------------------------ */

function PreferencesView({
  isMechanic,
  stored,
}: {
  isMechanic: boolean;
  stored: Record<string, { inApp?: boolean; email?: boolean }> | null | undefined;
}) {
  const updatePrefs = useMutation(
    api.notificationPreferences.updateMyNotificationPreferences,
  );
  const categories = categoriesForScope(isMechanic);

  const [draft, setDraft] = useState<Record<string, NotifChannelPrefs> | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Initialize the editable draft once, merging stored values over defaults.
  useEffect(() => {
    if (draft === null) setDraft(resolvePrefs(isMechanic, stored));
  }, [draft, isMechanic, stored]);

  const setChannel = (
    key: string,
    channel: keyof NotifChannelPrefs,
    value: boolean,
  ) => {
    setSaved(false);
    setDraft((prev) =>
      prev
        ? { ...prev, [key]: { ...prev[key], [channel]: value } }
        : prev,
    );
  };

  async function handleSave() {
    if (!draft) return;
    setSaving(true);
    try {
      await updatePrefs({ preferences: draft });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  if (!draft) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-border bg-card py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {saved && (
        <AlertBanner tone="success">Notification preferences saved.</AlertBanner>
      )}

      <SettingsCard
        title="Delivery preferences"
        description={
          isMechanic
            ? "Choose how you're notified about the work assigned to you. In-app alerts for assigned jobs can't be turned off."
            : "Choose how your shop is notified for each kind of event. In-app alerts for actionable work can't be turned off."
        }
        icon={<Bell className="h-4 w-4 text-muted-foreground" />}
      >
        <div className="overflow-hidden rounded-lg border border-border">
          {/* Column header */}
          <div className="flex items-center gap-4 border-b border-border bg-muted/40 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span className="flex-1">Notification</span>
            <span className="w-14 text-center">In-app</span>
            <span className="w-14 text-center">Email</span>
          </div>
          <div className="divide-y divide-border">
            {categories.map((cat) => {
              const ch = draft[cat.key] ?? { inApp: true, email: false };
              return (
                <div
                  key={cat.key}
                  className="flex items-center gap-4 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">
                      {cat.label}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {cat.description}
                    </p>
                  </div>
                  <div className="flex w-14 justify-center">
                    <Toggle
                      label={`${cat.label} in-app`}
                      checked={cat.inAppLocked ? true : ch.inApp}
                      disabled={cat.inAppLocked}
                      onChange={(v) => setChannel(cat.key, "inApp", v)}
                    />
                  </div>
                  <div className="flex w-14 justify-center">
                    <Toggle
                      label={`${cat.label} email`}
                      checked={ch.email}
                      onChange={(v) => setChannel(cat.key, "email", v)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          {saved && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
              <Check className="h-3.5 w-3.5" /> Saved
            </span>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className={BTN_PRIMARY}
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Save preferences"
            )}
          </button>
        </div>
      </SettingsCard>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page shell                                                          */
/* ------------------------------------------------------------------ */

function NotificationsInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const prefsData = useQuery(
    api.notificationPreferences.getMyNotificationPreferences,
  );
  const feed = useQuery(api.mechanicNotifications.getFeed);

  const rawTab = searchParams.get("tab");
  const tab: Tab =
    rawTab === "history" || rawTab === "preferences" ? rawTab : "inbox";

  const isMechanic = prefsData?.scopeKind === "mechanic";
  const unread = feed?.unreadCount ?? 0;

  const setTab = (next: Tab) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", next);
    router.replace(`/notifications?${params.toString()}`);
  };

  return (
    <div className="mx-auto max-w-3xl pb-16">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
            <Bell className="h-6 w-6 text-muted-foreground" />
            Notifications
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {prefsData === undefined
              ? " "
              : isMechanic
                ? "Showing the work assigned to you."
                : "Showing shop-wide activity across your team."}
          </p>
        </div>
        {unread > 0 && (
          <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
            {unread > 99 ? "99+" : unread} unread
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="mt-5 flex items-center gap-1 border-b border-border">
        {TABS.map((t) => {
          const active = tab === t.id;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
                active
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Body */}
      <div className="mt-6">
        {tab === "inbox" && <InboxView isMechanic={!!isMechanic} />}
        {tab === "history" && <HistoryView />}
        {tab === "preferences" &&
          (prefsData === undefined ? (
            <div className="flex items-center justify-center rounded-xl border border-border bg-card py-16">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <PreferencesView
              isMechanic={!!isMechanic}
              stored={prefsData?.preferences}
            />
          ))}
      </div>
    </div>
  );
}

export default function NotificationsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <NotificationsInner />
    </Suspense>
  );
}
