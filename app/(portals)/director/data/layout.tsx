"use client";

import { PortalShell } from "@/components/portal/PortalShell";

export default function DataLayout({ children }: { children: React.ReactNode }) {
  return <PortalShell portal="data">{children}</PortalShell>;
}
