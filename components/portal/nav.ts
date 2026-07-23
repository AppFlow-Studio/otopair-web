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
  { id: "data", label: "Data", base: "/director/data" },
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
        { label: "Reviews", href: "/ops/reviews" },
      ],
    },
    {
      label: "Money",
      items: [
        { label: "Payments", href: "/ops/payments" },
        { label: "Transactions", href: "/ops/transactions" },
        { label: "Rewards", href: "/ops/rewards", phase: "P2" },
      ],
    },
    {
      label: "Engagement",
      items: [
        { label: "Oto AI", href: "/ops/oto-ai" },
        { label: "Follow-ups", href: "/ops/follow-ups" },
      ],
    },
    {
      label: "Insight",
      items: [
        { label: "Analytics", href: "/ops/analytics" },
        { label: "System Health", href: "/ops/system-health" },
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
        { label: "Onboarding Pipeline", href: "/shops/pipeline" },
      ],
    },
    { label: "People", items: [{ label: "Mechanics", href: "/shops/mechanics" }] },
    {
      label: "Supply",
      items: [
        { label: "Capacity & Scheduling", href: "/shops/capacity" },
        { label: "Offerings Matrix", href: "/shops/offerings" },
      ],
    },
    { label: "Money", items: [{ label: "Stripe Connect Health", href: "/shops/stripe-health" }] },
    {
      label: "Quality",
      items: [
        { label: "Network Reviews", href: "/shops/reviews" },
        { label: "Performance", href: "/shops/performance" },
      ],
    },
  ],
  data: [
    {
      items: [
        { label: "Command Center", href: "/director/data" },
        { label: "Insights", href: "/director/data/insights" },
      ],
    },
    {
      label: "Catalog",
      items: [
        { label: "Vehicle Catalog", href: "/director/data/catalog" },
        { label: "VIN Explorer", href: "/director/data/vins" },
        { label: "Parts", href: "/director/data/parts" },
        { label: "Tire Intelligence", href: "/director/data/tires" },
      ],
    },
    {
      label: "Pipeline",
      items: [
        { label: "Control Room", href: "/director/data/control-room", badgeKey: "data.vin_queue_pending" },
        { label: "Sources & Cache", href: "/director/data/sources" },
        { label: "Review Queue", href: "/director/data/review-queue", badgeKey: "slo.review_queue_depth" },
      ],
    },
    {
      label: "Enrichment",
      items: [{ label: "Enrichment Console", href: "/director/data/enrichment" }],
    },
    {
      label: "Pricing & Labor",
      items: [
        { label: "Labor Times", href: "/director/data/labor" },
        { label: "Parts Pricing", href: "/director/data/parts-pricing" },
        { label: "Pricing Engine", href: "/director/data/pricing-engine" },
      ],
    },
    {
      label: "Quality",
      items: [
        { label: "Verification", href: "/director/data/verification" },
        { label: "Vehicle ID", href: "/director/data/vehicle-id" },
        { label: "Coverage", href: "/director/data/coverage" },
        { label: "Provenance", href: "/director/data/provenance", badgeKey: "data.incidents_open" },
      ],
    },
    { label: "Catalog Ops", items: [{ label: "Service Catalog", href: "/director/data/service-catalog" }] },
    { label: "Economics", items: [{ label: "Costs & Credits", href: "/director/data/costs" }] },
  ],
};
