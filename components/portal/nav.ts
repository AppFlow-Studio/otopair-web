// Sidebar nav trees for the three portals — tab names, groups, and order
// come from the specs' "exact sidebar" sections (Ops §3A, Shops §3A, Data
// §4A). Items whose pages ship after P0 are marked `phase` and render as a
// disabled row with a phase chip, so the IA is visible from day one without
// dead links.

export type NavItem = {
  label: string;
  href: string;
  /** portal_stats key (or "r1:<key>" client-computed) driving the badge. */
  badgeKey?: string;
  phase?: "P1" | "P2";
};

export type NavGroup = { label?: string; items: NavItem[] };

export type PortalId = "ops" | "shops" | "data";

export const PORTALS: { id: PortalId; label: string; base: string }[] = [
  { id: "ops", label: "Ops", base: "/ops" },
  { id: "shops", label: "Shops", base: "/shops" },
  { id: "data", label: "Data", base: "/data" },
];

export const NAV: Record<PortalId, NavGroup[]> = {
  ops: [
    { items: [{ label: "Overview", href: "/ops" }] },
    {
      label: "People",
      items: [
        { label: "Users", href: "/ops/users" },
        { label: "Deletion Queue", href: "/ops/deletion-queue", badgeKey: "ops.pending_deletions" },
      ],
    },
    {
      label: "Marketplace",
      items: [
        { label: "Bookings", href: "/ops/bookings" },
        { label: "Reviews", href: "/ops/reviews", phase: "P1" },
      ],
    },
    {
      label: "Money",
      items: [
        { label: "Payments", href: "/ops/payments" },
        { label: "Transactions", href: "/ops/transactions", phase: "P1" },
        { label: "Rewards", href: "/ops/rewards", phase: "P2" },
      ],
    },
    {
      label: "Engagement",
      items: [
        { label: "Oto AI", href: "/ops/oto-ai", phase: "P1" },
        { label: "Follow-ups", href: "/ops/follow-ups", phase: "P1" },
      ],
    },
    {
      label: "Insight",
      items: [
        { label: "Analytics", href: "/ops/analytics", phase: "P2" },
        { label: "System Health", href: "/ops/system-health", phase: "P2" },
      ],
    },
    { label: "Governance", items: [{ label: "Audit Log", href: "/ops/audit" }] },
  ],
  shops: [
    { items: [{ label: "Network Overview", href: "/shops" }] },
    {
      label: "Partners",
      items: [
        { label: "Directory", href: "/shops/all" },
        { label: "Onboarding Pipeline", href: "/shops/pipeline", phase: "P1" },
      ],
    },
    { label: "People", items: [{ label: "Mechanics", href: "/shops/mechanics", phase: "P1" }] },
    {
      label: "Supply",
      items: [
        { label: "Capacity & Scheduling", href: "/shops/capacity", phase: "P1" },
        { label: "Offerings Matrix", href: "/shops/offerings", phase: "P1" },
      ],
    },
    { label: "Money", items: [{ label: "Stripe Connect Health", href: "/shops/stripe-health" }] },
    {
      label: "Quality",
      items: [
        { label: "Network Reviews", href: "/shops/reviews", phase: "P2" },
        { label: "Performance", href: "/shops/performance", phase: "P2" },
      ],
    },
  ],
  data: [
    { items: [{ label: "Data Health", href: "/data" }] },
    {
      label: "Catalog",
      items: [
        { label: "Vehicle Catalog", href: "/data/catalog" },
        { label: "VIN Explorer", href: "/data/vins" },
        { label: "Parts", href: "/data/parts" },
        { label: "Tire Intelligence", href: "/data/tires" },
      ],
    },
    {
      label: "Pipeline",
      items: [
        { label: "Control Room", href: "/data/control-room", badgeKey: "data.vin_queue_pending" },
        { label: "Sources & Cache", href: "/data/sources" },
        { label: "Review Queue", href: "/data/review-queue", badgeKey: "slo.review_queue_depth" },
      ],
    },
    {
      label: "Pricing & Labor",
      items: [
        { label: "Labor Times", href: "/data/labor" },
        { label: "Parts Pricing", href: "/data/parts-pricing" },
        { label: "Pricing Engine", href: "/data/pricing-engine" },
      ],
    },
    {
      label: "Quality",
      items: [
        { label: "Verification", href: "/data/verification" },
        { label: "Vehicle ID", href: "/data/vehicle-id" },
        { label: "Coverage", href: "/data/coverage" },
        { label: "Provenance", href: "/data/provenance", badgeKey: "data.incidents_open" },
      ],
    },
    { label: "Catalog Ops", items: [{ label: "Service Catalog", href: "/data/service-catalog" }] },
    { label: "Economics", items: [{ label: "Costs & Credits", href: "/data/costs" }] },
    { label: "Product", items: [{ label: "API Sandbox", href: "/data/api-sandbox" }] },
  ],
};
