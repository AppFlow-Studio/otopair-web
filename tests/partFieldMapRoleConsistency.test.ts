/**
 * PART_FIELD_MAP ↔ SERVICE_PARTS_REFERENCE consistency — guards the
 * ad-hoc-core trap: a fitment whose subcategory has no reference role forms
 * an ad-hoc group the resolver treats as CORE with includeInLockedQuote:
 * true (serviceParts.ts role grouping). So every non-core part field the
 * pipeline discovers MUST have a declared PartRoleSpec, or it would silently
 * auto-bill on every quote for its service.
 */
import { describe, expect, it } from "vitest";
import { PART_FIELD_MAP } from "../convex/vehicleEnrichment/v3pipeline";
import { roleForSubcategory } from "../convex/lib/servicePartsReference";

describe("PART_FIELD_MAP role consistency", () => {
  const entries = Object.entries(PART_FIELD_MAP).filter(
    ([, meta]) => meta.serviceSlug != null,
  );

  it("every as_needed / kit part field has a declared reference role", () => {
    for (const [fieldKey, meta] of entries) {
      if (meta.serviceRole === "core") continue;
      const role = roleForSubcategory(
        meta.serviceSlug!,
        meta.subcategory,
        meta.category,
      );
      expect(
        role,
        `${fieldKey} (${meta.subcategory} on ${meta.serviceSlug}) has no reference role — it would form an ad-hoc CORE group and auto-bill`,
      ).not.toBeNull();
    }
  });

  it("declared roles agree on serviceRole (no as_needed field mapped to a core role)", () => {
    for (const [fieldKey, meta] of entries) {
      const role = roleForSubcategory(
        meta.serviceSlug!,
        meta.subcategory,
        meta.category,
      );
      if (!role) continue; // covered above for non-core; core ad-hoc is legal
      if (meta.serviceRole === "as_needed") {
        expect(
          role.serviceRole,
          `${fieldKey}: PART_FIELD_MAP says as_needed but the reference role "${role.roleKey}" is ${role.serviceRole}`,
        ).toBe("as_needed");
      }
    }
  });
});
