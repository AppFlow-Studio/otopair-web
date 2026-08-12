/**
 * Receipts layout — minimal customer-facing chrome (no shop sidebar, no
 * marketing nav). Used by `/receipts/[bookingId]` so customers who click
 * through from the invoice email land on a clean page focused on the
 * receipt itself.
 */
import Image from "next/image";
import Link from "next/link";
import { SignedIn, UserButton } from "@clerk/nextjs";

export default function ReceiptsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#f8fafc]">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            {/* unoptimized: this page is opened from an email link by people
                who may never sign in, and a broken logo is a worse first
                impression than an unoptimized 28px asset. */}
            <Image
              src="/logo.png"
              alt=""
              width={28}
              height={28}
              unoptimized
              priority
              className="size-7 object-contain"
            />
            <span className="text-lg font-bold tracking-tight text-[#0d72ff]">
              Otopair
            </span>
          </Link>
          {/* Only show the account chip for signed-in customers. Walk-ins
              opening a tokenized receipt link never had a Clerk account, so
              showing a sign-out / avatar would just confuse them. */}
          <SignedIn>
            <UserButton afterSignOutUrl="/" />
          </SignedIn>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-10">{children}</main>
    </div>
  );
}
