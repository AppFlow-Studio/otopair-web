const AUTH_ENTRY_STEPS = new Set([
  "welcome",
  "signup",
  "emailSignup",
  "emailVerify",
  "login",
]);

export function shouldUseInitialHomeBack(step: string, initialBackToHome: boolean): boolean {
  return initialBackToHome && !AUTH_ENTRY_STEPS.has(step);
}

export function shouldRedirectSignedOutFromMainTabs(
  isLoaded: boolean,
  isSignedIn: boolean | undefined,
): boolean {
  return isLoaded && isSignedIn !== true;
}
