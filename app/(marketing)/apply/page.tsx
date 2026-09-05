import type { Metadata } from "next";
import ApplyForm from "./apply-form";

export const metadata: Metadata = {
  // `absolute`: the root template would otherwise append a second "— Otopair".
  title: { absolute: "Apply to partner with Otopair" },
  description:
    "Apply to join the Otopair network. Tell us about your shop and we'll be in touch about setting up your account.",
  alternates: { canonical: "/apply" },
};

export default function ApplyPage() {
  return (
    <main className="min-h-screen w-full bg-[#eceae6]">
      <ApplyForm />
    </main>
  );
}
