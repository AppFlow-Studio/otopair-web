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

export function shouldRunStartupRedirect({
  authLoaded,
  hasNavigated,
  rootNavigationReady,
}: {
  authLoaded: boolean;
  hasNavigated: boolean;
  rootNavigationReady: boolean;
}): boolean {
  return authLoaded && !hasNavigated && rootNavigationReady;
}

export function shouldRedirectCompletedOnboardingToHome({
  isSignedIn,
  onboardingCompleted,
  essentialOnboardingCompleted,
}: {
  isSignedIn: boolean;
  onboardingCompleted?: boolean;
  essentialOnboardingCompleted?: boolean;
}): boolean {
  return (
    isSignedIn &&
    (onboardingCompleted === true || essentialOnboardingCompleted === true)
  );
}

export function getTrustedSavedOnboardingStep<T extends string>(
  savedStep: T | null | undefined,
  incompleteSteps: T[],
): T | null {
  if (!savedStep) return null;
  return incompleteSteps.includes(savedStep) ? savedStep : null;
}
