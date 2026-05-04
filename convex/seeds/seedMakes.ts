import { internalMutation } from "../_generated/server";

const FALLBACK_PATTERN = "^[A-Za-z0-9][A-Za-z0-9\\s\\-\\.]{2,22}[A-Za-z0-9]$";

const MAKES = [
  { name: "BMW", oem_part_pattern: "^\\d{11}$", country: "Germany" },
  { name: "Toyota", oem_part_pattern: "^\\d{5}-[A-Z0-9]{5}$", country: "Japan" },
  { name: "Honda", oem_part_pattern: "^[A-Z0-9]{3,4}-[A-Z0-9]{3,6}-[A-Z0-9]{2,4}$", country: "Japan" },
  { name: "Hyundai", oem_part_pattern: "^\\d{5}-[A-Z0-9]{5}$", country: "South Korea" },
  { name: "Kia", oem_part_pattern: "^\\d{5}-[A-Z0-9]{5}$", country: "South Korea" },
  { name: "Mercedes-Benz", oem_part_pattern: "^[A-Z]\\d{3}\\s?\\d{3}\\s?\\d{2}\\s?\\d{2}$", country: "Germany" },
  { name: "Audi", oem_part_pattern: "^[A-Z0-9]{3}\\s?\\d{3}\\s?\\d{3}\\s?[A-Z]?$", country: "Germany" },
  { name: "Volkswagen", oem_part_pattern: "^[A-Z0-9]{3}\\s?\\d{3}\\s?\\d{3}\\s?[A-Z]?$", country: "Germany" },
  { name: "Ford", oem_part_pattern: "^[A-Z0-9]{2,4}-[A-Z0-9]{4,6}-[A-Z0-9]{1,4}$", country: "USA" },
  { name: "Chevrolet", oem_part_pattern: "^\\d{7,8}$", country: "USA" },
  { name: "GMC", oem_part_pattern: "^\\d{7,8}$", country: "USA" },
  { name: "Cadillac", oem_part_pattern: "^\\d{7,8}$", country: "USA" },
  { name: "Buick", oem_part_pattern: "^\\d{7,8}$", country: "USA" },
  { name: "Chrysler", oem_part_pattern: FALLBACK_PATTERN, country: "USA" },
  { name: "Dodge", oem_part_pattern: FALLBACK_PATTERN, country: "USA" },
  { name: "Jeep", oem_part_pattern: FALLBACK_PATTERN, country: "USA" },
  { name: "Ram", oem_part_pattern: FALLBACK_PATTERN, country: "USA" },
  { name: "Subaru", oem_part_pattern: FALLBACK_PATTERN, country: "Japan" },
  { name: "Nissan", oem_part_pattern: "^\\d{5}-[A-Z0-9]{2}[A-Z0-9]{2,4}$", country: "Japan" },
  { name: "Infiniti", oem_part_pattern: FALLBACK_PATTERN, country: "Japan" },
  { name: "Mazda", oem_part_pattern: FALLBACK_PATTERN, country: "Japan" },
  { name: "Volvo", oem_part_pattern: FALLBACK_PATTERN, country: "Sweden" },
  { name: "Porsche", oem_part_pattern: FALLBACK_PATTERN, country: "Germany" },
  { name: "Lexus", oem_part_pattern: FALLBACK_PATTERN, country: "Japan" },
  { name: "Land Rover", oem_part_pattern: FALLBACK_PATTERN, country: "UK" },
  { name: "Jaguar", oem_part_pattern: FALLBACK_PATTERN, country: "UK" },
  { name: "Mitsubishi", oem_part_pattern: FALLBACK_PATTERN, country: "Japan" },
  { name: "Genesis", oem_part_pattern: FALLBACK_PATTERN, country: "South Korea" },
  { name: "Lincoln", oem_part_pattern: FALLBACK_PATTERN, country: "USA" },
  { name: "Acura", oem_part_pattern: FALLBACK_PATTERN, country: "Japan" },
] as const;

/**
 * Seeds the makes table with 30 manufacturers.
 * Safe to re-run: skips if makes table already has data.
 *
 * Run via: npx convex run seeds/seedMakes:seedMakes
 */
export const seedMakes = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("makes").first();
    if (existing) {
      console.log("Makes table already has data — skipping seed.");
      return;
    }

    for (const make of MAKES) {
      const slug = make.name.toLowerCase().replace(/\s+/g, "-");
      await ctx.db.insert("makes", {
        name: make.name,
        slug,
        oem_part_pattern: make.oem_part_pattern,
        country: make.country,
      });
    }

    console.log(`Seeded ${MAKES.length} makes.`);
  },
});
