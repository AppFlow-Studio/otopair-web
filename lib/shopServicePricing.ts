export type ShopServicePrice = {
  lowDollars: number;
  highDollars: number;
  isFixed: boolean;
};

export type ShopServicePriceMap = Map<string, ShopServicePrice>;

export function servicePricingMapFromCents(
  result:
    | Record<
        string,
        { low_cents: number; high_cents: number; is_fixed: boolean }
      >
    | null
    | undefined,
): ShopServicePriceMap {
  const map: ShopServicePriceMap = new Map();
  for (const [serviceId, price] of Object.entries(result ?? {})) {
    map.set(serviceId, {
      lowDollars: price.low_cents / 100,
      highDollars: price.high_cents / 100,
      isFixed: price.low_cents === price.high_cents || price.is_fixed,
    });
  }
  return map;
}

export function formatShopServicePrice(price: ShopServicePrice): string {
  const low = `$${price.lowDollars.toFixed(2)}`;
  const high = `$${price.highDollars.toFixed(2)}`;
  return price.lowDollars === price.highDollars ? low : `${low} – ${high}`;
}
