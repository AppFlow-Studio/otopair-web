export type ShopQuoteRequestStatus = "open" | "pending" | "expired" | "cancelled";

export function shouldShowShopQuoteRequest(status: ShopQuoteRequestStatus): boolean {
  return status !== "expired";
}
