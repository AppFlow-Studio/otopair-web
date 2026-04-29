import { Id } from "@/convex/_generated/dataModel";

type SendTeamInviteArgs =
  | {
      email: string;
      role: "shop_mechanic";
      shopId: Id<"shops">;
      mechanicId: Id<"mechanics"> | string;
      origin: string;
    }
  | {
      email: string;
      role: "shop_owner" | "front_desk";
      shopId: Id<"shops">;
      firstName?: string;
      lastName?: string;
      title?: string;
      origin: string;
    };

export async function sendTeamInvite(args: SendTeamInviteArgs) {
  const res = await fetch("/api/invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: args.email,
      role: args.role,
      shopId: args.shopId,
      ...("mechanicId" in args
        ? { mechanicId: args.mechanicId }
        : {
            firstName: args.firstName,
            lastName: args.lastName,
            title: args.title,
          }),
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    return {
      ok: false as const,
      error: data.error || "Failed to send invitation.",
    };
  }

  if (data.token) {
    const inviteLink = `${args.origin}/accept-invite?token=${data.token}`;
    console.log("Invite link:", inviteLink);
  }

  return {
    ok: true as const,
    token: typeof data.token === "string" ? data.token : undefined,
  };
}
