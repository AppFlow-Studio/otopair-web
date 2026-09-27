import { NextRequest, NextResponse } from "next/server";
import { fetchMutation } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { sendContactSupportEmail } from "@/email/send";
import { isValidEmail, normalizeEmail } from "@/lib/email";

/**
 * POST /api/privacy-requests — the /privacy-choices and /delete-account
 * forms. Drops obvious bots, saves the request to Convex
 * (privacyRequests.submit) and emails support so a person picks it up within
 * the windows Privacy Policy v6.1 promises. The visitor is never told
 * whether an account exists for the email.
 */
type Kind = "opt_out_vehicle_history" | "delete_account";

const KINDS: Record<Kind, { topic: string; subject: string; page: string; ask: string }> = {
  opt_out_vehicle_history: {
    topic: "Privacy",
    subject: "Vehicle History Data opt-out",
    page: "/privacy-choices",
    ask: "Opt out of Vehicle History Data licensing for the account with this email. Privacy Policy v6.1 §6: no identity verification is required, and recipients of previously licensed records for the account's vehicles must be told to delete them.",
  },
  delete_account: {
    topic: "Privacy",
    subject: "Account deletion request",
    page: "/delete-account",
    ask: "Delete the account with this email. Verify the request against the email or phone number on the account before acting (Privacy Policy v6.1, Exercising your rights). Respond within the time the law requires, generally 45 days.",
  },
};

// Same bot rules as the contact and waitlist forms: a hidden field people
// never fill, and a floor on how fast a person can read the page and type.
const HONEYPOT_FIELD = "company";
const MIN_FILL_MS = 1500;

// Best-effort, per warm instance — see app/api/waitlist/route.ts.
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX = 5;
const rateHits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (rateHits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  rateHits.set(ip, recent);
  return recent.length > RATE_MAX;
}

const FAILED = `The request didn't go through. Email support@otopair.com and we'll handle it from there.`;

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Send the form as JSON." }, { status: 400 });
  }

  const kind = body.kind === "opt_out_vehicle_history" || body.kind === "delete_account" ? (body.kind as Kind) : null;
  if (!kind) {
    return NextResponse.json({ error: "Unknown request type." }, { status: 400 });
  }

  // A bot must not learn why it failed, and nothing is stored or sent for it.
  const honeypot = typeof body[HONEYPOT_FIELD] === "string" ? (body[HONEYPOT_FIELD] as string) : "";
  const elapsedMs = typeof body.elapsedMs === "number" ? body.elapsedMs : undefined;
  if (honeypot.trim() !== "" || (elapsedMs !== undefined && elapsedMs < MIN_FILL_MS)) {
    return NextResponse.json({ success: true });
  }

  if (!isValidEmail(body.email)) {
    return NextResponse.json(
      { error: "Check the highlighted field.", errors: { email: "Enter the email address on your Otopair account." } },
      { status: 400 },
    );
  }
  const email = normalizeEmail(body.email);
  const gpc = body.gpc === true;

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (rateLimited(ip)) {
    return NextResponse.json({ error: "Too many attempts. Try again in a few minutes." }, { status: 429 });
  }

  let saved = false;
  try {
    await fetchMutation(api.privacyRequests.submit, { kind, email, ...(gpc ? { gpc } : {}) });
    saved = true;
  } catch (error) {
    console.error("[privacy-requests] Convex save failed:", error);
  }

  const copy = KINDS[kind];
  const emailed = await sendContactSupportEmail({
    topic: copy.topic,
    subject: copy.subject,
    customerEmail: email,
    sentFrom: `Sent from otopair.com${copy.page}.`,
    description: [
      copy.ask,
      gpc ? "The browser sent a Global Privacy Control signal." : null,
      saved
        ? "Saved in Convex: privacy_requests (status open)."
        : "NOT saved in Convex — the save failed. This email is the only record.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  if (!emailed.success) console.error("[privacy-requests] support email failed:", emailed.error);

  // Nothing stored and nobody told: say so, with a way that still works.
  if (!saved && !emailed.success) {
    return NextResponse.json({ error: FAILED }, { status: 502 });
  }
  return NextResponse.json({ success: true });
}
