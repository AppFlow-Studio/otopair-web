"use client";

import { useEffect, useState } from "react";
import { SignUp, useUser } from "@clerk/nextjs";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";

export function ClaimSignUp({
  token,
  email,
  firstName,
  shopName,
  vehicleSummary,
  vehicleNeedsVin = false,
}: {
  token: string;
  email: string;
  firstName: string;
  shopName: string;
  vehicleSummary: string;
  vehicleNeedsVin?: boolean;
}) {
  const { isSignedIn, isLoaded } = useUser();
  const claimByToken = useMutation(api.walkin_claims.claimByToken);
  const router = useRouter();
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);

  useEffect(() => {
    if (isLoaded && isSignedIn && !claiming && !claimed) {
      setClaiming(true);
      claimByToken({ token })
        .then(() => {
          setClaimed(true);
          setClaiming(false);
          setTimeout(() => {
            router.push(`/t/${token}`);
          }, 1500);
        })
        .catch((err) => {
          console.error("Claim error:", err);
          setClaiming(false);
        });
    }
  }, [isLoaded, isSignedIn, token, claiming, claimed, claimByToken, router]);

  if (isLoaded && isSignedIn) {
    return (
      <div className="max-w-md w-full bg-white rounded-xl shadow p-8 text-center">
        {claiming ? (
          <>
            <Loader2 className="h-8 w-8 animate-spin mx-auto text-blue-600 mb-4" />
            <h1 className="text-xl font-semibold text-gray-900">Connecting your vehicle...</h1>
            <p className="mt-2 text-sm text-gray-600">
              Merging your service history into your account.
            </p>
          </>
        ) : claimed ? (
          <>
            <CheckCircle2 className="h-10 w-10 text-emerald-500 mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-gray-900">Vehicle Added!</h1>
            <p className="mt-2 text-sm text-gray-600">
              Your service history has been connected. Taking you to your tracker...
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-gray-600">Taking you to your tracker...</p>
            <a
              href={`/t/${token}`}
              className="mt-4 inline-block px-6 py-2.5 rounded-lg bg-blue-600 text-white font-medium"
            >
              Go to Tracker
            </a>
          </>
        )}
      </div>
    );
  }

  const greeting = firstName ? `Welcome, ${firstName}` : "Welcome to Otopair";
  const subline = shopName
    ? `Your account from ${shopName} is ready.`
    : "Your account is ready.";

  return (
    <div className="max-w-md w-full">
      <div className="bg-white rounded-xl shadow p-6 mb-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-blue-600">
          Powered by Otopair
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-gray-900">{greeting}</h1>
        <p className="mt-1 text-sm text-gray-600">{subline}</p>
        {vehicleSummary ? (
          <p className="mt-3 text-sm text-gray-700">
            <span className="font-medium">Vehicle:</span> {vehicleSummary}
          </p>
        ) : null}
        {vehicleNeedsVin ? (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
            We don&apos;t have this car&apos;s VIN yet. After you sign up
            we&apos;ll ask for it once — it&apos;s what lets us pull the right
            parts and track its maintenance properly.
          </p>
        ) : null}
        <p className="mt-3 text-xs text-gray-500">
          Sign up below and we&apos;ll connect your service history automatically.
        </p>
      </div>

      <SignUp
        initialValues={email ? { emailAddress: email } : undefined}
        fallbackRedirectUrl={`/claim/${token}`}
      />
    </div>
  );
}
