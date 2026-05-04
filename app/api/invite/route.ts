import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { fetchMutation, fetchQuery } from "convex/nextjs";
import { makeFunctionReference } from "convex/server";
import { Id } from "@/convex/_generated/dataModel";
import { sendInviteEmail } from "@/email/send";

const getShopByIdQuery = makeFunctionReference<"query">("shops:getById");
const hasActiveShopMembershipQuery = makeFunctionReference<"query">(
  "users:hasActiveShopMembership"
);
const createInvitationMutation = makeFunctionReference<"mutation">("invitations:create");

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { email, role, shopId, mechanicId } = await req.json();
    if (!email || !role || !shopId) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }
    if ((role === "shop_mechanic" || role === "mechanic") && !mechanicId) {
      return NextResponse.json(
        { error: "Mechanic invitations must be tied to a mechanic profile." },
        { status: 400 }
      );
    }

    // Fetch shop name for the invite email
    const shop = (await fetchQuery(getShopByIdQuery, {
      id: shopId as Id<"shops">,
    })) as { name?: string } | null;
    const shopName = shop?.name;

    // Block invites to users who are already an active member of any shop
    const alreadyMember = await fetchQuery(hasActiveShopMembershipQuery, { email });
    if (alreadyMember) {
      return NextResponse.json(
        { error: "This person is already a member of a shop and cannot be invited again." },
        { status: 409 }
      );
    }

    const resolvedMechanicId: string | undefined = mechanicId;

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
          // role is intentionally omitted - it is only granted after the invite token is used
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
      console.log("Clerk invitation error:", JSON.stringify(err));
      const clerkError = err.errors?.[0];
      const errorMessage: string = clerkError?.message ?? "";
      const errorCode: string = clerkError?.code ?? "";
      const emailTaken = errorMessage.toLowerCase().includes("email address is taken");
      const alreadyInvited =
        errorMessage.toLowerCase().includes("already been invited") ||
        errorMessage.toLowerCase().includes("already invited") ||
        errorMessage.toLowerCase().includes("duplicate") ||
        errorCode === "duplicate_record" ||
        errorCode === "invitation_already_pending";

      if (emailTaken || alreadyInvited) {
        // Look up whether an active Clerk account exists for this email.
        // This covers two cases:
        //   1. emailTaken: user already has a Clerk account -> patch metadata + Resend email
        //   2. alreadyInvited/duplicate: Clerk has a stale invitation (e.g. from a deleted account)
        //      -> if no active account, send via Resend so the invitee still receives the link
        const lookupRes = await fetch(
          `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(email)}`,
          { headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` } }
        );
        if (lookupRes.ok) {
          const users = await lookupRes.json();
          const existingClerkUser = users[0];
          if (existingClerkUser?.id) {
            // Active Clerk account - patch their public_metadata so middleware lets them in
            await fetch(`https://api.clerk.com/v1/users/${existingClerkUser.id}`, {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                public_metadata: {
                  ...((existingClerkUser.public_metadata as object) ?? {}),
                  // role is intentionally omitted - it is only granted after the invite token is used
                  shop_id: shopId,
                  invitation_token: invitationToken,
                  ...(resolvedMechanicId ? { mechanic_id: resolvedMechanicId } : {}),
                },
              }),
            });
          }
          // Send invite link via Resend in both cases - Clerk won't email existing users,
          // and for stale-duplicate cases there's no active Clerk invitation to send from.
          await sendInviteEmail({ email, inviteUrl: redirectUrl, shopName });
        }
      } else {
        return NextResponse.json(
          { error: errorMessage || "Failed to send invitation." },
          { status: 400 }
        );
      }
    }

    // Store invitation in Convex (token is pre-generated above so it matches Clerk metadata)
    await fetchMutation(createInvitationMutation, {
      invitedByClerkUserId: userId,
      shopId: shopId as Id<"shops">,
      email,
      role,
      token: invitationToken,
      mechanicId: resolvedMechanicId as Id<"mechanics"> | undefined,
      clerkInvitationId,
    });

    console.log("Invite link:", redirectUrl);
    return NextResponse.json({ success: true, token: invitationToken });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
