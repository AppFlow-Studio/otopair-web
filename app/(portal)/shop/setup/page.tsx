//TODO: Forbid navigating away from this page until onboarding is fully complete

"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { Id } from "@/convex/_generated/dataModel";
import ConfirmationDialog from "@/components/confirmation-dialog";
import RemoveConfirmationDialog from "@/components/remove-confirmation-dialog";
import { removeTeamMember } from "@/lib/remove-team-member";
import { sendTeamInvite } from "@/lib/send-team-invite";
import TimePicker from "@/components/ui/time-picker";
import Tooltip from "@/components/ui/tooltip";
import LicenseUploader from "@/components/shop/license-uploader";
import {
  BadgeDollarSign,
  Building2,
  Check,
  ChevronRight,
  Clock3,
  CreditCard,
  Loader2,
  Plus,
  ShieldCheck,
  Sliders,
  Trash2,
  UserRoundCog,
  Users,
  Wrench,
} from "lucide-react";
import FixedPriceTierStrip, {
  FIXED_PRICE_TIERS,
  centsMapToInputs,
  countPricedGroups,
  priceMapToCents,
  type FixedPriceMap,
  type FixedPriceTier,
} from "@/components/shop/fixed-price-tier-strip";

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
    description: "Basic information, contact details, and public page name.",
    icon: Building2,
  },
  {
    title: "Operating Hours",
    description: "Set your weekly schedule from Monday through Sunday.",
    icon: Clock3,
  },
  {
    title: "Labor and services",
    description: "Set your labor rate and choose what the shop offers.",
    icon: Wrench,
  },
  {
    title: "Licenses & compliance",
    description: "Upload the licenses required to offer regulated services.",
    icon: ShieldCheck,
  },
  {
    title: "Add Mechanics",
    description: "Invite mechanics now, or skip this step and add them later.",
    icon: UserRoundCog,
  },
  {
    title: "Payments",
    description: "Connect the bank account where Otopair will send shop payouts.",
    icon: CreditCard,
  },
] as const;

const OWNER_MANAGER_ROLES = ["owner", "shop_owner", "admin"] as const;

const TIER_ORDER = ["T1", "T2a", "T2b", "T2c", "T3a", "T3b", "T4"] as const;
type TierCode = (typeof TIER_ORDER)[number];

// Shop-facing vehicle groups. The pricing engine still stores rates per internal
// tier (T1/T2a/...), but shop owners never see those codes — they think in the
// kinds of cars they work on. Each group maps to one or more internal tiers.
const VEHICLE_GROUPS: {
  id: string;
  name: string;
  examples: string;
  rangeLow: number;
  rangeHigh: number;
  tiers: TierCode[];
}[] = [
  {
    id: "everyday",
    name: "Everyday cars",
    examples: "Toyota, Honda, Ford, Hyundai, Kia, Mazda, Nissan, Subaru",
    rangeLow: 130,
    rangeHigh: 150,
    tiers: ["T1"],
  },
  {
    id: "luxury",
    name: "Luxury sedans & SUVs",
    examples: "Lexus, Acura, Genesis, Volvo, Mercedes, Audi, BMW, Macan",
    rangeLow: 160,
    rangeHigh: 210,
    tiers: ["T2a", "T2b", "T2c"],
  },
  {
    id: "performance",
    name: "Performance & sports",
    examples: "BMW M, AMG, Audi RS, Porsche 911 / Cayman, Audi R8",
    rangeLow: 195,
    rangeHigh: 275,
    tiers: ["T3a", "T3b"],
  },
  {
    id: "exotic",
    name: "Exotic",
    examples: "Ferrari, Lamborghini, Rolls-Royce, Bentley, McLaren",
    rangeLow: 250,
    rangeHigh: 400,
    tiers: ["T4"],
  },
];

type GroupRow = { rate: string; notServiced: boolean };

function initialGroupRows(
  rates: Partial<Record<TierCode, number>> | undefined,
  declined: TierCode[] | undefined,
): Record<string, GroupRow> {
  const declinedSet = new Set(declined ?? []);
  const out: Record<string, GroupRow> = {};
  for (const group of VEHICLE_GROUPS) {
    const notServiced =
      group.tiers.length > 0 && group.tiers.every((tier) => declinedSet.has(tier));
    let rate = "";
    for (const tier of group.tiers) {
      if (rates?.[tier] != null) {
        rate = String(rates[tier]);
        break;
      }
    }
    out[group.id] = { rate, notServiced };
  }
  return out;
}

const getPortalAccessQuery = makeFunctionReference<"query">("shops:getMyPortalAccess");
const getOnboardingDataQuery = makeFunctionReference<"query">("shops:getMyOnboardingData");
const getShopBySlugQuery = makeFunctionReference<"query">("shops:getBySlug");
const ensureUserMutation = makeFunctionReference<"mutation">("users:getOrCreateMe");
const generateUploadUrlMutation = makeFunctionReference<"mutation">("users:generateUploadUrl");
const updateMechanicProfilePhotoMutation = makeFunctionReference<"mutation">(
  "shops:updateOnboardingMechanicProfilePhoto"
);
const upsertShopDetailsMutation = makeFunctionReference<"mutation">(
  "shops:upsertOnboardingShopDetails"
);
const saveHoursMutation = makeFunctionReference<"mutation">("shops:saveOnboardingHours");
const saveLaborAndServicesMutation = makeFunctionReference<"mutation">(
  "shops:saveOnboardingLaborAndServices"
);
const setLaborRatesByTierMutation = makeFunctionReference<"mutation">(
  "shopLaborRates:setLaborRatesByTier"
);
const listShopServiceFixedPricesQuery = makeFunctionReference<"query">(
  "shopServiceFixedPrices:listForShop"
);
const setShopServiceFixedPricesMutation = makeFunctionReference<"mutation">(
  "shopServiceFixedPrices:setFixedPricesForService"
);
const addMechanicMutation = makeFunctionReference<"mutation">("shops:addOnboardingMechanic");
const updateMechanicMutation = makeFunctionReference<"mutation">(
  "shops:updateOnboardingMechanic"
);
const removeMechanicMutation = makeFunctionReference<"mutation">("shops:removeOnboardingMechanic");

type GoogleMapsWindow = Window & {
  google?: {
    maps?: {
      importLibrary?: (library: string) => Promise<unknown>;
      places?: {
        AutocompleteSuggestion?: {
          fetchAutocompleteSuggestions?: (request: Record<string, unknown>) => Promise<{
            suggestions?: GoogleAutocompleteSuggestion[];
          }>;
        };
        AutocompleteSessionToken?: new () => unknown;
      };
    };
  };
  __googleMapsApiPromise?: Promise<void>;
};

type GoogleAutocompleteSuggestion = {
  placePrediction?: {
    text?: { toString(): string };
    secondaryText?: { toString(): string };
    toPlace?: () => {
      fetchFields?: (request: { fields: string[] }) => Promise<void>;
      formattedAddress?: string;
      addressComponents?: Array<{
        longText?: string;
        shortText?: string;
        types?: string[];
      }>;
      location?: {
        lat?: () => number;
        lng?: () => number;
      };
    };
  };
};

type AddressSuggestion = {
  id: string;
  primaryText: string;
  secondaryText: string;
  suggestion: GoogleAutocompleteSuggestion;
};

type ShopDetailsForm = {
  name: string;
  slug: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
  phone: string;
};

type OnboardingService = {
  _id: string;
  name: string;
  description?: string;
  defaultLaborHours: number;
  isOffered: boolean;
  requiresInspectionLicense?: boolean;
};

type OnboardingServiceCategory = {
  id: string;
  name: string;
  services: OnboardingService[];
};

type OnboardingMechanicRow = {
  _id: string;
  firstName: string;
  lastName: string;
  title: string;
  email?: string | null;
  shopUserId: string | null;
  invitationId: string | null;
  pendingInvitationId: string | null;
  invitationStatus?: string | null;
  portalStatus?: string | null;
  blockingBookingCount?: number;
  photoUrl?: string | null;
};

type MechanicFormState = {
  mechanicId: string | null;
  firstName: string;
  lastName: string;
  title: string;
  email: string;
  pendingInvitationId: string | null;
  portalStatus?: string | null;
};

type PortalAccess =
  | null
  | {
      status: string;
      role?: string | null;
      userRole?: string | null;
    };

type OnboardingData = {
  userRole?: string | null;
  ownerEmail?: string | null;
  shop: {
    _id: Id<"shops">;
    name: string;
    slug: string;
    address: string;
    city: string;
    state: string;
    zipCode: string;
    phone: string;
    laborRate?: number;
    laborRatesByTier?: Partial<Record<TierCode, number>>;
    declinedTiers?: TierCode[];
    stripeConnectAccountId?: string | null;
    stripeRequirementsCurrentlyDue?: string[];
    stripeConnectReady?: boolean;
    onboardingComplete?: boolean;
  } | null;
  hours: HoursFormRow[];
  serviceCategories: OnboardingServiceCategory[];
  mechanics: OnboardingMechanicRow[];
};

type NormalizedShopAddress = {
  address: string;
  city: string;
  state: string;
  zipCode: string;
};

function getAddressComponent(
  components: Array<{ longText?: string; shortText?: string; types?: string[] }>,
  type: string,
  mode: "long" | "short" = "long"
) {
  const match = components.find((component) => component.types?.includes(type));
  if (!match) return "";
  return mode === "short" ? match.shortText ?? "" : match.longText ?? "";
}

function normalizeAddressToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function validateShopAddressWithGoogle(
  details: Pick<ShopDetailsForm, "address" | "city" | "state" | "zipCode">
): Promise<NormalizedShopAddress> {
  await loadGoogleMapsPlacesApi();

  const mapsWindow = window as GoogleMapsWindow;
  const maps = mapsWindow.google?.maps as
    | {
        Geocoder?: new () => {
          geocode: (request: Record<string, unknown>) => Promise<{
            results?: Array<{
              formatted_address?: string;
              address_components?: Array<{
                long_name?: string;
                short_name?: string;
                types?: string[];
              }>;
            }>;
          }>;
        };
      }
    | undefined;

  if (!maps?.Geocoder) {
    throw new Error("Google address validation is not available right now.");
  }

  const geocoder = new maps.Geocoder();
  const query = `${details.address}, ${details.city}, ${details.state} ${details.zipCode}`;
  const response = await geocoder.geocode({
    address: query,
    componentRestrictions: { country: "US" },
  });

  const result = response.results?.[0];
  if (!result) {
    throw new Error("Google could not validate this address. Select a valid suggested address.");
  }

  const components =
    result.address_components?.map((component) => ({
      longText: component.long_name ?? "",
      shortText: component.short_name ?? "",
      types: component.types ?? [],
    })) ?? [];

  const streetNumber = getAddressComponent(components, "street_number");
  const route = getAddressComponent(components, "route");
  const city =
    getAddressComponent(components, "locality") ||
    getAddressComponent(components, "postal_town") ||
    getAddressComponent(components, "sublocality_level_1");
  const state = getAddressComponent(components, "administrative_area_level_1", "short");
  const zipCode = getAddressComponent(components, "postal_code");
  const address =
    [streetNumber, route].filter(Boolean).join(" ") || result.formatted_address || details.address;

  if (!address || !city || !state || !zipCode) {
    throw new Error("This address is missing required location details. Choose a different suggestion.");
  }

  // ZIP uniquely identifies a small geographic area; if the user's typed ZIP
  // doesn't match Google's, the address they intended is somewhere else.
  // City/state are normalized silently using Google's values (handles common
  // typos like "N" → "NY", "Staten Is" → "Staten Island").
  if (
    normalizeAddressToken(zipCode) !== normalizeAddressToken(details.zipCode)
  ) {
    throw new Error(
      "We couldn't match that ZIP code to the street address. Double-check the ZIP or pick a suggested address."
    );
  }

  return {
    address,
    city,
    state,
    zipCode,
  };
}

async function loadGoogleMapsPlacesApi() {
  const mapsWindow = window as GoogleMapsWindow;
  if (mapsWindow.google?.maps?.importLibrary) return;
  if (!mapsWindow.__googleMapsApiPromise) {
    mapsWindow.__googleMapsApiPromise = new Promise<void>((resolve, reject) => {
      const existing = document.querySelector(
        'script[data-google-maps-api="true"]'
      ) as HTMLScriptElement | null;
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("Failed to load Google Maps.")), {
          once: true,
        });
        return;
      }

      const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
      if (!apiKey) {
        reject(new Error("Missing NEXT_PUBLIC_GOOGLE_MAPS_API_KEY."));
        return;
      }

      const script = document.createElement("script");
      script.src =
        `https://maps.googleapis.com/maps/api/js?key=${apiKey}&loading=async&libraries=places&v=weekly`;
      script.async = true;
      script.defer = true;
      script.dataset.googleMapsApi = "true";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load Google Maps."));
      document.head.appendChild(script);
    });
  }

  await mapsWindow.__googleMapsApiPromise;
}

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

function getInitials(firstName: string, lastName: string): string {
  const initials = `${firstName.trim()[0] ?? ""}${lastName.trim()[0] ?? ""}`.toUpperCase();
  return initials || "ME";
}

function getMechanicPortalStatusLabel(status?: string | null): string {
  if (status === "active") return "Portal active";
  if (status === "invite_sent") return "Invitation pending";
  if (status === "invite_expired") return "Invitation expired";
  if (status === "invite_revoked") return "Invitation revoked";
  return "Profile saved";
}

function getMechanicInviteLabel(status?: string | null): string {
  if (status === "invite_sent") return "Resend invite";
  if (status === "invite_expired") return "Resend invite";
  if (status === "invite_revoked") return "Send invite";
  return "Send invite";
}

function getEmptyMechanicForm(): MechanicFormState {
  return {
    mechanicId: null,
    firstName: "",
    lastName: "",
    title: "",
    email: "",
    pendingInvitationId: null,
    portalStatus: null,
  };
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
  // Licenses (3) and mechanics (4) are optional/skippable — resume at Payments.
  return 5;
}

