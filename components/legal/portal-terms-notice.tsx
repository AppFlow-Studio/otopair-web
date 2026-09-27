import Link from "next/link";

/**
 * Shown under every web sign-in / sign-up surface. The Shop Portal Terms of
 * Use make logging in the acceptance (§2), so the terms have to be in front of
 * the person at that moment, not only in the footer.
 */
export function PortalTermsNotice({ className = "" }: { className?: string }) {
  return (
    <p className={`max-w-[400px] px-4 text-center text-[12px] leading-relaxed text-gray-500 ${className}`}>
      By signing in to the Otopair shop portal, you agree to the{" "}
      <Link href="/shop-portal-terms" className="underline underline-offset-2 hover:text-gray-700">
        Shop Portal Terms of Use
      </Link>{" "}
      and acknowledge the{" "}
      <Link href="/privacy" className="underline underline-offset-2 hover:text-gray-700">
        Privacy Policy
      </Link>
      .
    </p>
  );
}
