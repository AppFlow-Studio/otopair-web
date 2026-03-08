"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { useSession } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import Image from "next/image";

export default function AcceptInvitePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const { session } = useSession();

  const invitation = useQuery(
    api.invitations.getByToken,
    token ? { token } : "skip"
  );

  const acceptAsCurrentUser = useMutation(api.invitations.acceptAsCurrentUser);

  const [status, setStatus] = useState<"loading" | "accepted" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  // Prevent calling acceptAsCurrentUser more than once
  const hasAccepted = useRef(false);

  useEffect(() => {
    if (invitation === undefined) return; // still loading

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

    if (invitation.status === "expired" || Date.now() > invitation.expires_at) {
      setStatus("error");
      setErrorMessage("This invitation has expired. Please ask the shop owner to send a new one.");
      return;
    }

    if (invitation.status === "accepted") {
      // Still ensure Clerk metadata is set in case it was missed, then reload session
      fetch("/api/finalize-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "shop_mechanic" }),
      })
        .then(() => session?.reload())
        .catch(() => {})
        .finally(() => {
          setStatus("accepted");
          setTimeout(() => router.push("/dashboard"), 2500);
        });
      return;
    }

    // Invitation is pending — try to accept it directly.
    // This handles existing Clerk users (no user.created webhook fires for them).
    if (!hasAccepted.current) {
      hasAccepted.current = true;
      acceptAsCurrentUser({ token })
        .then(async () => {
          // Explicitly set Clerk public_metadata.role so the middleware JWT check passes.
          // This is needed because Clerk may not have propagated the invitation metadata
          // to the user's session token yet (timing issue on new account creation).
          try {
            await fetch("/api/finalize-invite", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ role: "shop_mechanic" }),
            });
            // Reload the session so the fresh JWT claims (with role) are used when
            // the middleware checks on the next navigation.
            await session?.reload();
          } catch {
            // Non-fatal — the user may still get through if Clerk already set the role
          }
          setStatus("accepted");
          setTimeout(() => router.push("/dashboard"), 2500);
        })
        .catch((err: Error) => {
          // If not authenticated, the user needs to sign in first then come back
          if (err.message?.includes("Not authenticated")) {
            const signInUrl = `/sign-in?redirect_url=${encodeURIComponent(window.location.href)}`;
            router.push(signInUrl);
          } else {
            setStatus("error");
            setErrorMessage(err.message || "Something went wrong. Please try again.");
          }
        });
    }
  }, [invitation, router, token, acceptAsCurrentUser, session]);

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
              Just a moment while we verify your invitation and set up your shop access.
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
