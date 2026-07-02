/**
 * Intercepts console.error, console.warn, console.log, etc. and forwards to Convex.
 */

type LogLevel = "error" | "warn" | "log" | "info" | "debug";

type LogToConvexFn = (args: {
  level: LogLevel;
  message: string;
  stack?: string;
  metadata?: unknown;
  session_id?: string;
}) => Promise<unknown>;

let sessionId: string | undefined;
let isSending = false;
let activeCleanup: (() => void) | null = null;

function safeStringify(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  try {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    return JSON.parse(JSON.stringify(value, (_key, val) => (typeof val === "function" ? undefined : val)));
  } catch {
    return String(value);
  }
}

function buildMessage(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return a.message;
      if (typeof a === "object" && a !== null) return JSON.stringify(a);
      return String(a);
    })
    .join(" ");
}

function extractStack(args: unknown[]): string | undefined {
  const err = args.find((a) => a instanceof Error);
  return err instanceof Error ? err.stack : undefined;
}

function extractMetadata(args: unknown[]): unknown {
  const rest = args.filter((a) => !(a instanceof Error));
  if (rest.length <= 1) return undefined;
  return safeStringify(rest.length > 1 ? rest.slice(1) : rest[0]);
}

export function setupConsoleToConvex(logToConvex: LogToConvexFn): () => void {
  activeCleanup?.();

  if (!sessionId) {
    sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  const originalError = console.error;
  const originalWarn = console.warn;
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalDebug = console.debug;

  const intercept =
    (level: LogLevel, original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      original.apply(console, args);

      if (isSending) return;
      isSending = true;

      const message = buildMessage(args);
      const stack = extractStack(args);
      const metadata = extractMetadata(args);

      logToConvex({
        level,
        message: message.slice(0, 10_000),
        stack: stack?.slice(0, 20_000),
        metadata,
        session_id: sessionId,
      })
        .catch(() => {
          // Suppress - avoid recursion. Log already went to console.
        })
        .finally(() => {
          isSending = false;
        });
    };

  const nextError = intercept("error", originalError);
  const nextWarn = intercept("warn", originalWarn);
  const nextLog = intercept("log", originalLog);
  const nextInfo = intercept("info", originalInfo);
  const nextDebug = intercept("debug", originalDebug);

  console.error = nextError;
  console.warn = nextWarn;
  console.log = nextLog;
  console.info = nextInfo;
  console.debug = nextDebug;

  activeCleanup = () => {
    if (console.error === nextError) console.error = originalError;
    if (console.warn === nextWarn) console.warn = originalWarn;
    if (console.log === nextLog) console.log = originalLog;
    if (console.info === nextInfo) console.info = originalInfo;
    if (console.debug === nextDebug) console.debug = originalDebug;
    activeCleanup = null;
  };

  return () => {
    activeCleanup?.();
  };
}
