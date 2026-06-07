export type PasswordResetMethod = "email" | "phone";

export type PasswordResetFlowStep = "method" | "email" | "phone" | "code" | "password";

export type PasswordResetBackTarget = "login" | "method" | PasswordResetMethod;

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

export function getClerkErrorMessage(
  error: unknown,
  fallback: string
): string {
  if (typeof error === "object" && error !== null && "errors" in error) {
    const maybeErrors = (error as { errors?: { longMessage?: string; message?: string }[] }).errors;
    const firstError = maybeErrors?.[0];
    return firstError?.longMessage || firstError?.message || fallback;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return fallback;
}
