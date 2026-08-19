"use client";

import { SignUp } from "@clerk/nextjs";

export function ClaimSignUp({
  email,
  firstName,
  shopName,
  vehicleSummary,
  vehicleNeedsVin = false,
}: {
  email: string;
  firstName: string;
  shopName: string;
  vehicleSummary: string;
  vehicleNeedsVin?: boolean;
}) {
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
          Sign up below and we'll connect your service history automatically.
        </p>
      </div>

      <SignUp
        initialValues={email ? { emailAddress: email } : undefined}
      />
    </div>
  );
}
