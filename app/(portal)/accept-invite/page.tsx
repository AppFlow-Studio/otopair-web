"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { useSession, useUser, useClerk, useAuth } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";
import { CheckCircle2, XCircle, Loader2, AlertTriangle } from "lucide-react";

// Pull the role claim straight out of a Clerk session JWT so we can tell,
// deterministically, when the freshly-granted role has landed in the token
// that middleware will read on the next navigation.
function readRoleFromJwt(jwt: string | null | undefined): string | undefined {
  if (!jwt) return undefined;
  const parts = jwt.split(".");
  if (parts.length < 2) return undefined;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const claims = JSON.parse(atob(b64 + pad)) as {
      metadata?: { role?: string };
      public_metadata?: { role?: string };
    };
    return claims?.metadata?.role ?? claims?.public_metadata?.role;
  } catch {
    return undefined;
  }
}

export default function AcceptInvitePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-10 w-full max-w-md text-center">
            <Loader2 className="w-10 h-10 text-primary animate-spin mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-gray-900 mb-2">
              Loading…
            </h1>
          </div>
        </div>
      }
    >
      <AcceptInviteContent />
    </Suspense>
  );
}

function AcceptInviteContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const { session } = useSession();
  const { user: clerkUser, isLoaded: isUserLoaded } = useUser();
  const { signOut } = useClerk();
  const { getToken } = useAuth();

  const invitation = useQuery(
    api.invitations.getByToken,
    token ? { token } : "skip"
  );

  const acceptAsCurrentUser = useMutation(api.invitations.acceptAsCurrentUser);

  const [status, setStatus] = useState<
    "loading" | "accepted" | "wrong_account" | "error"
  >("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const hasAccepted = useRef(false);
  const hasEntered = useRef(false);

  // Check if the logged-in user matches the invitation email
  const loggedInEmail = clerkUser?.primaryEmailAddress?.emailAddress;
  const invitationEmail = invitation?.email;

  useEffect(() => {
    if (invitation === undefined || !isUserLoaded) return; // still loading

    if (invitation === null) {
      setStatus("error");
      setErrorMessage("This invitation link is invalid or has expired.");
      return;
    }

    if (invitation.status === "revoked") {
      setStatus("error");
      setErrorMessage("This invitation has been revoked by the shop owner.");
      return;
    }

    if (
      invitation.status === "expired" ||
      (invitation.expires_at != null && Date.now() > invitation.expires_at)
    ) {
      setStatus("error");
      setErrorMessage(
        "This invitation has expired. Please ask the shop owner to send a new one."
      );
      return;
    }

    // Require sign-in before any acceptance logic — finalize-invite needs an auth'd session.
    if (!clerkUser) {
      const signInUrl = `/sign-in?redirect_url=${encodeURIComponent(window.location.href)}`;
      router.push(signInUrl);
      return;
    }

    // If a user is logged in but their email doesn't match the invitation,
    // show a mismatch screen so they can switch accounts.
    if (
      loggedInEmail &&
      invitationEmail &&
      loggedInEmail.toLowerCase() !== invitationEmail.toLowerCase()
    ) {
      setStatus("wrong_account");
      return;
    }

    // Already accepted (returning user, or the reactive query re-firing right
    // after our own acceptance) — just make sure the role is live and enter.
    if (invitation.status === "accepted") {
      void finalizeAndEnter(invitation.role);
      return;
    }

    // Invitation is pending — accept it now that the user is signed in.
    if (!hasAccepted.current) {
      hasAccepted.current = true;
      acceptAsCurrentUser({ token })
        .then((result) => {
          const role =
            result && typeof result === "object" && "role" in result
              ? (result as { role: string }).role
              : invitation.role;
          return finalizeAndEnter(role);
        })
        .catch((err: Error) => {
          setStatus("error");
          setErrorMessage(
            err.message || "Something went wrong. Please try again."
          );
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    invitation,
    router,
    token,
    acceptAsCurrentUser,
    session,
    clerkUser,
    isUserLoaded,
    loggedInEmail,
    invitationEmail,
    getToken,
  ]);

  // Grant the role in Clerk, then wait until that role is actually present in a
  // freshly-minted session token BEFORE doing the full-page nav. This closes
  // the propagation race that previously made middleware bounce the user back
  // (the "refresh / close the tab and it works" symptom).
  async function finalizeAndEnter(role: string) {
    if (hasEntered.current) return;
    hasEntered.current = true;

    // Set role + is_active on Clerk public_metadata (retry once — this is the
    // one call that must succeed for the portal to let the user in).
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch("/api/finalize-invite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role }),
        });
        if (res.ok) break;
      } catch {
        // retry
      }
    }

    try {
      await session?.reload();
    } catch {
      // non-fatal
    }

    // Poll a fresh (uncached) session token until it carries the new role.
    const deadline = Date.now() + 12000;
    let roleLive = false;
    while (Date.now() < deadline) {
      try {
        const jwt = await getToken({ skipCache: true });
        if (readRoleFromJwt(jwt)) {
          roleLive = true;
          break;
        }
      } catch {
        // keep polling
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    setStatus("accepted");
    // Short beat so the success state is visible, then a full-page nav so
    // middleware re-reads the refreshed session cookie. `roleLive` is true in
    // the common case; the timeout fallback still navigates so we never hang.
    setTimeout(() => window.location.assign("/dashboard"), roleLive ? 700 : 1200);
  }

  async function handleSwitchAccount() {
    // Sign out the current user and redirect to sign-in with a return URL
    // back to this accept-invite page so the correct user can sign in.
    const returnUrl = window.location.href;
    await signOut();
    router.push(`/sign-in?redirect_url=${encodeURIComponent(returnUrl)}`);
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-10 w-full max-w-md text-center">
        {status === "loading" && (
          <>
            <Loader2 className="w-10 h-10 text-primary animate-spin mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-gray-900 mb-2">
              Setting up your account…
            </h1>
            <p className="text-sm text-gray-500">
              Hang tight — we&apos;re verifying your invitation and getting your
              shop access ready. This only takes a few seconds.
            </p>
          </>
        )}

        {status === "accepted" && (
          <>
            <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-gray-900 mb-2">
              You&apos;re in!
            </h1>
            <p className="text-sm text-gray-500">
              Your account is ready. Taking you to your dashboard…
            </p>
          </>
        )}

        {status === "wrong_account" && (
          <>
            <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-gray-900 mb-2">
              Wrong account
            </h1>
            <p className="text-sm text-gray-500 mb-2">
              You&apos;re currently signed in as{" "}
              <span className="font-medium text-gray-700">{loggedInEmail}</span>,
              but this invitation was sent to{" "}
              <span className="font-medium text-gray-700">
                {invitationEmail}
              </span>
              .
            </p>
            <p className="text-sm text-gray-500 mb-6">
              Please sign in with the correct account to accept this invitation.
            </p>
            <button
              onClick={handleSwitchAccount}
              className="inline-block px-5 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Switch Account
            </button>
          </>
        )}

        {status === "error" && (
          <>
            <XCircle className="w-10 h-10 text-red-500 mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-gray-900 mb-2">
              Invitation issue
            </h1>
            <p className="text-sm text-gray-500 mb-6">{errorMessage}</p>
            <a
              href="/"
              className="inline-block px-5 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Go to Home
            </a>
          </>
        )}
      </div>
    </div>
  );
}
