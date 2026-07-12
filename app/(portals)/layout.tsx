"use client";

// Shared layout for the internal portals (/ops, /shops, /data).
// Auth = director email+TOTP sessions (same backend as the legacy /director
// panel; the token is shared via localStorage so a session works in both).
// Middleware keeps these routes public — the security boundary is
// requireDirector inside every Convex function, per directorGate doctrine.

import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { PortalLogin } from "@/components/portal/PortalLogin";
import { EnvBanner } from "@/components/portal/EnvBanner";
import {
  PORTAL_SESSION_KEY,
  PortalSessionContext,
  type PortalSession,
} from "./portal-session";

export default function PortalsLayout({ children }: { children: React.ReactNode }) {
  // undefined = not yet read from localStorage; null = absent.
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [user, setUser] = useState<{ userId: string; name: string; role: string } | null>(null);
  const logoutMutation = useMutation(api.director_auth.logout);

  useEffect(() => {
    setToken(localStorage.getItem(PORTAL_SESSION_KEY));
  }, []);

  const validated = useQuery(
    api.director_auth.validateSession,
    typeof token === "string" && token ? { token } : "skip",
  );

  useEffect(() => {
    if (typeof token !== "string" || !token) return;
    if (validated === undefined) return; // loading
    if (validated === null) {
      localStorage.removeItem(PORTAL_SESSION_KEY);
      setToken(null);
      setUser(null);
    } else {
      setUser({ userId: validated.userId, name: validated.name, role: validated.role });
    }
  }, [validated, token]);

  const handleLogin = useCallback(
    (newToken: string, u: { name: string; role: string; userId: string }) => {
      localStorage.setItem(PORTAL_SESSION_KEY, newToken);
      setToken(newToken);
      setUser(u);
    },
    [],
  );

  const logout = useCallback(() => {
    const t = typeof token === "string" ? token : "";
    if (t && user) {
      void logoutMutation({ token: t, actorName: user.name, actorId: user.userId as never });
    }
    localStorage.removeItem(PORTAL_SESSION_KEY);
    setToken(null);
    setUser(null);
  }, [token, user, logoutMutation]);

  if (token === undefined || (typeof token === "string" && token && !user)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950">
        <div className="text-sm text-slate-400">Checking session…</div>
      </div>
    );
  }

  if (!token || !user) {
    return <PortalLogin onLogin={handleLogin} />;
  }

  const session: PortalSession = { ...user, token, logout };

  return (
    <PortalSessionContext.Provider value={session}>
      <div className="min-h-screen bg-slate-50 text-slate-900">
        <EnvBanner />
        {children}
      </div>
    </PortalSessionContext.Provider>
  );
}