export default function ShopSetupPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isLoaded: isUserLoaded } = useUser();
  const portalAccess = useQuery(getPortalAccessQuery) as PortalAccess | undefined;
  const onboardingData = useQuery(getOnboardingDataQuery) as OnboardingData | null | undefined;
  const ensureUser = useMutation(ensureUserMutation) as (args: {
    authProvider?: string;
    acquisitionSource?: string;
  }) => Promise<unknown>;
  const generateUploadUrl = useMutation(generateUploadUrlMutation) as () => Promise<string>;
  const updateMechanicProfilePhoto = useMutation(updateMechanicProfilePhotoMutation) as (args: {
    mechanicId: Id<"mechanics">;
    profilePhotoStorageId: string | null;
  }) => Promise<{ mechanicId: Id<"mechanics">; photoUrl: string | null }>;
  const upsertShopDetails = useMutation(upsertShopDetailsMutation) as (args: {
    name: string;
    slug: string;
    address: string;
    city: string;
    state: string;
    zipCode: string;
    phone: string;
  }) => Promise<Id<"shops">>;
  const saveHours = useMutation(saveHoursMutation) as (args: {
    hours: HoursFormRow[];
  }) => Promise<Id<"shops">>;
  const saveLaborAndServices = useMutation(saveLaborAndServicesMutation) as (args: {
    laborRate: number;
    serviceIds: Id<"services">[];
  }) => Promise<Id<"shops">>;
  const saveTierLaborRates = useMutation(setLaborRatesByTierMutation) as (args: {
    shop_id: Id<"shops">;
    rates: Partial<Record<TierCode, number>>;
    declined_tiers: TierCode[];
  }) => Promise<unknown>;
  const addMechanic = useMutation(addMechanicMutation) as (args: {
    firstName: string;
    lastName: string;
    title?: string;
    email?: string;
  }) => Promise<Id<"mechanics">>;
  const updateMechanic = useMutation(updateMechanicMutation) as (args: {
    mechanicId: Id<"mechanics">;
    firstName: string;
    lastName: string;
    title?: string;
    email?: string;
  }) => Promise<Id<"mechanics">>;
  const removeMechanic = useMutation(removeMechanicMutation) as (args: {
    mechanicId: Id<"mechanics">;
  }) => Promise<Id<"mechanics">>;
  const setShopServiceFixedPrices = useMutation(
    setShopServiceFixedPricesMutation,
  ) as (args: {
    shop_id: Id<"shops">;
    service_id: Id<"services">;
    prices: Partial<Record<FixedPriceTier, number | null>>;
  }) => Promise<unknown>;

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
  const [groupRows, setGroupRows] = useState<Record<string, GroupRow>>(() =>
    initialGroupRows(undefined, undefined),
  );
  const [selectedServiceIds, setSelectedServiceIds] = useState<Set<string>>(new Set());
  const [pricingOpenServiceIds, setPricingOpenServiceIds] = useState<Set<string>>(
    new Set(),
  );
  const [fixedPricesByService, setFixedPricesByService] = useState<
    Record<string, FixedPriceMap>
  >({});
  const [fixedPricesBaseline, setFixedPricesBaseline] = useState<
    Record<string, FixedPriceMap>
  >({});
  const [slugManual, setSlugManual] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);
  const [stepSuccess, setStepSuccess] = useState<string | null>(null);
  const [savingStep, setSavingStep] = useState<number | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [launchingStripe, setLaunchingStripe] = useState(false);
  const [addressSuggestions, setAddressSuggestions] = useState<AddressSuggestion[]>([]);
  const [addressLookupLoading, setAddressLookupLoading] = useState(false);
  const [addressSelectedFromAutocomplete, setAddressSelectedFromAutocomplete] = useState(false);
  const [highlightedAddressSuggestionIndex, setHighlightedAddressSuggestionIndex] = useState(-1);
  const addressLookupSessionRef = useRef<unknown>(null);
  const addressLookupRequestIdRef = useRef(0);
  const addressContainerRef = useRef<HTMLDivElement | null>(null);
  const mechanicFormRef = useRef<HTMLDivElement | null>(null);
  const mechanicEmailInputRef = useRef<HTMLInputElement | null>(null);
  const mechanicPhotoInputRef = useRef<HTMLInputElement | null>(null);
  const pendingMechanicPhotoIdRef = useRef<string | null>(null);
  const [mechanicForm, setMechanicForm] = useState<MechanicFormState>(getEmptyMechanicForm);
  const [sendingInvite, setSendingInvite] = useState(false);
  const [mechanicInviteError, setMechanicInviteError] = useState<string | null>(null);
  const [mechanicInviteSuccess, setMechanicInviteSuccess] = useState(false);
  const [hydratedShopId, setHydratedShopId] = useState<string | null>(null);
  const [ensuredConvexUser, setEnsuredConvexUser] = useState(false);
  const [uploadingMechanicId, setUploadingMechanicId] = useState<string | null>(null);
  const [photoDialogMechanicId, setPhotoDialogMechanicId] = useState<string | null>(null);
  const [removeMechanicConfirm, setRemoveMechanicConfirm] = useState<{
    mechanicId: string;
    shopUserId: string | null;
    pendingInvitationId: string | null;
    firstName: string;
    lastName: string;
  } | null>(null);
  const [mechanicInviteActionId, setMechanicInviteActionId] = useState<string | null>(null);
  const [removingMechanicId, setRemovingMechanicId] = useState<string | null>(null);
  const clerkRole =
    typeof user?.publicMetadata?.role === "string"
      ? user.publicMetadata.role
      : null;
  const isOwnerLike = clerkRole === "owner" || clerkRole === "shop_owner" || clerkRole === "admin";
  const effectivePortalRole =
    portalAccess?.status === "active"
      ? portalAccess.role
      : portalAccess?.status === "no_shop"
      ? (portalAccess.userRole ?? clerkRole ?? "")
      : (clerkRole ?? "");
  const canAccessSetup =
    portalAccess === null
      ? isOwnerLike
      : portalAccess?.status === "active"
      ? OWNER_MANAGER_ROLES.includes(portalAccess.role as (typeof OWNER_MANAGER_ROLES)[number])
      : portalAccess?.status === "no_shop"
      ? OWNER_MANAGER_ROLES.includes(effectivePortalRole as (typeof OWNER_MANAGER_ROLES)[number])
      : false;

  const slugCheckResult = useQuery(
    getShopBySlugQuery,
    details.slug.length >= 2 && SLUG_REGEX.test(details.slug)
      ? { slug: details.slug }
      : "skip"
  ) as { _id: Id<"shops"> } | null | undefined;
  const persistedShopId = onboardingData?.shop?._id ?? null;
  const fixedPricesData = useQuery(
    listShopServiceFixedPricesQuery,
    persistedShopId ? { shop_id: persistedShopId } : "skip",
  ) as Record<string, Partial<Record<FixedPriceTier, number>>> | undefined;
  const declinedTierSet = useMemo(
    () => new Set<string>(onboardingData?.shop?.declinedTiers ?? []),
    [onboardingData],
  );
  const serviceCategories = useMemo(
    () => (onboardingData?.serviceCategories ?? []) as OnboardingServiceCategory[],
    [onboardingData]
  );
  const persistedServiceCount = useMemo(
    () =>
      serviceCategories.flatMap((category) =>
        category.services.filter((service) => service.isOffered)
      ).length ?? 0,
    [serviceCategories]
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
    if (!isUserLoaded || !user || ensuredConvexUser) return;
    let cancelled = false;

    // First-touch attribution: OAuth provider (or password) from Clerk, and the
    // entry surface. Convex only writes these when still empty, so re-running is
    // harmless.
    const authProvider =
      user.externalAccounts?.[0]?.provider ??
      (user.passwordEnabled ? "password" : undefined);
    void ensureUser({ authProvider, acquisitionSource: "shop_portal_web" })
      .catch(() => {
        // Keep the UI responsive; the queries will stay null if auth bootstrap fails.
      })
      .finally(() => {
        if (!cancelled) setEnsuredConvexUser(true);
      });

    return () => {
      cancelled = true;
    };
  }, [ensureUser, ensuredConvexUser, isUserLoaded, user]);

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
    // Most shops service nearly everything, so default a fresh setup to ALL
    // services selected — the owner just unchecks the few they don't do. Once
    // they've saved their own selection, respect exactly what they offered.
    const offeredServiceIds = serviceCategories.flatMap((category) =>
      category.services
        .filter((service) => service.isOffered)
        .map((service) => service._id)
    );
    const allServiceIds = serviceCategories.flatMap((category) =>
      category.services.map((service) => service._id)
    );
    const nextSelectedServiceIds = new Set<string>(
      offeredServiceIds.length > 0 ? offeredServiceIds : allServiceIds
    );

    setDetails(nextDetails);
    setHours(nextHours);
    setLaborRate(nextLaborRate);
    setGroupRows(
      initialGroupRows(
        onboardingData.shop?.laborRatesByTier,
        onboardingData.shop?.declinedTiers,
      ),
    );
    setSelectedServiceIds(nextSelectedServiceIds);
    setAddressSelectedFromAutocomplete(Boolean(nextDetails.address));
    setAddressSuggestions([]);
    setSlugManual(
      Boolean(nextDetails.slug) && nextDetails.slug !== toSlug(nextDetails.name)
    );
    setCurrentStep(firstIncompleteSavedStep);
    setHydratedShopId(shopId);
  }, [firstIncompleteSavedStep, hydratedShopId, onboardingData, router, serviceCategories]);

  useEffect(() => {
    if (!fixedPricesData) return;
    const next: Record<string, FixedPriceMap> = {};
    for (const [serviceId, centsMap] of Object.entries(fixedPricesData)) {
      next[serviceId] = centsMapToInputs(centsMap);
    }
    setFixedPricesByService(next);
    setFixedPricesBaseline(next);
  }, [fixedPricesData]);

  useEffect(() => {
    const stripeStatus = searchParams.get("stripe");
    if (!stripeStatus) return;

    if (stripeStatus === "connected") {
      setStepSuccess("Stripe Connect onboarding is complete. You can finish setup now.");
    } else if (stripeStatus === "pending") {
      setStepSuccess(
        "Stripe account linked. Stripe is still finalizing the account before payouts are fully enabled."
      );
    } else if (stripeStatus === "action_needed") {
      setStepError(
        "Stripe still needs more information before payouts can be enabled. Reopen onboarding to continue."
      );
    } else if (stripeStatus === "missing") {
      setStepError("Start Stripe onboarding before finishing setup.");
    } else if (stripeStatus === "refresh_error") {
      setStepError("Stripe could not reopen onboarding. Try again.");
    } else if (stripeStatus === "return_error") {
      setStepError("Stripe returned an unexpected result. Try reopening onboarding.");
    }

    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete("stripe");
    const nextUrl = nextParams.toString()
      ? `/shop/setup?${nextParams.toString()}`
      : "/shop/setup";
    router.replace(nextUrl, { scroll: false });
  }, [router, searchParams]);

  useEffect(() => {
    if (portalAccess === undefined) return;

    if (portalAccess === null) {
      if (!isOwnerLike) {
        router.replace("/dashboard");
      }
      return;
    }

    if (portalAccess.status === "active") {
      if (!OWNER_MANAGER_ROLES.includes(portalAccess.role as (typeof OWNER_MANAGER_ROLES)[number])) {
        router.replace("/dashboard");
      }
      return;
    }

    if (portalAccess.status === "no_shop") {
      const role = portalAccess.userRole ?? clerkRole ?? "";
      if (!OWNER_MANAGER_ROLES.includes(role as (typeof OWNER_MANAGER_ROLES)[number])) {
        router.replace("/dashboard");
      }
    }
  }, [portalAccess, clerkRole, isOwnerLike, router]);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!addressContainerRef.current?.contains(event.target as Node)) {
        setAddressSuggestions([]);
        setHighlightedAddressSuggestionIndex(-1);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  useEffect(() => {
    if (addressSuggestions.length === 0) {
      setHighlightedAddressSuggestionIndex(-1);
      return;
    }

    setHighlightedAddressSuggestionIndex((currentIndex) =>
      currentIndex >= 0 && currentIndex < addressSuggestions.length ? currentIndex : 0
    );
  }, [addressSuggestions]);

  useEffect(() => {
    const query = details.address.trim();
    if (!query || addressSelectedFromAutocomplete) {
      setAddressLookupLoading(false);
      if (!query) setAddressSuggestions([]);
      return;
    }

    const timeoutId = window.setTimeout(async () => {
      const requestId = ++addressLookupRequestIdRef.current;
      setAddressLookupLoading(true);
      try {
        await loadGoogleMapsPlacesApi();
        const mapsWindow = window as GoogleMapsWindow;
        const maps = mapsWindow.google?.maps;
        if (!maps?.importLibrary) return;

        const placesLibrary = (await maps.importLibrary("places")) as {
          AutocompleteSuggestion?: {
            fetchAutocompleteSuggestions?: (request: Record<string, unknown>) => Promise<{
              suggestions?: GoogleAutocompleteSuggestion[];
            }>;
          };
          AutocompleteSessionToken?: new () => unknown;
        };

        if (!addressLookupSessionRef.current && placesLibrary.AutocompleteSessionToken) {
          addressLookupSessionRef.current = new placesLibrary.AutocompleteSessionToken();
        }

        const response = await placesLibrary.AutocompleteSuggestion?.fetchAutocompleteSuggestions?.({
          input: query,
          includedRegionCodes: ["us"],
          sessionToken: addressLookupSessionRef.current ?? undefined,
        });

        if (addressLookupRequestIdRef.current !== requestId) return;

        const nextSuggestions =
          response?.suggestions?.slice(0, 5).map((suggestion, index) => ({
            id: `${query}-${index}`,
            primaryText: suggestion.placePrediction?.text?.toString() ?? "",
            secondaryText: suggestion.placePrediction?.secondaryText?.toString() ?? "",
            suggestion,
          })) ?? [];
        setAddressSuggestions(nextSuggestions.filter((entry) => entry.primaryText));
      } catch {
        if (addressLookupRequestIdRef.current === requestId) {
          setAddressSuggestions([]);
        }
      } finally {
        if (addressLookupRequestIdRef.current === requestId) {
          setAddressLookupLoading(false);
        }
      }
    }, 250);

    return () => window.clearTimeout(timeoutId);
  }, [addressSelectedFromAutocomplete, details.address]);

  const inputClass =
    "w-full rounded-lg border border-input bg-white px-3.5 py-2.5 text-sm text-foreground placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent";
  const labelClass = "mb-1.5 block text-sm font-medium text-foreground";

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
        className: "text-destructive",
      };
    }
    if (details.slug.length < 2) {
      return { text: "Enter at least 2 characters.", className: "text-gray-400" };
    }
    if (slugCheckResult === undefined) {
      return { text: "Checking availability...", className: "text-muted-foreground" };
    }
    if (isSlugTaken) {
      return {
        text: "This slug is already taken. Please choose another.",
        className: "text-destructive",
      };
    }
    return {
      text: "Available",
      className: "text-success font-medium",
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

  function handleAddressInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (addressSuggestions.length === 0) {
      if (event.key === "Escape") {
        setHighlightedAddressSuggestionIndex(-1);
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedAddressSuggestionIndex((currentIndex) =>
        currentIndex < 0 ? 0 : (currentIndex + 1) % addressSuggestions.length
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedAddressSuggestionIndex((currentIndex) =>
        currentIndex <= 0 ? addressSuggestions.length - 1 : currentIndex - 1
      );
      return;
    }

    if (event.key === "Enter") {
      if (highlightedAddressSuggestionIndex < 0) return;
      event.preventDefault();
      void handleSelectAddressSuggestion(
        addressSuggestions[highlightedAddressSuggestionIndex]
      );
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setAddressSuggestions([]);
      setHighlightedAddressSuggestionIndex(-1);
    }
  }

  function handleStepChange(nextStep: number) {
    clearBanners();
    if (nextStep <= Math.max(currentStep, firstIncompleteSavedStep)) {
      setCurrentStep(nextStep);
    }
  }

  async function handleSelectAddressSuggestion(entry: AddressSuggestion) {
    const place = entry.suggestion.placePrediction?.toPlace?.();
    if (!place?.fetchFields) {
      setDetails((prev) => ({ ...prev, address: entry.primaryText }));
      setAddressSelectedFromAutocomplete(true);
      setAddressSuggestions([]);
      setHighlightedAddressSuggestionIndex(-1);
      return;
    }

    setAddressLookupLoading(true);
    clearBanners();
    try {
      await place.fetchFields({
        fields: ["formattedAddress", "addressComponents", "location"],
      });
      const components = place.addressComponents ?? [];
      const streetNumber = getAddressComponent(components, "street_number");
      const route = getAddressComponent(components, "route");
      const line1 =
        [streetNumber, route].filter(Boolean).join(" ") ||
        place.formattedAddress ||
        entry.primaryText;
      const city =
        getAddressComponent(components, "locality") ||
        getAddressComponent(components, "postal_town") ||
        getAddressComponent(components, "sublocality_level_1");
      const state = getAddressComponent(components, "administrative_area_level_1", "short");
      const zipCode = getAddressComponent(components, "postal_code");

      setDetails((prev) => ({
        ...prev,
        address: line1,
        city: city || prev.city,
        state: state || prev.state,
        zipCode: zipCode || prev.zipCode,
      }));
      setAddressSelectedFromAutocomplete(true);
      setAddressSuggestions([]);
      setHighlightedAddressSuggestionIndex(-1);
      addressLookupSessionRef.current = null;
    } catch {
      setStepError("Failed to load address details. Try selecting the address again.");
    } finally {
      setAddressLookupLoading(false);
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
      const normalizedAddress = addressSelectedFromAutocomplete
        ? {
            address: details.address,
            city: details.city,
            state: details.state,
            zipCode: details.zipCode,
          }
        : await validateShopAddressWithGoogle(details);
      const nextDetails = {
        ...details,
        ...normalizedAddress,
      };

      setDetails(nextDetails);
      await upsertShopDetails(nextDetails);
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

    const tierRates: Partial<Record<TierCode, number>> = {};
    const tierDeclined: TierCode[] = [];
    for (const group of VEHICLE_GROUPS) {
      const row = groupRows[group.id];
      if (!row) continue;
      if (row.notServiced) {
        tierDeclined.push(...group.tiers);
        continue;
      }
      const trimmed = row.rate.trim();
      if (trimmed === "") continue;
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n < 50 || n > 900) {
        setStepError(
          `Enter a rate between $50 and $900/hr for ${group.name}.`,
        );
        return;
      }
      for (const tier of group.tiers) {
        tierRates[tier] = Math.round(n);
      }
    }

    setSavingStep(2);
    try {
      const shopId = await saveLaborAndServices({
        laborRate: Number(laborRate),
        serviceIds: Array.from(selectedServiceIds).map(
          (id) => id as Id<"services">
        ),
      });
      const hasTierChanges =
        Object.keys(tierRates).length > 0 || tierDeclined.length > 0;
      if (hasTierChanges) {
        await saveTierLaborRates({
          shop_id: shopId,
          rates: tierRates,
          declined_tiers: tierDeclined,
        });
      }

      // Persist fixed prices for any service whose strip values changed.
      const dirtyServiceIds: string[] = [];
      for (const serviceId of Object.keys(fixedPricesByService)) {
        const current = fixedPricesByService[serviceId] ?? {};
        const baseline = fixedPricesBaseline[serviceId] ?? {};
        for (const tier of FIXED_PRICE_TIERS) {
          if ((current[tier] ?? "") !== (baseline[tier] ?? "")) {
            dirtyServiceIds.push(serviceId);
            break;
          }
        }
      }
      for (const serviceId of dirtyServiceIds) {
        const current = fixedPricesByService[serviceId] ?? {};
        const baseline = fixedPricesBaseline[serviceId] ?? {};
        const centsPatch = priceMapToCents(current);
        const changed: Partial<Record<FixedPriceTier, number | null>> = {};
        for (const tier of FIXED_PRICE_TIERS) {
          if ((current[tier] ?? "") !== (baseline[tier] ?? "")) {
            changed[tier] = tier in centsPatch ? centsPatch[tier]! : null;
          }
        }
        if (Object.keys(changed).length === 0) continue;
        await setShopServiceFixedPrices({
          shop_id: shopId,
          service_id: serviceId as Id<"services">,
          prices: changed,
        });
      }
      setFixedPricesBaseline(fixedPricesByService);
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

  function resetMechanicForm() {
    setMechanicForm(getEmptyMechanicForm());
  }

  function scrollToMechanicForm({ selectEmail = false }: { selectEmail?: boolean } = {}) {
    mechanicFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

    if (!selectEmail) return;

    window.setTimeout(() => {
      mechanicEmailInputRef.current?.focus({ preventScroll: true });
      mechanicEmailInputRef.current?.select();
    }, 250);
  }

  function editMechanicForInvite(mechanic: OnboardingMechanicRow) {
    setMechanicForm({
      mechanicId: mechanic._id,
      firstName: mechanic.firstName,
      lastName: mechanic.lastName,
      title: mechanic.title,
      email: mechanic.email ?? "",
      pendingInvitationId: mechanic.pendingInvitationId,
      portalStatus: mechanic.portalStatus,
    });
    scrollToMechanicForm({ selectEmail: true });
  }

  async function handleInviteMechanic() {
    clearBanners();
    setMechanicInviteError(null);
    setMechanicInviteSuccess(false);

    if (!onboardingData?.shop?._id) {
      setMechanicInviteError("Save your shop details before adding mechanics.");
      return;
    }
    if (!mechanicForm.firstName.trim() || !mechanicForm.lastName.trim()) {
      setMechanicInviteError("Enter both a first and last name for the mechanic.");
      return;
    }

    setSendingInvite(true);
    try {
      const mechanicId = mechanicForm.mechanicId
        ? await updateMechanic({
            mechanicId: mechanicForm.mechanicId as Id<"mechanics">,
            firstName: mechanicForm.firstName.trim(),
            lastName: mechanicForm.lastName.trim(),
            title: mechanicForm.title.trim() || undefined,
            email: mechanicForm.email.trim() || undefined,
          })
        : await addMechanic({
            firstName: mechanicForm.firstName.trim(),
            lastName: mechanicForm.lastName.trim(),
            title: mechanicForm.title.trim() || undefined,
            email: mechanicForm.email.trim() || undefined,
          });

      if (mechanicForm.email.trim()) {
        if (
          mechanicForm.pendingInvitationId &&
          (mechanicForm.portalStatus === "invite_sent" ||
            mechanicForm.portalStatus === "invite_expired")
        ) {
          await removeTeamMember({ invitationId: mechanicForm.pendingInvitationId });
        }

        const result = await sendTeamInvite({
          email: mechanicForm.email.trim(),
          role: "shop_mechanic",
          shopId: onboardingData.shop._id,
          mechanicId,
          origin: window.location.origin,
        });

        if (!result.ok) {
          setMechanicInviteError(
            `Mechanic profile ${mechanicForm.mechanicId ? "updated" : "saved"}, but the invitation failed: ${result.error}`
          );
          return;
        }
      }

      resetMechanicForm();
      setMechanicInviteSuccess(true);
      setTimeout(() => setMechanicInviteSuccess(false), 4000);
    } catch (error) {
      setMechanicInviteError(
        error instanceof Error ? error.message : "Failed to save mechanic. Please try again."
      );
    } finally {
      setSendingInvite(false);
    }
  }

  async function handleInviteExistingMechanic(mechanic: OnboardingMechanicRow) {
    clearBanners();
    setMechanicInviteError(null);
    setMechanicInviteSuccess(false);

    if (!onboardingData?.shop?._id) return;
    if (!mechanic.email?.trim()) {
      editMechanicForInvite(mechanic);
      setMechanicInviteError("Add an email address before inviting this mechanic.");
      return;
    }

    setMechanicInviteActionId(mechanic._id);
    try {
      if (
        mechanic.pendingInvitationId &&
        (mechanic.portalStatus === "invite_sent" || mechanic.portalStatus === "invite_expired")
      ) {
        await removeTeamMember({ invitationId: mechanic.pendingInvitationId });
      }

      const result = await sendTeamInvite({
        email: mechanic.email.trim(),
        role: "shop_mechanic",
        shopId: onboardingData.shop._id,
        mechanicId: mechanic._id,
        origin: window.location.origin,
      });

      if (!result.ok) {
        setMechanicInviteError(result.error);
        return;
      }

      setMechanicInviteSuccess(true);
      setTimeout(() => setMechanicInviteSuccess(false), 4000);
    } catch (error) {
      setMechanicInviteError(
        error instanceof Error ? error.message : "Failed to send invitation. Please try again."
      );
    } finally {
      setMechanicInviteActionId(null);
    }
  }

  function handleMechanicPhotoClick(mechanic: {
    _id: string;
    shopUserId: string | null;
    pendingInvitationId: string | null;
  }) {
    clearBanners();
    setPhotoDialogMechanicId(mechanic._id);
  }

  function closeMechanicPhotoDialog() {
    setPhotoDialogMechanicId(null);
  }

  function handleChooseMechanicPhoto() {
    const mechanicId = photoDialogMechanicId;
    if (!mechanicId) return;
    pendingMechanicPhotoIdRef.current = mechanicId;
    setPhotoDialogMechanicId(null);
    mechanicPhotoInputRef.current?.click();
  }

  async function handleMechanicPhotoSelected(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = event.target.files?.[0];
    const mechanicId = pendingMechanicPhotoIdRef.current;
    event.target.value = "";
    if (!file || !mechanicId) return;

    clearBanners();
    setUploadingMechanicId(mechanicId);
    try {
      const uploadUrl = await generateUploadUrl();
      const uploadResult = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
        },
        body: file,
      });
      if (!uploadResult.ok) {
        throw new Error("Failed to upload the image file.");
      }

      const { storageId } = (await uploadResult.json()) as { storageId?: string };
      if (!storageId) {
        throw new Error("Upload did not return a storage id.");
      }

      await updateMechanicProfilePhoto({
        mechanicId: mechanicId as Id<"mechanics">,
        profilePhotoStorageId: storageId,
      });
      setStepSuccess("Mechanic profile photo updated.");
    } catch (error) {
      setStepError(
        error instanceof Error ? error.message : "Failed to update mechanic profile photo."
      );
    } finally {
      pendingMechanicPhotoIdRef.current = null;
      setUploadingMechanicId(null);
    }
  }

  async function handleRemoveMechanicPhoto() {
    const mechanicId = photoDialogMechanicId;
    if (!mechanicId) return;

    clearBanners();
    setUploadingMechanicId(mechanicId);
    setPhotoDialogMechanicId(null);
    try {
      await updateMechanicProfilePhoto({
        mechanicId: mechanicId as Id<"mechanics">,
        profilePhotoStorageId: null as never,
      });
      setStepSuccess("Mechanic profile photo removed.");
    } catch (error) {
      setStepError(
        error instanceof Error ? error.message : "Failed to remove mechanic profile photo."
      );
    } finally {
      pendingMechanicPhotoIdRef.current = null;
      setUploadingMechanicId(null);
    }
  }

  async function handleRemoveMechanic(args: {
    mechanicId: string;
    shopUserId: string | null;
    pendingInvitationId: string | null;
  }) {
    clearBanners();
    setRemovingMechanicId(args.mechanicId);
    try {
      if (args.shopUserId) {
        await removeTeamMember({ shopUserId: args.shopUserId });
      }

      if (args.pendingInvitationId) {
        await removeTeamMember({ invitationId: args.pendingInvitationId });
      }

      await removeMechanic({ mechanicId: args.mechanicId as Id<"mechanics"> });
      setRemoveMechanicConfirm(null);
      setStepSuccess("Mechanic removed.");
    } catch (error) {
      setStepError(
        error instanceof Error ? error.message : "Failed to remove mechanic."
      );
    } finally {
      setRemovingMechanicId(null);
    }
  }

  async function handleLaunchStripeOnboarding() {
    clearBanners();
    setLaunchingStripe(true);
    try {
      const response = await fetch("/api/stripe/connect/start", {
        method: "POST",
      });
      const data = (await response.json()) as {
        error?: string;
        url?: string;
      };

      if (!response.ok || !data.url) {
        throw new Error(data.error ?? "Failed to launch Stripe onboarding.");
      }

      window.location.assign(data.url);
    } catch (error) {
      setStepError(
        error instanceof Error ? error.message : "Failed to launch Stripe onboarding."
      );
      setLaunchingStripe(false);
    }
  }

  async function handleFinish() {
    clearBanners();
    setFinishing(true);
    try {
      const response = await fetch("/api/shop/onboarding/complete", {
        method: "POST",
      });
      const data = (await response.json()) as {
        error?: string;
        redirectTo?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? "Failed to complete onboarding.");
      }

      router.replace(data.redirectTo ?? "/dashboard");
    } catch (error) {
      setStepError(
        error instanceof Error ? error.message : "Failed to complete onboarding."
      );
    } finally {
      setFinishing(false);
    }
  }

  if (portalAccess === undefined) {
    return null;
  }

  if (!canAccessSetup) {
    return null;
  }

  if (onboardingData === undefined) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (onboardingData === null) {
    return (
      <div className="mx-auto max-w-3xl rounded-xl border border-amber-200 bg-amber-50 p-8 text-amber-900">
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
  const selectedMechanicForPhotoDialog =
    photoDialogMechanicId === null
      ? null
      : mechanics.find((mechanic) => mechanic._id === photoDialogMechanicId) ?? null;
  const selectedMechanicForRemoveDialog =
    removeMechanicConfirm === null
      ? null
      : mechanics.find((mechanic) => mechanic._id === removeMechanicConfirm.mechanicId) ??
        removeMechanicConfirm;
  const offeredCount = selectedServiceIds.size;
  // A selected service that legally needs the NY DMV inspection station license.
  const selectedNeedsInspectionLicense = serviceCategories.some((category) =>
    category.services.some(
      (service) =>
        selectedServiceIds.has(service._id) && service.requiresInspectionLicense,
    ),
  );
  const stripeRequirements =
    onboardingData.shop?.stripeRequirementsCurrentlyDue ?? [];
  const stripeConnectReady = onboardingData.shop?.stripeConnectReady === true;
  const stepButtonClass =
    "inline-flex items-center rounded-lg border px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-8 text-center">
        <p className="text-sm font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Partner onboarding
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-foreground">
          Shop registration and onboarding
        </h1>
        <p className="mt-3 mx-auto max-w-xl text-sm leading-6 text-muted-foreground">
          Let&apos;s get your shop ready to receive bookings. This takes about 15
          minutes - your progress is saved at every step.
        </p>
      </div>

      <nav aria-label="Onboarding progress" className="mb-8">
        <ol className="grid grid-cols-6">
          {STEP_META.map((step, index) => {
            const completed =
              index < firstIncompleteSavedStep ||
              (firstIncompleteSavedStep === 5 &&
                index === 5 &&
                onboardingData.shop?.onboardingComplete);
            const active = currentStep === index;
            const clickable =
              index <= Math.max(currentStep, firstIncompleteSavedStep);
            return (
              <li key={step.title} className="relative flex flex-col items-center">
                {index > 0 && (
                  <span
                    aria-hidden
                    className={`absolute right-1/2 top-[18px] h-px w-full -translate-y-1/2 ${
                      index <= firstIncompleteSavedStep ? "bg-primary" : "bg-border"
                    }`}
                  />
                )}
                <button
                  type="button"
                  onClick={() => handleStepChange(index)}
                  disabled={!clickable}
                  aria-current={active ? "step" : undefined}
                  className={`relative z-10 flex flex-col items-center gap-2 px-1 transition-opacity ${
                    clickable ? "cursor-pointer hover:opacity-90" : "cursor-not-allowed"
                  }`}
                >
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-sm font-semibold transition-colors ${
                      completed
                        ? "border-transparent bg-primary text-white"
                        : active
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-white text-muted-foreground"
                    }`}
                  >
                    {completed ? <Check className="h-4 w-4" /> : index + 1}
                  </span>
                  <span className="hidden text-center leading-tight sm:block">
                    <span className="block text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                      Step {index + 1}
                    </span>
                    <span
                      className={`block text-xs font-semibold ${
                        active || completed ? "text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      {step.title}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <section className="rounded-xl border border-border bg-white p-6 sm:p-8 shadow-sm">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-4 pb-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                Current step
              </p>
              <h2 className="mt-2 text-2xl font-bold text-foreground">
                Step {currentStep + 1}: {STEP_META[currentStep].title}
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                {STEP_META[currentStep].description}
              </p>
            </div>
          </div>

          {stepError && (
            <div className="mb-5 rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {stepError}
            </div>
          )}

          {stepSuccess && (
            <div className="mb-5 rounded-xl border border-success/20 bg-success/10 px-4 py-3 text-sm text-success">
              {stepSuccess}
            </div>
          )}

          {currentStep === 0 && (
            <div className="space-y-6">
              <div>
                <label className={labelClass}>
                  Shop Name <span className="text-destructive">*</span>
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
                  Page name <span className="text-destructive">*</span>
                </label>
                <div className="flex items-center overflow-hidden rounded-lg border border-input focus-within:border-transparent focus-within:ring-2 focus-within:ring-ring">
                  <span className="border-r border-input bg-muted px-3.5 py-2.5 font-mono text-sm text-muted-foreground">
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
                    className="min-w-0 flex-1 bg-white px-3.5 py-2.5 text-sm text-foreground outline-none"
                  />
                </div>
                <p className={`mt-1.5 text-xs ${slugStatus.className}`}>{slugStatus.text}</p>
              </div>

              <div ref={addressContainerRef} className="relative">
                <label className={labelClass}>
                  Street Address <span className="text-destructive">*</span>
                </label>
                <input
                  type="text"
                  value={details.address}
                  onChange={(event) => {
                    const value = event.target.value;
                    setAddressSelectedFromAutocomplete(false);
                    setHighlightedAddressSuggestionIndex(-1);
                    setDetails((prev) => ({ ...prev, address: value }));
                  }}
                  onKeyDown={handleAddressInputKeyDown}
                  autoComplete="off"
                  placeholder="1234 Main St"
                  className={inputClass}
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Start typing and pick your address from the suggestions - we&apos;ll fill in the rest.
                </p>
                {(addressLookupLoading || addressSuggestions.length > 0) && (
                  <div className="absolute left-0 right-0 top-full z-20 mt-2 overflow-hidden rounded-xl border border-border bg-white shadow-lg">
                    {addressLookupLoading && addressSuggestions.length === 0 ? (
                      <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Looking up addresses...
                      </div>
                    ) : (
                      addressSuggestions.map((entry, index) => (
                        <button
                          key={entry.id}
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => void handleSelectAddressSuggestion(entry)}
                          onMouseEnter={() => setHighlightedAddressSuggestionIndex(index)}
                          className={`block w-full border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-muted ${
                            addressSuggestions[highlightedAddressSuggestionIndex]?.id === entry.id
                              ? "bg-muted"
                              : ""
                          }`}
                        >
                          <div className="text-sm font-medium text-foreground">
                            {entry.primaryText}
                          </div>
                          {entry.secondaryText && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              {entry.secondaryText}
                            </div>
                          )}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <label className={labelClass}>
                    City <span className="text-destructive">*</span>
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
                    State <span className="text-destructive">*</span>
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
                    ZIP Code <span className="text-destructive">*</span>
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
                  Phone Number <span className="text-destructive">*</span>
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
                  className={`${stepButtonClass} border-blue-600 bg-primary text-white hover:bg-primary/90`}
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
            <div className="space-y-6">
              <div className="divide-y divide-border">
                {hours.map((row, index) => (
                  <div
                    key={row.dayOfWeek}
                    className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-6"
                  >
                    <p className="text-sm font-semibold text-foreground sm:w-28">
                      {row.dayName}
                    </p>

                    <div className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-2">
                      {row.isClosed ? (
                        <span className="text-sm text-muted-foreground">
                          Closed all day
                        </span>
                      ) : (
                        <>
                          <div className="w-32">
                            <TimePicker
                              value={row.openTime}
                              ariaLabel={`${row.dayName} opening time`}
                              onChange={(next) =>
                                setHours((prev) =>
                                  prev.map((item, itemIndex) =>
                                    itemIndex === index
                                      ? { ...item, openTime: next }
                                      : item
                                  )
                                )
                              }
                            />
                          </div>
                          <span className="text-sm text-muted-foreground">to</span>
                          <div className="w-32">
                            <TimePicker
                              value={row.closeTime}
                              ariaLabel={`${row.dayName} closing time`}
                              onChange={(next) =>
                                setHours((prev) =>
                                  prev.map((item, itemIndex) =>
                                    itemIndex === index
                                      ? { ...item, closeTime: next }
                                      : item
                                  )
                                )
                              }
                            />
                          </div>
                        </>
                      )}
                    </div>

                    <button
                      type="button"
                      role="switch"
                      aria-checked={!row.isClosed}
                      aria-label={`${row.dayName} open`}
                      onClick={() =>
                        setHours((prev) =>
                          prev.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, isClosed: !item.isClosed }
                              : item
                          )
                        )
                      }
                      className="inline-flex items-center gap-2.5 self-start sm:self-auto"
                    >
                      <span
                        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                          row.isClosed ? "bg-gray-300" : "bg-primary"
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                            row.isClosed ? "translate-x-0.5" : "translate-x-[18px]"
                          }`}
                        />
                      </span>
                      <span className="w-12 text-left text-sm font-medium text-foreground">
                        {row.isClosed ? "Closed" : "Open"}
                      </span>
                    </button>
                  </div>
                ))}
              </div>

              <div className="flex justify-between pt-2">
                <button
                  type="button"
                  onClick={() => handleStepChange(0)}
                  className={`${stepButtonClass} border-input bg-white text-foreground hover:bg-muted`}
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleSaveHours}
                  disabled={savingStep === 1}
                  className={`${stepButtonClass} border-blue-600 bg-primary text-white hover:bg-primary/90`}
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
            <div className="space-y-12">
              <section>
                <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  Rate
                </p>
                <h3 className="text-base font-semibold text-foreground">
                  What do you charge per hour?
                </h3>
                <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted-foreground">
                  Your standard labor rate — we&apos;ll use it for every car unless you
                  set a different rate below. Most Otopair shops charge between $150 and
                  $220/hr, and you can change it anytime.
                </p>
                <div className="mt-4 flex max-w-[220px] items-center rounded-xl border border-input bg-white transition-colors focus-within:border-transparent focus-within:ring-2 focus-within:ring-ring">
                  <span className="pl-3.5 pr-1 text-sm text-muted-foreground">$</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={laborRate}
                    onChange={(event) => setLaborRate(event.target.value)}
                    aria-label="Hourly labor rate"
                    className="min-w-0 flex-1 bg-transparent py-2.5 text-sm font-medium text-foreground outline-none"
                  />
                  <span className="pl-1 pr-3.5 text-sm text-muted-foreground">/ hr</span>
                </div>
              </section>

              <section>
                <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  Vehicle groups · Optional
                </p>
                <h3 className="text-base font-semibold text-foreground">
                  Charge more for certain cars?
                </h3>
                <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted-foreground">
                  Some cars take longer or need more specialized skill, so many shops
                  charge extra for them. Leave a group blank and we&apos;ll charge your
                  default{" "}
                  <span className="font-medium text-foreground">
                    ${laborRate || 150}/hr
                  </span>{" "}
                  for it.
                </p>

                <div className="mt-6">
                  <div className="hidden grid-cols-[minmax(0,1fr)_6rem_8rem_9rem] gap-4 pb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground md:grid">
                    <span>Vehicle group</span>
                    <span className="text-center">Typical range</span>
                    <span>Your rate</span>
                    <span aria-hidden />
                  </div>

                  <ul className="divide-y divide-border border-t border-border">
                    {VEHICLE_GROUPS.map((group) => {
                      const row = groupRows[group.id] ?? {
                        rate: "",
                        notServiced: false,
                      };
                      const notServiced = row.notServiced;
                      return (
                        <li
                          key={group.id}
                          className="grid grid-cols-1 items-center gap-x-4 gap-y-3 py-5 md:grid-cols-[minmax(0,1fr)_6rem_8rem_9rem]"
                        >
                          <div
                            title={`Internal pricing groups: ${group.tiers.join(", ")}`}
                            className={
                              notServiced
                                ? "opacity-50 transition-opacity"
                                : "transition-opacity"
                            }
                          >
                            <p className="text-sm font-semibold text-foreground">
                              {group.name}
                            </p>
                            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                              e.g. {group.examples}
                            </p>
                          </div>

                          <p className="whitespace-nowrap text-xs text-muted-foreground md:text-center">
                            ${group.rangeLow} – ${group.rangeHigh}
                          </p>

                          <div>
                            {notServiced ? (
                              <span className="inline-flex items-center rounded-xl bg-muted px-3.5 py-2.5 text-xs text-muted-foreground">
                                Not serviced
                              </span>
                            ) : (
                              <div className="inline-flex items-center rounded-xl border border-input bg-white transition-colors focus-within:border-transparent focus-within:ring-2 focus-within:ring-ring">
                                <span className="pl-3 pr-1 text-sm text-muted-foreground">$</span>
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  value={row.rate}
                                  onChange={(event) => {
                                    const next = event.target.value.replace(
                                      /[^0-9]/g,
                                      "",
                                    );
                                    setGroupRows((prev) => ({
                                      ...prev,
                                      [group.id]: {
                                        ...(prev[group.id] ?? {
                                          rate: "",
                                          notServiced: false,
                                        }),
                                        rate: next,
                                      },
                                    }));
                                  }}
                                  placeholder={String(laborRate || 150)}
                                  aria-label={`Your hourly rate for ${group.name}`}
                                  className="w-16 bg-transparent py-2.5 pr-3 text-sm font-medium text-foreground outline-none"
                                />
                              </div>
                            )}
                          </div>

                          <div className="md:text-right">
                            <button
                              type="button"
                              onClick={() =>
                                setGroupRows((prev) => {
                                  const current = prev[group.id] ?? {
                                    rate: "",
                                    notServiced: false,
                                  };
                                  return {
                                    ...prev,
                                    [group.id]: {
                                      rate: current.notServiced ? current.rate : "",
                                      notServiced: !current.notServiced,
                                    },
                                  };
                                })
                              }
                              className={`text-xs underline-offset-4 hover:underline ${
                                notServiced
                                  ? "text-primary"
                                  : "text-muted-foreground hover:text-foreground"
                              }`}
                            >
                              {notServiced ? "Undo" : "I don't work on these"}
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </section>

              <section>
                <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  Services
                </p>
                <div className="flex items-start justify-between gap-6">
                  <div>
                    <h3 className="text-base font-semibold text-foreground">
                      Which services do you offer?
                    </h3>
                    <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted-foreground">
                      Pick the services your shop is set up for. Set a fixed price per
                      vehicle group if you like, or leave it blank to use your standard
                      quote range.
                    </p>
                  </div>
                  <div className="mt-0.5 flex shrink-0 items-center gap-2.5 text-sm">
                    <button
                      type="button"
                      onClick={() => {
                        const allIds = serviceCategories.flatMap((c) =>
                          c.services.map((s) => s._id)
                        );
                        const allSelected =
                          allIds.length > 0 && allIds.every((id) => selectedServiceIds.has(id));
                        setSelectedServiceIds(allSelected ? new Set() : new Set(allIds));
                      }}
                      className="font-medium text-primary hover:underline"
                    >
                      {(() => {
                        const allIds = serviceCategories.flatMap((c) =>
                          c.services.map((s) => s._id)
                        );
                        return allIds.length > 0 && allIds.every((id) => selectedServiceIds.has(id))
                          ? "Clear all"
                          : "Select all";
                      })()}
                    </button>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">{offeredCount} selected</span>
                  </div>
                </div>

                {selectedNeedsInspectionLicense && (
                  <p className="mt-4 flex items-start gap-2 text-sm leading-relaxed text-muted-foreground">
                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <span>
                      <span className="font-medium text-foreground">
                        State Inspection &amp; Emissions Tests
                      </span>{" "}
                      need a NY DMV inspection station license — add it next, or in
                      Settings.
                    </span>
                  </p>
                )}

                <div className="mt-6 flex flex-col gap-8">
                  {serviceCategories
                    .filter((category) => category.services.length > 0)
                    .map((category) => {
                      const categoryIds = category.services.map((s) => s._id);
                      const allInCategorySelected = categoryIds.every((id) =>
                        selectedServiceIds.has(id)
                      );
                      return (
                        <div key={category.id}>
                          <div className="mb-1 flex items-center justify-between">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                              {category.name}
                            </p>
                            <button
                              type="button"
                              onClick={() =>
                                setSelectedServiceIds((prev) => {
                                  const next = new Set(prev);
                                  if (allInCategorySelected) {
                                    categoryIds.forEach((id) => next.delete(id));
                                  } else {
                                    categoryIds.forEach((id) => next.add(id));
                                  }
                                  return next;
                                })
                              }
                              className="text-xs font-medium text-primary hover:underline"
                            >
                              {allInCategorySelected ? "Clear" : "Select all"}
                            </button>
                          </div>
                          <div className="divide-y divide-border">
                            {category.services.map((service) => {
                              const checked = selectedServiceIds.has(service._id);
                              const prices = fixedPricesByService[service._id] ?? {};
                              const pricedCount = countPricedGroups(prices);
                              const isPricingOpen =
                                checked && pricingOpenServiceIds.has(service._id);
                              return (
                                <div key={service._id} className="py-3.5">
                                  <div className="flex items-start gap-3">
                                    <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
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
                                        className="mt-1 h-4 w-4 rounded border-input text-primary focus:ring-ring"
                                        aria-label={`Offer ${service.name}`}
                                      />
                                      <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                          <p className="text-sm font-medium text-foreground">
                                            {service.name}
                                          </p>
                                          <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                                            {service.defaultLaborHours} hr
                                          </span>
                                        </div>
                                        {service.description ? (
                                          <p className="mt-1 text-sm leading-6 text-muted-foreground">
                                            {service.description}
                                          </p>
                                        ) : null}
                                      </div>
                                    </label>
                                    {checked ? (
                                      <Tooltip
                                        className="mt-0.5 shrink-0"
                                        content="Set a fixed price for this service by vehicle group — e.g. charge more on an exotic than an everyday car. Leave a group blank to use your standard quote range."
                                      >
                                        <button
                                          type="button"
                                          onClick={() =>
                                            setPricingOpenServiceIds((prev) => {
                                              const next = new Set(prev);
                                              if (next.has(service._id)) next.delete(service._id);
                                              else next.add(service._id);
                                              return next;
                                            })
                                          }
                                          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                                            isPricingOpen
                                              ? "border-blue-200 bg-blue-50 text-blue-700"
                                              : "border-input text-muted-foreground hover:bg-muted"
                                          }`}
                                          aria-expanded={isPricingOpen}
                                        >
                                          <Sliders className="h-3.5 w-3.5" />
                                          {pricedCount > 0
                                            ? `${pricedCount} fixed price${pricedCount === 1 ? "" : "s"}`
                                            : "Fixed prices"}
                                        </button>
                                      </Tooltip>
                                    ) : null}
                                  </div>
                                  {isPricingOpen ? (
                                    <div className="mt-3 overflow-hidden rounded-xl bg-muted">
                                      <FixedPriceTierStrip
                                        prices={prices}
                                        declinedTiers={declinedTierSet}
                                        onChange={(nextPrices) =>
                                          setFixedPricesByService((prev) => ({
                                            ...prev,
                                            [service._id]: nextPrices,
                                          }))
                                        }
                                        onPersist={async (nextPrices) => {
                                          if (!persistedShopId) return;
                                          const baseline =
                                            fixedPricesBaseline[service._id] ?? {};
                                          const centsPatch = priceMapToCents(nextPrices);
                                          const changed: Partial<
                                            Record<FixedPriceTier, number | null>
                                          > = {};
                                          for (const tier of FIXED_PRICE_TIERS) {
                                            if (
                                              (nextPrices[tier] ?? "") !==
                                              (baseline[tier] ?? "")
                                            ) {
                                              changed[tier] =
                                                tier in centsPatch
                                                  ? centsPatch[tier]!
                                                  : null;
                                            }
                                          }
                                          if (Object.keys(changed).length === 0) return;
                                          await setShopServiceFixedPrices({
                                            shop_id: persistedShopId,
                                            service_id: service._id as Id<"services">,
                                            prices: changed,
                                          });
                                          setFixedPricesBaseline((prev) => ({
                                            ...prev,
                                            [service._id]: { ...nextPrices },
                                          }));
                                        }}
                                      />
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                </div>
              </section>

              <div className="flex justify-between border-t border-border pt-8">
                <button
                  type="button"
                  onClick={() => handleStepChange(1)}
                  className={`${stepButtonClass} border-input bg-white text-foreground hover:bg-muted`}
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleSaveServices}
                  disabled={savingStep === 2}
                  className={`${stepButtonClass} border-blue-600 bg-primary text-white hover:bg-primary/90`}
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
            <div className="space-y-8">
              <LicenseUploader
                shopId={persistedShopId}
                inspectionSelected={selectedNeedsInspectionLicense}
              />

              <div className="flex justify-between pt-2">
                <button
                  type="button"
                  onClick={() => handleStepChange(2)}
                  className={`${stepButtonClass} border-input bg-white text-foreground hover:bg-muted`}
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => {
                    clearBanners();
                    setCurrentStep(4);
                  }}
                  className={`${stepButtonClass} border-blue-600 bg-primary text-white hover:bg-primary/90`}
                >
                  <ChevronRight className="mr-2 h-4 w-4" />
                  Continue
                </button>
              </div>
            </div>
          )}

          {currentStep === 4 && (
            <div className="space-y-6">
              <div
                ref={mechanicFormRef}
                className="grid gap-4 md:grid-cols-3"
              >
                <div>
                  <label className={labelClass}>
                    First Name <span className="text-destructive">*</span>
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
                    placeholder="John"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>
                    Last Name <span className="text-destructive">*</span>
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
                    placeholder="Doe"
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
                  <label className={labelClass}>Email Address</label>
                  <input
                    ref={mechanicEmailInputRef}
                    type="email"
                    value={mechanicForm.email}
                    onChange={(event) =>
                      setMechanicForm((prev) => ({
                        ...prev,
                        email: event.target.value,
                      }))
                    }
                    placeholder="mechanic@example.com"
                    className={inputClass}
                  />
                </div>
                <div className="flex flex-wrap justify-end gap-2 md:col-span-3">
                  {mechanicForm.mechanicId && (
                    <button
                      type="button"
                      onClick={() => {
                        resetMechanicForm();
                        setMechanicInviteError(null);
                        setMechanicInviteSuccess(false);
                      }}
                      disabled={sendingInvite}
                      className={`${stepButtonClass} border-input bg-white text-foreground hover:bg-muted`}
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleInviteMechanic}
                    disabled={sendingInvite}
                    className={`${stepButtonClass} border-blue-600 bg-primary text-white hover:bg-primary/90`}
                  >
                    {sendingInvite ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Wrench className="mr-2 h-4 w-4" />
                    )}
                    {mechanicForm.email.trim() ? "Save and invite mechanic" : "Save mechanic"}
                  </button>
                </div>
              </div>

              {mechanicInviteError && (
                <div className="rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {mechanicInviteError}
                </div>
              )}

              {mechanicInviteSuccess && (
                <div className="rounded-xl border border-success/20 bg-success/10 px-4 py-3 text-sm text-success">
                  Mechanic saved successfully.
                </div>
              )}

              <input
                ref={mechanicPhotoInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleMechanicPhotoSelected}
              />

              <div className="border-t border-border pt-6">
                <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  Your team
                </p>
                <div className="space-y-3">
                {mechanics.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border bg-muted/30 px-6 py-10 text-center">
                    <Users className="mx-auto h-6 w-6 text-muted-foreground" />
                    <p className="mt-3 text-sm font-medium text-foreground">
                      No mechanics yet
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Add your first mechanic above, or skip this step and invite
                      them later.
                    </p>
                  </div>
                ) : (
                  mechanics.map((mechanic) => (
                    <div
                      key={mechanic._id}
                      className="flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-4"
                    >
                      <div className="flex min-w-0 items-center gap-4">
                        <button
                          type="button"
                          onClick={() => handleMechanicPhotoClick(mechanic)}
                          disabled={uploadingMechanicId === mechanic._id}
                          className="group relative h-14 w-14 shrink-0 disabled:cursor-wait disabled:opacity-80"
                          aria-label={`Add a profile photo for ${mechanic.firstName} ${mechanic.lastName}`}
                        >
                          <div className="h-14 w-14 overflow-hidden rounded-full border border-input bg-slate-700 text-white transition-colors group-hover:border-blue-300 group-hover:bg-slate-800">
                            {mechanic.photoUrl ? (
                              <img
                                src={mechanic.photoUrl}
                                alt={`${mechanic.firstName} ${mechanic.lastName}`}
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(135deg,#5B4BFF_0%,#8B5CF6_100%)] text-lg font-semibold tracking-tight text-white">
                                {getInitials(mechanic.firstName, mechanic.lastName)}
                              </div>
                            )}
                            <span className="absolute inset-0 rounded-full bg-black/0 transition-colors group-hover:bg-black/10" />
                          </div>
                          <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-white ring-2 ring-white">
                            {uploadingMechanicId === mechanic._id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Plus className="h-3.5 w-3.5" />
                            )}
                          </span>
                        </button>

                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground">
                            {mechanic.firstName} {mechanic.lastName}
                          </p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {mechanic.title || "Mechanic"}
                          </p>
                          <p className="mt-1 text-xs font-medium text-primary">
                            {getMechanicPortalStatusLabel(mechanic.portalStatus)}
                          </p>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {mechanic.portalStatus !== "active" && (
                          <button
                            type="button"
                            onClick={() => void handleInviteExistingMechanic(mechanic)}
                            disabled={mechanicInviteActionId === mechanic._id}
                            className="inline-flex items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {mechanicInviteActionId === mechanic._id && (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            )}
                            {getMechanicInviteLabel(mechanic.portalStatus)}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            if ((mechanic.blockingBookingCount ?? 0) > 0) {
                              setStepError(
                                "This mechanic has active bookings or jobs that must be completed or reassigned first."
                              );
                              return;
                            }
                            setRemoveMechanicConfirm({
                              mechanicId: mechanic._id,
                              shopUserId: mechanic.shopUserId,
                              pendingInvitationId: mechanic.pendingInvitationId,
                              firstName: mechanic.firstName,
                              lastName: mechanic.lastName,
                            });
                          }}
                          disabled={removingMechanicId === mechanic._id}
                          className="inline-flex items-center gap-2 rounded-lg border border-destructive/20 px-3 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10"
                        >
                          {removingMechanicId === mechanic._id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                          {removingMechanicId === mechanic._id ? "Removing..." : "Remove"}
                        </button>
                      </div>
                    </div>
                  ))
                )}
                </div>
              </div>

              <ConfirmationDialog
                open={selectedMechanicForPhotoDialog !== null}
                title={
                  <span className="block text-center text-xl font-semibold text-foreground">
                    Profile Photo
                  </span>
                }
                description={
                  <span className="block text-center text-sm text-muted-foreground">
                    {selectedMechanicForPhotoDialog
                      ? `Select an option to update ${selectedMechanicForPhotoDialog.firstName} ${selectedMechanicForPhotoDialog.lastName}'s profile picture.`
                      : ""}
                  </span>
                }
                onClose={closeMechanicPhotoDialog}
                enableShortcuts={false}
                maxWidthClassName="max-w-md"
              >
                <div className="space-y-3">
                  <button
                    type="button"
                    onClick={handleChooseMechanicPhoto}
                    disabled={uploadingMechanicId === selectedMechanicForPhotoDialog?._id}
                    className="inline-flex h-12 w-full items-center justify-center rounded-lg bg-primary px-4 text-sm font-semibold text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Add photo
                  </button>
                  <button
                    type="button"
                    onClick={handleRemoveMechanicPhoto}
                    disabled={
                      !selectedMechanicForPhotoDialog?.photoUrl ||
                      uploadingMechanicId === selectedMechanicForPhotoDialog?._id
                    }
                    className="inline-flex h-12 w-full items-center justify-center rounded-lg border border-destructive/20 bg-destructive/10 px-4 text-sm font-semibold text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Remove photo
                  </button>
                  <button
                    type="button"
                    onClick={closeMechanicPhotoDialog}
                    className="inline-flex h-12 w-full items-center justify-center rounded-lg border border-input bg-white px-4 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
                  >
                    Cancel
                  </button>
                </div>
              </ConfirmationDialog>

              <RemoveConfirmationDialog
                open={removeMechanicConfirm !== null}
                title="Remove mechanic?"
                subjectName={
                  selectedMechanicForRemoveDialog
                    ? `${selectedMechanicForRemoveDialog.firstName} ${selectedMechanicForRemoveDialog.lastName}`
                    : undefined
                }
                confirmLabel="Remove mechanic"
                isSubmitting={!!removingMechanicId}
                submittingLabel="Removing..."
                onClose={() => setRemoveMechanicConfirm(null)}
                onConfirm={() => {
                  if (!removeMechanicConfirm) return;
                  void handleRemoveMechanic(removeMechanicConfirm);
                }}
              />

              <div className="flex justify-between pt-2">
                <button
                  type="button"
                  onClick={() => handleStepChange(3)}
                  className={`${stepButtonClass} border-input bg-white text-foreground hover:bg-muted`}
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => {
                    clearBanners();
                    setCurrentStep(5);
                  }}
                  className={`${stepButtonClass} border-blue-600 bg-primary text-white hover:bg-primary/90`}
                >
                  <ChevronRight className="mr-2 h-4 w-4" />
                  {mechanics.length === 0 ? "Skip for now" : "Continue"}
                </button>
              </div>
            </div>
          )}

          {currentStep === 5 && (
            <div className="space-y-6">
              <div className="grid gap-4 md:grid-cols-[1.1fr_0.9fr]">
                <div className="rounded-xl border border-border bg-white p-5 shadow-sm">
                  <div className="flex items-center gap-3">
                    <div className="rounded-lg bg-primary/10 p-2 text-primary">
                      <CreditCard className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-foreground">
                        Stripe Connect onboarding
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Connect your bank account securely through Stripe.
                      </p>
                    </div>
                  </div>
                  <div className="mt-5 rounded-xl border border-dashed border-input bg-muted p-4 text-sm leading-6 text-muted-foreground">
                    {onboardingData.shop?.stripeConnectAccountId ? (
                      <>
                        {stripeConnectReady
                          ? "Stripe has verified this shop for charges and payouts."
                          : stripeRequirements.length > 0
                            ? "Stripe still needs more information. Reopen onboarding below and finish the hosted steps."
                            : "Stripe has created a connected account and is still finalizing verification."}
                        <div className="mt-2 font-mono text-xs text-foreground">
                          {onboardingData.shop.stripeConnectAccountId}
                        </div>
                        <div className="mt-2 text-xs font-semibold text-foreground">
                          Status: {stripeConnectReady ? "Ready" : "Not ready"}
                        </div>
                      </>
                    ) : (
                      <>
                        Launch Stripe Express onboarding to connect the bank account where
                        Otopair should send payouts for this shop.
                      </>
                    )}
                  </div>
                  <div className="mt-5 flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={handleLaunchStripeOnboarding}
                      disabled={launchingStripe}
                      className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {launchingStripe ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <CreditCard className="h-4 w-4" />
                      )}
                      {onboardingData.shop?.stripeConnectAccountId
                        ? "Open Stripe onboarding"
                        : "Connect your bank account"}
                    </button>
                    {onboardingData.shop?.stripeConnectAccountId ? (
                      <p className="max-w-sm text-sm text-muted-foreground">
                        Use this again any time Stripe asks for more information.
                      </p>
                    ) : null}
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Otopair never sees or stores your bank details - Stripe handles everything.
                  </p>
                </div>

                <div className="rounded-xl border border-border bg-muted p-5 shadow-sm">
                  <h3 className="text-lg font-semibold text-foreground">Setup summary</h3>
                  <div className="mt-4 space-y-3 text-sm text-muted-foreground">
                    <div className="flex items-center justify-between rounded-xl bg-white px-4 py-3">
                      <span>Shop details</span>
                      <span className="font-medium text-foreground">
                        {details.name || "Incomplete"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between rounded-xl bg-white px-4 py-3">
                      <span>Weekly hours</span>
                      <span className="font-medium text-foreground">
                        {hours.filter((row) => !row.isClosed).length} open days
                      </span>
                    </div>
                    <div className="flex items-center justify-between rounded-xl bg-white px-4 py-3">
                      <span>Services selected</span>
                      <span className="font-medium text-foreground">{offeredCount}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-xl bg-white px-4 py-3">
                      <span>Mechanics added</span>
                      <span className="font-medium text-foreground">{mechanics.length}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-xl bg-white px-4 py-3">
                      <span>Labor rate</span>
                      <span className="font-medium text-foreground">${laborRate}/hr</span>
                    </div>
                  </div>
                </div>
              </div>

              <div
                className={`rounded-xl border px-4 py-4 text-sm leading-6 ${
                  stripeConnectReady
                    ? "border-success/20 bg-success/10 text-success"
                    : "border-amber-200 bg-amber-50 text-amber-900"
                }`}
              >
                {stripeConnectReady
                  ? "Stripe Connect is ready. You can finish setup now."
                  : "To finish setup, connect your bank account through Stripe. That's how we'll send you payments for the jobs you complete."}
              </div>

              <div className="flex justify-between pt-2">
                <button
                  type="button"
                  onClick={() => handleStepChange(4)}
                  className={`${stepButtonClass} border-input bg-white text-foreground hover:bg-muted`}
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleFinish}
                  disabled={finishing || !stripeConnectReady}
                  className={`${stepButtonClass} border-blue-600 bg-primary text-white hover:bg-primary/90`}
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
  );
}
