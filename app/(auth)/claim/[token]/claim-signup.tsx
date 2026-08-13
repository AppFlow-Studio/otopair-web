"use client";

import { SignUp } from "@clerk/nextjs";

export function ClaimSignUp({
  email,
  firstName,
  shopName,
  vehicleSummary,
}: {
  email: string;
  firstName: string;
  shopName: string;
  vehicleSummary: string;
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
