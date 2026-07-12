"use client";

import { PortalShell } from "@/components/portal/PortalShell";

export default function OpsLayout({ children }: { children: React.ReactNode }) {
  return <PortalShell portal="ops">{children}</PortalShell>;
}
