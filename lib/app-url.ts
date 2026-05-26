function normalizeBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) return null;

  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `${/^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(trimmed) ? "http" : "https"}://${trimmed}`;

  try {
    return new URL(withProtocol).origin.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function getAppBaseUrl(requestOrigin: string): string {
  return (
    normalizeBaseUrl(process.env.NEXT_PUBLIC_APP_URL) ??
    normalizeBaseUrl(requestOrigin) ??
    normalizeBaseUrl(process.env.VERCEL_URL) ??
    "http://localhost:3000"
  );
}
