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

// Hard ceiling on how long the invite request may run before we give the user
// back control. The server bounds each of its own hops, so the response should
// arrive well within this; the client timeout is a backstop so the invite
// button can never spin forever (e.g. if the network drops mid-request).
const INVITE_REQUEST_TIMEOUT_MS = 30_000;

export async function sendTeamInvite(args: SendTeamInviteArgs) {
  let res: Response;
  try {
    res = await fetch("/api/invite", {
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
      signal: AbortSignal.timeout(INVITE_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut =
      err instanceof DOMException &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      ok: false as const,
      error: timedOut
        ? "The invitation is taking longer than expected. Please check your connection and try again."
        : "Couldn't reach the server. Please try again.",
    };
  }

  // Guard against non-JSON error responses (e.g. an HTML 500 page) so a bad
  // body can't throw here and leave the caller without a result.
  let data: { error?: string; token?: string } = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

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
