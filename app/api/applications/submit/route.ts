import { NextRequest, NextResponse } from "next/server";
import { fetchMutation, fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import {
  sendShopApplicationReceiptEmail,
  sendShopApplicationNotificationEmail,
} from "@/email/send";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Public POST — no auth (mirrors /api/waitlist). Validates a shop partner
// application, rejects already-registered emails, writes a pending_review row,
// then fires the receipt + internal notification best-effort.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const shopLegalName = str(body?.shopLegalName);
    const ownerFullName = str(body?.ownerFullName);
    const businessEmailRaw = str(body?.businessEmail);
    const phoneRaw = str(body?.phone);
    const streetAddress = str(body?.streetAddress);
    const source = typeof body?.source === "string" ? body.source : "apply-direct";

    // --- Field validation (first failure wins → 400) ---
    if (shopLegalName.length < 2 || shopLegalName.length > 120) {
      return NextResponse.json(
        { error: "Please enter your shop's legal name." },
        { status: 400 },
      );
    }
    if (ownerFullName.length < 2 || ownerFullName.length > 80) {
      return NextResponse.json(
        { error: "Please enter the owner's full name." },
        { status: 400 },
      );
    }
    const businessEmail = businessEmailRaw.toLowerCase();
    if (!EMAIL_RE.test(businessEmail)) {
      return NextResponse.json(
        { error: "Please enter a valid business email address." },
        { status: 400 },
      );
    }
    const phone = phoneRaw.replace(/\D/g, "");
    if (phone.length < 10 || phone.length > 15) {
      return NextResponse.json(
        { error: "Please enter a valid phone number." },
        { status: 400 },
      );
    }
    if (streetAddress.length < 5 || streetAddress.length > 160) {
      return NextResponse.json(
        { error: "Please enter your shop's street address." },
        { status: 400 },
      );
    }

    // --- Already-registered guard (route-level, mirrors /api/invite) ---
    const existingUser = await fetchQuery(api.users.getByEmail, {
      email: businessEmail,
    });
    if (existingUser) {
      return NextResponse.json(
        {
          error:
            "An account with this email already exists. Please sign in instead.",
          code: "already_registered",
        },
        { status: 409 },
      );
    }

    // --- Insert (mutation owns the duplicate-pending guard) ---
    let applicationId;
    try {
      applicationId = await fetchMutation(api.shopApplications.submit, {
        shop_legal_name: shopLegalName,
        owner_full_name: ownerFullName,
        business_email: businessEmail,
        phone,
        street_address: streetAddress,
        source,
        user_agent: req.headers.get("user-agent") ?? undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("DUPLICATE_PENDING_APPLICATION")) {
        return NextResponse.json(
          {
            error: "You already have an application under review.",
            code: "duplicate_application",
          },
          { status: 409 },
        );
      }
      throw err;
    }

    // --- Emails (best-effort; row is already written, never block success) ---
    const emailData = {
      ownerFullName,
      shopLegalName,
      businessEmail,
      phone,
      streetAddress,
    };
    const receipt = await sendShopApplicationReceiptEmail(emailData);
    if (!receipt.success) {
      console.error("Failed to send application receipt email:", receipt.error);
    }
    const notify = await sendShopApplicationNotificationEmail(emailData);
    if (!notify.success) {
      console.error(
        "Failed to send application notification email:",
        notify.error,
      );
    }

    return NextResponse.json(
      {
        success: true,
        applicationId,
        confirmationSent: receipt.success,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error processing shop application:", error);
    return NextResponse.json(
      { error: "Failed to submit application. Please try again." },
      { status: 500 },
    );
  }
}
