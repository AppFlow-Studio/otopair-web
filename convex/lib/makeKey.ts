/**
 * lib/makeKey.ts — THE single make-identity normalization (Aug 2026).
 *
 * The makes table accumulated case-variant duplicate rows of the same
 * manufacturer ("Mercedes-Benz" vs "MERCEDES-BENZ") because every creation
 * path did its own lookup: upsertMake matched exact name then slug, the demo
 * seeds inserted blind with no slug at all, and VIN decoders hand back
 * ALL-CAPS names. Once two rows exist, parts get stamped under either one and
 * the strict id-equality I1 read guard rejects correct same-make parts.
 *
 * Every makes lookup or create MUST come through here:
 *   - makeKeyOf     — the identity key (lowercase, hyphens/spaces stripped).
 *                     Same transform contentSanitization's OEM pattern table,
 *                     the corporate-family map and genuineFluids use.
 *   - findMakeByName — total lookup: by_name, then by_make_key, then a full
 *                     scan keyed on makeKeyOf (makes is a small reference
 *                     table; the scan covers legacy rows with no make_key).
 *   - getOrCreateMake — the only sanctioned insert path. Normalizes before
 *                     creating and self-heals make_key/slug on found rows.
 *
 * The one-time dedupe of already-duplicated rows lives in makesMerge.ts.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";

/** Case/hyphen/space-insensitive make identity key:
 *  "Mercedes-Benz" → "mercedesbenz", "LAND ROVER" → "landrover". */
export function makeKeyOf(name: string): string {
  return name.toLowerCase().replace(/[-\s]/g, "");
}

/** Display slug convention used by the seeders ("Land Rover" → "land-rover").
 *  NOT an identity key — hyphen placement varies by source; use makeKeyOf. */
export function makeSlugOf(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

/** Fields a caller may supply when a brand-new make row has to be created. */
export type MakeSeedFields = Partial<
  Omit<Doc<"makes">, "_id" | "_creationTime" | "name" | "make_key">
>;

/**
 * Total make lookup by display name. Never returns a different manufacturer:
 * every step matches on exact name or on makeKeyOf identity.
 */
export async function findMakeByName(
  db: DatabaseReader,
  name: string,
): Promise<Doc<"makes"> | null> {
  const exact = await db
    .query("makes")
    .withIndex("by_name", (q) => q.eq("name", name))
    .first();
  if (exact) return exact;

  const key = makeKeyOf(name);
  const byKey = await db
    .query("makes")
    .withIndex("by_make_key", (q) => q.eq("make_key", key))
    .first();
  if (byKey) return byKey;

  // Legacy rows predating make_key, and case variants the by_name index
  // cannot see ("MERCEDES-BENZ" vs "Mercedes-Benz"). makes is a small
  // reference table — the scan is cheap and total.
  const all = await db.query("makes").collect();
  return all.find((m) => makeKeyOf(m.name) === key) ?? null;
}

/**
 * The only sanctioned way to create a makes row. Looks up by normalized
 * identity first; creates with make_key + slug stamped so future lookups hit
 * the index. Self-heals make_key/slug onto found legacy rows.
 */
export async function getOrCreateMake(
  db: DatabaseWriter,
  name: string,
  extra?: MakeSeedFields,
): Promise<Id<"makes">> {
  const found = await findMakeByName(db, name);
  if (found) {
    const heal: Record<string, unknown> = {};
    if (found.make_key !== makeKeyOf(found.name)) {
      heal.make_key = makeKeyOf(found.name);
    }
    if (!found.slug) heal.slug = makeSlugOf(found.name);
    if (Object.keys(heal).length > 0) await db.patch(found._id, heal);
    return found._id;
  }
  return await db.insert("makes", {
    slug: makeSlugOf(name),
    ...extra,
    name,
    make_key: makeKeyOf(name),
  });
}
