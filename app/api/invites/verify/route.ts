import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";

// Public token verification for the /invite preview card (Step 3). Hashes the
// raw token here so only the hash is sent to Convex; returns just what the
// preview needs (shop name + role), never the token.
export async function GET(req: NextRequest) {
  try {
    const raw = req.nextUrl.searchParams.get("token");
    if (!raw) {
      return NextResponse.json({ valid: false, reason: "invalid" }, { status: 400 });
    }
    const tokenHash = createHash("sha256").update(raw).digest("hex");
    const result = await fetchQuery(api.shopInvites.verifyByHash, {
      token_hash: tokenHash,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Error verifying invite token:", error);
    return NextResponse.json(
      { valid: false, reason: "error" },
      { status: 500 },
    );
  }
}
