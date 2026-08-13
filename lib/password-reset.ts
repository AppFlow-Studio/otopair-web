export type PasswordResetMethod = "email" | "phone";

export type PasswordResetFlowStep = "method" | "email" | "phone" | "code" | "password";

export type PasswordResetBackTarget = "login" | "method" | PasswordResetMethod;

export type PasswordResetErrorPhase = "send" | "verify" | "reset";

export const PASSWORD_RESET_RESEND_SECONDS = 60;

export type PasswordResetStrategy =
  | "reset_password_email_code"
  | "reset_password_phone_code";

export type PasswordResetAttempt =
  | {
      strategy: "reset_password_email_code";
      code: string;
      password?: string;
    }
  | {
      strategy: "reset_password_phone_code";
      code: string;
      password?: string;
    };

export interface ResetPasswordValidation {
  isLongEnough: boolean;
  passwordsMatch: boolean;
  canSubmit: boolean;
}

export interface PasswordResetErrorOptions {
  method?: PasswordResetMethod;
  phase?: PasswordResetErrorPhase;
}

export interface DistributedPasswordResetCodeInput {
  code: string[];
  nextFocusIndex: number;
  fullCode: string;
}

interface ClerkErrorDetail {
  code?: string;
  message?: string;
  longMessage?: string;
}

export function getPasswordResetStrategy(
  method: PasswordResetMethod
): PasswordResetStrategy {
  return method === "email"
    ? "reset_password_email_code"
    : "reset_password_phone_code";
}

export function getPasswordResetAttempt(
  method: PasswordResetMethod,
  code: string,
  password?: string
): PasswordResetAttempt {
  if (method === "email") {
    return {
      strategy: "reset_password_email_code",
      code,
      ...(password ? { password } : {}),
    };
  }

  return {
    strategy: "reset_password_phone_code",
    code,
    ...(password ? { password } : {}),
  };
}

export function getPasswordResetIdentifierLabel(
  _method: PasswordResetMethod,
  identifier: string
) {
  return identifier.trim();
}

export function getPasswordResetBackTarget(
  step: PasswordResetFlowStep,
  method: PasswordResetMethod
): PasswordResetBackTarget {
  switch (step) {
    case "method":
    case "password":
      return "login";
    case "email":
    case "phone":
      return "method";
    case "code":
      return method;
  }
}

export function validateResetPassword(
  password: string,
  confirmPassword: string
): ResetPasswordValidation {
  const isLongEnough = password.length >= 8;
  const passwordsMatch = password === confirmPassword;

  return {
    isLongEnough,
    passwordsMatch,
    canSubmit: isLongEnough && passwordsMatch && confirmPassword.length > 0,
  };
}

export function isValidResetEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function getPasswordResetTimeRemaining(
  availableAtMs: number | null,
  nowMs = Date.now()
): number {
  if (!availableAtMs) {
    return 0;
  }

  return Math.max(0, Math.ceil((availableAtMs - nowMs) / 1000));
}

export function distributePasswordResetCodeInput(
  currentCode: string[],
  value: string,
  index: number
): DistributedPasswordResetCodeInput {
  const nextCode = currentCode.slice(0, 6);
  while (nextCode.length < 6) {
    nextCode.push("");
  }

  const boundedIndex = Math.max(0, Math.min(index, nextCode.length - 1));
  const digits = value.replace(/\D/g, "").slice(0, nextCode.length - boundedIndex);

  if (!digits) {
    nextCode[boundedIndex] = "";
    return {
      code: nextCode,
      nextFocusIndex: boundedIndex,
      fullCode: nextCode.join(""),
    };
  }

  digits.split("").forEach((digit, offset) => {
    nextCode[boundedIndex + offset] = digit;
  });

  return {
    code: nextCode,
    nextFocusIndex: Math.min(boundedIndex + digits.length, nextCode.length - 1),
    fullCode: nextCode.join(""),
  };
}

export function getPasswordResetErrorMessage(
  error: unknown,
  fallback: string,
  options: PasswordResetErrorOptions = {}
): string {
  const clerkError = getFirstClerkError(error);
  const rawMessage = clerkError?.longMessage || clerkError?.message;
  const normalized = [
    clerkError?.code,
    clerkError?.message,
    clerkError?.longMessage,
    error instanceof Error ? error.message : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();

  if (
    normalized.includes("network request failed") ||
    normalized.includes("failed to fetch") ||
    normalized.includes("networkerror")
  ) {
    return "Network error. Check your connection and try again.";
  }

  if (
    options.phase === "send" &&
    (normalized.includes("identifier_not_found") ||
      normalized.includes("form_identifier_not_found") ||
      normalized.includes("not found") ||
      normalized.includes("not registered") ||
      normalized.includes("not exist") ||
      normalized.includes("couldn't find") ||
      normalized.includes("could not find"))
  ) {
    return options.method === "phone"
      ? "We couldn't find an account with that phone number."
      : "We couldn't find an account with that email.";
  }

  if (normalized.includes("expired")) {
    return "This code expired. Send a new one.";
  }

  if (
    normalized.includes("code_incorrect") ||
    normalized.includes("incorrect") ||
    normalized.includes("invalid_code") ||
    normalized.includes("verification_code_invalid") ||
    normalized.includes("invalid verification") ||
    normalized.includes("doesn't match") ||
    normalized.includes("didn't match")
  ) {
    return "That code didn't match. Try again.";
  }

  if (rawMessage) {
    return rawMessage;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return fallback;
}

export function getClerkErrorMessage(
  error: unknown,
  fallback: string
): string {
  return getPasswordResetErrorMessage(error, fallback);
}

function getFirstClerkError(error: unknown): ClerkErrorDetail | null {
  if (typeof error !== "object" || error === null || !("errors" in error)) {
    return null;
  }

  const maybeErrors = (error as { errors?: unknown }).errors;
  if (!Array.isArray(maybeErrors)) {
    return null;
  }

  const firstError = maybeErrors[0];
  if (typeof firstError !== "object" || firstError === null) {
    return null;
  }

  const detail = firstError as Record<string, unknown>;
  return {
    code: typeof detail.code === "string" ? detail.code : undefined,
    message: typeof detail.message === "string" ? detail.message : undefined,
    longMessage:
      typeof detail.longMessage === "string" ? detail.longMessage : undefined,
  };
}
