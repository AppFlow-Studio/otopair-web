import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { fetchMutation, fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { shopUserId } = await req.json();
    if (!shopUserId) {
      return NextResponse.json({ error: "Missing shopUserId" }, { status: 400 });
    }

    // Look up the shop_user and their Convex user record
    const member = await fetchQuery(api.invitations.getMemberWithUser, {
      shopUserId: shopUserId as Id<"shop_users">,
    });

    if (!member) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    const clerkUserId = member.user.clerkUserId;

    // Fetch current Clerk public_metadata and reset role + clear shop fields
    const clerkRes = await fetch(`https://api.clerk.com/v1/users/${clerkUserId}`, {
      headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` },
    });

    if (clerkRes.ok) {
      const clerkUser = await clerkRes.json();
      const meta = (clerkUser.public_metadata ?? {}) as Record<string, unknown>;
      const {
        invitation_token,
        mechanic_id,
        shop_id,
        role: _role,
        is_active: _isActive,
        ...remainingMeta
      } = meta;
      void invitation_token; void mechanic_id; void shop_id; void _role;
      void _isActive;

      await fetch(`https://api.clerk.com/v1/users/${clerkUserId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          public_metadata: { ...remainingMeta, role: "user", is_active: false },
        }),
      });
    }

    // Reset role in Convex users table
    await fetchMutation(api.users.resetRoleToUser, { clerkUserId });

    // Deactivate the shop_users record
    await fetchMutation(api.invitations.removeMember, {
      shopUserId: shopUserId as Id<"shop_users">,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
