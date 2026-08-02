import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { auth } from "@clerk/nextjs/server";
import { fetchMutation } from "convex/nextjs";
import { api } from "@/convex/_generated/api";

// STEP 4 — Authenticated owner claims the shop. Requires a Clerk session; binds
// the owner to the shop atomically (in Convex), then sets Clerk metadata so the
// role-based middleware lets them into the portal.
export async function POST(req: NextRequest) {
  try {
    const { userId, getToken } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "You must be signed in." }, { status: 401 });
    }

    const body = await req.json();
    const raw = typeof body?.token === "string" ? body.token : "";
    if (!raw) {
      return NextResponse.json({ error: "Missing invite token." }, { status: 400 });
    }

    const convexToken = await getToken({ template: "convex" });
    if (!convexToken) {
      return NextResponse.json({ error: "Missing auth token." }, { status: 401 });
    }

    const tokenHash = createHash("sha256").update(raw).digest("hex");

    let result;
    try {
      result = await fetchMutation(
        api.shopInvites.acceptOwnerInvite,
        { token_hash: tokenHash },
        { token: convexToken },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: message }, { status: 400 });
    }

    // Reflect the new role into Clerk public_metadata (merge, don't overwrite)
    // so middleware's role checks admit the owner into the portal.
    try {
      const userRes = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
        headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` },
      });
      let existingMeta: object = {};
      if (userRes.ok) {
        const userData = await userRes.json();
        existingMeta = (userData.public_metadata as object) ?? {};
      }
      await fetch(`https://api.clerk.com/v1/users/${userId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          public_metadata: {
            ...existingMeta,
            role: "shop_owner",
            shop_id: result.shopId,
            is_active: true,
          },
        }),
      });
    } catch (err) {
      console.error("Failed to update Clerk metadata after claim:", err);
      // Non-fatal: the Convex binding succeeded. The user can still be fixed up
      // by the webhook / re-login; don't fail the claim.
    }

    return NextResponse.json({ success: true, redirectTo: "/shop/setup" });
  } catch (error) {
    console.error("Error accepting owner invite:", error);
    return NextResponse.json(
      { error: "Failed to claim the shop. Please try again." },
      { status: 500 },
    );
  }
}
