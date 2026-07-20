/**
 * navigationLock
 *
 * PURPOSE: A module-level (singleton) cooldown that drops duplicate
 *          stack-growing navigations fired within COOLDOWN_MS of each
 *          other — e.g. a double-tap that triggers two router.push calls
 *          before the first transition settles, opening the same screen
 *          twice.
 *
 * WHY TIME-BASED: `lastNavAt` is a timestamp, not a boolean flag. The gate
 *          re-opens automatically once the window elapses, so it can never
 *          get "stuck locked" even if a navigation is cancelled or throws —
 *          there is nothing to reset.
 *
 * USED BY: hooks/useGuardedRouter.ts (wraps useRouter) and `guardedRouter`
 *          below (drop-in for the imported singleton `router`).
 */

import { router as expoRouter } from "expo-router";

const COOLDOWN_MS = 400; // 320ms booking-flow fade + 80ms margin

let lastNavAt = 0;

/** Records the attempt; returns false if still inside the cooldown window. */
export function shouldAllowNavigation(): boolean {
  const now = Date.now();
  if (now - lastNavAt < COOLDOWN_MS) return false;
  lastNavAt = now;
  return true;
}

/** Escape hatch for intentional same-tick chains; next guarded call is allowed. */
export function resetNavigationLock(): void {
  lastNavAt = 0;
}

/** Guarded drop-in for the imported singleton `router`. */
export const guardedRouter: typeof expoRouter = {
  ...expoRouter,
  push: ((href) => {
    if (!shouldAllowNavigation()) return;
    return expoRouter.push(href);
  }) as typeof expoRouter.push,
  navigate: ((href) => {
    if (!shouldAllowNavigation()) return;
    return expoRouter.navigate(href);
  }) as typeof expoRouter.navigate,
  replace: ((href) => {
    if (!shouldAllowNavigation()) return;
    return expoRouter.replace(href);
  }) as typeof expoRouter.replace,
};
