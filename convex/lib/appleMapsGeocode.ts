/**
 * Apple MapKit Server API — geocode helper.
 *
 * Server-to-server geocoding using Apple's MapKit JS Maps Token.
 * Same backend as the in-app Apple Maps view, so resolved coords
 * land the pin exactly where the map would draw it.
 *
 * Flow:
 *   1. Build + sign an ES256 JWT with the private MapKit JS key.
 *   2. Exchange that JWT at /v1/token for a ~30-minute access token.
 *   3. Use the access token as Bearer on /v1/geocode calls.
 *
 * Required Convex env vars:
 *   APPLE_MAPS_KEY_ID       — 10-char Key ID from Apple Developer portal
 *   APPLE_MAPS_TEAM_ID      — 10-char Team ID from the same portal
 *   APPLE_MAPS_PRIVATE_KEY  — full contents of the .p8 file, including the
 *                             -----BEGIN PRIVATE KEY----- / -----END PRIVATE KEY-----
 *                             lines (PEM, PKCS#8, ECDSA P-256)
 *
 * USED IN: convex/shops.ts (geocodeShop internalAction)
 */

interface AccessTokenCache {
  token: string;
  expiresAt: number; // unix seconds
}

let cachedToken: AccessTokenCache | null = null;

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) {
    return cachedToken.token;
  }

  const keyId = process.env.APPLE_MAPS_KEY_ID;
  const teamId = process.env.APPLE_MAPS_TEAM_ID;
  const pem = process.env.APPLE_MAPS_PRIVATE_KEY;
  if (!keyId || !teamId || !pem) {
    throw new Error(
      "Apple Maps env vars not set (need APPLE_MAPS_KEY_ID, APPLE_MAPS_TEAM_ID, APPLE_MAPS_PRIVATE_KEY).",
    );
  }

  const key = await importP8PrivateKey(pem);

  const header = { alg: "ES256", typ: "JWT", kid: keyId };
  const payload = { iss: teamId, iat: now, exp: now + 1800 };
  const signingInput = `${base64urlString(JSON.stringify(header))}.${base64urlString(JSON.stringify(payload))}`;

  const sigDer = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  // WebCrypto returns the raw ECDSA r||s concatenation (64 bytes for P-256) —
  // exactly what JOSE expects for ES256. No DER unwrapping needed.
  const jwt = `${signingInput}.${base64urlBytes(new Uint8Array(sigDer))}`;

  const res = await fetch("https://maps-api.apple.com/v1/token", {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Apple token exchange failed ${res.status}: ${body.slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    accessToken: string;
    expiresInSeconds: number;
  };
  cachedToken = {
    token: body.accessToken,
    expiresAt: now + body.expiresInSeconds,
  };
  return body.accessToken;
}

export async function geocodeAddress(
  address: string,
): Promise<{ lat: number; lng: number } | null> {
  if (!address || !address.trim()) return null;
  const token = await getAccessToken();
  const url = `https://maps-api.apple.com/v1/geocode?q=${encodeURIComponent(address.trim())}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.warn(`[appleMapsGeocode] /geocode returned ${res.status} for "${address}"`);
    return null;
  }
  const body = (await res.json()) as {
    results?: { coordinate?: { latitude: number; longitude: number } }[];
  };
  const c = body.results?.[0]?.coordinate;
  if (!c || typeof c.latitude !== "number" || typeof c.longitude !== "number") {
    return null;
  }
  return { lat: c.latitude, lng: c.longitude };
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

async function importP8PrivateKey(pem: string): Promise<CryptoKey> {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const binary = atob(b64);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

function base64urlString(input: string): string {
  return btoa(input).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64urlBytes(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
