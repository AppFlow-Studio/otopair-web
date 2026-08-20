import type { Metadata } from "next";
import PartnerClient from "./partner-client";

export const metadata: Metadata = {
  title: "Partner with Otopair — For repair shops",
  description:
    "Join the Otopair network. Fill your bays with booked customers, skip the phone tag, and get paid fast — all from one dashboard.",
};

export default function PartnerWithUsPage() {
  return (
    <main className="min-h-screen w-full bg-white">
      <PartnerClient />
    </main>
  );
}
