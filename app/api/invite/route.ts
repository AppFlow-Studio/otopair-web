import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { fetchMutation } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { sendInviteEmail } from "@/email/send";

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { email, role, shopId, firstName, lastName, title, mechanicId } = await req.json();
    if (!email || !role || !shopId) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // Optionally create a mechanic profile if name is provided and no existing mechanic_id
    let resolvedMechanicId: string | undefined = mechanicId;
    if (!resolvedMechanicId && firstName && lastName) {
      resolvedMechanicId = await fetchMutation(api.mechanics.create, {
        shopId: shopId as Id<"shops">,
        firstName,
        lastName,
        title: title ?? undefined,
      });
    }

    // Generate token here so it can be embedded in Clerk's invitation metadata
    const invitationToken = crypto.randomUUID();

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin;
    const redirectUrl = `${baseUrl}/accept-invite?token=${invitationToken}`;

    // Send invitation via Clerk Invitations API
    const clerkResponse = await fetch("https://api.clerk.com/v1/invitations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email_address: email,
        public_metadata: {
          role: "shop_mechanic",
          shop_id: shopId,
          invitation_token: invitationToken,
          ...(resolvedMechanicId ? { mechanic_id: resolvedMechanicId } : {}),
        },
        redirect_url: redirectUrl,
        notify: true,
      }),
    });

    let clerkInvitationId: string | undefined;
    if (clerkResponse.ok) {
      const clerkData = await clerkResponse.json();
      clerkInvitationId = clerkData.id;
    } else {
      const err = await clerkResponse.json();
      const errorMessage: string = err.errors?.[0]?.message ?? "";
      const emailTaken = errorMessage.toLowerCase().includes("email address is taken");
      const alreadyInvited = errorMessage.toLowerCase().includes("already been invited");

      if (emailTaken) {
        // Existing Clerk user — look up their Clerk ID and update publicMetadata.role
        // so the middleware allows them into portal routes after they accept.
        const lookupRes = await fetch(
          `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(email)}`,
          { headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` } }
        );
        if (lookupRes.ok) {
          const users = await lookupRes.json();
          const existingClerkUser = users[0];
          if (existingClerkUser?.id) {
            await fetch(`https://api.clerk.com/v1/users/${existingClerkUser.id}`, {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                public_metadata: {
                  ...((existingClerkUser.public_metadata as object) ?? {}),
                  role: "shop_mechanic",
                  shop_id: shopId,
                  invitation_token: invitationToken,
                  ...(resolvedMechanicId ? { mechanic_id: resolvedMechanicId } : {}),
                },
              }),
            });

            // Send invite link via Resend since Clerk won't email existing users
            await sendInviteEmail({ email, inviteUrl: redirectUrl });
          }
        }
      } else if (!alreadyInvited) {
        return NextResponse.json(
          { error: errorMessage || "Failed to send invitation." },
          { status: 400 }
        );
      }
    }

    // Store invitation in Convex (token is pre-generated above so it matches Clerk metadata)
    await fetchMutation(api.invitations.create, {
      invitedByClerkUserId: userId,
      shopId: shopId as Id<"shops">,
      email,
      role,
      token: invitationToken,
      mechanicId: resolvedMechanicId as Id<"mechanics"> | undefined,
      clerkInvitationId,
    });

    console.log("Invite token:", invitationToken);
    return NextResponse.json({ success: true, token: invitationToken });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
