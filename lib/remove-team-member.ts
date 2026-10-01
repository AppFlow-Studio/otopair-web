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

/**
 * The success banner's account of a removed mechanic's bookings ("" when none
 * moved). Reassigned and unassigned are told apart: an unassigned booking has
 * no mechanic and no slot, so it is off the Schedule lanes until someone
 * assigns it (bug #397).
 */
export function describeMovedBookings(
  result: { reassigned?: number; unassigned?: number } | null | undefined,
): string {
  const reassigned = result?.reassigned ?? 0;
  const unassigned = result?.unassigned ?? 0;
  const bookings = (count: number) => `${count} booking${count === 1 ? "" : "s"}`;
  const sentences: string[] = [];
  if (reassigned > 0) {
    sentences.push(`${bookings(reassigned)} reassigned to your team.`);
  }
  if (unassigned > 0) {
    const one = unassigned === 1;
    sentences.push(
      `${bookings(unassigned)} ${one ? "was" : "were"} left unassigned (${one ? "its time had already passed or wasn't set" : "their times had already passed or weren't set"}). Assign ${one ? "it" : "them"} from All Bookings.`,
    );
  }
  return sentences.join(" ");
}
