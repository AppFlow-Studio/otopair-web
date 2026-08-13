type ClerkPhoneNumberResource = {
  id: string;
  phoneNumber?: string | null;
  verification?: { status?: string | null } | null;
  prepareVerification?: (...args: any[]) => Promise<unknown>;
  destroy: () => Promise<unknown>;
};

type ClerkUserWithPhoneNumbers = {
  phoneNumbers: ClerkPhoneNumberResource[];
  reload?: () => Promise<unknown>;
  update?: (params: { primaryPhoneNumberId?: string }) => Promise<unknown>;
};

export const normalizePhoneForComparison = (phone: string | undefined | null) =>
  (phone ?? "").replace(/\D/g, "");

export const isPhoneNumberVerified = (phoneNumber: ClerkPhoneNumberResource | undefined | null) =>
  phoneNumber?.verification?.status === "verified";

export const findPhoneNumberByNormalizedValue = (
  user: ClerkUserWithPhoneNumbers,
  normalizedPhone: string,
) =>
  user.phoneNumbers.find(
    (phoneNumber) =>
      normalizePhoneForComparison(phoneNumber.phoneNumber) === normalizedPhone,
  );

export const isIdentifierAlreadyTakenError = (err: unknown) => {
  const code = (err as any)?.errors?.[0]?.code ?? (err as any)?.code;
  const message = err instanceof Error ? err.message : String((err as any)?.message ?? "");
  const lowerMessage = message.toLowerCase();
  return (
    code === "form_identifier_exists" ||
    lowerMessage.includes("phone number is taken") ||
    lowerMessage.includes("email address is taken") ||
    lowerMessage.includes("identifier already exists")
  );
};

export const cleanupStaleUnverifiedPhoneNumbers = async (
  user: ClerkUserWithPhoneNumbers,
  normalizedPhoneToKeep: string,
) => {
  const cleanupResults = await Promise.allSettled(
    user.phoneNumbers
      .filter(
        (phoneNumber) =>
          !isPhoneNumberVerified(phoneNumber) &&
          normalizePhoneForComparison(phoneNumber.phoneNumber) !== normalizedPhoneToKeep,
      )
      .map((phoneNumber) => phoneNumber.destroy()),
  );

  const failedCleanup = cleanupResults.filter((result) => result.status === "rejected");
  if (failedCleanup.length > 0) {
    console.warn("Failed to remove one or more stale unverified phone numbers:", failedCleanup);
  }
};

export const destroyOtherPhoneNumbers = async (
  user: ClerkUserWithPhoneNumbers,
  phoneNumberIdToKeep: string,
  options?: { makePrimary?: boolean },
) => {
  if (options?.makePrimary === true) {
    await user.update?.({ primaryPhoneNumberId: phoneNumberIdToKeep });
  }

  await user.reload?.();
  const cleanupResults = await Promise.allSettled(
    user.phoneNumbers
      .filter((phoneNumber) => phoneNumber.id !== phoneNumberIdToKeep)
      .map((phoneNumber) => phoneNumber.destroy()),
  );

  const failedCleanup = cleanupResults.filter((result) => result.status === "rejected");
  if (failedCleanup.length > 0) {
    console.warn("Failed to remove one or more secondary phone numbers:", failedCleanup);
  }
  await user.reload?.();
};
