"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  BadgeDollarSign,
  Building2,
  Check,
  ChevronRight,
  Clock3,
  CreditCard,
  Loader2,
  Plus,
  Trash2,
  UserRoundCog,
  Wrench,
} from "lucide-react";

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const WEEK_DAYS = [
  { dayOfWeek: 1, dayName: "Monday" },
  { dayOfWeek: 2, dayName: "Tuesday" },
  { dayOfWeek: 3, dayName: "Wednesday" },
  { dayOfWeek: 4, dayName: "Thursday" },
  { dayOfWeek: 5, dayName: "Friday" },
  { dayOfWeek: 6, dayName: "Saturday" },
  { dayOfWeek: 0, dayName: "Sunday" },
] as const;

const STEP_META = [
  {
    title: "Shop Details",
    description: "Basic information, contact details, and public slug.",
    icon: Building2,
  },
  {
    title: "Operating Hours",
    description: "Set your weekly schedule from Monday through Sunday.",
    icon: Clock3,
  },
  {
    title: "Labor & Services",
    description: "Set your labor rate and choose what the shop offers.",
    icon: Wrench,
  },
  {
    title: "Add Mechanics",
    description: "Create at least one mechanic profile to receive work.",
    icon: UserRoundCog,
  },
  {
    title: "Payments",
    description: "Stripe Connect belongs here once the payment onboarding is wired.",
    icon: CreditCard,
  },
] as const;

type ShopDetailsForm = {
  name: string;
  slug: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
  phone: string;
};

type HoursFormRow = {
  dayOfWeek: number;
  dayName: string;
  isClosed: boolean;
  openTime: string;
  closeTime: string;
};

function getDefaultHours(): HoursFormRow[] {
  return WEEK_DAYS.map((day) => ({
    dayOfWeek: day.dayOfWeek,
    dayName: day.dayName,
    isClosed: day.dayOfWeek === 6 || day.dayOfWeek === 0,
    openTime: "09:00",
    closeTime: "17:00",
  }));
}

function normalizeHours(
  hours:
    | Array<{
        dayOfWeek: number;
        dayName: string;
        isClosed: boolean;
        openTime: string;
        closeTime: string;
      }>
    | undefined
): HoursFormRow[] {
  const existing = new Map((hours ?? []).map((row) => [row.dayOfWeek, row]));
  return WEEK_DAYS.map((day) => {
    const row = existing.get(day.dayOfWeek);
    return {
      dayOfWeek: day.dayOfWeek,
      dayName: day.dayName,
      isClosed: row?.isClosed ?? (day.dayOfWeek === 6 || day.dayOfWeek === 0),
      openTime: row?.openTime ?? "09:00",
      closeTime: row?.closeTime ?? "17:00",
    };
  });
}

function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 10);
  if (digits.length >= 7) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length >= 4) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  }
  if (digits.length >= 1) {
    return `(${digits}`;
  }
  return "";
}

function getFirstIncompleteSavedStep(params: {
  hasSavedShop: boolean;
  savedHoursCount: number;
  savedServiceCount: number;
  mechanicCount: number;
}) {
  if (!params.hasSavedShop) return 0;
  if (params.savedHoursCount < 7) return 1;
  if (params.savedServiceCount === 0) return 2;
  if (params.mechanicCount === 0) return 3;
  return 4;
}

