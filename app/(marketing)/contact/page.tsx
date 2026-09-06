import type { Metadata } from "next";
import ContactClient from "./contact-client";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Reach Otopair support, the shop partnerships team, or the car-data team. Based in Staten Island, NY. A form that goes to a person, plus the direct addresses.",
  alternates: { canonical: "/contact" },
};

export default function ContactPage() {
  return <ContactClient />;
}
