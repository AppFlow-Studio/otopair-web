/**
 * Centralized haptics. This is the ONLY file in the app that imports
 * `expo-haptics`. Every other call site goes through these named helpers.
 *
 * Policy (docs/notifications/PLAN.md §B.4):
 *  - Haptics confirm, they do not announce.
 *  - Reduce Motion does NOT suppress haptics — only motion crossfades.
 *    iOS Vibration setting handles haptic suppression natively.
 *  - Tab taps, scroll, keystrokes, modal open/close, info toasts → no haptic.
 *  - CTA-toast double-haptic suppression: if your CTA fires a mutation
 *    wrapped in `useMutationWithToast`, call `haptics.ctaSilent()` instead
 *    of `haptics.cta()` — the toast haptic is the confirmation.
 *
 * If you need a new haptic intent, add a helper here — do not import
 * expo-haptics elsewhere. The ESLint rule in eslint.config.js enforces this.
 */
// eslint-disable-next-line no-restricted-imports
import * as Haptics from "expo-haptics";

function silent<T>(p: Promise<T>): void {
  p.catch(() => {});
}

export const haptics = {
  /** Primary CTA that commits to a server mutation (chosen project-wide). */
  cta() {
    silent(Haptics.selectionAsync());
  },
  /**
   * No-op placeholder for CTAs that fire a mutation wrapped in
   * `useMutationWithToast`. The toast haptic is the confirmation;
   * calling this keeps the onPress shape consistent at the call site.
   */
  ctaSilent() {
    /* intentionally empty — toast haptic fires instead */
  },
  /** Toast Success / Trust-Moment appear. */
  success() {
    silent(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
  },
  /** Toast Warning appear. */
  warning() {
    silent(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
  },
  /** Toast Error appear. */
  error() {
    silent(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
  },
  /** Destructive confirmation tap (cancel booking, delete vehicle/address). */
  confirmDestructive() {
    silent(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy));
  },
  /** Pull-to-refresh release, toggle change, picker detent, menu selection. */
  selection() {
    silent(Haptics.selectionAsync());
  },
  /**
   * Step-advance / sub-CTA tap (not server-committing). Use sparingly —
   * prefer `selection` for most cases.
   */
  step() {
    silent(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
  },
};

export type HapticIntent = keyof typeof haptics;
