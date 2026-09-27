import { NextRequest, NextResponse } from "next/server";
import { fetchMutation } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import {
  sendSupportRequestReceiptEmail,
  sendContactSupportEmail,
} from "@/email/send";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Human labels for the category slugs the public form sends.
const CATEGORY_LABELS: Record<string, string> = {
  charge_dispute: "Charge dispute",
  service_quality: "Service quality",
  other: "Other",
};

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Public POST — no auth (mirrors /api/applications/submit). Validates a customer
// support / charge-dispute request, writes a "new" support_requests row, then
// fires the customer receipt + internal ops notification best-effort.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const customerName = str(body?.customerName);
    const customerEmailRaw = str(body?.customerEmail);
    const phoneRaw = str(body?.customerPhone);
    const category = str(body?.category);
    const subject = str(body?.subject);
    const description = str(body?.description);
    const orderReference = str(body?.orderReference);
    const shopNameText = str(body?.shopNameText);
    const source = typeof body?.source === "string" ? body.source : "support-web";

    // --- Field validation (first failure wins → 400) ---
    if (customerName.length < 2 || customerName.length > 80) {
      return NextResponse.json(
        { error: "Please enter your name." },
        { status: 400 },
      );
    }
    const customerEmail = customerEmailRaw.toLowerCase();
    if (!EMAIL_RE.test(customerEmail)) {
      return NextResponse.json(
        { error: "Please enter a valid email address." },
        { status: 400 },
      );
    }
    // Phone is optional; validate only when supplied.
    const phone = phoneRaw.replace(/\D/g, "");
    if (phoneRaw && (phone.length < 10 || phone.length > 15)) {
      return NextResponse.json(
        { error: "Please enter a valid phone number, or leave it blank." },
        { status: 400 },
      );
    }
    if (!CATEGORY_LABELS[category]) {
      return NextResponse.json(
        { error: "Please choose a category." },
        { status: 400 },
      );
    }
    if (subject.length < 2 || subject.length > 160) {
      return NextResponse.json(
        { error: "Please enter a short subject." },
        { status: 400 },
      );
    }
    if (description.length < 10 || description.length > 4000) {
      return NextResponse.json(
        { error: "Please describe your issue (at least 10 characters)." },
        { status: 400 },
      );
    }
    if (orderReference.length > 160 || shopNameText.length > 160) {
      return NextResponse.json(
        { error: "Order reference or shop name is too long." },
        { status: 400 },
      );
    }

    // --- Insert (mutation owns the duplicate-recent guard) ---
    let supportRequestId;
    try {
      supportRequestId = await fetchMutation(api.supportRequests.submit, {
        customer_email: customerEmail,
        customer_name: customerName,
        customer_phone: phone || undefined,
        category,
        subject,
        description,
        order_reference: orderReference || undefined,
        shop_name_text: shopNameText || undefined,
        source,
        user_agent: req.headers.get("user-agent") ?? undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("DUPLICATE_RECENT_SUPPORT_REQUEST")) {
        return NextResponse.json(
          {
            error: "We just received a request like this from you. We're on it.",
            code: "duplicate_request",
          },
          { status: 409 },
        );
      }
      throw err;
    }

    // --- Emails (best-effort; row is already written, never block success) ---
    const categoryLabel = CATEGORY_LABELS[category];
    const receipt = await sendSupportRequestReceiptEmail({
      customerEmail,
      customerName,
      categoryLabel,
      subject,
    });
    if (!receipt.success) {
      console.error("Failed to send support receipt email:", receipt.error);
    }

    // Internal ops alert — reuse the existing contact-support template. Fold the
    // customer's free-text order reference + shop name into the description so ops
    // can start triage from the email.
    const opsDescription = [
      description,
      orderReference ? `\n\nOrder reference: ${orderReference}` : "",
      shopNameText ? `\nShop named: ${shopNameText}` : "",
      phone ? `\nPhone: ${phone}` : "",
    ].join("");
    const notify = await sendContactSupportEmail({
      topic: categoryLabel,
      subject,
      description: opsDescription,
      customerEmail,
      customerName,
      sentFrom: "Sent from the public /support form.",
    });
    if (!notify.success) {
      console.error("Failed to send support notification email:", notify.error);
    }

    return NextResponse.json(
      {
        success: true,
        supportRequestId,
        confirmationSent: receipt.success,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error processing support request:", error);
    return NextResponse.json(
      { error: "Failed to submit. Please try again." },
      { status: 500 },
    );
  }
}
