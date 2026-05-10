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

export function setupConsoleToConvex(logToConvex: LogToConvexFn) {
  if (!sessionId) {
    sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalLog = console.log.bind(console);
  const originalInfo = console.info.bind(console);
  const originalDebug = console.debug.bind(console);

  const intercept =
    (level: LogLevel, original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      original(...args);

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

  console.error = intercept("error", originalError);
  console.warn = intercept("warn", originalWarn);
  console.log = intercept("log", originalLog);
  console.info = intercept("info", originalInfo);
  console.debug = intercept("debug", originalDebug);
}
