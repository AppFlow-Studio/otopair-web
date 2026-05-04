import { internalMutation } from "../_generated/server";

/**
 * Seeds the blocked_domains table with known bad sources.
 * Run via: npx convex run seeds/seedBlockedDomains:seedBlockedDomains
 */
export const seedBlockedDomains = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("blocked_domains").first();
    if (existing) {
      console.log("blocked_domains table already has data — skipping seed.");
      return;
    }

    const domains = [
      {
        domain: "kbb.com",
        reason: "Empty maintenance pages, misparses intervals (coolant flush → 10K = oil change interval)",
      },
      {
        domain: "justanswer.com",
        reason: "Paid Q&A, often wrong model year",
      },
      {
        domain: "carscounsel.com",
        reason: "Aggregated/AI-generated, unverified",
      },
      {
        domain: "firestonecompleteautocare.com",
        reason: "Sparse data, wrong spark plug intervals",
      },
      {
        domain: "yourmechanic.com",
        reason: "Generic estimates, not model-specific",
      },
      {
        domain: "chargerforums.com",
        reason: "Wrong make entirely (used BMW data for Dodge in R6)",
      },
    ];

    const now = Date.now();
    for (const d of domains) {
      await ctx.db.insert("blocked_domains", {
        domain: d.domain,
        reason: d.reason,
        blocked_by: "manual",
        blocked_at: now,
        created_at: now,
      });
    }

    console.log(`Seeded ${domains.length} blocked domains.`);
  },
});
