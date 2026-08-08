"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Bell,
  CalendarCheck,
  Clock,
  CreditCard,
  ExternalLink,
  Globe,
  Mail,
  MapPin,
  Phone,
  ShieldCheck,
  Store,
  Tag,
  User,
  Users,
  Wrench,
  LogOut,
  Zap,
} from "lucide-react";
import {
  DEFAULT_NO_SHOW_THRESHOLD_MINUTES,
  DEFAULT_OVERRUN_AUTO_APPLY_MINUTES,
  DEFAULT_OVERRUN_ESCALATION_MINUTES,
  DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES,
  DEFAULT_OVERRUN_EXTENSION_PERCENT,
} from "@/lib/scheduling-overhaul";
import { detectTimezoneFromState, US_TIMEZONES } from "@/lib/shopTimezone";
import HoursEditor from "./hours-editor";
import ShopLogoUploader from "./logo-uploader";
import PortfolioManager from "./portfolio-manager";
import ServicesEditor from "./services-editor";
import LaborRateCard from "./labor-rate-card";
import LicensesManager from "./licenses-manager";
import DevTestTools from "./dev-test-tools";
import {
  SettingsCard,
  SubSection,
  BTN_PRIMARY,
  BTN_SECONDARY,
  FIELD_INPUT,
} from "@/components/settings/primitives";
import {
  SettingsSaveProvider,
  useRegisterSaveable,
} from "@/components/settings/save-manager";
import {
  SettingsNav,
  type SettingsNavGroup,
} from "@/components/settings/settings-nav";

const schedFieldLabel = "text-sm font-medium text-foreground";
const schedFieldHelp = "mt-1 block text-xs text-muted-foreground";
const schedFieldInput = `mt-2 ${FIELD_INPUT}`;

const NAV_GROUPS: SettingsNavGroup[] = [
  {
    heading: "Shop",
    items: [
      { id: "general", label: "General", icon: Store },
      { id: "hours", label: "Hours", icon: Clock },
      { id: "services", label: "Services", icon: Wrench },
      { id: "pricing", label: "Pricing", icon: Tag },
      { id: "licenses", label: "Licenses & Certs", icon: ShieldCheck },
    ],
  },
  {
    heading: "Operations",
    items: [
      { id: "booking-rules", label: "Booking rules", icon: CalendarCheck },
      { id: "notifications", label: "Notifications", icon: Bell, badge: "New" },
      { id: "team", label: "Team", icon: Users, href: "/team" },
    ],
  },
  {
    heading: "Financial",
    items: [{ id: "payouts", label: "Payouts", icon: CreditCard, href: "/payouts" }],
  },
  {
    heading: "Account",
    items: [{ id: "profile", label: "Profile", icon: User }],
  },
];

export default function SettingsPage() {
  return (
    <SettingsSaveProvider>
      <SettingsInner />
    </SettingsSaveProvider>
  );
}

function TabPanel({
  id,
  active,
  children,
}: {
  id: string;
  active: string;
  children: ReactNode;
}) {
  // Panels stay mounted (state + save registrations survive tab switches);
  // only the active one is shown.
  return (
    <div hidden={active !== id} className="space-y-6">
      {children}
    </div>
  );
}

