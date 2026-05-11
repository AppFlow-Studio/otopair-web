import { NextResponse } from "next/server";

const VIN_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/i;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const vin = (searchParams.get("vin") ?? "").trim().toUpperCase();
  const year = (searchParams.get("year") ?? "").trim();
  const make = (searchParams.get("make") ?? "").trim();
  const model = (searchParams.get("model") ?? "").trim();
  const trim = (searchParams.get("trim") ?? "").trim();

  const apiKey = process.env.VEHICLE_DB_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing API key" }, { status: 500 });
  }

  // Primary: VIN lookup
  if (VIN_REGEX.test(vin)) {
    const fromVin = await tryFetchImage(
      `https://api.vehicledatabases.com/vehicle-images/${vin}`,
      apiKey
    );
    if (fromVin) return NextResponse.json({ imageUrl: fromVin, source: "vin" });
  }

  // Fallback: YMM(T) lookup
  if (year && make && model) {
    const path = [year, make, model, trim].filter(Boolean).map(encodeURIComponent).join("/");
    const fromYmmt = await tryFetchImage(
      `https://api.vehicledatabases.com/vehicle-images/${path}`,
      apiKey
    );
    if (fromYmmt) return NextResponse.json({ imageUrl: fromYmmt, source: "ymmt" });
  }

  return NextResponse.json({ imageUrl: null });
}

async function tryFetchImage(url: string, apiKey: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "x-AuthKey": apiKey },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = await res.json();
    return pickImageUrl(json);
  } catch {
    return null;
  }
}

function pickImageUrl(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  const data = (root.data ?? root) as Record<string, unknown>;

  const candidates: unknown[] = [];
  for (const key of ["main", "default", "primary", "front", "image", "url"]) {
    candidates.push((data as Record<string, unknown>)[key]);
  }
  if (Array.isArray(data.images)) candidates.push(...(data.images as unknown[]));
  if (Array.isArray(data.image)) candidates.push(...(data.image as unknown[]));

  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("http")) return c;
    if (c && typeof c === "object") {
      const obj = c as Record<string, unknown>;
      for (const k of ["url", "src", "image", "image_url", "main"]) {
        const v = obj[k];
        if (typeof v === "string" && v.startsWith("http")) return v;
      }
    }
  }
  return null;
}
