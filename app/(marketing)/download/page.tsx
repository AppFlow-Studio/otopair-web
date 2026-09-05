import type { Metadata } from "next";
import Link from "next/link";
import PageShell, { Section } from "@/components/flagship/page-shell";
import { ComingSoonPlates } from "@/components/flagship/download-app";
import WaitlistForm from "@/components/flagship/waitlist-form";
import { FaqSection } from "@/components/seo/faq";
import { HeroPhoto } from "@/components/flagship/hero-visual";

export const metadata: Metadata = {
  title: { absolute: "Get the Otopair app: iPhone and Android" },
  description:
    "Download Otopair for iOS or Android: talk to Oto about what your car is doing, get locked prices from verified Staten Island shops, and book in about 90 seconds.",
  alternates: { canonical: "/download" },
};

/**
 * /download — audit Tier 1: the #get-oto anchor as a URL for app-install
 * intent. The store badges come from download-app.tsx, which renders the
 * platform's own badge and a "coming soon" caption while APP_STORE_URL /
 * PLAY_STORE_URL are placeholders — so this page is truthful before and
 * after the listings go live without a copy change.
 */
const FAQ = [
  {
    q: "Is the Otopair app free?",
    a: "Yes. Downloading the app, talking to Oto and getting prices from shops costs nothing. You pay only when you book a job, and the price you pay is the one the shop set and you confirmed.",
  },
  {
    q: "Which phones does Otopair support?",
    a: "iPhone (iOS) and Android. There is no web booking for drivers; the app is where Oto, the price lock and the booking live. Repair shops use a separate web dashboard.",
  },
  {
    q: "What does Oto do in the app?",
    a: "Oto is the assistant you talk to, by text or voice. It asks about the symptom, turns the problem into a job a shop can quote, and hands you to the booking flow, where you see verified shops and the full total before you confirm. Oto is a guide, not a mechanic: it never quotes a price itself and never walks you through a repair.",
  },
];

export default function DownloadPage() {
  return (
    <PageShell
      eyebrow="GET OTO"
      title="Car repair, price locked, in your pocket"
      lede="Tell Oto what your car is doing, get fixed prices from verified shops nearby, and pay the price you saw. Leave your email for launch day."
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Download", href: "/download" },
      ]}
      visual={
        <HeroPhoto
          src="/landing/oto-listens-dash.png"
          alt="A driver at the wheel holding a phone with Oto listening in the Otopair app"
          width={2574}
          height={1380}
          position="62% 50%"
        />
      }
      hero={
        <div className="flex w-full flex-col items-start gap-4">
          <WaitlistForm list="app" />
          <ComingSoonPlates className="justify-start" />
        </div>
      }
    >
      <Section id="what" title="What you get in the app">
        <ul>
          <li>
            <strong>Oto, by text or voice.</strong> Describe the symptom in your own words; Oto turns it
            into a job a shop can quote.
          </li>
          <li>
            <strong>Prices from real shops.</strong> Each verified shop sets its own price. You see the
            full total, parts and labor and tax, before you confirm.
          </li>
          <li>
            <strong>A locked price.</strong> What you confirm is what you pay. Extra work needs your
            approval in the app first.
          </li>
          <li>
            <strong>A deposit, not a full charge.</strong> A small hold reserves the slot; the balance is
            collected when the job is done.
          </li>
          <li>
            <strong>Your car&rsquo;s record.</strong> Every job, receipt and inspection stays with the
            vehicle.
          </li>
        </ul>
      </Section>

      <Section id="where" title="Where does it work?">
        <p>
          Staten Island today; the rest of New York City borough by borough. The{" "}
          <Link href="/coverage">coverage page</Link> has the ladder and the waitlists.
        </p>
      </Section>

      <FaqSection items={FAQ} />
    </PageShell>
  );
}