function SettingsInner() {
  const { signOut } = useClerk();
  const { user } = useUser();
  const router = useRouter();
  const shops = useQuery(api.shops.getMyShops);
  const updateSchedulingSettings = useMutation(api.shops.updateMySchedulingSettings);
  const setShopTimezone = useMutation(api.shops.setShopTimezone);
  const shop = shops?.[0] ?? null;

  const [active, setActive] = useState("general");

  const [noShowThreshold, setNoShowThreshold] = useState(DEFAULT_NO_SHOW_THRESHOLD_MINUTES);
  const [overrunPercent, setOverrunPercent] = useState(DEFAULT_OVERRUN_EXTENSION_PERCENT);
  const [overrunFloor, setOverrunFloor] = useState(DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES);
  const [overrunEscalationMinutes, setOverrunEscalationMinutes] = useState(DEFAULT_OVERRUN_ESCALATION_MINUTES);
  const [overrunAutoApplyMinutes, setOverrunAutoApplyMinutes] = useState(DEFAULT_OVERRUN_AUTO_APPLY_MINUTES);
  const [bufferMinutes, setBufferMinutes] = useState(10);
  const [maxPerMechanic, setMaxPerMechanic] = useState(2);
  const [entityLabelMode, setEntityLabelMode] = useState<"mechanic" | "bay">("mechanic");
  const [reminderLeadMinutes, setReminderLeadMinutes] = useState(0);
  const [timezone, setTimezone] = useState("");
  const [timezoneHint, setTimezoneHint] = useState("");

  const savedTimezone = ((shop as any)?.timezone as string | undefined) ?? "";

  const resetScheduling = useCallback(() => {
    if (!shop) return;
    setNoShowThreshold(shop.no_show_threshold_minutes ?? DEFAULT_NO_SHOW_THRESHOLD_MINUTES);
    setOverrunPercent(shop.overrun_default_extension_percent ?? DEFAULT_OVERRUN_EXTENSION_PERCENT);
    setOverrunFloor(shop.overrun_extension_floor_minutes ?? DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES);
    setOverrunEscalationMinutes(shop.overrun_escalation_minutes ?? DEFAULT_OVERRUN_ESCALATION_MINUTES);
    setOverrunAutoApplyMinutes(shop.overrun_auto_apply_minutes ?? DEFAULT_OVERRUN_AUTO_APPLY_MINUTES);
    setBufferMinutes(shop.buffer_minutes ?? 10);
    setMaxPerMechanic(shop.max_bookings_per_mechanic_rolling_hour ?? 2);
    setEntityLabelMode(shop.entity_label_mode === "bay" ? "bay" : "mechanic");
    setReminderLeadMinutes(Number(shop.appointment_reminder_lead_minutes ?? 0));
  }, [shop]);

  useEffect(() => {
    if (!shop) return;
    setTimezone(savedTimezone);
    resetScheduling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shop]);

  async function handleSignOut() {
    await signOut();
    router.push("/");
  }

  function handleAutoDetectTimezone() {
    const detected = detectTimezoneFromState((shop as any)?.state);
    if (detected) {
      setTimezone(detected);
      setTimezoneHint(`Auto-detected from ${(shop as any)?.state}. Save to apply.`);
    } else {
      setTimezoneHint("Couldn't auto-detect — please select a timezone manually.");
    }
  }

  const saveTimezone = useCallback(async () => {
    if (!timezone || timezone === savedTimezone) return;
    await setShopTimezone({ timezone });
    setTimezoneHint("");
  }, [timezone, savedTimezone, setShopTimezone]);

  const saveScheduling = useCallback(async () => {
    await updateSchedulingSettings({
      noShowThresholdMinutes: noShowThreshold,
      overrunDefaultExtensionPercent: overrunPercent,
      overrunExtensionFloorMinutes: overrunFloor,
      bufferMinutes,
      maxBookingsPerMechanicRollingHour: maxPerMechanic,
      entityLabelMode,
      appointmentReminderLeadMinutes: reminderLeadMinutes,
      overrunEscalationMinutes,
      overrunAutoApplyMinutes,
    });
  }, [
    updateSchedulingSettings,
    noShowThreshold,
    overrunPercent,
    overrunFloor,
    bufferMinutes,
    maxPerMechanic,
    entityLabelMode,
    reminderLeadMinutes,
    overrunEscalationMinutes,
    overrunAutoApplyMinutes,
  ]);

  const timezoneDirty = !!shop && timezone !== savedTimezone;
  const schedulingDirty =
    !!shop &&
    (noShowThreshold !== (shop.no_show_threshold_minutes ?? DEFAULT_NO_SHOW_THRESHOLD_MINUTES) ||
      overrunPercent !== (shop.overrun_default_extension_percent ?? DEFAULT_OVERRUN_EXTENSION_PERCENT) ||
      overrunFloor !== (shop.overrun_extension_floor_minutes ?? DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES) ||
      overrunEscalationMinutes !== (shop.overrun_escalation_minutes ?? DEFAULT_OVERRUN_ESCALATION_MINUTES) ||
      overrunAutoApplyMinutes !== (shop.overrun_auto_apply_minutes ?? DEFAULT_OVERRUN_AUTO_APPLY_MINUTES) ||
      bufferMinutes !== (shop.buffer_minutes ?? 10) ||
      maxPerMechanic !== (shop.max_bookings_per_mechanic_rolling_hour ?? 2) ||
      entityLabelMode !== (shop.entity_label_mode === "bay" ? "bay" : "mechanic") ||
      reminderLeadMinutes !== Number(shop.appointment_reminder_lead_minutes ?? 0));

  useRegisterSaveable("tz", "General", timezoneDirty, saveTimezone, () =>
    setTimezone(savedTimezone),
  );
  useRegisterSaveable(
    "booking-rules",
    "Booking rules",
    schedulingDirty,
    saveScheduling,
    resetScheduling,
  );

  const isDev = process.env.NODE_ENV === "development";

  return (
    <div className="mx-auto max-w-5xl pb-24">
      <div className="flex flex-col gap-8 md:flex-row">
        <div className="md:sticky md:top-6 md:self-start">
          <SettingsNav groups={NAV_GROUPS} active={active} onSelect={setActive} />
        </div>

        <div className="min-w-0 flex-1">
          {/* GENERAL */}
          <TabPanel id="general" active={active}>
            {shops === undefined ? (
              <SettingsCard title="Shop">
                <p className="text-sm text-muted-foreground">Loading…</p>
              </SettingsCard>
            ) : !shop ? (
              <SettingsCard
                title="Shop"
                description="Set up your shop to start accepting bookings and managing your team."
              >
                <Link href="/shop/setup" className={BTN_PRIMARY}>
                  Set up shop
                </Link>
              </SettingsCard>
            ) : (
              <>
                <SettingsCard
                  title="Shop"
                  description="Your public profile, location, and contact details."
                  action={
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
                        shop.is_active
                          ? "bg-success/10 text-success"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {shop.is_active ? "Active" : "Inactive"}
                    </span>
                  }
                >
                  <div className="space-y-6">
                    <ShopLogoUploader
                      shopId={(shop as any)._id}
                      logoUrl={(shop as any).logoUrl ?? null}
                      memberRole={(shop as any).memberRole}
                      shopName={(shop as any).name}
                      shopSlug={(shop as any).slug}
                    />

                    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                      <SubSection title="Location & contact">
                        <ul className="space-y-3">
                          <li className="flex items-start gap-3 text-sm text-foreground">
                            <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                            <span>
                              {shop.address}
                              <br />
                              {shop.city}, {shop.state} {shop.zip}
                            </span>
                          </li>
                          <li className="flex items-center gap-3 text-sm text-foreground">
                            <Phone className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span>{shop.phone}</span>
                          </li>
                          {shop.email && (
                            <li className="flex items-center gap-3 text-sm text-foreground">
                              <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                              <span>{shop.email}</span>
                            </li>
                          )}
                          {shop.website && (
                            <li className="flex items-center gap-3 text-sm">
                              <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
                              <a
                                href={shop.website}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1 text-primary hover:underline"
                              >
                                {shop.website}
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            </li>
                          )}
                        </ul>
                      </SubSection>

                      {shop.description && (
                        <SubSection title="About">
                          <p className="text-sm leading-relaxed text-foreground">
                            {shop.description}
                          </p>
                        </SubSection>
                      )}
                    </div>
                  </div>
                </SettingsCard>

                {isDev && (
                  <SettingsCard
                    title="Shop timezone"
                    icon={<Clock className="h-4 w-4 text-muted-foreground" />}
                    description="Used to determine today's schedule and compute appointment times correctly. Should match the physical location of the shop."
                  >
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="min-w-[280px]">
                        <label className="mb-1.5 block text-sm font-medium text-foreground">
                          Timezone
                        </label>
                        <select
                          value={timezone}
                          onChange={(e) => setTimezone(e.target.value)}
                          className={FIELD_INPUT}
                        >
                          <option value="">— Select timezone —</option>
                          {US_TIMEZONES.map((tz) => (
                            <option key={tz.value} value={tz.value}>
                              {tz.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <button
                        type="button"
                        onClick={handleAutoDetectTimezone}
                        className={BTN_SECONDARY}
                      >
                        <Zap className="h-3.5 w-3.5 text-amber-500" />
                        Auto-detect from state
                      </button>
                    </div>
                    {timezoneHint && (
                      <p className="mt-2 text-sm text-muted-foreground">{timezoneHint}</p>
                    )}
                  </SettingsCard>
                )}

                <PortfolioManager
                  shopId={(shop as any)._id}
                  memberRole={(shop as any).memberRole}
                />
              </>
            )}
          </TabPanel>

          <TabPanel id="licenses" active={active}>
            {shop && <LicensesManager shopId={shop._id} />}
          </TabPanel>

          {/* HOURS */}
          <TabPanel id="hours" active={active}>
            {shop ? <HoursEditor /> : null}
          </TabPanel>

          {/* SERVICES */}
          <TabPanel id="services" active={active}>
            {shop ? <ServicesEditor /> : null}
          </TabPanel>

          {/* PRICING */}
          <TabPanel id="pricing" active={active}>
            {shop ? <LaborRateCard shopId={shop._id} /> : null}
          </TabPanel>

          {/* BOOKING RULES */}
          <TabPanel id="booking-rules" active={active}>
            {shop ? (
              <SettingsCard
                title="Booking rules"
                description="How the schedule handles buffers, overruns, no-shows, and reminders."
              >
                <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
                  <label className="block">
                    <span className={schedFieldLabel}>Buffer after job</span>
                    <select
                      value={bufferMinutes}
                      onChange={(event) => setBufferMinutes(Number(event.target.value))}
                      className={schedFieldInput}
                    >
                      {[10, 15, 20, 30].map((value) => (
                        <option key={value} value={value}>
                          {value} minutes
                        </option>
                      ))}
                    </select>
                    <span className={schedFieldHelp}>
                      Time reserved between jobs; next slot rounds up to the 15-minute grid.
                    </span>
                  </label>
                  <label className="block">
                    <span className={schedFieldLabel}>No-show threshold</span>
                    <select
                      value={noShowThreshold}
                      onChange={(event) => setNoShowThreshold(Number(event.target.value))}
                      className={schedFieldInput}
                    >
                      {[15, 30, 45, 60].map((value) => (
                        <option key={value} value={value}>
                          {value} minutes
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <span className={schedFieldLabel}>Default extension</span>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={overrunPercent}
                      onChange={(event) => setOverrunPercent(Number(event.target.value))}
                      className={schedFieldInput}
                    />
                    <span className={schedFieldHelp}>Percent of estimated job duration</span>
                  </label>

                  <label className="block">
                    <span className={schedFieldLabel}>Extension floor</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={overrunFloor}
                      onChange={(event) => setOverrunFloor(Number(event.target.value))}
                      className={schedFieldInput}
                    />
                    <span className={schedFieldHelp}>Minimum minutes applied by system default</span>
                  </label>

                  <label className="block">
                    <span className={schedFieldLabel}>Front desk escalation</span>
                    <input
                      type="number"
                      min={1}
                      max={30}
                      step={1}
                      value={overrunEscalationMinutes}
                      onChange={(event) => setOverrunEscalationMinutes(Number(event.target.value))}
                      className={schedFieldInput}
                    />
                    <span className={schedFieldHelp}>
                      Minutes after an overrun before the front desk is alerted.
                    </span>
                  </label>

                  <label className="block">
                    <span className={schedFieldLabel}>Auto-apply extension</span>
                    <input
                      type="number"
                      min={1}
                      max={60}
                      step={1}
                      value={overrunAutoApplyMinutes}
                      onChange={(event) => setOverrunAutoApplyMinutes(Number(event.target.value))}
                      className={schedFieldInput}
                    />
                    <span className={schedFieldHelp}>
                      Minutes after an overrun before the system auto-applies the default extension. Must be at or after front desk escalation.
                    </span>
                  </label>

                  <label className="block">
                    <span className={schedFieldLabel}>Max bookings per mechanic / hour</span>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={maxPerMechanic}
                      onChange={(event) => setMaxPerMechanic(Number(event.target.value))}
                      className={schedFieldInput}
                    />
                    <span className={schedFieldHelp}>
                      Soft cap on jobs per mechanic in any rolling 60-minute window.
                    </span>
                  </label>

                  <label className="block">
                    <span className={schedFieldLabel}>Booking entity label</span>
                    <select
                      value={entityLabelMode}
                      onChange={(event) =>
                        setEntityLabelMode(event.target.value as "mechanic" | "bay")
                      }
                      className={schedFieldInput}
                    >
                      <option value="mechanic">Mechanic (John, Mike, Sarah)</option>
                      <option value="bay">Bay (Bay 1, Bay 2, Bay 3)</option>
                    </select>
                    <span className={schedFieldHelp}>
                      How customer-visible UI refers to bookable slots.
                    </span>
                  </label>

                  <label className="block">
                    <span className={schedFieldLabel}>Appointment reminder</span>
                    <select
                      value={reminderLeadMinutes}
                      onChange={(event) =>
                        setReminderLeadMinutes(Number(event.target.value))
                      }
                      className={schedFieldInput}
                    >
                      <option value={0}>Off</option>
                      <option value={60}>1 hour before</option>
                      <option value={120}>2 hours before</option>
                      <option value={1440}>1 day before</option>
                      <option value={2880}>2 days before</option>
                    </select>
                    <span className={schedFieldHelp}>
                      Customers receive an SMS + email reminder at this lead time. Sends silently skip if no contact info is on file.
                    </span>
                  </label>
                </div>
              </SettingsCard>
            ) : null}
            {shop && isDev && <DevTestTools shopId={shop._id} />}
          </TabPanel>

          {/* NOTIFICATIONS */}
          <TabPanel id="notifications" active={active}>
            <SettingsCard
              title="Notifications"
              description="Choose which updates you and your team receive."
            >
              <div className="flex items-start gap-3 rounded-lg bg-muted/50 p-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                  <Bell className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">Coming soon</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Per-channel notification preferences (SMS, email, push) will live
                    here. For now, transactional alerts follow your booking rules.
                  </p>
                </div>
              </div>
            </SettingsCard>
          </TabPanel>

          {/* PROFILE */}
          <TabPanel id="profile" active={active}>
            <SettingsCard title="Profile">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Signed in as
              </p>
              <p className="mt-1 text-sm font-semibold text-foreground">
                {user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? "-"}
              </p>
              {user?.primaryEmailAddress && user.fullName && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {user.primaryEmailAddress.emailAddress}
                </p>
              )}
              <div className="mt-5">
                <button
                  onClick={handleSignOut}
                  className="inline-flex items-center gap-2 rounded-lg border border-destructive/30 px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/5"
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </button>
                <p className="mt-2 text-xs text-muted-foreground">
                  You will be redirected to the home page.
                </p>
              </div>
            </SettingsCard>
          </TabPanel>
        </div>
      </div>
    </div>
  );
}
