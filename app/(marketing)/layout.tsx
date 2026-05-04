import Navbar from "@/components/navbar";
import FooterImage from "@/components/footerimage";
import Footer from "@/components/footer";
import ReactLenis from "lenis/react";
import PortalUserRedirect from "@/components/portal-user-redirect";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <PortalUserRedirect />
      <Navbar />
      <ReactLenis root>{children}</ReactLenis>
      <Footer />
      <FooterImage />
    </>
  );
}
