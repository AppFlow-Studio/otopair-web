/**
 * vehicleEnrichment/blockedDomains.ts
 *
 * Re-exports BLOCKED_DOMAINS from sourceRegistry.ts — the canonical location.
 * Domain blocking is enforced natively via the Anthropic web_search `blocked_domains`
 * parameter in batchClient.ts. Results from blocked domains never enter Claude's context.
 */
export { BLOCKED_DOMAINS } from "./sourceRegistry";
