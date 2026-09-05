import type { Metadata } from "next";
import PageShell, { Section } from "@/components/flagship/page-shell";
import { SITE_NAME, SUPPORT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Accessibility",
  description:
    "Otopair's accessibility statement: what the website and apps do today for keyboard, screen-reader and reduced-motion users, what is still being fixed, and how to report a barrier.",
  alternates: { canonical: "/accessibility" },
};

/**
 * /accessibility — audit Tier 4. An honest statement, not a compliance
 * badge: it lists what is actually implemented in this codebase (reduced
 * motion via useReducedMotionSafe + the prefers-reduced-motion block in
 * globals.css, labelled controls in the pill nav, visible focus rings on
 * the long-form pages) and names the known gaps. Update the gaps list as
 * they close; do not claim WCAG conformance until an audit says so.
 */
const UPDATED = "2026-09-04";

export default function AccessibilityPage() {
  return (
    <PageShell
      title="Usable by everyone who needs a mechanic"
      lede={`${SITE_NAME} is meant to work for people who use a keyboard, a screen reader, magnification, or who turn animation off. This page says what is true today, what is still being fixed, and how to tell us about a barrier.`}
      updated={UPDATED}
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Accessibility", href: "/accessibility" },
      ]}
    >
      <Section id="standard" title="What standard are we working to?">
        <p>
          WCAG 2.1 level AA is the target for the website and the driver app. We have not completed a
          third-party audit against it, and we do not claim conformance until one says so. What follows is
          what is built.
        </p>
      </Section>

      <Section id="today" title="What works today">
        <ul>
          <li>
            <strong>Reduced motion.</strong> The site checks your system&rsquo;s reduce-motion setting.
            When it is on, the scroll-driven stories, the breathing orb and the entrance animations become
            plain fades or stop.
          </li>
          <li>
            <strong>Keyboard.</strong> A &ldquo;Skip to content&rdquo; link is the first thing the Tab key
            reaches on every page. Navigation, forms and links follow in a sensible order, the menu
            button announces its open and closed state, and links on the long-form pages show a visible
            focus ring.
          </li>
          <li>
            <strong>Smooth scrolling that steps aside.</strong> The site&rsquo;s smooth-scroll effect
            turns itself off when your system asks for reduced motion, so the page scrolls natively.
          </li>
          <li>
            <strong>Structure.</strong> One heading per page level, question-shaped section headings, a
            table of contents on long pages, and landmarks for the navigation, main content and footer.
          </li>
          <li>
            <strong>Text, not pictures of text.</strong> Prices, steps and policies are real text that
            can be enlarged, selected and read aloud.
          </li>
          <li>
            <strong>Oto in text.</strong> Voice is optional in the app; everything Oto does works by typing.
          </li>
        </ul>
      </Section>

      <Section id="gaps" title="What we are still fixing">
        <ul>
          <li>Some decorative images in the product mock-ups on the home page have no description yet.</li>
          <li>
            The home page&rsquo;s illustrated product stories are visual by design; the same information
            is written out on the <a href="/how-it-works">how it works</a> page.
          </li>
          <li>Contrast on a few secondary captions is close to the AA threshold and is being retuned.</li>
          <li>
            The interactive coverage map is not fully operable by keyboard. The same shops are listed as
            plain links in the <a href="/shops">shop directory</a>.
          </li>
        </ul>
      </Section>

      <Section id="report" title="Found a barrier?">
        <p>
          Email <a href={`mailto:${SUPPORT_EMAIL}?subject=Accessibility`}>{SUPPORT_EMAIL}</a> with
          &ldquo;Accessibility&rdquo; in the subject, the page or screen, and what happened. A person reads
          every report, and fixes to the website ship on the same cadence as everything else.
        </p>
      </Section>
    </PageShell>
  );
}
