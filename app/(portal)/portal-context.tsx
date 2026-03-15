"use client";

import { createContext, useContext } from "react";

interface PortalSidebarContextType {
  setSidebarCompact: (compact: boolean) => void;
}

export const PortalSidebarContext = createContext<PortalSidebarContextType>({
  setSidebarCompact: () => {},
});

export function usePortalSidebar() {
  return useContext(PortalSidebarContext);
}
