import { Id } from "@/convex/_generated/dataModel";

type RemoveTeamMemberArgs = {
  shopUserId?: Id<"shop_users"> | string | null;
  invitationId?: Id<"shop_invitations"> | string | null;
};

export async function removeTeamMember(args: RemoveTeamMemberArgs) {
  if (args.shopUserId) {
    const res = await fetch("/api/remove-member", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shopUserId: args.shopUserId }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || "Failed to remove member.");
    }

    return;
  }

  if (args.invitationId) {
    const res = await fetch("/api/revoke-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitationId: args.invitationId }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || "Failed to revoke invitation.");
    }

    return;
  }

  throw new Error("Missing team member removal target.");
}
