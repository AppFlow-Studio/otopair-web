/**
 * Shared email checks for the public capture forms (waitlist, contact). One
 * source of truth so the client (disable submit, inline hint) and the server
 * (/api/waitlist) agree on what counts as a real address.
 *
 * Deliberately NOT full RFC 5322 — that regex rejects addresses people
 * actually use. This catches the real mistakes: empty, no `@`, no dotted
 * domain, or whitespace. Deliverability is proven by the confirmation email
 * landing, not by a stricter pattern.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: unknown): email is string {
  return typeof email === "string" && EMAIL_RE.test(email.trim());
}

/** Canonical form for storage/dedupe: trimmed and lowercased. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
