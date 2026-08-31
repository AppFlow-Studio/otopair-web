/**
 * Idempotent setup for the OtoIndex Car Data API billing catalog.
 * Spec: convex/CARDATA_BILLING_SPEC.md.
 *
 * Creates (or reuses, keyed on price lookup_key + product name) the Stripe
 * meter, tier products/prices, and the metered enrich-overage price — all
 * namespaced metadata.app="otofacts". Safe to run repeatedly. Run it once
 * against TEST, then again against LIVE (just change the key).
 *
 * Run from otopair-web/:
 *   set -a; source .env.local; set +a        # loads STRIPE_SECRET_KEY
 *   npx tsx scripts/setup-stripe-billing.ts
 * or:
 *   STRIPE_SECRET_KEY=sk_test_... npx tsx scripts/setup-stripe-billing.ts
 */
import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("✗ STRIPE_SECRET_KEY not set. Prefix the command or source .env.local.");
  process.exit(1);
}
const stripe = new Stripe(key, { apiVersion: Stripe.API_VERSION });
const MODE = key.startsWith("sk_live_") ? "LIVE" : "TEST";

// Keep in sync with convex/dataApiBilling.ts (PLAN_FALLBACK, ENRICH_OVERAGE_UNIT_CENTS)
// and the OtoIndex app/pricing/plans.ts module.
const SCOPES = "maintenance:read,labor:read,media:read,service_history:read,enrich:write";
const OVERAGE_UNIT_CENTS = 25;

const TIERS = [
  {
    lookupKey: "otofacts_pro_monthly",
    productName: "OtoIndex API — Pro",
    unitAmount: 4900,
    metadata: { plan: "pro", scopes: SCOPES, rate_limit_per_min: "300", monthly_read_quota: "250000", enrich_monthly_grant: "100" },
  },
  {
    lookupKey: "otofacts_scale_monthly",
    productName: "OtoIndex API — Scale",
    unitAmount: 24900,
    metadata: { plan: "scale", scopes: SCOPES, rate_limit_per_min: "1000", monthly_read_quota: "2000000", enrich_monthly_grant: "1000" },
  },
];

async function findProductByName(name: string): Promise<Stripe.Product | null> {
  for await (const p of stripe.products.list({ limit: 100, active: true })) {
    if (p.metadata?.app === "otofacts" && p.name === name) return p;
  }
  return null;
}

async function ensureProduct(name: string): Promise<Stripe.Product> {
  const existing = await findProductByName(name);
  if (existing) {
    console.log(`  · product reused   ${existing.id}  (${name})`);
    return existing;
  }
  const p = await stripe.products.create({ name, metadata: { app: "otofacts" } });
  console.log(`  ✓ product created  ${p.id}  (${name})`);
  return p;
}

async function findPriceByLookupKey(lk: string): Promise<Stripe.Price | null> {
  const res = await stripe.prices.list({ lookup_keys: [lk], active: true, limit: 1 });
  return res.data[0] ?? null;
}

async function ensureMeter(): Promise<Stripe.Billing.Meter> {
  for await (const m of stripe.billing.meters.list({ limit: 100 })) {
    if (m.event_name === "otofacts.enrich" && m.status === "active") {
      console.log(`  · meter reused     ${m.id}  (otofacts.enrich)`);
      return m;
    }
  }
  const m = await stripe.billing.meters.create({
    display_name: "OtoIndex enrich runs",
    event_name: "otofacts.enrich",
    default_aggregation: { formula: "sum" },
    value_settings: { event_payload_key: "value" },
    customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
  });
  console.log(`  ✓ meter created    ${m.id}  (otofacts.enrich)`);
  return m;
}

async function main() {
  console.log(`\nOtoIndex billing setup — Stripe ${MODE} mode\n`);

  // Tier products + prices.
  for (const t of TIERS) {
    const existing = await findPriceByLookupKey(t.lookupKey);
    if (existing) {
      console.log(`  · price reused     ${existing.id}  (${t.lookupKey})`);
      continue;
    }
    const product = await ensureProduct(t.productName);
    const price = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: t.unitAmount,
      recurring: { interval: "month" },
      lookup_key: t.lookupKey,
      transfer_lookup_key: true,
      metadata: { app: "otofacts", ...t.metadata },
    });
    console.log(`  ✓ price created    ${price.id}  (${t.lookupKey})`);
  }

  // Meter + metered overage price.
  const meter = await ensureMeter();
  const overageLk = "otofacts_enrich_overage";
  const existingOverage = await findPriceByLookupKey(overageLk);
  if (existingOverage) {
    console.log(`  · price reused     ${existingOverage.id}  (${overageLk})`);
  } else {
    const product = await ensureProduct("OtoIndex Enrich (overage)");
    const price = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: OVERAGE_UNIT_CENTS,
      recurring: { interval: "month", usage_type: "metered", meter: meter.id },
      billing_scheme: "per_unit",
      lookup_key: overageLk,
      transfer_lookup_key: true,
      metadata: { app: "otofacts" },
    });
    console.log(`  ✓ price created    ${price.id}  (${overageLk})`);
  }

  console.log(`\n✓ Done (${MODE}). Next: subscribe the webhook to subscription events`);
  console.log(`  and enable the Customer Portal (Steps 3–4 of the runbook).\n`);
}

main().catch((e) => {
  console.error("\n✗ Setup failed:", e?.message ?? e);
  process.exit(1);
});
