import Navbar from "@/components/navbar";
import SmoothScroll from "@/components/flagship/smooth-scroll";
import { WaitlistProvider } from "@/components/flagship/waitlist-modal";

// The flagship landing page carries its own footer (FooterCta) per the Figma
// design, so the old global Footer/FooterImage are no longer rendered here.
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {/* Skip link — first focusable element on every marketing page
          (accessibility statement 2026-09-04). Visible only on focus; targets
          the page's <main>, which every PageShell page and the home render. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-full focus:bg-[#1a1a1a] focus:px-4 focus:py-2 focus:text-[14px] focus:text-white"
      >
        Skip to content
      </a>
      <WaitlistProvider>
        <Navbar />
        <SmoothScroll>{children}</SmoothScroll>
      </WaitlistProvider>
    </>
  );
}
