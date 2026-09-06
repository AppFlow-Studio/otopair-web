import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

/*
 * Link-preview card (og:image + twitter:image, wired up by Next from this
 * route). Replaces the hand-set repairconnectglasslogo.png — link previews
 * were still showing the old brand (site audit 2026-08-31). Drawn from the
 * landing's own palette: the white → #95C7E7 wash, ink text, the 3D pin.
 * Text renders in ImageResponse's built-in fallback face on purpose — a
 * remote font fetch here would put Google Fonts on the build's critical path.
 */

export const alt = "Otopair — car repair at a price locked before you book";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpengraphImage() {
  const pin = await readFile(join(process.cwd(), "public", "pin-logo-3d.png"));
  const pinSrc = `data:image/png;base64,${pin.toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 72px",
          background: "linear-gradient(180deg, #FFFFFF 0%, #C9E2F4 62%, #95C7E7 100%)",
          color: "#1a1a1a",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- satori element, not DOM */}
          <img src={pinSrc} alt="" width={92} height={92} />
          <div style={{ display: "flex", fontSize: 46, fontWeight: 600, letterSpacing: -1 }}>
            Otopair
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div
            style={{
              display: "flex",
              maxWidth: 940,
              fontSize: 78,
              lineHeight: 1.06,
              fontWeight: 600,
              letterSpacing: -2,
            }}
          >
            The shop sets the price. Oto locks it.
          </div>
          <div style={{ display: "flex", fontSize: 30, color: "#33383b" }}>
            Car repair without the negotiation — live in Staten Island, NYC.
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
