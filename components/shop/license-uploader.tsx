"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Loader2,
  ShieldCheck,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";

const DMV_LICENSE_TYPE = "dmv_inspection_station";
const DMV_LICENSE_LABEL = "NY DMV Inspection Station License";
const ACCEPT = "application/pdf,image/png,image/jpeg,image/webp";
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

type LicenseRow = {
  _id: string;
  licenseType: string;
  url: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  licenseNumber: string | null;
  issuer: string | null;
  expiresAt: number | null;
  reviewStatus: "pending_review" | "verified" | "rejected";
  reviewNote: string | null;
  reviewedAt: number | null;
  createdAt: number;
};

function StatusBadge({ status }: { status: LicenseRow["reviewStatus"] }) {
  const map = {
    pending_review: {
      label: "Pending review",
      className: "bg-amber-50 text-amber-700 border-amber-200",
      Icon: Loader2,
    },
    verified: {
      label: "Verified",
      className: "bg-emerald-50 text-emerald-700 border-emerald-200",
      Icon: CheckCircle2,
    },
    rejected: {
      label: "Rejected",
      className: "bg-red-50 text-red-700 border-red-200",
      Icon: XCircle,
    },
  }[status];
  const Icon = map.Icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${map.className}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {map.label}
    </span>
  );
}

function formatDate(ms: number | null): string | null {
  if (!ms) return null;
  return new Date(ms).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function LicenseUploader({
  shopId,
  showIntro = true,
  inspectionSelected = false,
}: {
  shopId: Id<"shops"> | null | undefined;
  showIntro?: boolean;
  /** True when the shop has picked services that need this license — surfaces a
   *  quiet "skip = stays off" note when nothing is uploaded yet. */
  inspectionSelected?: boolean;
}) {
  const licenses = useQuery(
    api.shopLicenses.listForShop,
    shopId ? { shopId } : "skip",
  ) as LicenseRow[] | undefined;

  const generateUploadUrl = useMutation(api.shopLicenses.generateUploadUrl);
  const addLicense = useMutation(api.shopLicenses.addLicense);
  const removeLicense = useMutation(api.shopLicenses.removeLicense);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [licenseNumber, setLicenseNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [removing, setRemoving] = useState(false);

  const dmv = licenses?.find((l) => l.licenseType === DMV_LICENSE_TYPE) ?? null;

  async function handleFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !shopId) return;

    setError(null);
    if (file.size > MAX_BYTES) {
      setError("File is too large — max 15 MB.");
      return;
    }
    if (!ACCEPT.split(",").includes(file.type)) {
      setError("Upload a PDF or an image (PNG, JPG, or WebP).");
      return;
    }

    setUploading(true);
    try {
      const uploadUrl = await generateUploadUrl({ shopId });
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!res.ok) throw new Error("Upload failed. Please try again.");
      const { storageId } = (await res.json()) as { storageId?: string };
      if (!storageId) throw new Error("Upload did not return a storage id.");

      await addLicense({
        shopId,
        storageId: storageId as Id<"_storage">,
        licenseType: DMV_LICENSE_TYPE,
        originalFilename: file.name,
        mimeType: file.type || undefined,
        issuer: "NY DMV",
        licenseNumber: licenseNumber.trim() || undefined,
        expiresAt: expiry ? new Date(expiry).getTime() : undefined,
      });
      setLicenseNumber("");
      setExpiry("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to upload the document.",
      );
    } finally {
      setUploading(false);
    }
  }

  async function handleRemove() {
    if (!shopId || !dmv) return;
    setRemoving(true);
    setError(null);
    try {
      await removeLicense({
        shopId,
        licenseId: dmv._id as Id<"shop_licenses">,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove the document.");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="space-y-5">
      {showIntro && (
        <p className="text-sm leading-relaxed text-muted-foreground">
          New York requires a DMV inspection station license to run State
          Inspections or Emissions Tests. Upload yours and we&apos;ll confirm it
          before those services show up for customers.
        </p>
      )}

      {!shopId ? (
        <p className="rounded-xl border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
          Save your shop details first, then upload your license here.
        </p>
      ) : (
        <div className="rounded-xl border border-border bg-white p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="rounded-lg bg-primary/10 p-2 text-primary">
                <FileText className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {DMV_LICENSE_LABEL}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  PDF or image, up to 15 MB.
                </p>
              </div>
            </div>
            {dmv ? <StatusBadge status={dmv.reviewStatus} /> : null}
          </div>

          {dmv ? (
            <div className="mt-4 space-y-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                {dmv.url ? (
                  <a
                    href={dmv.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-primary hover:underline"
                  >
                    {dmv.originalFilename ?? "View document"}
                  </a>
                ) : (
                  <span className="text-muted-foreground">
                    {dmv.originalFilename ?? "Document"}
                  </span>
                )}
                {dmv.licenseNumber ? (
                  <span className="text-muted-foreground">
                    License #{dmv.licenseNumber}
                  </span>
                ) : null}
                {formatDate(dmv.expiresAt) ? (
                  <span className="text-muted-foreground">
                    Expires {formatDate(dmv.expiresAt)}
                  </span>
                ) : null}
              </div>

              {dmv.reviewStatus === "rejected" && dmv.reviewNote ? (
                <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    <span className="font-semibold">Rejected:</span> {dmv.reviewNote}{" "}
                    Please upload a corrected document.
                  </span>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="inline-flex items-center gap-2 rounded-lg border border-input bg-white px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
                >
                  {uploading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  Replace document
                </button>
                <button
                  type="button"
                  onClick={handleRemove}
                  disabled={removing}
                  className="inline-flex items-center gap-2 rounded-lg border border-destructive/20 px-3.5 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-60"
                >
                  {removing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                  Remove
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    License number (optional)
                  </label>
                  <input
                    type="text"
                    value={licenseNumber}
                    onChange={(e) => setLicenseNumber(e.target.value)}
                    placeholder="e.g. 7001234"
                    className="w-full rounded-lg border border-input bg-white px-3 py-2 text-sm text-foreground outline-none focus:border-transparent focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Expiration date (optional)
                  </label>
                  <input
                    type="date"
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value)}
                    className="w-full rounded-lg border border-input bg-white px-3 py-2 text-sm text-foreground outline-none focus:border-transparent focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-input bg-muted/40 px-4 py-6 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
              >
                {uploading ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Upload className="h-5 w-5 text-muted-foreground" />
                )}
                {uploading ? "Uploading…" : "Upload license (PDF or image)"}
              </button>
            </div>
          )}

          {error ? (
            <p className="mt-3 text-sm text-destructive">{error}</p>
          ) : null}
        </div>
      )}

      {shopId && !dmv && inspectionSelected ? (
        <p className="flex items-start gap-2 text-sm leading-relaxed text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span>
            Skip this and{" "}
            <span className="font-medium text-foreground">
              State Inspection &amp; Emissions Tests
            </span>{" "}
            stay off for customers until you upload this license — here, or later
            in Settings → Licenses.
          </span>
        </p>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={handleFileSelected}
      />
    </div>
  );
}
