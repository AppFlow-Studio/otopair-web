import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { fetchMutation, fetchQuery } from "convex/nextjs";
import { makeFunctionReference } from "convex/server";
import { Id } from "@/convex/_generated/dataModel";
import { sendInviteEmail } from "@/email/send";

const getShopByIdQuery = makeFunctionReference<"query">("shops:getById");
const getMechanicByIdQuery = makeFunctionReference<"query">("mechanics:getById");
const hasActiveShopMembershipQuery = makeFunctionReference<"query">(
  "users:hasActiveShopMembership"
);
const createInvitationMutation = makeFunctionReference<"mutation">("invitations:create");
const getEmailLogoUrlQuery = makeFunctionReference<"query">("files:getEmailLogoUrl");

// Every outbound hop in this route is bounded by a timeout. Without one, a
// single stalled upstream (Clerk egress, Convex HTTP, or Resend) holds the
// request — and therefore the client's invite spinner — open indefinitely,
// which is exactly the "invite just keeps loading" symptom users reported.
// undici's default header timeout is ~5 minutes, so an un-aborted fetch can
// hang for that long. We fail fast instead and surface a real error.
const CLERK_API = "https://api.clerk.com/v1";
const CLERK_INVITE_TIMEOUT_MS = 12_000; // critical path
const CLERK_LOOKUP_TIMEOUT_MS = 6_000; // best-effort / recovery lookups
const CONVEX_TIMEOUT_MS = 12_000;
const EMAIL_TIMEOUT_MS = 12_000;

function clerkHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
  };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

