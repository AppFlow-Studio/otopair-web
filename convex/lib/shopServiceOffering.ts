// ============================================================================
// Shop service offering — one definition of "this shop offers this service"
// (bug #404).
//
// The only per-shop switch is `shop_services.is_offered`, written by the
// portal's Settings → Services save (shops.updateShopOfferedServices), shop
// onboarding (shops.saveOnboardingLaborAndServices) and the director's
// offerings matrix (shopsOfferings.toggleOffering). Before #404 no customer
// booking mutation read it, so a customer whose Review & Pay screen was open
// when the shop switched a service off booked it anyway — the booking
// transaction never read the row the toggle wrote, so Convex had nothing to
// serialize the two against.
//
// Everything that decides "offered" goes through `offeringState` so the guard
// (createBatch, create, quote accepts), the listing (shop_services.list) and
// the live checkout query (shop_services.validateCheckoutServices) can't drift:
//
//   offered = the service exists
//             AND services.is_bookable !== false        (not retired)
//             AND ANY shop_services row for (shop, service) has is_offered true
//
// ANY-true (not every-true) on purpose: the portal checkbox
// (shops.getMyOnboardingData) and the mobile shop list both treat one true row
// as ticked, so the guard must agree or a shop could see a service ticked that
// its customers can't book. A missing row means NOT offered (fail closed),
// except where the caller says the shop already committed to the work
// (`allowMissingRow` — the tire/rotor quote accepts).
//
// OCC: the guard reads the `by_shop_and_service` index range and the services
// doc inside the calling mutation, so a concurrent toggle (which patches or
// inserts in that range) conflicts with the booking and one of them retries
// against the other's result.
// ============================================================================
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import { formatServiceDisplayName } from "../../utils/serviceDisplayName";
import { bookingError } from "./bookingErrors";

type Reader = { db: DatabaseReader };
type Writer = { db: DatabaseWriter };

export type ServiceOfferingState =
  | "offered"
  // No shop_services row for the pair — the shop never ticked or unticked it.
  | "no_row"
  // Rows exist and none is true — the shop (or the director) switched it off.
  | "off"
  // Catalog-level retirement (services.is_bookable === false).
  | "retired"
  // The services doc is gone.
  | "missing";

export type ServiceBlockedReason = "not_offered" | "retired" | "missing";

export type BlockedService = {
  serviceId: string;
  name: string;
  reason: ServiceBlockedReason;
};

/** Pure predicate over what the guard read. See the file header. */
export function offeringState(
  service: Pick<Doc<"services">, "is_bookable"> | null,
  rows: ReadonlyArray<Pick<Doc<"shop_services">, "is_offered">>,
): ServiceOfferingState {
  if (!service) return "missing";
  if (service.is_bookable === false) return "retired";
  if (rows.some((row) => row.is_offered === true)) return "offered";
  return rows.length === 0 ? "no_row" : "off";
}

export function isOfferedState(
  state: ServiceOfferingState,
  opts: { allowMissingRow?: boolean } = {},
): boolean {
  return state === "offered" || (state === "no_row" && opts.allowMissingRow === true);
}

export function blockedReasonFor(state: ServiceOfferingState): ServiceBlockedReason {
  if (state === "missing") return "missing";
  if (state === "retired") return "retired";
  return "not_offered";
}

async function readOfferingRows(
  ctx: Reader,
  shopId: Id<"shops">,
  serviceId: Id<"services">,
): Promise<Doc<"shop_services">[]> {
  // collect(), not first(): duplicate (shop, service) rows exist in the wild
  // (see toggleOffering's old .first() patch) and ANY-true must see all of
  // them. The index range read is also what puts the key in the OCC read set.
  return await ctx.db
    .query("shop_services")
    .withIndex("by_shop_and_service", (q) =>
      q.eq("shop_id", shopId).eq("service_id", serviceId),
    )
    .collect();
}

export async function readShopServiceOffering(
  ctx: Reader,
  shopId: Id<"shops">,
  serviceId: Id<"services">,
): Promise<{
  service: Doc<"services"> | null;
  rows: Doc<"shop_services">[];
  state: ServiceOfferingState;
}> {
  const [service, rows] = await Promise.all([
    ctx.db.get(serviceId),
    readOfferingRows(ctx, shopId, serviceId),
  ]);
  return { service, rows, state: offeringState(service, rows) };
}

function normalizeVin(vin: string | null | undefined): string {
  return String(vin ?? "").trim().toUpperCase();
}

/**
 * Services the shop itself recommended for this car. A booking that starts
 * from the shop's own recommendation (job_recommendations, via
 * `source_recommendation_id`) is the shop asking for the work, so it isn't
 * refused just because the shop never ticked that service in Settings. Scoped
 * to the recommending shop AND the recommended car so a stray recommendation
 * id can't unlock a switched-off service anywhere else.
 */
