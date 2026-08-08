"use client";

import { ShieldCheck } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import LicenseUploader from "@/components/shop/license-uploader";
import { SettingsCard } from "@/components/settings/primitives";

type Row = { reviewStatus: "pending_review" | "verified" | "rejected" };

export default function LicensesManager({ shopId }: { shopId: Id<"shops"> }) {
  const licenses = useQuery(api.shopLicenses.listForShop, { shopId }) as
    | Row[]
    | undefined;

  const verified = licenses?.filter((l) => l.reviewStatus === "verified").length ?? 0;
  const pending = licenses?.filter((l) => l.reviewStatus === "pending_review").length ?? 0;
  const rejected = licenses?.filter((l) => l.reviewStatus === "rejected").length ?? 0;

  const summary =
    licenses && licenses.length > 0
      ? [
          verified ? `${verified} verified` : null,
          pending ? `${pending} pending review` : null,
          rejected ? `${rejected} rejected` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "No documents uploaded yet.";

  return (
    <SettingsCard
      title="Licenses & Certifications"
      description="Upload your licenses, insurance, and certifications so we can verify your shop is a legitimate business. Only the NY DMV inspection license affects which services you can offer — everything else builds trust."
      icon={<ShieldCheck className="h-4 w-4 text-muted-foreground" />}
      action={
        <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">
          {summary}
        </span>
      }
    >
      <LicenseUploader shopId={shopId} showIntro={false} />
    </SettingsCard>
  );
}