/** Bound a promise that we can't attach an AbortSignal to (Convex, Resend). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// Look up the inviter's display name so the email can read
// "Marcus invited you to join …" instead of an anonymous notice.
// Best-effort: any failure (including a timeout) just omits the name.
async function getClerkInviterName(userId: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${CLERK_API}/users/${userId}`, {
      headers: clerkHeaders(),
      signal: AbortSignal.timeout(CLERK_LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const u = await res.json();
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { email, role, shopId, mechanicId, firstName, lastName } = await req.json();
    if (!email || !role || !shopId) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }
    if ((role === "shop_mechanic" || role === "mechanic") && !mechanicId) {
      return NextResponse.json(
        { error: "Mechanic invitations must be tied to a mechanic profile." },
        { status: 400 }
      );
    }

    const providedFirstName =
      typeof firstName === "string" && firstName.trim() ? firstName.trim() : undefined;

    // Run the independent read lookups concurrently instead of one-at-a-time.
    // This collapses five serial round-trips into one and shrinks the window in
    // which any single slow dependency can stall the request.
    //  - shop name / logo / mechanic name are best-effort (fall back gracefully)
    //  - the active-membership gate is authoritative: if it errors we let it
    //    propagate to the outer catch (a 500 is fine — an infinite spinner isn't)
    const [shop, mechanicForName, inviterName, emailLogoUrl, alreadyMember] =
      await Promise.all([
        withTimeout(
          fetchQuery(getShopByIdQuery, { id: shopId as Id<"shops"> }),
          CONVEX_TIMEOUT_MS,
          "shop lookup"
        ).catch(() => null) as Promise<{ name?: string } | null>,
        !providedFirstName && mechanicId
          ? (withTimeout(
              fetchQuery(getMechanicByIdQuery, { id: mechanicId as Id<"mechanics"> }),
              CONVEX_TIMEOUT_MS,
              "mechanic lookup"
            ).catch(() => null) as Promise<{ first_name?: string } | null>)
          : Promise.resolve(null),
        getClerkInviterName(userId),
        withTimeout(
          fetchQuery(getEmailLogoUrlQuery, {}),
          CONVEX_TIMEOUT_MS,
          "logo lookup"
        ).catch((e) => {
          console.error("Could not resolve email logo URL:", e);
          return null;
        }) as Promise<string | null>,
        withTimeout(
          fetchQuery(hasActiveShopMembershipQuery, { email }),
          CONVEX_TIMEOUT_MS,
          "membership check"
        ) as Promise<boolean>,
      ]);

    // Block invites to users who are already an active member of any shop
    if (alreadyMember) {
      return NextResponse.json(
        { error: "This person is already a member of a shop and cannot be invited again." },
        { status: 409 }
      );
    }

    const shopName = shop?.name;
    const inviteeFirstName =
      providedFirstName || mechanicForName?.first_name?.trim() || undefined;
    const resolvedLogoUrl = emailLogoUrl ?? undefined;

    const resolvedMechanicId: string | undefined = mechanicId;

    // Generate token here so it can be embedded in Clerk's invitation metadata
    const invitationToken = crypto.randomUUID();

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin;
    const redirectUrl = `${baseUrl}/accept-invite?token=${invitationToken}`;

    // Create the Clerk invitation with notify:false — Clerk still binds account
    // creation to this invitation (mechanics can't self-register), but WE send
    // the branded, personalized email instead of Clerk's default template.
    const clerkResponse = await fetch(`${CLERK_API}/invitations`, {
      method: "POST",
      headers: clerkHeaders(true),
      body: JSON.stringify({
        email_address: email,
        public_metadata: {
          // role is intentionally omitted - it is only granted after the invite token is used
          shop_id: shopId,
          invitation_token: invitationToken,
          ...(resolvedMechanicId ? { mechanic_id: resolvedMechanicId } : {}),
        },
        redirect_url: redirectUrl,
        notify: false,
      }),
      signal: AbortSignal.timeout(CLERK_INVITE_TIMEOUT_MS),
    });

    let clerkInvitationId: string | undefined;
    let emailDelivered = false;
    if (clerkResponse.ok) {
      const clerkData = await clerkResponse.json();
      clerkInvitationId = clerkData.id;
      // Clerk returns a one-click ticket URL (email pre-verified) on the
      // invitation object. Prefer it; fall back to our /accept-invite link.
      const ticketUrl =
        typeof clerkData.url === "string" && clerkData.url ? clerkData.url : redirectUrl;
      emailDelivered = await sendInviteEmailBounded({
        email,
        inviteUrl: ticketUrl,
        shopName,
        firstName: inviteeFirstName,
        role,
        inviterName,
        logoUrl: resolvedLogoUrl,
      });
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
          `${CLERK_API}/users?email_address=${encodeURIComponent(email)}`,
          {
            headers: clerkHeaders(),
            signal: AbortSignal.timeout(CLERK_LOOKUP_TIMEOUT_MS),
          }
        );
        if (lookupRes.ok) {
          const users = await lookupRes.json();
          const existingClerkUser = users[0];
          if (existingClerkUser?.id) {
            // Active Clerk account - patch their public_metadata so middleware lets them in
            await fetch(`${CLERK_API}/users/${existingClerkUser.id}`, {
              method: "PATCH",
              headers: clerkHeaders(true),
              body: JSON.stringify({
                public_metadata: {
                  ...((existingClerkUser.public_metadata as object) ?? {}),
                  // role is intentionally omitted - it is only granted after the invite token is used
                  shop_id: shopId,
                  invitation_token: invitationToken,
                  ...(resolvedMechanicId ? { mechanic_id: resolvedMechanicId } : {}),
                },
              }),
              signal: AbortSignal.timeout(CLERK_LOOKUP_TIMEOUT_MS),
            });
          }
          // Send invite link via Resend in both cases - for an existing account
          // the /accept-invite link lets them sign in and accept; for a stale
          // duplicate there's no active Clerk invitation to send from.
          emailDelivered = await sendInviteEmailBounded({
            email,
            inviteUrl: redirectUrl,
            shopName,
            firstName: inviteeFirstName,
            role,
            inviterName,
            logoUrl: resolvedLogoUrl,
          });
        }
      } else {
        return NextResponse.json(
          { error: errorMessage || "Failed to send invitation." },
          { status: 400 }
        );
      }
    }

    // Store invitation in Convex (token is pre-generated above so it matches Clerk metadata)
    await withTimeout(
      fetchMutation(createInvitationMutation, {
        invitedByClerkUserId: userId,
        shopId: shopId as Id<"shops">,
        email,
        role,
        token: invitationToken,
        mechanicId: resolvedMechanicId as Id<"mechanics"> | undefined,
        clerkInvitationId,
      }),
      CONVEX_TIMEOUT_MS,
      "invitation persist"
    );

    console.log("Invite link:", redirectUrl);
    return NextResponse.json({ success: true, token: invitationToken, emailDelivered });
  } catch (err) {
    // A timeout (from AbortSignal.timeout or withTimeout) surfaces here. Map it
    // to a clear, actionable message instead of a raw abort string.
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" ||
        err.name === "AbortError" ||
        /timed out/i.test(err.message));
    const message = isTimeout
      ? "The invitation service is taking too long to respond. Please try again in a moment."
      : err instanceof Error
        ? err.message
        : "Internal server error";
    return NextResponse.json({ error: message }, { status: isTimeout ? 504 : 500 });
  }
}

/** Send the invite email without letting a slow Resend call hang the request.
 *  Email is resendable, so a timeout/failure here logs and returns false rather
 *  than blocking invite creation. */
async function sendInviteEmailBounded(args: Parameters<typeof sendInviteEmail>[0]): Promise<boolean> {
  try {
    const sent = await withTimeout(sendInviteEmail(args), EMAIL_TIMEOUT_MS, "invite email");
    if (!sent.success) {
      console.error("Invite email failed to send:", sent.error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("Invite email send timed out or threw:", e);
    return false;
  }
}