export async function recommendationExemptServiceIds(
  ctx: Reader,
  args: {
    shopId: Id<"shops">;
    sourceRecommendationId?: Id<"job_recommendations"> | null;
    vin?: string | null;
  },
): Promise<Set<string>> {
  const exempt = new Set<string>();
  if (!args.sourceRecommendationId) return exempt;
  const rec = await ctx.db.get(args.sourceRecommendationId);
  if (!rec || !rec.recommended_service_id) return exempt;
  if (String(rec.shop_id) !== String(args.shopId)) return exempt;
  if (!args.vin || normalizeVin(rec.vehicle_vin) !== normalizeVin(args.vin)) return exempt;
  exempt.add(String(rec.recommended_service_id));
  return exempt;
}

export type OfferingCheckOptions = {
  /** Treat "no row" as offered (the shop already committed via a quote). */
  allowMissingRow?: boolean;
  /** Booking started from this recommendation — see recommendationExemptServiceIds. */
  sourceRecommendationId?: Id<"job_recommendations"> | null;
  /** The booking's VIN; required for the recommendation exemption. */
  vin?: string | null;
};

/**
 * The services in `serviceIds` the shop does not offer right now, deduped and
 * in the caller's order. Empty = every service is bookable at this shop.
 */
export async function findServicesNotOffered(
  ctx: Reader,
  shopId: Id<"shops">,
  serviceIds: ReadonlyArray<Id<"services">>,
  opts: OfferingCheckOptions = {},
): Promise<BlockedService[]> {
  const exempt = await recommendationExemptServiceIds(ctx, {
    shopId,
    sourceRecommendationId: opts.sourceRecommendationId,
    vin: opts.vin,
  });
  const seen = new Set<string>();
  const blocked: BlockedService[] = [];
  for (const serviceId of serviceIds) {
    const key = String(serviceId);
    if (seen.has(key)) continue;
    seen.add(key);
    if (exempt.has(key)) continue;
    const { service, state } = await readShopServiceOffering(ctx, shopId, serviceId);
    if (isOfferedState(state, opts)) continue;
    blocked.push({
      serviceId: key,
      name: formatServiceDisplayName(service?.name ?? ""),
      reason: blockedReasonFor(state),
    });
  }
  return blocked;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Customer-facing copy for SERVICE_NOT_OFFERED. `quote_accept` is the tire /
 * rotor quote accept, where "remove it from your booking" doesn't apply.
 */
export function serviceNotOfferedMessage(
  shopName: string | null | undefined,
  serviceNames: readonly string[],
  copy: "checkout" | "quote_accept" = "checkout",
): string {
  const shop = shopName?.trim() || "This shop";
  const names = serviceNames.map((name) => name.trim()).filter(Boolean);
  const what = names.length > 0 ? joinNames(names) : "one of the services you picked";
  if (copy === "quote_accept") {
    return `${shop} no longer offers ${what}, so this quote can't be booked. Choose another shop's quote.`;
  }
  const pronoun = names.length > 1 ? "them" : "it";
  return `${shop} no longer offers ${what}. Remove ${pronoun} from your booking or pick another shop.`;
}

/**
 * Commit-time guard. Throws SERVICE_NOT_OFFERED `{shopId, shopName,
 * serviceIds, serviceNames, services}` when any service isn't offered. Call
 * it inside the booking mutation, before its first write.
 */
export async function assertShopOffersServices(
  ctx: Reader,
  shopId: Id<"shops">,
  serviceIds: ReadonlyArray<Id<"services">>,
  opts: OfferingCheckOptions & { copy?: "checkout" | "quote_accept" } = {},
): Promise<void> {
  const blocked = await findServicesNotOffered(ctx, shopId, serviceIds, opts);
  if (blocked.length === 0) return;
  const shop = await ctx.db.get(shopId);
  const serviceNames = blocked.map((b) => b.name);
  throw bookingError(
    "SERVICE_NOT_OFFERED",
    serviceNotOfferedMessage(shop?.name, serviceNames, opts.copy),
    {
      shopId: String(shopId),
      shopName: shop?.name ?? undefined,
      serviceIds: blocked.map((b) => b.serviceId),
      serviceNames,
      services: blocked,
    },
  );
}

// ─── Tire / rotor quotes ─────────────────────────────────────────────────────

/**
 * The catalog service a tire / rotor quote books. Same slug fallbacks as
 * bookings.acceptTireQuote / acceptRotorQuote (hyphenated first, legacy
 * underscore seed second).
 */
export async function findQuoteService(
  ctx: Reader,
  kind: "tire" | "rotor",
): Promise<Doc<"services"> | null> {
  const slugs =
    kind === "tire"
      ? ["tire-replacement", "tire_replacement"]
      : ["rotor-replacement", "rotor_replacement"];
  for (const slug of slugs) {
    const service = await ctx.db
      .query("services")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (service) return service;
  }
  return null;
}

/**
 * Shop-side quote submit guard: refuse only when the shop EXPLICITLY switched
 * the service off. A shop with no row for it can still quote — plenty of
 * shops quote tires without ever having ticked Tire Replacement, and the
 * accept path registers the row for them.
 */
export async function assertShopMayQuoteService(
  ctx: Reader,
  shopId: Id<"shops">,
  kind: "tire" | "rotor",
): Promise<void> {
  const service = await findQuoteService(ctx, kind);
  if (!service) return;
  const { state } = await readShopServiceOffering(ctx, shopId, service._id);
  if (state !== "off") return;
  const name = formatServiceDisplayName(service.name) || "this service";
  throw bookingError(
    "SERVICE_NOT_OFFERED",
    `Turn on ${name} in Settings → Services to send quotes.`,
    {
      shopId: String(shopId),
      serviceIds: [String(service._id)],
      serviceNames: [name],
    },
  );
}

/**
 * Register the (shop, service) row a quote accept depends on, ONLY when the
 * shop has none. Never flips an existing row: a customer's accept must not
 * switch a service back on for everyone after the shop turned it off (#404).
 */
export async function registerQuotedServiceIfMissing(
  ctx: Writer,
  shopId: Id<"shops">,
  serviceId: Id<"services">,
): Promise<void> {
  const rows = await readOfferingRows(ctx, shopId, serviceId);
  if (rows.length > 0) return;
  await ctx.db.insert("shop_services", {
    shop_id: shopId,
    service_id: serviceId,
    is_offered: true,
  });
}

// ─── Writers ─────────────────────────────────────────────────────────────────

/**
 * Set one (shop, service) offering. Patches EVERY row for the key (duplicates
 * exist; patching only `.first()` let them disagree) and inserts one when
 * there is none. Returns the ANY-true state before the write so callers can
 * report what actually changed.
 */
export async function setShopServiceOffered(
  ctx: Writer,
  shopId: Id<"shops">,
  serviceId: Id<"services">,
  offered: boolean,
): Promise<{ wasOffered: boolean; changed: boolean }> {
  const rows = await readOfferingRows(ctx, shopId, serviceId);
  const wasOffered = rows.some((row) => row.is_offered === true);
  if (rows.length === 0) {
    await ctx.db.insert("shop_services", {
      shop_id: shopId,
      service_id: serviceId,
      is_offered: offered,
    });
    return { wasOffered, changed: offered };
  }
  for (const row of rows) {
    if (row.is_offered !== offered) {
      await ctx.db.patch(row._id, { is_offered: offered });
    }
  }
  return { wasOffered, changed: wasOffered !== offered };
}

/**
 * Full-set replace used by the owner's Settings save and onboarding: every
 * service in `serviceIds` ends up offered, every other service the shop has a
 * row for ends up off. Services the shop never had a row for and didn't pick
 * stay row-less (same as before). Returns the services whose offered state
 * flipped, for the audit row.
 */
export async function replaceShopOfferedServices(
  ctx: Writer,
  shopId: Id<"shops">,
  serviceIds: ReadonlyArray<Id<"services">>,
): Promise<{ turnedOn: Id<"services">[]; turnedOff: Id<"services">[] }> {
  const existing = await ctx.db
    .query("shop_services")
    .withIndex("by_shop_id", (q) => q.eq("shop_id", shopId))
    .collect();
  const selected = new Set(serviceIds.map((id) => String(id)));
  const keys = new Map<string, Id<"services">>();
  for (const row of existing) keys.set(String(row.service_id), row.service_id);
  for (const id of serviceIds) keys.set(String(id), id);

  const turnedOn: Id<"services">[] = [];
  const turnedOff: Id<"services">[] = [];
  for (const [key, serviceId] of keys) {
    const offered = selected.has(key);
    const { wasOffered, changed } = await setShopServiceOffered(ctx, shopId, serviceId, offered);
    if (!changed) continue;
    if (offered && !wasOffered) turnedOn.push(serviceId);
    if (!offered && wasOffered) turnedOff.push(serviceId);
  }
  return { turnedOn, turnedOff };
}

/**
 * audit_log row for an owner-side offering change, in the same shape the
 * owner's pricing saves already write (entity_type "shops", actor = email),
 * so "did the Services save land, and when?" is answerable. Skipped when
 * nothing flipped.
 */
export async function logShopOfferingChange(
  ctx: Writer,
  args: {
    shopId: Id<"shops">;
    actor: string;
    source: "settings" | "onboarding";
    turnedOn: ReadonlyArray<Id<"services">>;
    turnedOff: ReadonlyArray<Id<"services">>;
  },
): Promise<void> {
  if (args.turnedOn.length === 0 && args.turnedOff.length === 0) return;
  const describe = async (ids: ReadonlyArray<Id<"services">>) =>
    await Promise.all(
      ids.map(async (id) => {
        const service = await ctx.db.get(id);
        return { service_id: String(id), slug: service?.slug ?? null, name: service?.name ?? null };
      }),
    );
  await ctx.db.insert("audit_log", {
    entity_type: "shops",
    entity_id: String(args.shopId),
    action: "shop_services_offered_changed",
    actor: args.actor,
    detail: JSON.stringify({
      source: args.source,
      turned_on: await describe(args.turnedOn),
      turned_off: await describe(args.turnedOff),
    }),
    created_at: Date.now(),
  });
}
