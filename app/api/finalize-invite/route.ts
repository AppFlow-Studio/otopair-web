import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { role } = await req.json();
    const assignedRole = role ?? "shop_mechanic";

    // Fetch current public_metadata so we can merge, not overwrite
    const userRes = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
      headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` },
    });

    let existingMeta: object = {};
    if (userRes.ok) {
      const userData = await userRes.json();
      existingMeta = (userData.public_metadata as object) ?? {};
    }

    const patchRes = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        public_metadata: {
          ...existingMeta,
          role: assignedRole,
        },
      }),
    });

    if (!patchRes.ok) {
      const err = await patchRes.json();
      console.error("Failed to update Clerk metadata:", err);
      return NextResponse.json({ error: "Failed to update user role" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
