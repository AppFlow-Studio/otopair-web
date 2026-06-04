"use client";

/**
 * Unified Quotes page — single sidebar entry that hosts both the Tire and
 * Rotor bid flows behind a tab toggle. Each tab renders the existing
 * `*QuoteRequestsContent` component (the originals at
 * /bookings/tire-quote-requests and /bookings/rotor-quote-requests still
 * resolve via their default-export shells, for any deep-links).
 *
 * Default tab can be forced via `?type=tire` or `?type=rotor`. The
 * Schedule page uses `?type=tire&booking=…` to deep-link tentative tire
 * quotes back to this view.
 */

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { Disc3, Circle } from "lucide-react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { TireQuoteRequestsContent } from "@/app/(portal)/bookings/tire-quote-requests/page";
import { RotorQuoteRequestsContent } from "@/app/(portal)/bookings/rotor-quote-requests/page";

type QuoteType = "tire" | "rotor";

export default function QuoteRequestsPage() {
  const searchParams = useSearchParams();
  const initialTypeParam = searchParams?.get("type");
  const initialType: QuoteType = initialTypeParam === "rotor" ? "rotor" : "tire";

  const [active, setActive] = useState<QuoteType>(initialType);

  // Pull both open-quote lists at the parent so we can badge each tab
  // with the unresolved count. Convex dedupes by (query, args), so the
  // active tab's child component shares the same subscription — no
  // duplicate work.
  const context = useQuery(api.bookings.getMyShopJobContext);
  const shopId = context?.shopId as Id<"shops"> | undefined;
  const tireRequests = useQuery(
    api.bookings.listOpenTireQuoteRequestsForShop,
    shopId ? { shopId } : "skip",
  );
  const rotorRequests = useQuery(
    api.bookings.listOpenRotorQuoteRequestsForShop,
    shopId ? { shopId } : "skip",
  );
  const tireCount = tireRequests?.length ?? 0;
  const rotorCount = rotorRequests?.length ?? 0;

  // Keep the active tab in sync with the URL `?type=` param when the user
  // navigates between deep-links without remounting the page.
  useEffect(() => {
    const t = searchParams?.get("type");
    if (t === "rotor" && active !== "rotor") setActive("rotor");
    else if (t === "tire" && active !== "tire") setActive("tire");
    // Intentionally do not sync on `active` change — the local tab click
    // is the source of truth once the user is on the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Quotes</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Open quote requests from customers — submit a price + ready-by
          slot, and the row leaves once the customer accepts.
        </p>
      </div>

      {/* Tab strip */}
      <div className="border-b border-border">
        <div className="flex gap-1">
          <TabButton
            label="Tires"
            icon={<Circle className="h-4 w-4" strokeWidth={2} />}
            active={active === "tire"}
            count={tireCount}
            onClick={() => setActive("tire")}
          />
          <TabButton
            label="Rotors"
            icon={<Disc3 className="h-4 w-4" strokeWidth={2} />}
            active={active === "rotor"}
            count={rotorCount}
            onClick={() => setActive("rotor")}
          />
        </div>
      </div>

      {/* Active tab content — render only the active one so we don't pay
          the cost of two parallel Convex queries when only one is on
          screen. */}
      {active === "tire" ? (
        <TireQuoteRequestsContent hideHeader />
      ) : (
        <RotorQuoteRequestsContent hideHeader />
      )}
    </div>
  );
}

function TabButton({
  label,
  icon,
  active,
  count,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  /** Number of unresolved quote requests in this category. Undefined =
   *  still loading (no badge shown). 0 = badge hidden so the tab strip
   *  doesn't shout about empty queues. */
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors " +
        (active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40")
      }
    >
      {icon}
      {label}
      {count !== undefined && count > 0 ? (
        <span
          className={
            "ml-1 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[11px] font-semibold tabular-nums " +
            (active
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground")
          }
        >
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </button>
  );
}
