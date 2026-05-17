import { NextRequest } from "next/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { fetchMutation } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

type ShopInviteMetadata = {
  role?: string;
  shop_id?: string;
  invitation_token?: string;
  mechanic_id?: string;
};

export async function POST(req: NextRequest) {
  try {
    const evt = await verifyWebhook(req);
    const eventType = evt.type;

    if (eventType === "user.created" || eventType === "user.updated") {
      const { id, email_addresses, phone_numbers, first_name, last_name, image_url, public_metadata, primary_email_address_id, primary_phone_number_id } = evt.data;

      // Find the primary email address (not just the first one in the array).
      // When a user changes their email in Clerk and sets a new primary,
      // this ensures we always sync the correct one to Convex.
      const primaryEmailObj = email_addresses?.find(
        (e: { id: string }) => e.id === primary_email_address_id
      ) ?? email_addresses?.[0];
      const primaryEmail = primaryEmailObj?.email_address;

      if (!primaryEmail) {
        return new Response("No email address found", { status: 400 });
      }

      // Extract shop invite metadata copied from Clerk invitation onto the user
      const meta = (public_metadata ?? {}) as ShopInviteMetadata;

      const role = meta.role;

      const primaryPhoneObj = phone_numbers?.find(
        (p: { id: string }) => p.id === primary_phone_number_id
      ) ?? phone_numbers?.[0];
      const primaryPhone = primaryPhoneObj?.phone_number;

      await fetchMutation(api.users.upsertFromClerk, {
        clerkUserId: id,
        email: primaryEmail,
        phone: primaryPhone ?? undefined,
        first_name: first_name ?? undefined,
        last_name: last_name ?? undefined,
        profile_photo_url: image_url ?? undefined,
        role,
      });

      // If this event has an invitation token, attempt to accept the invitation.
      // Token is required — email alone is not sufficient (security: prevents auto-accept
      // if someone signs up directly without using the invite link).
      if (meta.invitation_token) {
        await fetchMutation(api.invitations.acceptIfInvited, {
          clerkUserId: id,
          email: primaryEmail,
          invitationToken: meta.invitation_token,
          mechanicId: meta.mechanic_id
            ? (meta.mechanic_id as Id<"mechanics">)
            : undefined,
        });
      }
    }

    // invitation.accepted fires after user.created/updated when a Clerk invitation is accepted.
    // Acts as a safety-net to ensure shop_users is created even if user.created processing failed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const evtAny = evt as any;
    if (evtAny.type === "invitation.accepted") {
      const data = evtAny.data as { id?: string; email_address?: string };
      if (data.id && data.email_address) {
        await fetchMutation(api.invitations.acceptByClerkInvitationId, {
          clerkInvitationId: data.id,
          email: data.email_address,
        });
      }
    }

    if (eventType === "user.deleted") {
      const { id } = evt.data;
      if (id) {
        await fetchMutation(api.users.deleteFromClerk, { clerkUserId: id });
      }
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("Webhook verification failed:", err);
    return new Response("Webhook verification failed", { status: 400 });
  }
}
