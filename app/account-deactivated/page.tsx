"use client";

import Image from "next/image";
import { useClerk } from "@clerk/nextjs";
import { useRouter } from "next/navigation";

export default function AccountDeactivatedPage() {
  const { signOut } = useClerk();
  const router = useRouter();

  async function handleGoHome() {
    await signOut();
    router.push("/");
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 px-4">
      <Image src="/logo.png" alt="Otopair" width={64} height={64} className="mb-6" />
      <h1 className="text-2xl font-bold text-gray-900 mb-3 text-center">
        Your account has been deactivated
      </h1>
      <p className="text-gray-600 mb-8 text-center max-w-md">
        Your shop portal access has been deactivated. If you believe this is a
        mistake, please contact your shop owner or reach out to Otopair support
        for assistance.
      </p>
      <div className="flex gap-4">
        <button
          onClick={handleGoHome}
          className="px-5 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          Go Home
        </button>
        <a
          href="mailto:support@otopair.com"
          className="px-5 py-2.5 rounded-lg border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-100 transition-colors"
        >
          Contact Support
        </a>
      </div>
    </div>
  );
}
