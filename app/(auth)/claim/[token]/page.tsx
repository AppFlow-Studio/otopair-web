import { redirect } from "next/navigation";
import { fetchQuery } from "convex/nextjs";
import { api } from "../../../../convex/_generated/api";
import { ClaimSignUp } from "./claim-signup";

export const dynamic = "force-dynamic";

export default async function ClaimPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await fetchQuery(api.walkin_claims.resolveClaimToken, {
    token,
  });

  if (!result) {
    return (
      <div className="max-w-md w-full bg-white rounded-xl shadow p-8 text-center">
        <h1 className="text-xl font-semibold text-gray-900">Link not found</h1>
        <p className="mt-2 text-sm text-gray-600">
          This claim link is invalid. If you visited a shop recently, ask them
          to resend your account link.
        </p>
      </div>
    );
  }

  if ("expired" in result && result.expired) {
    return (
      <div className="max-w-md w-full bg-white rounded-xl shadow p-8 text-center">
        <h1 className="text-xl font-semibold text-gray-900">Link expired</h1>
        <p className="mt-2 text-sm text-gray-600">
          This claim link has expired. You can still sign up with the same
          email you gave the shop and we'll connect your history.
        </p>
        <a
          href="/sign-up"
          className="mt-6 inline-block px-6 py-3 rounded-lg bg-blue-600 text-white font-medium"
        >
          Continue to sign up
        </a>
      </div>
    );
  }

  if ("alreadyClaimed" in result && result.alreadyClaimed) {
    redirect("/sign-in");
  }

  return (
    <ClaimSignUp
      email={result.email ?? ""}
      firstName={result.firstName ?? ""}
      shopName={result.shopName ?? ""}
      vehicleSummary={result.vehicleSummary ?? ""}
      // The shop entered this car without a valid VIN, so it's on a placeholder
      // identity (Off-Catalog Work spec, §5). Setting the expectation here is
      // all we can do pre-signup — the repair itself needs an authenticated
      // owner to authorise it. Deliberately not a blocker on claiming.
      vehicleNeedsVin={result.vehicleNeedsVin === true}
    />
  );
}
