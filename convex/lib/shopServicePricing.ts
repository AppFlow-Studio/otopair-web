export const MIN_SHOP_SERVICE_PRICE_CENTS = 100;
export const MAX_SHOP_SERVICE_PRICE_CENTS = 10_000_000;

export type ShopServicePriceFields = {
  price_cents?: number;
  price_low_cents?: number;
  price_high_cents?: number;
};

export type NormalizedShopServicePrice = {
  lowCents: number;
  highCents: number;
  isFixed: boolean;
};

function validCents(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_SHOP_SERVICE_PRICE_CENTS &&
    value <= MAX_SHOP_SERVICE_PRICE_CENTS
  );
}

/** Normalizes legacy fixed rows and newer range rows into one safe shape. */
export function normalizeShopServicePrice(
  row: ShopServicePriceFields | null | undefined,
): NormalizedShopServicePrice | null {
  if (!row) return null;

  if (validCents(row.price_cents)) {
    return {
      lowCents: row.price_cents,
      highCents: row.price_cents,
      isFixed: true,
    };
  }

  if (
    validCents(row.price_low_cents) &&
    validCents(row.price_high_cents) &&
    row.price_low_cents <= row.price_high_cents
  ) {
    return {
      lowCents: row.price_low_cents,
      highCents: row.price_high_cents,
      isFixed: row.price_low_cents === row.price_high_cents,
    };
  }

  return null;
}
