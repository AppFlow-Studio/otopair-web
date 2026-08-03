import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createHash } from "crypto";
import { fetchMutation } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { sendShopOwnerInviteEmail } from "@/email/send";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Admin approves a shop application (Step 2). Authorization is enforced inside
// the Convex mutation via the director session token. The raw 32-byte token is
// generated + hashed HERE (Node); only the hash reaches Convex. The raw token
// lives in the emailed link and the response shown to the trusted director.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const token = typeof body?.token === "string" ? body.token : "";
    const applicationId = body?.applicationId;
    if (!token || !applicationId) {
      return NextResponse.json(
        { error: "Missing director token or applicationId." },
        { status: 400 },
      );
    }

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = Date.now() + INVITE_TTL_MS;

    let result;
    try {
      result = await fetchMutation(api.shopInvites.approveApplication, {
        token,
        applicationId,
        tokenHash,
        expiresAt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // requireDirector throws unauthorized/forbidden → 403.
      if (/unauthorized|forbidden/i.test(message)) {
        return NextResponse.json({ error: "Not authorized." }, { status: 403 });
      }
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin;
    const inviteUrl = `${baseUrl}/invite?token=${rawToken}`;

    const emailResult = await sendShopOwnerInviteEmail({
      email: result.email,
      inviteUrl,
      shopName: result.shopName,
      ownerName: result.ownerName,
    });
    if (!emailResult.success) {
      console.error("Failed to send shop owner invite email:", emailResult.error);
    }

    return NextResponse.json({
      success: true,
      shopId: result.shopId,
      inviteUrl, // returned to the trusted director for copy/resend
      emailSent: emailResult.success,
    });
  } catch (error) {
    console.error("Error approving shop application:", error);
    return NextResponse.json(
      { error: "Failed to approve application. Please try again." },
      { status: 500 },
    );
  }
}
