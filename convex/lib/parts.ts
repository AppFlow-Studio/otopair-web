// Shared, dependency-free predicates + labels for part rows. Kept as pure
// functions (no db / scheduler / validator imports) so every mutation and query
// that touches parts can import them without an import cycle:
// booking_approvals, bookings, invoices, customJobs, payments_stripe.
//
// The bug these guard against: a manually-added part with a blank part_name was
// treated as valid — it passed the entry filters, got summed into the billed
// subtotal, and rendered as an empty "$0.01 · Qty 1" line because the display
// fallbacks only caught null/undefined (`?? "Part"`), never "".
//
// A CLIENT copy of isNamedPart / partDisplayName lives in lib/tire-part-lines.ts
// (the dialog can't import from convex/). Keep the two in sync — they're a few
// lines of pure logic, mirroring the existing client tidyOem vs server-tidy split.

export type PartLike = {
  part_name?: string | null;
  oem_number?: string | null;
  is_tire?: boolean | null;
  tire_size?: string | null;
  tire_brand?: string | null;
  tire_model?: string | null;
  not_used?: boolean | null;
  supplied_by?: string | null;
};

const TIRE_SENTINEL = /^TIRE-/i;

/** A mechanic-entered tire line — either the explicit flag or the legacy
 *  `TIRE-{size}` sentinel oem_number. Tires carry no OEM part number; their
 *  identity is size / brand / model, and their part_name is synthesized by
 *  tireLinesToPartPayloads (lib/tire-part-lines.ts) so it's never actually blank. */
export function isTireRow(p: PartLike): boolean {
  return (
    p.is_tire === true ||
    (typeof p.oem_number === "string" && TIRE_SENTINEL.test(p.oem_number))
  );
}

/** Does a tire row carry enough identity to render / bill? */
function tireHasIdentity(p: PartLike): boolean {
  return Boolean(
    (p.tire_size && p.tire_size.trim()) ||
      (p.tire_brand && p.tire_brand.trim()) ||
      (p.tire_model && p.tire_model.trim()) ||
      (p.oem_number && p.oem_number.replace(TIRE_SENTINEL, "").trim()),
  );
}

/** True when a part row is a real, nameable part. Non-tire rows require a
 *  non-empty trimmed part_name; tire rows require any tire identity. This is the
 *  single gate every write boundary and count uses so a blank-name priced row
 *  can never be billed or displayed. */
export function isNamedPart(p: PartLike): boolean {
  if (isTireRow(p)) return tireHasIdentity(p);
  return Boolean(p.part_name && p.part_name.trim().length > 0);
}

/** Display label for a part row. NEVER returns "" — a legacy blank-name row
 *  already stored in the db renders as its OEM number or a safe placeholder
 *  instead of an empty line. */
export function partDisplayName(p: PartLike): string {
  const name = (p.part_name ?? "").trim();
  if (name) return name;
  if (isTireRow(p)) {
    const size = (p.tire_size ?? (p.oem_number ?? "").replace(TIRE_SENTINEL, "")).trim();
    return size ? `Tires (${size})` : "Tires";
  }
  const oem = (p.oem_number ?? "").trim();
  return oem ? `Part ${oem}` : "Unnamed part";
}

/** The one predicate for both the billed subtotal and any "parts count". A row
 *  counts toward money + the count only when it's a real named part the shop is
 *  charging for — not used and not customer-supplied ($0) rows are excluded.
 *  Sharing this between the sum and the count is what stops "3 counted / 5
 *  billed" divergence. */
export function billablePart(p: PartLike): boolean {
  return isNamedPart(p) && p.not_used !== true && p.supplied_by !== "customer";
}
