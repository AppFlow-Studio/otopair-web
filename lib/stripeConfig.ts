export function resolveStripePublishableKey(
  expoPublicKey: string | undefined,
  serverHint: string | null | undefined,
): string | null {
  const expoKey = expoPublicKey?.trim();
  if (expoKey) return expoKey;

  const hintedKey = serverHint?.trim();
  return hintedKey || null;
}
