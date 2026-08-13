import Navbar from "@/components/navbar";
import ReactLenis from "lenis/react";

// The flagship landing page carries its own footer (FooterCta) per the Figma
// design, so the old global Footer/FooterImage are no longer rendered here.
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Navbar />
      {/* anchors: smooth-scroll nav hash links, offset clears the fixed pill nav */}
      <ReactLenis root options={{ anchors: { offset: -90 } }}>
        {children}
      </ReactLenis>
    </>
  );
}
