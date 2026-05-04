"use client";

import Image from "next/image";
import { useClerk } from "@clerk/nextjs";
import { useRouter } from "next/navigation";

//TODO: add Otopair App Store and Play Store link

export default function ShopOnlyPage() {
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
        This portal is for Otopair partner shops
      </h1>
      <p className="text-gray-600 mb-2 text-center max-w-md">
        If you&apos;re a shop owner, contact us to get started and set up your
        shop on Otopair.
      </p>
      <p className="text-gray-600 mb-8 text-center max-w-md">
        If you're looking for car service, download the Otopair app.
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
          Contact Us
        </a>
      </div>
    </div>
  );
}
