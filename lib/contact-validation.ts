export const normalizeContactEmail = (email: string | undefined | null) =>
  (email ?? "").trim().toLowerCase();

export const isValidEmailAddress = (email: string | undefined | null) => {
  const normalizedEmail = normalizeContactEmail(email);
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(normalizedEmail);
};

export const normalizePhoneDigits = (phone: string | undefined | null) =>
  (phone ?? "").replace(/\D/g, "");

export const isValidPhoneNumber = (
  nationalPhone: string | undefined | null,
  callingCode = "1",
) => {
  const nationalDigits = normalizePhoneDigits(nationalPhone);
  const callingCodeDigits = normalizePhoneDigits(callingCode);

  if (callingCodeDigits === "1") {
    return nationalDigits.length === 10;
  }

  const fullDigits = `${callingCodeDigits}${nationalDigits}`;
  return nationalDigits.length >= 4 && fullDigits.length >= 8 && fullDigits.length <= 15;
};
