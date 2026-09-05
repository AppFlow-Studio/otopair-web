import type { Metadata } from "next";
import Link from "next/link";
import PageShell, { Section, Summary, type TocItem } from "@/components/flagship/page-shell";
import { FaqSection } from "@/components/seo/faq";

export const metadata: Metadata = {
  title: "Dealership or independent mechanic: which should I choose?",
  description:
    "When a dealership is the better choice (warranty work, recalls, brand-specific tooling), when an independent shop is (out-of-warranty maintenance, price transparency, a relationship), what to check either way, and how Otopair's locked-price model fits.",
  alternates: { canonical: "/guides/dealership-vs-independent-mechanic" },
};

/**
 * /guides/dealership-vs-independent-mechanic — the one comparison the locked
 * decisions allow (audit Tier 5): no competitor names, no cost figures, no
 * percentages, no "dealers charge more". Balanced on purpose: it tells the
 * reader when the answer is a dealership and not Otopair. Product claims in
 * the Otopair section are the same ones the help articles carry (locked
 * total, $20 hold, 24-hour approvals, receipt, 14-day disputes, one-way
 * reviews, hand-reviewed shops).
 */
const UPDATED = "2026-09-04";

const TOC: TocItem[] = [
  { id: "difference", title: "What is the real difference?" },
  { id: "dealership", title: "When is a dealership the better choice?" },
  { id: "independent", title: "When is an independent shop the better choice?" },
  { id: "check", title: "What should I check in either case?" },
  { id: "otopair", title: "How does Otopair fit in?" },
  { id: "both", title: "Can I use both?" },
  { id: "faq", title: "Questions people ask" },
];

const FAQ = [
  {
    q: "Does using an independent shop void my warranty?",
    a: "Not by itself. In the United States a manufacturer generally cannot require that routine maintenance be done at its dealers for the warranty to stay valid, as long as the work is done to the manufacturer's schedule and specifications and you keep the receipts. Warranty repairs themselves are a different matter: the covered repair is done and paid for through the manufacturer's network. Your warranty booklet has the specifics for your car.",
  },
  {
    q: "Can an independent shop do a recall repair?",
    a: "No. A safety recall is repaired at no charge by the manufacturer through its dealers, regardless of where you normally service the car. Check your VIN on NHTSA's recall lookup; the Otopair app cannot look up recalls for you.",
  },
  {
    q: "Can I get a New York State inspection at an independent shop?",
    a: "Yes, at any DMV-licensed inspection station, dealer or independent. On Otopair, State Inspection and Emissions Test are offered only by shops that hold the NY DMV inspection-station license, which Otopair's team reviews.",
  },
  {
    q: "Are dealerships on Otopair?",
    a: "The network today is independent shops, each reviewed and approved by Otopair's team. Warranty and recall work belongs at your dealer; for out-of-warranty maintenance and repair, the app shows you the full total for your exact car at a shop near you before you confirm.",
  },
  {
    q: "How do I know an independent shop's price is fair if there is no price list?",
    a: "Get the total before the work starts and make sure extra work needs your say-so. On Otopair that is built in: the total for your exact car, with parts, labor, tax and Otopair's service fee inside it, is shown before you confirm and locked; the shop confirms its final price after inspection without seeing the figure you approved, and anything above it needs your approval in the app.",
  },
];

