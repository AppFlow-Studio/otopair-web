import type { Metadata, Viewport } from "next";
import {
  Inter,
  Lora,
  Roboto_Slab,
  Balthazar,
  Jersey_20,
  Fraunces,
  Literata,
  Petrona,
  Urbanist,
} from "next/font/google";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import ConvexClientProvider from "@/components/providers/convex-client-provider";
import { SiteJsonLd } from "@/components/seo/json-ld";
import { SITE_NAME, SITE_URL } from "@/lib/site";
import Okta from "next/font/local";

const OktaRegular = Okta({
  src: "../public/fonts/OktaItalic.otf",
  variable: "--font-Okta",
});

const Inters = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const Loras = Lora({
  variable: "--font-Lora",
  subsets: ["latin"],
  display: "swap",
});

const Robotoslab = Roboto_Slab({
  variable: "--font-Roboto_Slab",
  weight: "500",
  style: "normal",
  subsets: ["latin"],
  display: "swap",
});

const Balthazars = Balthazar({
  variable: "--font-Balthazar",
  weight: ["400"],
  style: "normal",
  subsets: ["latin"],
  display: "swap",
});

// Flagship hero display face. Figma V1 specifies Romie (Claude Type), which
// we don't license. Fraunces 300 is the closest free match by glyph anatomy —
// single-storey g with the open tail, big round a-bowl, high contrast — and by
// measurement (1.01x Romie's rendered stroke mass, 0.93x its line width; the
// previous stand-ins Lora and Cormorant were 1.53x mass and 0.87x width).
// Swap for the real Romie when the trial pack / licence lands.
const Fraunceses = Fraunces({
  variable: "--font-Fraunces",
  // Variable axis so the landing can tune weight below 300 — Romie's stat
  // numerals are lighter than its headline weight, and static 300 was the
  // closest whole instance Google served.
  weight: "variable",
  // Ship the optical-size axis too — high opsz is where Fraunces' hairline
  // contrast (the Romie-like part) lives; without listing it next/font serves
  // a wght-only instance and font-variation opsz settings silently no-op.
  axes: ["opsz"],
  style: "normal",
  subsets: ["latin"],
  display: "swap",
});

// Stat-numeral face for the landing's "why Oto" mini cards. Romie's stat cut
// has flat hairline slab serifs and narrow lining digits; measured against the
// V1 render, Literata at opsz 72 / wght ~250 is the closest free match
// (ink-mask IoU 0.43 vs Fraunces' 0.21, width ratios 1.00-1.04 on all four
// values). Same swap-for-Romie caveat as Fraunces above.
const Literatas = Literata({
  variable: "--font-Literata",
  weight: "variable",
  // Without the opsz axis next/font serves a wght-only instance and the
  // display-size forms this face was picked for never load.
  axes: ["opsz"],
  style: "normal",
  subsets: ["latin"],
  display: "swap",
});

// Landing display face. Figma V1 specifies Romie (Claude Type), which we don't
// license. Petrona replaced Fraunces on 2026-08-19 after scoring 26 free serifs
// against the V1 render two ways — proportion (x/cap, asc/cap, desc/cap, width
// per cap) and per-glyph ink-mask overlap at matched cap height. Fraunces came
// 24th of 26; it sets 18% narrow, its x-height is 0.63 of cap against Romie's
// 0.735, and its percent bowls and ball-terminal f are nothing like Romie's.
// Petrona carries the anatomy Romie has: ball terminals on a/r, a swept f, large
// open percent bowls, x/cap 0.729 and line width 11.36 caps against Romie's
// 0.735 and 11.27. Swap for the real Romie when the trial pack / licence lands.
const Petronas = Petrona({
  variable: "--font-Petrona",
  weight: "variable",
  style: "normal",
  subsets: ["latin"],
  display: "swap",
});

// Urbanist is the driver app's face (otopair-1 constants/theme.ts FontFamily).
// Loaded for the product pages' phone screens only, so the app UI drawn on
// the site is set in the app's own type.
const Urbanists = Urbanist({
  variable: "--font-Urbanist",
  weight: ["400", "500", "600", "700"],
  style: "normal",
  subsets: ["latin"],
  display: "swap",
});

const Jersey20s = Jersey_20({
  variable: "--font-Jersey_20",
  weight: ["400"],
  style: "normal",
  subsets: ["latin"],
  display: "swap",
});

// theme-color matches the page ground so the browser chrome does not flash a
// foreign colour on mobile (Vercel Web Interface Guidelines, dark mode & theming).
export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  // Resolves every relative og:url / canonical / og:image to the production
  // origin, on preview deploys too — a preview must never advertise its own
  // host as canonical (site audit 2026-08-31, Phase 1).
  metadataBase: new URL(SITE_URL),
  title: {
    // Page-level titles win via the template; this default only covers routes
    // that set none. Carries the two keywords the audit found missing from
    // the homepage: the service ("car repair") and the market ("Staten Island").
    default: "Otopair — Car repair at a locked price, Staten Island NY",
    template: "%s — Otopair",
  },
  description:
    "Tell Oto what your car is doing and book a verified shop nearby at a locked price — no negotiating, no surprises at pickup. Live in Staten Island, NYC.",
  applicationName: SITE_NAME,
  // Emits <meta name="apple-mobile-web-app-capable" content="yes" /> so that,
  // when launched from an iOS home-screen shortcut, the site opens full-screen
  // (no Safari address/tool bars) like a standalone app.
  appleWebApp: {
    capable: true,
  },
  icons: {
    icon: "/logo.png",
  },
  // og/twitter images come from app/opengraph-image.tsx — never point this at
  // a static asset again without checking the brand: the old hand-set image
  // was the pre-rename repairconnectglasslogo.png (site audit 2026-08-31).
  openGraph: {
    siteName: SITE_NAME,
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider afterSignOutUrl="/">
      <html lang="en" suppressHydrationWarning>
        <body
          className={`${Inters.variable} ${Loras.variable} ${Robotoslab.variable} ${Balthazars.variable} ${OktaRegular.variable} ${Jersey20s.variable} ${Fraunceses.variable} ${Literatas.variable} ${Petronas.variable} ${Urbanists.variable} antialiased overscroll-none`}
        >
          {/* Organization + WebSite + LocalBusiness graph, sitewide. */}
          <SiteJsonLd />
          <ConvexClientProvider>{children}</ConvexClientProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