export default function ShopSetupPage() {
  const router = useRouter();
  const { user } = useUser();
  const onboardingData = useQuery(api.shops.getMyOnboardingData);
  const upsertShopDetails = useMutation(api.shops.upsertOnboardingShopDetails);
  const saveHours = useMutation(api.shops.saveOnboardingHours);
  const saveLaborAndServices = useMutation(api.shops.saveOnboardingLaborAndServices);
  const addMechanic = useMutation(api.shops.addOnboardingMechanic);
  const removeMechanic = useMutation(api.shops.removeOnboardingMechanic);
  const completeOnboarding = useMutation(api.shops.completeOnboarding);

  const [details, setDetails] = useState<ShopDetailsForm>({
    name: "",
    slug: "",
    address: "",
    city: "",
    state: "",
    zipCode: "",
    phone: "",
  });
  const [hours, setHours] = useState<HoursFormRow[]>(getDefaultHours());
  const [laborRate, setLaborRate] = useState("150");
  const [selectedServiceIds, setSelectedServiceIds] = useState<Set<string>>(new Set());
  const [slugManual, setSlugManual] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);
  const [stepSuccess, setStepSuccess] = useState<string | null>(null);
  const [savingStep, setSavingStep] = useState<number | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [mechanicForm, setMechanicForm] = useState({
    firstName: "",
    lastName: "",
    title: "",
  });
  const [addingMechanic, setAddingMechanic] = useState(false);
  const [hydratedShopId, setHydratedShopId] = useState<string | null>(null);
  const clerkRole =
    typeof user?.publicMetadata?.role === "string"
      ? user.publicMetadata.role
      : null;
  const isOwnerLike = clerkRole === "owner" || clerkRole === "shop_owner" || clerkRole === "admin";

  const slugCheckResult = useQuery(
    api.shops.getBySlug,
    details.slug.length >= 2 && SLUG_REGEX.test(details.slug)
      ? { slug: details.slug }
      : "skip"
  );
  const persistedServiceCount = useMemo(
    () =>
      onboardingData?.serviceCategories.flatMap((category) =>
        category.services.filter((service) => service.isOffered)
      ).length ?? 0,
    [onboardingData]
  );
  const firstIncompleteSavedStep = useMemo(
    () =>
      getFirstIncompleteSavedStep({
        hasSavedShop: Boolean(onboardingData?.shop),
        savedHoursCount: onboardingData?.hours.length ?? 0,
        savedServiceCount: persistedServiceCount,
        mechanicCount: onboardingData?.mechanics.length ?? 0,
      }),
    [onboardingData, persistedServiceCount]
  );

  useEffect(() => {
    if (onboardingData === undefined || onboardingData === null) return;
    if (onboardingData.shop?.onboardingComplete) {
      router.replace("/dashboard");
      return;
    }

    const shopId = onboardingData.shop ? String(onboardingData.shop._id) : "new";
    if (hydratedShopId === shopId) return;

    const nextDetails: ShopDetailsForm = {
      name: onboardingData.shop?.name ?? "",
      slug: onboardingData.shop?.slug ?? "",
      address: onboardingData.shop?.address ?? "",
      city: onboardingData.shop?.city ?? "",
      state: onboardingData.shop?.state ?? "",
      zipCode: onboardingData.shop?.zipCode ?? "",
      phone: onboardingData.shop?.phone ?? "",
    };
    const nextHours = normalizeHours(onboardingData.hours);
    const nextLaborRate = String(onboardingData.shop?.laborRate ?? 150);
    const nextSelectedServiceIds = new Set(
      onboardingData.serviceCategories.flatMap((category) =>
        category.services
          .filter((service) => service.isOffered)
          .map((service) => service._id)
      )
    );

    setDetails(nextDetails);
    setHours(nextHours);
    setLaborRate(nextLaborRate);
    setSelectedServiceIds(nextSelectedServiceIds);
    setSlugManual(
      Boolean(nextDetails.slug) && nextDetails.slug !== toSlug(nextDetails.name)
    );
    setCurrentStep(firstIncompleteSavedStep);
    setHydratedShopId(shopId);
  }, [firstIncompleteSavedStep, hydratedShopId, onboardingData, router]);

  const inputClass =
    "w-full rounded-lg border border-gray-300 bg-white px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent";
  const labelClass = "mb-1.5 block text-sm font-medium text-gray-700";

  const currentShopId = onboardingData?.shop ? String(onboardingData.shop._id) : null;
  const isSlugTaken =
    slugCheckResult !== undefined &&
    slugCheckResult !== null &&
    String(slugCheckResult._id) !== currentShopId;

  const slugStatus = (() => {
    if (!details.slug) {
      return { text: "Enter at least 2 characters.", className: "text-gray-400" };
    }
    if (!SLUG_REGEX.test(details.slug)) {
      return {
        text: "Use only lowercase letters, numbers, and hyphens.",
        className: "text-red-600",
      };
    }
    if (details.slug.length < 2) {
      return { text: "Enter at least 2 characters.", className: "text-gray-400" };
    }
    if (slugCheckResult === undefined) {
      return { text: "Checking availability...", className: "text-gray-500" };
    }
    if (isSlugTaken) {
      return {
        text: "This slug is already taken. Please choose another.",
        className: "text-red-600",
      };
    }
    return {
      text: "Available",
      className: "text-green-600 font-medium",
    };
  })();

  function clearBanners() {
    setStepError(null);
    setStepSuccess(null);
  }

  function handleNameChange(value: string) {
    setDetails((prev) => ({
      ...prev,
      name: value,
      ...(!slugManual ? { slug: toSlug(value) } : {}),
    }));
  }

  function handleStepChange(nextStep: number) {
    clearBanners();
    if (nextStep <= Math.max(currentStep, firstIncompleteSavedStep)) {
      setCurrentStep(nextStep);
    }
  }

  async function handleSaveShopDetails() {
    clearBanners();

    const errors: string[] = [];
    if (!details.name.trim()) errors.push("Please enter a shop name.");
    if (!details.slug.trim() || !SLUG_REGEX.test(details.slug)) {
      errors.push("Please enter a valid URL-safe slug.");
    }
    if (isSlugTaken) {
      errors.push("This slug is already taken. Please choose another.");
    }
    if (!details.address.trim()) errors.push("Please enter a street address.");
    if (!details.city.trim()) errors.push("Please enter a city.");
    if (!details.state.trim()) errors.push("Please enter a state.");
    if (details.zipCode.length !== 5) errors.push("Zip code must be 5 digits.");
    if (details.phone.replace(/\D/g, "").length !== 10) {
      errors.push("Phone number must be 10 digits.");
    }

    if (errors.length > 0) {
      setStepError(errors[0]);
      return;
    }

    setSavingStep(0);
    try {
      await upsertShopDetails(details);
      setStepSuccess("Shop details saved.");
      setCurrentStep(1);
    } catch (error) {
      setStepError(
        error instanceof Error ? error.message : "Failed to save shop details."
      );
    } finally {
      setSavingStep(null);
    }
  }

  async function handleSaveHours() {
    clearBanners();
    const invalidDay = hours.find(
      (row) =>
        !row.isClosed && (!row.openTime || !row.closeTime || row.openTime >= row.closeTime)
    );
    if (invalidDay) {
      setStepError(`Set a valid opening range for ${invalidDay.dayName}.`);
      return;
    }

    setSavingStep(1);
    try {
      await saveHours({ hours });
      setStepSuccess("Operating hours saved.");
      setCurrentStep(2);
    } catch (error) {
      setStepError(
        error instanceof Error ? error.message : "Failed to save operating hours."
      );
    } finally {
      setSavingStep(null);
    }
  }

  async function handleSaveServices() {
    clearBanners();
    if (Number(laborRate) <= 0) {
      setStepError("Enter a valid labor rate.");
      return;
    }
    if (selectedServiceIds.size === 0) {
      setStepError("Select at least one service your shop offers.");
      return;
    }

    setSavingStep(2);
    try {
      await saveLaborAndServices({
        laborRate: Number(laborRate),
        serviceIds: Array.from(selectedServiceIds).map(
          (id) => id as Id<"services">
        ),
      });
      setStepSuccess("Labor rate and services saved.");
      setCurrentStep(3);
    } catch (error) {
      setStepError(
        error instanceof Error
          ? error.message
          : "Failed to save labor rate and services."
      );
    } finally {
      setSavingStep(null);
    }
  }

  async function handleAddMechanic() {
    clearBanners();
    if (!mechanicForm.firstName.trim() || !mechanicForm.lastName.trim()) {
      setStepError("Enter both a first and last name for the mechanic.");
      return;
    }

    setAddingMechanic(true);
    try {
      await addMechanic({
        firstName: mechanicForm.firstName,
        lastName: mechanicForm.lastName,
        title: mechanicForm.title.trim() || undefined,
      });
      setMechanicForm({ firstName: "", lastName: "", title: "" });
      setStepSuccess("Mechanic added.");
    } catch (error) {
      setStepError(error instanceof Error ? error.message : "Failed to add mechanic.");
    } finally {
      setAddingMechanic(false);
    }
  }

  async function handleRemoveMechanic(mechanicId: string) {
    clearBanners();
    try {
      await removeMechanic({ mechanicId: mechanicId as Id<"mechanics"> });
      setStepSuccess("Mechanic removed.");
    } catch (error) {
      setStepError(
        error instanceof Error ? error.message : "Failed to remove mechanic."
      );
    }
  }

  async function handleFinish() {
    clearBanners();
    setFinishing(true);
    try {
      await completeOnboarding();
      router.replace("/dashboard");
    } catch (error) {
      setStepError(
        error instanceof Error ? error.message : "Failed to complete onboarding."
      );
    } finally {
      setFinishing(false);
    }
  }

  if (onboardingData === undefined) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (onboardingData === null && !isOwnerLike) {
    return (
      <div className="mx-auto max-w-3xl rounded-2xl border border-amber-200 bg-amber-50 p-8 text-amber-900">
        <h1 className="text-2xl font-bold">Shop setup unavailable</h1>
        <p className="mt-3 text-sm leading-6">
          This onboarding flow is intended for authenticated shop owners. Set your
          Clerk test user&apos;s public metadata role to <code>shop_owner</code>,
          sign back in, and the portal will route you here automatically.
        </p>
      </div>
    );
  }

  const mechanics = onboardingData.mechanics;
  const offeredCount = selectedServiceIds.size;
  const stepButtonClass =
    "inline-flex items-center rounded-lg border px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-8">
        <p className="text-sm font-medium uppercase tracking-[0.24em] text-blue-600">
          Partner onboarding
        </p>
        <h1 className="mt-2 text-3xl font-bold text-gray-900">
          Shop Registration &amp; Onboarding Wizard
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-600">
          Step 1 already existed as a single setup form. This flow now continues
          through hours, services, mechanics, and a final payments handoff screen.
          Address autocomplete and geocoding are still not implemented in this repo.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="mb-4 border-b border-gray-100 pb-4">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-500">
              Progress
            </p>
            <div className="mt-3 h-2 rounded-full bg-gray-100">
              <div
                className="h-2 rounded-full bg-blue-600 transition-all"
                style={{ width: `${((currentStep + 1) / STEP_META.length) * 100}%` }}
              />
            </div>
          </div>

          <div className="space-y-2">
            {STEP_META.map((step, index) => {
              const Icon = step.icon;
              const completed =
                index < firstIncompleteSavedStep ||
                (firstIncompleteSavedStep === 4 &&
                  index === 4 &&
                  onboardingData.shop?.onboardingComplete);
              const active = currentStep === index;
              const clickable = index <= Math.max(currentStep, firstIncompleteSavedStep);
              return (
                <button
                  key={step.title}
                  type="button"
                  onClick={() => handleStepChange(index)}
                  disabled={!clickable}
                  className={`flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left transition-colors ${
                    active
                      ? "border-blue-200 bg-blue-50"
                      : "border-transparent hover:border-gray-200 hover:bg-gray-50"
                  }`}
                >
                  <div
                    className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                      completed
                        ? "bg-green-100 text-green-700"
                        : active
                        ? "bg-blue-100 text-blue-700"
                        : "bg-gray-100 text-gray-500"
                    }`}
                  >
                    {completed ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">
                      Step {index + 1}: {step.title}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-gray-500">
                      {step.description}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="rounded-2xl border border-gray-200 bg-white p-6 sm:p-8">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-gray-100 pb-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-500">
                Current step
              </p>
              <h2 className="mt-2 text-2xl font-bold text-gray-900">
                Step {currentStep + 1}: {STEP_META[currentStep].title}
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-600">
                {STEP_META[currentStep].description}
              </p>
            </div>
            {onboardingData.shop?.name && (
              <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
                <p className="font-semibold text-gray-900">{onboardingData.shop.name}</p>
                <p className="mt-1">/{onboardingData.shop.slug}</p>
              </div>
            )}
          </div>

          {stepError && (
            <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {stepError}
            </div>
          )}

          {stepSuccess && (
            <div className="mb-5 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
              {stepSuccess}
            </div>
          )}

          {currentStep === 0 && (
            <div className="space-y-6">
              <div>
                <label className={labelClass}>
                  Shop Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={details.name}
                  onChange={(event) => handleNameChange(event.target.value)}
                  placeholder="Otopair Service Center"
                  className={inputClass}
                />
              </div>

              <div>
                <label className={labelClass}>
                  Shop URL Slug <span className="text-red-500">*</span>
                </label>
                <div className="flex items-center overflow-hidden rounded-lg border border-gray-300 focus-within:border-transparent focus-within:ring-2 focus-within:ring-blue-500">
                  <span className="border-r border-gray-300 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-500">
                    otopair.com/shop/
                  </span>
                  <input
                    type="text"
                    value={details.slug}
                    onChange={(event) => {
                      const value = event.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9-]/g, "")
                        .replace(/-+/g, "-")
                        .replace(/^-+/, "");
                      setSlugManual(value !== toSlug(details.name));
                      setDetails((prev) => ({ ...prev, slug: value }));
                    }}
                    placeholder="otopair-service-center"
                    className="min-w-0 flex-1 bg-white px-3.5 py-2.5 text-sm text-gray-900 outline-none"
                  />
                </div>
                <p className={`mt-1.5 text-xs ${slugStatus.className}`}>{slugStatus.text}</p>
              </div>

              <div>
                <label className={labelClass}>
                  Street Address <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={details.address}
                  onChange={(event) =>
                    setDetails((prev) => ({ ...prev, address: event.target.value }))
                  }
                  placeholder="1234 Main St"
                  className={inputClass}
                />
                <p className="mt-1.5 text-xs text-gray-500">
                  Address autocomplete and geocoding are not wired yet, so lat/lng are
                  still not being set from this screen.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <label className={labelClass}>
                    City <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={details.city}
                    onChange={(event) =>
                      setDetails((prev) => ({ ...prev, city: event.target.value }))
                    }
                    placeholder="Austin"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>
                    State <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    maxLength={2}
                    value={details.state}
                    onChange={(event) =>
                      setDetails((prev) => ({
                        ...prev,
                        state: event.target.value.toUpperCase(),
                      }))
                    }
                    placeholder="TX"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>
                    ZIP Code <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={details.zipCode}
                    onChange={(event) =>
                      setDetails((prev) => ({
                        ...prev,
                        zipCode: event.target.value.replace(/\D/g, "").slice(0, 5),
                      }))
                    }
                    placeholder="78701"
                    className={inputClass}
                  />
                </div>
              </div>

              <div>
                <label className={labelClass}>
                  Phone Number <span className="text-red-500">*</span>
                </label>
                <input
                  type="tel"
                  value={details.phone}
                  onChange={(event) =>
                    setDetails((prev) => ({
                      ...prev,
                      phone: formatPhone(event.target.value),
                    }))
                  }
                  placeholder="(512) 555-0100"
                  className={inputClass}
                />
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleSaveShopDetails}
                  disabled={savingStep === 0}
                  className={`${stepButtonClass} border-blue-600 bg-blue-600 text-white hover:bg-blue-700`}
                >
                  {savingStep === 0 ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <ChevronRight className="mr-2 h-4 w-4" />
                  )}
                  Save and continue
                </button>
              </div>
            </div>
          )}

          {currentStep === 1 && (
            <div className="space-y-4">
              {hours.map((row, index) => (
                <div
                  key={row.dayOfWeek}
                  className="grid gap-3 rounded-xl border border-gray-200 p-4 md:grid-cols-[160px_minmax(0,1fr)_minmax(0,1fr)_120px]"
                >
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{row.dayName}</p>
                    <p className="mt-1 text-xs text-gray-500">
                      {row.isClosed ? "Closed all day" : "Open for bookings"}
                    </p>
                  </div>
                  <div>
                    <label className={labelClass}>Open</label>
                    <input
                      type="time"
                      value={row.openTime}
                      disabled={row.isClosed}
                      onChange={(event) =>
                        setHours((prev) =>
                          prev.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, openTime: event.target.value }
                              : item
                          )
                        )
                      }
                      className={`${inputClass} disabled:bg-gray-100 disabled:text-gray-400`}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Close</label>
                    <input
                      type="time"
                      value={row.closeTime}
                      disabled={row.isClosed}
                      onChange={(event) =>
                        setHours((prev) =>
                          prev.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, closeTime: event.target.value }
                              : item
                          )
                        )
                      }
                      className={`${inputClass} disabled:bg-gray-100 disabled:text-gray-400`}
                    />
                  </div>
                  <label className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 md:self-end">
                    Closed
                    <input
                      type="checkbox"
                      checked={row.isClosed}
                      onChange={(event) =>
                        setHours((prev) =>
                          prev.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, isClosed: event.target.checked }
                              : item
                          )
                        )
                      }
                      className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                  </label>
                </div>
              ))}

              <div className="flex justify-between pt-2">
                <button
                  type="button"
                  onClick={() => handleStepChange(0)}
                  className={`${stepButtonClass} border-gray-300 bg-white text-gray-700 hover:bg-gray-50`}
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleSaveHours}
                  disabled={savingStep === 1}
                  className={`${stepButtonClass} border-blue-600 bg-blue-600 text-white hover:bg-blue-700`}
                >
                  {savingStep === 1 ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <ChevronRight className="mr-2 h-4 w-4" />
                  )}
                  Save and continue
                </button>
              </div>
            </div>
          )}

          {currentStep === 2 && (
            <div className="space-y-6">
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-5">
                <label className={labelClass}>
                  Hourly Labor Rate <span className="text-red-500">*</span>
                </label>
                <div className="flex max-w-sm items-center overflow-hidden rounded-lg border border-gray-300 bg-white focus-within:border-transparent focus-within:ring-2 focus-within:ring-blue-500">
                  <span className="border-r border-gray-300 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-500">
                    $
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={laborRate}
                    onChange={(event) => setLaborRate(event.target.value)}
                    className="min-w-0 flex-1 px-3.5 py-2.5 text-sm text-gray-900 outline-none"
                  />
                  <span className="border-l border-gray-300 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-500">
                    / hr
                  </span>
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  The spec default is $150 per hour. You can change it now or later.
                </p>
              </div>

              <div>
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">Services offered</h3>
                    <p className="mt-1 text-sm text-gray-500">
                      Select the services this shop should show as available.
                    </p>
                  </div>
                  <div className="rounded-full bg-blue-50 px-3 py-1 text-sm font-medium text-blue-700">
                    {offeredCount} selected
                  </div>
                </div>

                <div className="space-y-4">
                  {onboardingData.serviceCategories.map((category) => (
                    <div
                      key={category.id}
                      className="overflow-hidden rounded-xl border border-gray-200"
                    >
                      <div className="border-b border-gray-200 bg-gray-50 px-4 py-3">
                        <h4 className="text-sm font-semibold text-gray-900">{category.name}</h4>
                      </div>
                      <div className="divide-y divide-gray-100">
                        {category.services.map((service) => {
                          const checked = selectedServiceIds.has(service._id);
                          return (
                            <label
                              key={service._id}
                              className="flex cursor-pointer items-start gap-3 px-4 py-4 hover:bg-gray-50"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(event) =>
                                  setSelectedServiceIds((prev) => {
                                    const next = new Set(prev);
                                    if (event.target.checked) next.add(service._id);
                                    else next.delete(service._id);
                                    return next;
                                  })
                                }
                                className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                              />
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="text-sm font-medium text-gray-900">
                                    {service.name}
                                  </p>
                                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                                    {service.defaultLaborHours} hr
                                  </span>
                                </div>
                                <p className="mt-1 text-sm leading-6 text-gray-500">
                                  {service.description}
                                </p>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-between pt-2">
                <button
                  type="button"
                  onClick={() => handleStepChange(1)}
                  className={`${stepButtonClass} border-gray-300 bg-white text-gray-700 hover:bg-gray-50`}
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleSaveServices}
                  disabled={savingStep === 2}
                  className={`${stepButtonClass} border-blue-600 bg-blue-600 text-white hover:bg-blue-700`}
                >
                  {savingStep === 2 ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <ChevronRight className="mr-2 h-4 w-4" />
                  )}
                  Save and continue
                </button>
              </div>
            </div>
          )}

          {currentStep === 3 && (
            <div className="space-y-6">
              <div className="grid gap-4 rounded-2xl border border-gray-200 bg-gray-50 p-5 md:grid-cols-3">
                <div>
                  <label className={labelClass}>
                    First Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={mechanicForm.firstName}
                    onChange={(event) =>
                      setMechanicForm((prev) => ({
                        ...prev,
                        firstName: event.target.value,
                      }))
                    }
                    placeholder="Anakin"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>
                    Last Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={mechanicForm.lastName}
                    onChange={(event) =>
                      setMechanicForm((prev) => ({
                        ...prev,
                        lastName: event.target.value,
                      }))
                    }
                    placeholder="Skywalker"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Title</label>
                  <input
                    type="text"
                    value={mechanicForm.title}
                    onChange={(event) =>
                      setMechanicForm((prev) => ({
                        ...prev,
                        title: event.target.value,
                      }))
                    }
                    placeholder="Lead mechanic"
                    className={inputClass}
                  />
                </div>
                <div className="md:col-span-3">
                  <button
                    type="button"
                    onClick={handleAddMechanic}
                    disabled={addingMechanic}
                    className={`${stepButtonClass} border-gray-300 bg-white text-gray-700 hover:bg-gray-50`}
                  >
                    {addingMechanic ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="mr-2 h-4 w-4" />
                    )}
                    Add mechanic
                  </button>
                </div>
              </div>

              <div className="space-y-3">
                {mechanics.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-sm text-gray-500">
                    No mechanics added yet. Add at least one before you finish setup.
                  </div>
                ) : (
                  mechanics.map((mechanic) => (
                    <div
                      key={mechanic._id}
                      className="flex items-center justify-between gap-4 rounded-xl border border-gray-200 px-4 py-4"
                    >
                      <div>
                        <p className="text-sm font-semibold text-gray-900">
                          {mechanic.firstName} {mechanic.lastName}
                        </p>
                        <p className="mt-1 text-sm text-gray-500">
                          {mechanic.title || "Mechanic"}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveMechanic(mechanic._id)}
                        className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50"
                      >
                        <Trash2 className="h-4 w-4" />
                        Remove
                      </button>
                    </div>
                  ))
                )}
              </div>

              <div className="flex justify-between pt-2">
                <button
                  type="button"
                  onClick={() => handleStepChange(2)}
                  className={`${stepButtonClass} border-gray-300 bg-white text-gray-700 hover:bg-gray-50`}
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => {
                    clearBanners();
                    if (mechanics.length === 0) {
                      setStepError("Add at least one mechanic before continuing.");
                      return;
                    }
                    setCurrentStep(4);
                  }}
                  className={`${stepButtonClass} border-blue-600 bg-blue-600 text-white hover:bg-blue-700`}
                >
                  <ChevronRight className="mr-2 h-4 w-4" />
                  Continue
                </button>
              </div>
            </div>
          )}

          {currentStep === 4 && (
            <div className="space-y-6">
              <div className="grid gap-4 md:grid-cols-[1.1fr_0.9fr]">
                <div className="rounded-2xl border border-gray-200 bg-white p-5">
                  <div className="flex items-center gap-3">
                    <div className="rounded-full bg-blue-100 p-2 text-blue-700">
                      <CreditCard className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900">
                        Stripe Connect onboarding
                      </h3>
                      <p className="mt-1 text-sm text-gray-500">
                        The screen is in place, but the actual Stripe redirect flow is
                        not implemented in this repo yet.
                      </p>
                    </div>
                  </div>
                  <div className="mt-5 rounded-xl border border-dashed border-gray-300 bg-gray-50 p-4 text-sm leading-6 text-gray-600">
                    {onboardingData.shop?.stripeConnectAccountId ? (
                      <>
                        Stripe account connected:
                        <div className="mt-2 font-mono text-xs text-gray-900">
                          {onboardingData.shop.stripeConnectAccountId}
                        </div>
                      </>
                    ) : (
                      <>
                        When you wire Stripe Connect later, this step should launch the
                        Express onboarding flow and return the user here with a connected
                        account ID.
                      </>
                    )}
                  </div>
                </div>

                <div className="rounded-2xl border border-gray-200 bg-gray-50 p-5">
                  <h3 className="text-lg font-semibold text-gray-900">Setup summary</h3>
                  <div className="mt-4 space-y-3 text-sm text-gray-600">
                    <div className="flex items-center justify-between rounded-xl bg-white px-4 py-3">
                      <span>Shop details</span>
                      <span className="font-medium text-gray-900">
                        {details.name || "Incomplete"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between rounded-xl bg-white px-4 py-3">
                      <span>Weekly hours</span>
                      <span className="font-medium text-gray-900">
                        {hours.filter((row) => !row.isClosed).length} open days
                      </span>
                    </div>
                    <div className="flex items-center justify-between rounded-xl bg-white px-4 py-3">
                      <span>Services selected</span>
                      <span className="font-medium text-gray-900">{offeredCount}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-xl bg-white px-4 py-3">
                      <span>Mechanics added</span>
                      <span className="font-medium text-gray-900">{mechanics.length}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-xl bg-white px-4 py-3">
                      <span>Labor rate</span>
                      <span className="font-medium text-gray-900">${laborRate}/hr</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm leading-6 text-amber-900">
                You can finish onboarding now and add the real Stripe Connect handoff
                later. Nothing here fakes a payment connection.
              </div>

              <div className="flex justify-between pt-2">
                <button
                  type="button"
                  onClick={() => handleStepChange(3)}
                  className={`${stepButtonClass} border-gray-300 bg-white text-gray-700 hover:bg-gray-50`}
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleFinish}
                  disabled={finishing}
                  className={`${stepButtonClass} border-blue-600 bg-blue-600 text-white hover:bg-blue-700`}
                >
                  {finishing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <BadgeDollarSign className="mr-2 h-4 w-4" />
                  )}
                  Finish setup
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
