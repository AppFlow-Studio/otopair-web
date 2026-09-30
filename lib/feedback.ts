import { toast } from "sonner";
import {
  formatBookingError,
  readBookingError,
  type BookingErrorCode,
} from "@/convex/lib/bookingErrors";

export {
  readBookingError,
  isBookingError,
  isStaleStateError,
  type BookingErrorCode,
  type BookingErrorData,
} from "@/convex/lib/bookingErrors";

// Single choke point for reaction feedback across the shop portal. Handlers call
// `notify.*` for one-off reactions or wrap a mutation in `runAction` so every
// Confirm/Continue/Submit emits a success toast and a readable error toast. Swap
// the toast library or tune copy/positioning here, not at every call site.

export const notify = {
  success: (message: string) => toast.success(message),
  error: (message: string) => toast.error(message),
  info: (message: string) => toast.info(message),
  warning: (message: string) => toast.warning(message),
};

const GENERIC_ERROR = "Something went wrong. Please try again.";

/**
 * Turn a thrown value into one readable sentence. Structured booking conflicts
 * (`ConvexError` with `{ code, message }`, see convex/lib/bookingErrors.ts)
 * return their server-written copy; a legacy plain `throw new Error("msg")` is
 * dug out of the `[CONVEX M(path)] [Request ID: …] … Uncaught Error: msg at …`
 * wrapper. Wrapper text, stack frames, file paths, JSON payloads, bare codes
 * and prod's redacted "Server Error" never come back — `fallback` does.
 */
export function errorMessage(err: unknown, fallback = GENERIC_ERROR): string {
  return formatBookingError(err, fallback);
}

/** The structured conflict code on a thrown Convex error, if any. */
export function errorCode(err: unknown): BookingErrorCode | null {
  return readBookingError(err)?.code ?? null;
}

/**
 * Wrap an async action so it reacts on every outcome: an optional loading toast,
 * a success toast when it resolves, and a readable error toast when it throws.
 * Returns the result, or `undefined` if it failed (so callers can early-return).
 */
export async function runAction<T>(
  fn: () => Promise<T>,
  opts: { success: string; error?: string; loading?: string },
): Promise<T | undefined> {
  if (opts.loading) {
    const promise = fn();
    toast.promise(promise, {
      loading: opts.loading,
      success: opts.success,
      error: (e) => opts.error ?? errorMessage(e),
    });
    try {
      return await promise;
    } catch {
      return undefined;
    }
  }

  try {
    const result = await fn();
    notify.success(opts.success);
    return result;
  } catch (e) {
    notify.error(opts.error ?? errorMessage(e));
    return undefined;
  }
}
