"use client";

import { createContext, useContext } from "react";
import type { Capability } from "@/lib/portal/capabilities";
import { can as roleCan } from "@/lib/portal/capabilities";

export const PORTAL_SESSION_KEY = "otopair_director_token";

export type PortalSession = {
  userId: string;
  name: string;
  role: string;
  token: string;
  logout: () => void;
};

export const PortalSessionContext = createContext<PortalSession | null>(null);

/** Session for the internal portals. Only call inside the (portals) layout —
 *  it throws when unauthenticated, because the layout never renders children
 *  without a validated session. */
export function usePortalSession(): PortalSession {
  const s = useContext(PortalSessionContext);
  if (!s) throw new Error("usePortalSession outside an authenticated portal layout");
  return s;
}

export function useCan(capability: Capability): boolean {
  const s = useContext(PortalSessionContext);
  return roleCan(s?.role, capability);
}
