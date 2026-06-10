import Navbar from "@/components/navbar";
import FooterImage from "@/components/footerimage";
import Footer from "@/components/footer";
import ReactLenis from "lenis/react";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Navbar />
      <ReactLenis root>{children}</ReactLenis>
      <Footer />
      <FooterImage />
    </>
  );
}
