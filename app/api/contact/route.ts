import { NextRequest, NextResponse } from "next/server";
import { sendContactEmail, type ContactLane } from "@/email/send";

/**
 * POST /api/contact — the website contact form. Validates, drops obvious
 * bots (a hidden field humans never fill), and forwards the message to the
 * support inbox with the visitor as reply-to. Nothing is stored: the email
 * is the record, same as the waitlist route.
 */
const LANES = new Set<ContactLane>(["driver", "shop", "data", "press"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Send the form as JSON." }, { status: 400 });
  }

  // Honeypot: real browsers never fill it; bots that autofill every field do.
  if (typeof body.company === "string" && body.company.trim() !== "") {
    return NextResponse.json({ success: true });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const lane = typeof body.lane === "string" ? (body.lane as ContactLane) : ("driver" as ContactLane);
  const message = typeof body.message === "string" ? body.message.trim() : "";

  const errors: Record<string, string> = {};
  if (name.length < 2 || name.length > 80) errors.name = "Enter your name (2 to 80 characters).";
  if (!EMAIL.test(email) || email.length > 254) errors.email = "Enter an email address we can reply to.";
  if (!LANES.has(lane)) errors.lane = "Choose who you are.";
  if (message.length < 10) errors.message = "Tell us a little more (at least 10 characters).";
  if (message.length > 4000) errors.message = "Keep it under 4,000 characters, or attach the rest in a reply.";
  if (Object.keys(errors).length) {
    return NextResponse.json({ error: "Check the highlighted fields.", errors }, { status: 400 });
  }

  const result = await sendContactEmail({ name, email, lane, message });
  if (!result.success) {
    console.error("[contact] send failed:", result.error);
    return NextResponse.json(
      { error: "The message did not send. Email support@otopair.com directly and we will pick it up." },
      { status: 502 },
    );
  }
  return NextResponse.json({ success: true });
}
