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
  Plus,
  ShieldCheck,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import {
  DOCUMENT_GROUPS,
  DOCUMENT_TYPES,
  CUSTOM_GROUP_LABEL,
  isKnownDocumentType,
  type DocumentType,
} from "@/lib/license-catalog";

const DMV_LICENSE_TYPE = "dmv_inspection_station";
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

function validateFile(file: File): string | null {
  if (file.size > MAX_BYTES) return "File is too large — max 15 MB.";
  if (!ACCEPT.split(",").includes(file.type)) {
    return "Upload a PDF or an image (PNG, JPG, or WebP).";
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  One document card (known catalog type OR an existing custom row)    */
/* ------------------------------------------------------------------ */

function DocumentCard({
  shopId,
  typeKey,
  label,
  helper,
  issuerDefault,
  collectMeta = true,
  row,
}: {
  shopId: Id<"shops">;
  typeKey: string;
  label: string;
  helper?: string;
  issuerDefault?: string;
  collectMeta?: boolean;
  row: LicenseRow | null;
}) {
  const generateUploadUrl = useMutation(api.shopLicenses.generateUploadUrl);
  const addLicense = useMutation(api.shopLicenses.addLicense);
  const removeLicense = useMutation(api.shopLicenses.removeLicense);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [licenseNumber, setLicenseNumber] = useState("");
  const [expiry, setExpiry] = useState("");

  async function handleFileSelected(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    const invalid = validateFile(file);
    if (invalid) {
      setError(invalid);
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
        licenseType: typeKey,
        originalFilename: file.name,
        mimeType: file.type || undefined,
        issuer: issuerDefault,
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
    if (!row) return;
    setRemoving(true);
    setError(null);
    try {
      await removeLicense({
        shopId,
        licenseId: row._id as Id<"shop_licenses">,
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to remove the document.",
      );
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <FileText className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">{label}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {helper ? `${helper} ` : ""}PDF or image, up to 15 MB.
            </p>
          </div>
        </div>
        {row ? <StatusBadge status={row.reviewStatus} /> : null}
      </div>

      {row ? (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {row.url ? (
              <a
                href={row.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-primary hover:underline"
              >
                {row.originalFilename ?? "View document"}
              </a>
            ) : (
              <span className="text-muted-foreground">
                {row.originalFilename ?? "Document"}
              </span>
            )}
            {row.licenseNumber ? (
              <span className="text-muted-foreground">
                Ref #{row.licenseNumber}
              </span>
            ) : null}
            {formatDate(row.expiresAt) ? (
              <span className="text-muted-foreground">
                Expires {formatDate(row.expiresAt)}
              </span>
            ) : null}
          </div>

          {row.reviewStatus === "rejected" && row.reviewNote ? (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                <span className="font-semibold">Rejected:</span> {row.reviewNote}{" "}
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
          {collectMeta ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Reference / license # (optional)
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
          ) : null}
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
            {uploading ? "Uploading…" : "Upload document (PDF or image)"}
          </button>
        </div>
      )}

      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}

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

/* ------------------------------------------------------------------ */
/*  Add-a-custom-document form                                          */
/* ------------------------------------------------------------------ */

function AddCustomDocument({ shopId }: { shopId: Id<"shops"> }) {
  const generateUploadUrl = useMutation(api.shopLicenses.generateUploadUrl);
  const addLicense = useMutation(api.shopLicenses.addLicense);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFileSelected(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const label = name.trim();
    if (!label) {
      setError("Give the document a name first.");
      return;
    }
    if (isKnownDocumentType(label)) {
      setError("That name matches a standard document above — use its card.");
      return;
    }
    setError(null);
    const invalid = validateFile(file);
    if (invalid) {
      setError(invalid);
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

      // Custom docs store their human label directly as license_type.
      await addLicense({
        shopId,
        storageId: storageId as Id<"_storage">,
        licenseType: label,
        originalFilename: file.name,
        mimeType: file.type || undefined,
      });
      setName("");
      setOpen(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to upload the document.",
      );
    } finally {
      setUploading(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg border border-dashed border-input bg-white px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
      >
        <Plus className="h-4 w-4" />
        Add another document
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-white p-5">
      <p className="text-sm font-semibold text-foreground">Add a document</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Anything else that proves your shop is legit — a permit, membership, or
        award.
      </p>
      <div className="mt-4 space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Document name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Chamber of Commerce membership"
            className="w-full rounded-lg border border-input bg-white px-3 py-2 text-sm text-foreground outline-none focus:border-transparent focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || !name.trim()}
            className="inline-flex items-center gap-2 rounded-lg border border-input bg-white px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            {uploading ? "Uploading…" : "Upload file"}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setName("");
              setError(null);
            }}
            disabled={uploading}
            className="inline-flex items-center rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
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

/* ------------------------------------------------------------------ */
/*  Manager — one section per group + custom docs                       */
/* ------------------------------------------------------------------ */

export default function LicenseUploader({
  shopId,
  showIntro = true,
  inspectionSelected = false,
}: {
  shopId: Id<"shops"> | null | undefined;
  showIntro?: boolean;
  /** True when the shop has picked services that need the inspection license —
   *  surfaces a quiet "skip = stays off" note when nothing is uploaded yet. */
  inspectionSelected?: boolean;
}) {
  const licenses = useQuery(
    api.shopLicenses.listForShop,
    shopId ? { shopId } : "skip",
  ) as LicenseRow[] | undefined;

  if (!shopId) {
    return (
      <div className="space-y-5">
        {showIntro ? (
          <p className="text-sm leading-relaxed text-muted-foreground">
            Upload your licenses and certifications so we can confirm your shop
            is a legitimate business.
          </p>
        ) : null}
        <p className="rounded-xl border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
          Save your shop details first, then upload your documents here.
        </p>
      </div>
    );
  }

  const rowByType = new Map<string, LicenseRow>();
  for (const row of licenses ?? []) rowByType.set(row.licenseType, row);

  // Rows whose type isn't a known catalog key → rendered under "Other".
  const customRows = (licenses ?? []).filter(
    (r) => !isKnownDocumentType(r.licenseType),
  );

  const dmvRow = rowByType.get(DMV_LICENSE_TYPE) ?? null;

  return (
    <div className="space-y-8">
      {showIntro ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          Upload your licenses and certifications so we can confirm your shop is
          a legitimate business. Each document is reviewed before it&apos;s
          marked verified.
        </p>
      ) : null}

      {DOCUMENT_GROUPS.map(({ group, label }) => {
        const types = DOCUMENT_TYPES.filter(
          (t: DocumentType) => t.group === group,
        );
        if (types.length === 0) return null;
        return (
          <section key={group} className="space-y-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              {label}
            </h3>
            <div className="space-y-3">
              {types.map((t) => (
                <DocumentCard
                  key={t.key}
                  shopId={shopId}
                  typeKey={t.key}
                  label={t.label}
                  helper={t.helper}
                  issuerDefault={t.issuerDefault}
                  collectMeta={t.group !== "certification"}
                  row={rowByType.get(t.key) ?? null}
                />
              ))}
              {/* DMV service-gating note lives with the license that drives it. */}
              {group === "license" && !dmvRow && inspectionSelected ? (
                <p className="flex items-start gap-2 text-sm leading-relaxed text-muted-foreground">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span>
                    Skip the inspection license and{" "}
                    <span className="font-medium text-foreground">
                      State Inspection &amp; Emissions Tests
                    </span>{" "}
                    stay off for customers until it&apos;s uploaded and verified.
                  </span>
                </p>
              ) : null}
            </div>
          </section>
        );
      })}

      {/* ── Other / custom documents ── */}
      <section className="space-y-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          {CUSTOM_GROUP_LABEL}
        </h3>
        <div className="space-y-3">
          {customRows.map((row) => (
            <DocumentCard
              key={row._id}
              shopId={shopId}
              typeKey={row.licenseType}
              label={row.licenseType}
              collectMeta={false}
              row={row}
            />
          ))}
          <AddCustomDocument shopId={shopId} />
        </div>
      </section>
    </div>
  );
}
