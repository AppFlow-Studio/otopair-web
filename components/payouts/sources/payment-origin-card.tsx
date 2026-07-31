"use client";

import { CATEGORICAL, ShareBar, type ShareSlice } from "../charts";
import {
  Card,
  CardEyebrow,
  ChartTableView,
  EmptyHint,
  Skeleton,
  formatMoneyCents,
} from "../shared";
import type { ShopPaymentInsights } from "../types";

/**
 * How customers pay.
 *
 * A 100% stacked bar, not a donut: a real method mix is closer to 90/7/3, and
 * a donut of that is three slivers and a circle.
 */
export function PaymentOriginCard({
  insights,
  loading,
}: {
  insights: ShopPaymentInsights | null | undefined;
  loading: boolean;
}) {
  const mix = insights?.methodMix ?? [];
  const slices: ShareSlice[] = mix.map((m, i) => ({
    key: m.key,
    label: m.label,
    valueCents: m.capturedCents,
    count: m.count,
    color: CATEGORICAL[i % CATEGORICAL.length],
  }));

  const top = mix[0];
  const brands = insights?.cardBrandMix ?? [];

  return (
    <Card className="flex flex-col">
      <CardEyebrow>How customers pay</CardEyebrow>
      {loading ? (
        <>
          <Skeleton className="mt-3 h-6 w-40" />
          <Skeleton className="mt-4 h-3 w-full rounded-full" />
          <Skeleton className="mt-4 h-20 w-full" />
        </>
      ) : slices.length === 0 ? (
        <EmptyHint>No captured payments in this range.</EmptyHint>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted-foreground">
            {top
              ? `${Math.round(top.sharePctBps / 100)}% of your revenue came in via ${top.label.toLowerCase()}.`
              : ""}
          </p>
          <div className="mt-4">
            <ShareBar slices={slices} />
          </div>

          {brands.length > 0 ? (
            <p className="mt-4 border-t border-border/50 pt-3 text-xs text-muted-foreground">
              Cards:{" "}
              {brands
                .slice(0, 4)
                .map((b) => `${b.brand} (${b.count})`)
                .join(" · ")}
            </p>
          ) : null}

          <ChartTableView
            caption="Revenue by payment method"
            columns={["Method", "Payments", "Captured"]}
            rows={mix.map((m) => [
              m.label,
              m.count,
              formatMoneyCents(m.capturedCents),
            ])}
          />
        </>
      )}
    </Card>
  );
}
