import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { fetchMutation, fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { invitationId } = await req.json();
    if (!invitationId) {
      return NextResponse.json({ error: "Missing invitationId" }, { status: 400 });
    }

    // Look up the Convex invitation to get the email, token, and Clerk invitation ID
    const invitation = await fetchQuery(api.invitations.getById, {
      invitationId: invitationId as Id<"shop_invitations">,
    });

    if (!invitation) {
      return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
    }

    // --- 1. Revoke the Clerk invitation object (new users only) ---
    if (invitation.clerk_invitation_id) {
      const clerkRes = await fetch(
        `https://api.clerk.com/v1/invitations/${invitation.clerk_invitation_id}/revoke`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` },
        }
      );
      // 404 = already accepted/revoked in Clerk — fine
      if (!clerkRes.ok && clerkRes.status !== 404) {
        const err = await clerkRes.json();
        console.error("Failed to revoke Clerk invitation:", err);
      }
    }

    // --- 2. If an existing Clerk user was invited, clear their public_metadata ---
    // We look up the user by email. If their invitation_token matches this invitation,
    // the invite was pending on their account and we need to clean it up.
    if (invitation.email) {
      const lookupRes = await fetch(
        `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(invitation.email)}`,
        { headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` } }
      );

      if (lookupRes.ok) {
        const users = await lookupRes.json();
        const clerkUser = users[0];

        if (clerkUser?.id) {
          const meta = (clerkUser.public_metadata ?? {}) as Record<string, unknown>;

          // Only clear if this invitation's token is still on the user
          // (guards against clearing a newer invitation's metadata)
          if (meta.invitation_token === invitation.token) {
            // Remove invitation fields and reset role to "user"
            const { invitation_token, mechanic_id, shop_id, role: _role, ...remainingMeta } = meta;
            void invitation_token; void mechanic_id; void shop_id; void _role;

            await fetch(`https://api.clerk.com/v1/users/${clerkUser.id}`, {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                public_metadata: {
                  ...remainingMeta,
                  role: "user",
                },
              }),
            });

            // Reset role in Convex too
            await fetchMutation(api.users.resetRoleToUser, {
              clerkUserId: clerkUser.id,
            });
          }
        }
      }
    }

    // --- 3. Mark invitation as revoked in Convex ---
    await fetchMutation(api.invitations.revoke, {
      invitationId: invitationId as Id<"shop_invitations">,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
