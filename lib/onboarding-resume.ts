import type { OnboardingStep } from "@/components/onboarding/OnboardingFlow";

const HEARD_ABOUT_QUESTION = "How did you hear about Otopair?";
const VISIT_REASON_QUESTION = "What brings you to Otopair today?";
const ZIP_CODE_QUESTION = "What's your zip code?";

type PersistedUser = {
  auth_provider?: string;
  email?: string;
  emailConfirmed?: boolean;
  first_name?: string;
  last_name?: string;
  phone?: string;
  phoneVerified?: boolean;
  profile_photo_storage_id?: string;
  profile_photo_url?: string;
};

type PersistedQa = {
  questions_and_answers?: Array<{ question?: string; answer?: string }>;
  user_intentions?: { intentions?: string[] };
};

type ResumeData = {
  authProvider: "google" | "apple" | "email" | null;
  email: string | null;
  emailConfirmed: boolean;
  firstName: string | null;
  lastName: string | null;
  phoneNumber: string | null;
  phoneVerified: boolean;
  profilePhotoUri: string | null;
  userIntentions: string[] | null;
  heardAboutOtopair: string | null;
  visitReason: string | null;
  zipCode: string | null;
};

export type DevicePermissionState = {
  pushNotificationStatus: "granted" | "provisional" | "denied" | "undetermined" | null;
  locationPermissionStatus: "granted" | "denied" | "undetermined" | null;
};

export function buildOnboardingResumeData(
  user: PersistedUser | null | undefined,
  qa: PersistedQa | null | undefined,
): ResumeData {
  const answers = Array.isArray(qa?.questions_and_answers)
    ? qa!.questions_and_answers
    : [];

  const getAnswer = (question: string) =>
    answers.find((entry) => entry?.question === question)?.answer ?? null;

  const authProvider =
    user?.auth_provider === "google" ||
    user?.auth_provider === "apple" ||
    user?.auth_provider === "email"
      ? user.auth_provider
      : null;

  return {
    authProvider,
    email: user?.email ?? null,
    emailConfirmed: user?.emailConfirmed === true,
    firstName: user?.first_name ?? null,
    lastName: user?.last_name ?? null,
    phoneNumber: user?.phone ?? null,
    phoneVerified: user?.phoneVerified === true,
    profilePhotoUri:
      user?.profile_photo_storage_id && user?.profile_photo_url
        ? user.profile_photo_url
        : null,
    userIntentions:
      Array.isArray(qa?.user_intentions?.intentions) &&
      qa!.user_intentions!.intentions.length > 0
        ? qa!.user_intentions!.intentions
        : null,
    heardAboutOtopair: getAnswer(HEARD_ABOUT_QUESTION),
    visitReason: getAnswer(VISIT_REASON_QUESTION),
    zipCode: getAnswer(ZIP_CODE_QUESTION),
  };
}

export function getIncompleteOnboardingStepsFromResumeData(
  data: ResumeData,
  permissions: DevicePermissionState,
): OnboardingStep[] {
  const stepChecks: Array<{ step: OnboardingStep; isComplete: boolean }> = [
    { step: "phone", isComplete: !!data.phoneNumber },
    { step: "confirm", isComplete: data.phoneVerified },
    { step: "name", isComplete: !!(data.firstName && data.lastName) },
    { step: "emailConfirm", isComplete: data.emailConfirmed },
    { step: "profilePhoto", isComplete: !!data.profilePhotoUri },
    {
      step: "userIntent",
      isComplete: !!(data.userIntentions && data.userIntentions.length > 0),
    },
    { step: "heardAbout", isComplete: !!data.heardAboutOtopair },
    { step: "visitReason", isComplete: !!data.visitReason },
    { step: "zipCode", isComplete: !!data.zipCode },
    {
      step: "pushNotifications",
      isComplete: permissions.pushNotificationStatus !== null,
    },
    {
      step: "locationServices",
      isComplete: permissions.locationPermissionStatus !== null,
    },
  ];

  return stepChecks
    .filter(({ isComplete }) => !isComplete)
    .map(({ step }) => step);
}

export async function getDevicePermissionState(): Promise<DevicePermissionState> {
  let pushNotificationStatus: DevicePermissionState["pushNotificationStatus"] =
    null;
  let locationPermissionStatus: DevicePermissionState["locationPermissionStatus"] =
    null;

  try {
    // @ts-ignore Runtime module
    const notifications = await import("expo-notifications");
    const result = await notifications.getPermissionsAsync();
    if (
      result.status === "granted" ||
      result.status === "provisional" ||
      result.status === "denied" ||
      result.status === "undetermined"
    ) {
      pushNotificationStatus = result.status;
    } else {
      pushNotificationStatus = "undetermined";
    }
  } catch {
    pushNotificationStatus = null;
  }

  try {
    // @ts-ignore Runtime module
    const location = await import("expo-location");
    const result = await location.getForegroundPermissionsAsync();
    if (
      result.status === "granted" ||
      result.status === "denied" ||
      result.status === "undetermined"
    ) {
      locationPermissionStatus = result.status;
    } else {
      locationPermissionStatus = result.granted ? "granted" : "undetermined";
    }
  } catch {
    locationPermissionStatus = null;
  }

  return {
    pushNotificationStatus,
    locationPermissionStatus,
  };
}
