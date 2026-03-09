import type { Metadata } from "next";
import { Inter, Lora, Roboto_Slab, Balthazar, Jersey_20 } from "next/font/google";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import ConvexClientProvider from "@/components/providers/convex-client-provider";
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

const Jersey20s = Jersey_20({
  variable: "--font-Jersey_20",
  weight: ["400"],
  style: "normal",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Otopair",
  description: "",
  icons: {
    icon: "/logo.png",
  },
  openGraph: {
    images: [
      {
        url: "/repairconnectglasslogo.png",
      },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider afterSignOutUrl="/">
      <html lang="en">
        <body
          className={`${Inters.variable} ${Loras.variable} ${Robotoslab.variable} ${Balthazars.variable} ${OktaRegular.variable} ${Jersey20s.variable} antialiased overscroll-none`}
        >
          <ConvexClientProvider>{children}</ConvexClientProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
