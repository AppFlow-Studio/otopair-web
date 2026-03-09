"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { useSession, useUser, useClerk } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";
import { CheckCircle2, XCircle, Loader2, AlertTriangle } from "lucide-react";
import Image from "next/image";

export default function AcceptInvitePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const { session } = useSession();
  const { user: clerkUser, isLoaded: isUserLoaded } = useUser();
  const { signOut } = useClerk();

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
      Date.now() > invitation.expires_at
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

    if (invitation.status === "accepted") {
      // Ensure Clerk metadata is set, reload session, then redirect
      (async () => {
        try {
          await fetch("/api/finalize-invite", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ role: invitation.role }),
          });
          await session?.reload();
        } catch {
          // Non-fatal
        }
        setStatus("accepted");
        setTimeout(() => router.push("/dashboard"), 2500);
      })();
      return;
    }

    // Invitation is pending — accept it now that the user is signed in.
    if (!hasAccepted.current) {
      hasAccepted.current = true;
      acceptAsCurrentUser({ token })
        .then(async (result) => {
          const role =
            result && typeof result === "object" && "role" in result
              ? (result as { role: string }).role
              : invitation.role;
          try {
            await fetch("/api/finalize-invite", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ role }),
            });
            await session?.reload();
          } catch {
            // Non-fatal
          }
          setStatus("accepted");
          setTimeout(() => router.push("/dashboard"), 2500);
        })
        .catch((err: Error) => {
          setStatus("error");
          setErrorMessage(
            err.message || "Something went wrong. Please try again."
          );
        });
    }
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
  ]);

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
        <div className="flex justify-center mb-6">
          <div className="relative w-12 h-12">
            <Image src="/logo.png" alt="Otopair" fill className="object-cover" />
          </div>
        </div>

        {status === "loading" && (
          <>
            <Loader2 className="w-10 h-10 text-primary animate-spin mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-gray-900 mb-2">
              Setting up your account…
            </h1>
            <p className="text-sm text-gray-500">
              Just a moment while we verify your invitation and set up your shop
              access.
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
              Your account is set up. Redirecting you to your dashboard…
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
