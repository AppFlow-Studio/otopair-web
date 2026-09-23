import { toast } from "sonner";

// Single choke point for reaction feedback across the shop portal. Handlers call
// `notify.*` for one-off reactions or wrap a mutation in `runAction` so every
// Confirm/Continue/Submit emits a success toast and a readable error toast. Swap
// the toast library or tune copy/positioning here, not at every call site.

export const notify = {
  success: (message: string) => toast.success(message),
  error: (message: string) => toast.error(message),
  info: (message: string) => toast.info(message),
};

const GENERIC_ERROR = "Something went wrong. Please try again.";

/**
 * Turn a thrown value into a human-readable string. Convex surfaces two shapes:
 *  - `ConvexError` carries a structured `.data` payload (string or `{ message }`).
 *  - A plain `throw new Error("msg")` in a mutation reaches the client wrapped as
 *    `[CONVEX M(path)] [Request ID: …] Server Error\nUncaught Error: msg\n  at …`.
 * We dig the real message out of both, falling back to a generic line.
 */
export function errorMessage(err: unknown, fallback = GENERIC_ERROR): string {
  if (!err) return fallback;

  const data = (err as { data?: unknown }).data;
  if (typeof data === "string" && data.trim()) return data.trim();
  if (
    data &&
    typeof data === "object" &&
    typeof (data as { message?: unknown }).message === "string" &&
    (data as { message: string }).message.trim()
  ) {
    return (data as { message: string }).message.trim();
  }

  const raw =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!raw) return fallback;

  const uncaught = raw.match(
    /Uncaught (?:Convex)?Error:\s*([\s\S]*?)(?:\n\s*at\s|\n\s*Called by|$)/,
  );
  if (uncaught && uncaught[1].trim()) return uncaught[1].trim();

  const cleaned = raw
    .replace(/^\[CONVEX[^\]]*\]\s*/, "")
    .replace(/^\[Request ID:[^\]]*\]\s*/, "")
    .split("\n")[0]
    .trim();
  return cleaned || fallback;
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