export default function DealershipVsIndependentGuide() {
  return (
    <PageShell
      eyebrow="GUIDE"
      title="Dealership or independent mechanic: which should I choose?"
      lede="It depends on the job. Warranty repairs, recalls and anything that needs the manufacturer's own tools and software belong at a dealership. Out-of-warranty maintenance and most repairs are well served by a good independent shop, where you can build a relationship and see exactly what you are paying for. Here is how to decide, job by job."
      updated={UPDATED}
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Guides", href: "/guides" },
        {
          name: "Dealership or independent mechanic",
          href: "/guides/dealership-vs-independent-mechanic",
        },
      ]}
      toc={TOC}
      numbered
    >
      <Summary
        items={[
          "Under warranty, or a recall? Dealership. The repair is covered there, and the dealer has the brand's own tooling and software.",
          "Out of warranty, routine maintenance, brakes, tires, batteries, common repairs? An independent shop is usually the better fit.",
          "Either way: get the total in writing before work starts, make sure extra work needs your approval, and keep the itemized receipt.",
          "On Otopair the total for your exact car is locked before the car goes in, extra work needs your approval in the app, and the receipt is kept for you.",
        ]}
      />

      <Section id="difference" title="What is the real difference?">
        <p>
          Who they answer to, and what they specialize in. A dealership&rsquo;s service department is
          franchised by one manufacturer: its technicians are trained on that brand, it runs the
          brand&rsquo;s own diagnostic software, it fits the manufacturer&rsquo;s parts, and it is where
          warranty and recall work is carried out. An independent shop is locally owned, works across
          makes, sets its own labor rate, chooses between manufacturer and equivalent parts, and lives
          or dies on repeat customers.
        </p>
        <p>
          Neither is better in the abstract. The same brake job can be done well at either; the
          questions are what the job needs and what you want from the relationship.
        </p>
      </Section>

      <Section id="dealership" title="When is a dealership the better choice?">
        <p>
          When the repair is covered, or when the car needs the brand&rsquo;s own tools. Specifically:
        </p>
        <ul>
          <li>
            <strong>Warranty repairs.</strong> A covered fault is diagnosed, repaired and paid for
            through the manufacturer&rsquo;s network. Having the dealer diagnose it also avoids an
            argument later about what caused it.
          </li>
          <li>
            <strong>Safety recalls.</strong> A recall repair is done at no charge by the manufacturer
            through its dealers, wherever you usually service the car. Check your VIN on{" "}
            <a href="https://www.nhtsa.gov/recalls" rel="noopener">NHTSA&rsquo;s recall lookup</a>;
            the Otopair app cannot look up recalls for you.
          </li>
          <li>
            <strong>Brand-specific software.</strong> Module programming, key coding, some
            driver-assistance calibrations and software updates need the manufacturer&rsquo;s tools
            and access, which many independents do not have for every make.
          </li>
          <li>
            <strong>Very new models.</strong> In a car&rsquo;s first year or two, the dealer has seen
            the platform and its known issues; an independent may not have yet.
          </li>
          <li>
            <strong>Goodwill and service bulletins.</strong> A known fault just outside warranty is
            sometimes covered in part by the manufacturer, and only the dealer can ask.
          </li>
        </ul>
      </Section>

      <Section id="independent" title="When is an independent shop the better choice?">
        <p>
          When the car is out of warranty and the job is one shops do every day: oil and fluids,
          brakes, tires, batteries, filters, belts, suspension wear, exhaust, and diagnosing a
          check-engine light on an established model. That is most of what a car needs over its
          life. An independent shop also tends to win on three things drivers say they care about:
        </p>
        <ul>
          <li>
            <strong>Price transparency.</strong> An independent sets its own labor rate and can tell
            you what the job will cost before it starts, in a conversation with the person doing the
            work.
          </li>
          <li>
            <strong>A relationship.</strong> One shop that knows the car&rsquo;s history, remembers
            what it told you last time, and has a reason to keep you.
          </li>
          <li>
            <strong>Part choice.</strong> On an older car, a good equivalent part can be the sensible
            call, and an independent will usually offer the choice.
          </li>
        </ul>
        <p>
          Routine maintenance at an independent shop does not by itself void a manufacturer&rsquo;s
          warranty in the United States, provided the work follows the manufacturer&rsquo;s schedule
          and specifications and you keep the receipts. Your warranty booklet has the specifics. In
          New York, the annual state inspection can be done at any DMV-licensed inspection station,
          dealer or independent.
        </p>
      </Section>

      <Section id="check" title="What should I check in either case?">
        <p>
          The same five things, at a dealership or an independent. Most bad experiences with either
          trace back to one of them being skipped.
        </p>
        <ol>
          <li>
            <strong>A written total before the work starts</strong>, with parts, labor, tax and any
            fees, and a clear answer to what happens if the estimate changes.
          </li>
          <li>
            <strong>Who authorizes extra work, and how.</strong> Nothing should be added to the job
            without your say-so, and you should know how they will reach you for it.
          </li>
          <li>
            <strong>Which parts.</strong> Manufacturer, equivalent or used, and whether you get a
            choice.
          </li>
          <li>
            <strong>The warranty on parts and labor, in writing.</strong> Warranties differ from
            shop to shop and by part and job.
          </li>
          <li>
            <strong>An itemized receipt at the end</strong>, which is also what you will need for
            any warranty claim later.
          </li>
        </ol>
        <p>
          For a state inspection or emissions test, add one more: that the station holds the DMV
          inspection-station license. And weigh reviews from people whose jobs were actually
          completed there over star counts.
        </p>
      </Section>

      <Section id="otopair" title="How does Otopair fit in?">
        <p>
          Otopair is a marketplace for booking independent shops, and it is built around the five
          checks above so you do not have to run them yourself. Each shop on the network is reviewed
          and approved by Otopair&rsquo;s team. Before you confirm a booking you see the full total for
          your exact car, with parts, labor, tax and Otopair&rsquo;s service fee inside it, and that
          figure is locked. A $20 hold reserves the slot; nothing more is charged until the job is
          done.
        </p>
        <p>
          After inspecting the car the shop confirms its final price. Within what you approved, it
          is confirmed without another tap; above it, you get a request in the app with the breakdown
          and 24 hours to approve or decline, and declined work is never charged. The itemized
          receipt is kept in the app, you can open a dispute within 14 days of the final charge, and
          the reviews you read are from drivers whose bookings were completed.
        </p>
        <p>
          What Otopair is not for: warranty and recall work, which belongs at your dealer, and
          roadside help, which it does not provide. It does not publish price lists or averages;
          every total is built in the app for the car and the shop you pick. The network is live in
          Staten Island today, with the rest of the city on the{" "}
          <Link href="/coverage">coverage ladder</Link>. See{" "}
          <Link href="/help/what-locked-price-means">what &ldquo;locked price&rdquo; means</Link> and{" "}
          <Link href="/help/how-the-20-dollar-hold-works">how the $20 hold works</Link>.
        </p>
      </Section>

      <Section id="both" title="Can I use both?">
        <p>
          Yes, and most drivers with a newer car do: the dealer for warranty repairs, recalls and
          software, an independent for everything else. What matters is that the car&rsquo;s record
          stays in one place, so whoever works on it next knows what was done. Otopair keeps a
          per-VIN record of what its shops have physically confirmed, such as mileage, tires,
          fluids, brakes and inspection status, and you can add records from service done elsewhere.
          Keep the dealer&rsquo;s receipts too; a warranty claim is only as good as its paperwork.
        </p>
      </Section>

      <FaqSection items={FAQ} />
    </PageShell>
  );
}
