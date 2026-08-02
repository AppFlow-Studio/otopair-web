"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth, useUser } from "@clerk/nextjs";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type VerifyState =
  | { phase: "loading" }
  | { phase: "invalid"; reason: string }
  | { phase: "valid"; shopName: string; role: string; email: string };

const REASON_COPY: Record<string, { title: string; body: string }> = {
  invalid: {
    title: "This invite link isn't valid",
    body: "The link may be mistyped or was never issued. Check the link in your email, or contact the Otopair team.",
  },
  expired: {
    title: "This invite has expired",
    body: "Invite links are valid for 7 days. Ask the Otopair team to send you a fresh one.",
  },
  used: {
    title: "This invite has already been used",
    body: "If you've already claimed your shop, just sign in. Otherwise, reach out to the Otopair team.",
  },
  error: {
    title: "Something went wrong",
    body: "We couldn't verify this link right now. Please try again in a moment.",
  },
};

function roleLabel(role: string): string {
  if (role === "shop_owner") return "Shop Owner";
  return role.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function InviteCard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const auto = searchParams.get("auto") === "1";
  const { isLoaded: userLoaded, isSignedIn, user } = useUser();
  const { getToken } = useAuth();

  const [state, setState] = useState<VerifyState>({ phase: "loading" });
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Verify the token on mount.
  useEffect(() => {
    if (!token) {
      setState({ phase: "invalid", reason: "invalid" });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/invites/verify?token=${encodeURIComponent(token)}`);
        const data = await res.json();
        if (cancelled) return;
        if (data?.valid) {
          setState({ phase: "valid", shopName: data.shopName, role: data.role, email: data.email });
        } else {
          setState({ phase: "invalid", reason: data?.reason ?? "invalid" });
        }
      } catch {
        if (!cancelled) setState({ phase: "invalid", reason: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const accept = useCallback(async () => {
    setError(null);
    // Not signed in → send to Clerk sign-up, returning here with auto=1 to
    // finish the claim once authenticated.
    if (userLoaded && !isSignedIn) {
      const returnTo = `/invite?token=${encodeURIComponent(token)}&auto=1`;
      router.push(`/sign-up?redirect_url=${encodeURIComponent(returnTo)}`);
      return;
    }
    setAccepting(true);
    try {
      const res = await fetch("/api/invites/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (res.ok && data?.success) {
        // The accept route just PATCHed our Clerk role server-side, but the
        // active session JWT still carries the pre-claim metadata — a role-gated
        // route (/shop) would bounce to /shop-only. Reload the user and mint a
        // fresh token (with the new shop_owner claim), then hard-navigate so
        // middleware re-reads the updated session.
        try {
          await user?.reload();
          await getToken({ skipCache: true });
        } catch {
          /* refresh best-effort — worst case the portal refreshes the token itself */
        }
        window.location.assign(data.redirectTo ?? "/shop/setup");
      } else {
        setError(data?.error ?? "Something went wrong. Please try again.");
        setAccepting(false);
      }
    } catch {
      setError("Something went wrong. Please try again.");
      setAccepting(false);
    }
  }, [isSignedIn, router, token, userLoaded, user, getToken]);

  // After returning from sign-up (auto=1) and signed in, finish automatically.
  useEffect(() => {
    if (auto && userLoaded && isSignedIn && state.phase === "valid" && !accepting) {
      void accept();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, userLoaded, isSignedIn, state.phase]);

  const card =
    "w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 shadow-sm";

  if (state.phase === "loading" || !userLoaded) {
    return (
      <div className={`${card} flex items-center justify-center py-16`}>
        <Loader2 className="size-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (state.phase === "invalid") {
    const copy = REASON_COPY[state.reason] ?? REASON_COPY.invalid;
    return (
      <div className={card}>
        <h1 className="text-lg font-semibold text-gray-900">{copy.title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-500">{copy.body}</p>
        <div className="mt-6 flex gap-3">
          <Button asChild variant="outline">
            <Link href="/">Back to home</Link>
          </Button>
          {state.reason === "used" && (
            <Button asChild className="bg-[#5299fe] text-white hover:bg-[#5299fe]/90">
              <Link href="/sign-in">Sign in</Link>
            </Button>
          )}
        </div>
      </div>
    );
  }

  // valid
  return (
    <div className={card}>
      <h1 className="text-lg font-semibold text-gray-900">You've been invited to Otopair</h1>
      <p className="mt-2 text-sm leading-relaxed text-gray-500">
        You are claiming <strong className="font-semibold text-gray-900">{state.shopName}</strong> as{" "}
        <strong className="font-semibold text-gray-900">{roleLabel(state.role)}</strong>. Accept to set
        up your shop and start taking bookings.
      </p>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <div className="mt-6 flex items-center justify-between gap-3">
        <Button asChild variant="outline" disabled={accepting}>
          <Link href="/">Decline</Link>
        </Button>
        <Button
          onClick={accept}
          disabled={accepting}
          className="bg-[#5299fe] text-white hover:bg-[#5299fe]/90"
        >
          {accepting && <Loader2 className="size-4 animate-spin" />}
          {accepting ? "Claiming…" : "Accept"}
        </Button>
      </div>
    </div>
  );
}

export default function InvitePage() {
  return (
    <Suspense
      fallback={
        <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 shadow-sm flex items-center justify-center py-16">
          <Loader2 className="size-6 animate-spin text-gray-400" />
        </div>
      }
    >
      <InviteCard />
    </Suspense>
  );
}
