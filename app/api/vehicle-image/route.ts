import { NextResponse } from "next/server";

const VIN_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/i;

const EVOX_FRONT_MARKERS = ["3231303031", "6130313031"];

// Sample template VINs for popular models so visitors who enter a vehicle name
// (e.g. "2020 BMW M550i", "Honda Civic", "CR-V", "Tesla Model 3") get their exact
// transparent vehicle render directly from the Vehicle Databases API.
const POPULAR_VEHICLE_VINS: Array<{ test: (text: string) => boolean; vin: string }> = [
  { test: (t) => /bmw.*(m550|550|5\s*series)|m550i/i.test(t), vin: "WBAJS7C05LG123456" },
  { test: (t) => /bmw.*(m3|m4|m5|330|340|m340)/i.test(t), vin: "WBAJS7C05LG123456" },
  { test: (t) => /honda.*civic|civic/i.test(t), vin: "2HGFC2F89LH556366" },
  { test: (t) => /honda.*cr-?v|cr-?v/i.test(t), vin: "2HKRM4H45GH674118" },
  { test: (t) => /honda.*accord|accord/i.test(t), vin: "1HGCR2F83HA000001" },
  { test: (t) => /vw.*tiguan|volkswagen.*tiguan|tiguan/i.test(t), vin: "3VV5B7AX9RM230023" },
  { test: (t) => /vw.*golf|volkswagen.*golf|gti/i.test(t), vin: "3VW4T7AU3FM000001" },
  { test: (t) => /ford.*(f-?150|f-?250|f-?350|f150)/i.test(t), vin: "1FT8W3BT8LED00001" },
  { test: (t) => /toyota.*supra|gr\s*supra/i.test(t), vin: "WZ1DB4C05LW030001" },
  { test: (t) => /toyota.*camry|camry/i.test(t), vin: "4T1B11HK5LU000001" },
  { test: (t) => /toyota.*corolla|corolla/i.test(t), vin: "JTDEPMAE0LJ000001" },
  { test: (t) => /toyota.*rav-?4|rav-?4/i.test(t), vin: "2T3P1RFV7LC000001" },
  { test: (t) => /toyota.*prius|prius/i.test(t), vin: "JTDKAMFU6M3000001" },
  { test: (t) => /chevy.*silverado|silverado/i.test(t), vin: "1GCUYDED2KZ100001" },
  { test: (t) => /nissan.*altima|altima/i.test(t), vin: "1N4BL4BV3KC110001" },
  { test: (t) => /tesla.*model\s*3|model\s*3/i.test(t), vin: "5YJ3E1EA4MF000001" },
  { test: (t) => /mercedes.*c-?300|c300/i.test(t), vin: "55SWF4JB4GU100001" },
  { test: (t) => /alfa.*stelvio|stelvio/i.test(t), vin: "ZASPAKBN3J7C00001" },
  { test: (t) => /hyundai.*sonata|sonata/i.test(t), vin: "5NPEL4JA7LH000001" },
];

const imageCache = new Map<string, string>();

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const vinParam = (searchParams.get("vin") ?? "").trim().toUpperCase();
  const carParam = (searchParams.get("car") ?? "").trim();
  const year = (searchParams.get("year") ?? "").trim();
  const make = (searchParams.get("make") ?? "").trim();
  const model = (searchParams.get("model") ?? "").trim();
  const trim = (searchParams.get("trim") ?? "").trim();

  const apiKey = process.env.VEHICLE_DATABASES_API_KEY || process.env.VEHICLE_DB_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing API key" }, { status: 500 });
  }

  // 1. Check in-memory cache
  const cacheKey = vinParam || [carParam, year, make, model, trim].filter(Boolean).join(":");
  if (cacheKey && imageCache.has(cacheKey)) {
    return NextResponse.json({ imageUrl: imageCache.get(cacheKey), source: "cache" });
  }

  // 2. Real VIN lookup
  if (VIN_REGEX.test(vinParam)) {
    const fromVin = await tryFetchImage(
      `https://api.vehicledatabases.com/vehicle-images/${vinParam}`,
      apiKey
    );
    if (fromVin) {
      imageCache.set(cacheKey, fromVin);
      return NextResponse.json({ imageUrl: fromVin, source: "vin" });
    }
  }

  // 3. Match against popular vehicle template VINs (e.g. 2020 BMW M550i, Civic, CR-V)
  const fullText = [carParam, year, make, model, trim].filter(Boolean).join(" ");
  for (const entry of POPULAR_VEHICLE_VINS) {
    if (entry.test(fullText)) {
      const fromTemplate = await tryFetchImage(
        `https://api.vehicledatabases.com/vehicle-images/${entry.vin}`,
        apiKey
      );
      if (fromTemplate) {
        imageCache.set(cacheKey, fromTemplate);
        return NextResponse.json({ imageUrl: fromTemplate, source: "vehicle_database_template" });
      }
    }
  }

  // 4. Fallback: YMM(T) lookup
  if (year && make && model) {
    const path = [year, make, model, trim].filter(Boolean).map(encodeURIComponent).join("/");
    const fromYmmt = await tryFetchImage(
      `https://api.vehicledatabases.com/vehicle-images/${path}`,
      apiKey
    );
    if (fromYmmt) {
      imageCache.set(cacheKey, fromYmmt);
      return NextResponse.json({ imageUrl: fromYmmt, source: "ymmt" });
    }
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

  // Vehicle Databases returns images: { exterior: [...], colors: [...] }
  const images = data.images as Record<string, unknown> | undefined;
  if (images && typeof images === "object" && !Array.isArray(images)) {
    const exterior = Array.isArray(images.exterior) ? (images.exterior as string[]) : [];
    const colors = Array.isArray(images.colors) ? (images.colors as string[]) : [];

    // Prefer EVOX front 3/4 angle
    const evox = exterior.find(
      (u) => typeof u === "string" && EVOX_FRONT_MARKERS.some((m) => u.includes(m))
    );
    if (evox) return evox;

    if (exterior[0] && typeof exterior[0] === "string" && exterior[0].startsWith("http")) {
      return exterior[0];
    }
    if (colors[0] && typeof colors[0] === "string" && colors[0].startsWith("http")) {
      return colors[0];
    }
  }

  // Flat candidates fallback
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
