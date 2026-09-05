import type { Metadata } from "next";
import BoroughPage from "@/components/flagship/borough-page";
import { boroughBySlug } from "@/lib/coverage";

const borough = boroughBySlug("queens")!;

export const metadata: Metadata = {
  title: { absolute: `Otopair in ${borough.name}: coming ${borough.date}` },
  description: `Fixed-price car repair from verified independent shops is coming to ${borough.name} in ${borough.date}. Join the waitlist to hear when the first shops go live, or apply now if you run a shop.`,
  alternates: { canonical: "/queens" },
};

export default function Page() {
  return <BoroughPage borough={borough} />;
}
