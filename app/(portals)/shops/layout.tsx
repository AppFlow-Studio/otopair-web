"use client";

import { PortalShell } from "@/components/portal/PortalShell";

export default function ShopsLayout({ children }: { children: React.ReactNode }) {
  return <PortalShell portal="shops">{children}</PortalShell>;
}
