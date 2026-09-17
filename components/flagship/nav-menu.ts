import type { PillLink } from "./pill-nav";

/**
 * The pill nav's category menus — one source for the home page and for
 * PageShell's secondary pages, so the two can't drift.
 *
 * Written after the reachability audit (2026-09-08): of the 33 routes in
 * `PUBLIC_ROUTES`, only 9 were reachable from the nav or footer, and
 * /queens, /bronx and /manhattan had no inbound link anywhere in the repo.
 * Every registered public route now appears either here or in FooterCta
 * (which carries / , /privacy and /terms).
 *
 * Shape follows the Duna pattern the design review picked: each trigger is
 * still a real link (clicking it goes to the overview), and hovering it
 * opens a two-column panel of the pages underneath. Exactly two groups per
 * category on purpose — it keeps the panel a constant width, so moving
 * between triggers changes only its height and never makes the panel
 * breathe sideways.
 *
 * Hints are one short line each. They never print a price, a fee or a hold
 * amount — those live only on the pages that own them (truthfulness pass,
 * 2026-08-31).
 */

const HOW_IT_WORKS_GROUPS = [
  {
    label: "For drivers",
    items: [
      { label: "How it works", href: "/how-it-works", hint: "Book, track and pay in one place" },
      { label: "Meet Oto", href: "/oto", hint: "The assistant that reads your car" },
      { label: "Vehicle health score", href: "/vehicle-health-score", hint: "What the number means" },
      { label: "Pricing", href: "/pricing", hint: "How pricing works" },
    ],
  },
  {
    label: "Book a job",
    items: [
      { label: "Browse services", href: "/services", hint: "Every routine job we book" },
      { label: "Find a shop", href: "/shops", hint: "Verified shops near you" },
      { label: "Get the app", href: "/download", hint: "iPhone and Android" },
    ],
  },
];

const FOR_SHOPS_GROUPS = [
  {
    label: "Join Otopair",
    items: [
      { label: "Why Otopair", href: "/for-shops", hint: "What the platform does for your bays" },
      { label: "Partner with us", href: "/partner-with-us", hint: "How the partnership works" },
      { label: "Apply", href: "/apply", hint: "Start your application" },
    ],
  },
  {
    label: "Our standards",
    items: [
      { label: "How shops are verified", href: "/how-shops-are-verified", hint: "The checks every shop passes" },
      { label: "Trust and safety", href: "/trust-and-safety", hint: "How we handle disputes" },
      { label: "Warranty", href: "/warranty", hint: "What is covered after a repair" },
      { label: "Cancellation policy", href: "/cancellation-policy", hint: "Changing or calling off a booking" },
    ],
  },
];

const COVERAGE_GROUPS = [
  {
    label: "Where we operate",
    items: [
      { label: "Coverage map", href: "/coverage", hint: "Every neighbourhood we serve" },
      { label: "Find a shop", href: "/shops", hint: "Search by service and area" },
    ],
  },
  {
    label: "Boroughs",
    items: [
      { label: "Staten Island", href: "/staten-island" },
      { label: "Brooklyn", href: "/brooklyn" },
      { label: "Queens", href: "/queens" },
      { label: "Bronx", href: "/bronx" },
      { label: "Manhattan", href: "/manhattan" },
    ],
  },
];

const COMPANY_GROUPS = [
  {
    label: "Company",
    items: [
      { label: "About", href: "/about", hint: "Why we built Otopair" },
      { label: "Careers", href: "/careers", hint: "We are hiring" },
      { label: "Press kit", href: "/press", hint: "Logos, facts and contacts" },
      { label: "Contact", href: "/contact", hint: "Talk to a human" },
    ],
  },
  {
    label: "Resources",
    items: [
      { label: "Help centre", href: "/help", hint: "Answers to common questions" },
      { label: "Guides", href: "/guides", hint: "Plain-English car advice" },
      { label: "Car data", href: "/car-data", hint: "The data behind our estimates" },
      { label: "Security", href: "/security", hint: "How we protect your data" },
      { label: "Accessibility", href: "/accessibility", hint: "Our commitment and status" },
    ],
  },
];

/**
 * The four triggers. `home` keeps the landing page's in-page anchors on the
 * top-level labels — that behaviour is settled design — so on the home page
 * clicking "Coverage" still scrolls to the coverage section while hovering
 * it opens the same panel the secondary pages get.
 */
export function navMenu(home = false): PillLink[] {
  return [
    {
      label: "How it works",
      href: home ? "#how-it-works" : "/how-it-works",
      groups: HOW_IT_WORKS_GROUPS,
    },
    {
      label: "For shops",
      href: home ? "#for-shops" : "/for-shops",
      groups: FOR_SHOPS_GROUPS,
    },
    {
      label: "Coverage",
      href: home ? "#coverage" : "/coverage",
      groups: COVERAGE_GROUPS,
    },
    {
      label: "Company",
      href: "/about",
      groups: COMPANY_GROUPS,
    },
  ];
}
