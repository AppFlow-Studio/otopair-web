"use client";

import { ShieldCheck } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import LicenseUploader from "@/components/shop/license-uploader";

export default function LicensesManager({ shopId }: { shopId: Id<"shops"> }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="mb-4 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-gray-500" />
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">
          Licenses &amp; Certificates
        </h2>
      </div>
      <LicenseUploader shopId={shopId} />
    </div>
  );
}
