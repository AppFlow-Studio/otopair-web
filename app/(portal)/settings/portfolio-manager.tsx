"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ChevronLeft, ChevronRight, ImagePlus, Loader2, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

// Mirrors convex/shops.ts OWNER_ROLES and convex/shop_portfolio.ts limits —
// UI gating only; the mutations enforce ownership and caps server-side.
const OWNER_ROLES = new Set(["owner", "shop_owner", "admin"]);
const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_PORTFOLIO_IMAGES = 12;
const MAX_CAPTION_LENGTH = 200;

export default function PortfolioManager({
  shopId,
  memberRole,
}: {
  shopId: Id<"shops">;
  memberRole?: string;
}) {
  const images = useQuery(api.shop_portfolio.listByShopId, { shopId });
  const generateUploadUrl = useMutation(api.shop_portfolio.generateUploadUrl);
  const addImage = useMutation(api.shop_portfolio.addImage);
  const removeImage = useMutation(api.shop_portfolio.removeImage);
  const setCaption = useMutation(api.shop_portfolio.setCaption);
  const reorder = useMutation(api.shop_portfolio.reorder);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [captionDrafts, setCaptionDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");

  const canEdit = OWNER_ROLES.has(memberRole ?? "");
  const isUploading = uploadProgress !== null;
  const count = images?.length ?? 0;

  async function handlePickFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = ""; // allow re-picking the same files
    if (files.length === 0) return;
    setMessage("");

    const room = MAX_PORTFOLIO_IMAGES - count;
    const failures: string[] = [];
    const queue = files.slice(0, Math.max(room, 0));
    if (files.length > queue.length) {
      failures.push(`${files.length - queue.length} skipped — max ${MAX_PORTFOLIO_IMAGES} photos.`);
    }

    // Sequential on purpose: uploads share bandwidth anyway, per-file failures
    // stay attributable, and the server cap can't be raced by parallel adds.
    let done = 0;
    setUploadProgress({ done, total: queue.length });
    for (const file of queue) {
      try {
        if (!ACCEPTED_TYPES.has(file.type)) throw new Error("not a PNG, JPEG, or WebP");
        if (file.size > MAX_SOURCE_BYTES) throw new Error("over 10 MB");
        const uploadUrl = await generateUploadUrl({ shopId });
        const response = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": file.type },
          body: file,
        });
        if (!response.ok) throw new Error(`upload failed (${response.status})`);
        const { storageId } = await response.json();
        await addImage({ shopId, storageId });
      } catch (error: unknown) {
        failures.push(
          `${file.name}: ${error instanceof Error ? error.message : "could not upload"}`,
        );
      }
      done += 1;
      setUploadProgress({ done, total: queue.length });
    }
    setUploadProgress(null);
    setMessage(
      failures.length > 0
        ? `Some photos were not added — ${failures.join("; ")}`
        : "Photos added.",
    );
  }

  async function handleRemove(portfolioId: Id<"shop_portfolio">) {
    setBusyId(String(portfolioId));
    setMessage("");
    try {
      await removeImage({ shopId, portfolioId });
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "Could not remove the photo.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleMove(index: number, direction: -1 | 1) {
    if (!images) return;
    const target = index + direction;
    if (target < 0 || target >= images.length) return;
    const ids = images.map((image) => image._id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setBusyId(String(images[index]._id));
    setMessage("");
    try {
      await reorder({ shopId, orderedIds: ids });
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "Could not reorder photos.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleCaptionBlur(portfolioId: Id<"shop_portfolio">, original: string) {
    const draft = captionDrafts[String(portfolioId)];
    if (draft === undefined || draft.trim() === original.trim()) return;
    setBusyId(String(portfolioId));
    try {
      await setCaption({ shopId, portfolioId, caption: draft });
      setCaptionDrafts((drafts) => {
        const next = { ...drafts };
        delete next[String(portfolioId)];
        return next;
      });
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "Could not save the caption.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">
          Photo Gallery
        </h2>
        <span className="text-xs text-gray-400">
          {count} / {MAX_PORTFOLIO_IMAGES} photos
        </span>
      </div>
      <p className="mb-4 text-sm text-gray-500">
        Show customers the cars you&apos;ve worked on. Photos appear on your shop&apos;s public
        profile in the order below.
      </p>

      {images === undefined ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {images.map((image, index) => (
            <figure key={String(image._id)} className="group">
              <div className="relative aspect-[4/3] overflow-hidden rounded-lg border border-gray-200 bg-gray-100">
                {/* eslint-disable-next-line @next/next/no-img-element -- Convex storage
                    URLs aren't in next.config images.remotePatterns; plain <img> by design. */}
                <img
                  src={image.url ?? ""}
                  alt={image.caption ?? "Shop portfolio photo"}
                  className="h-full w-full object-cover"
                />
                {busyId === String(image._id) && (
                  <div className="absolute inset-0 flex items-center justify-center bg-white/70">
                    <Loader2 className="h-5 w-5 animate-spin text-gray-500" />
                  </div>
                )}
                {canEdit && (
                  <div className="absolute inset-x-0 top-0 flex justify-between p-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <div className="flex gap-1">
                      <button
                        type="button"
                        aria-label="Move photo earlier"
                        onClick={() => void handleMove(index, -1)}
                        disabled={index === 0 || busyId !== null || isUploading}
                        className="rounded-md bg-white/90 p-1 text-gray-700 shadow-sm hover:bg-white disabled:opacity-40"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        aria-label="Move photo later"
                        onClick={() => void handleMove(index, 1)}
                        disabled={index === images.length - 1 || busyId !== null || isUploading}
                        className="rounded-md bg-white/90 p-1 text-gray-700 shadow-sm hover:bg-white disabled:opacity-40"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                    <button
                      type="button"
                      aria-label="Remove photo"
                      onClick={() => void handleRemove(image._id)}
                      disabled={busyId !== null || isUploading}
                      className="rounded-md bg-white/90 p-1 text-red-600 shadow-sm hover:bg-white disabled:opacity-40"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
              {canEdit ? (
                <input
                  type="text"
                  maxLength={MAX_CAPTION_LENGTH}
                  placeholder="Add a caption…"
                  value={captionDrafts[String(image._id)] ?? image.caption ?? ""}
                  onChange={(e) =>
                    setCaptionDrafts((drafts) => ({
                      ...drafts,
                      [String(image._id)]: e.target.value,
                    }))
                  }
                  onBlur={() => void handleCaptionBlur(image._id, image.caption ?? "")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  className="mt-1.5 w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-xs text-gray-700 outline-none transition-colors placeholder:text-gray-400 hover:border-gray-200 focus:border-blue-500 focus:bg-white"
                />
              ) : image.caption ? (
                <figcaption className="mt-1.5 px-1 text-xs text-gray-600">{image.caption}</figcaption>
              ) : null}
            </figure>
          ))}

          {canEdit && count < MAX_PORTFOLIO_IMAGES && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-gray-300 text-gray-400 transition-colors hover:border-blue-400 hover:text-blue-500 disabled:opacity-60"
            >
              {isUploading ? (
                <>
                  <Loader2 className="h-6 w-6 animate-spin" />
                  <span className="text-xs font-medium">
                    Uploading {Math.min(uploadProgress.done + 1, uploadProgress.total)} of{" "}
                    {uploadProgress.total}…
                  </span>
                </>
              ) : (
                <>
                  <ImagePlus className="h-6 w-6" />
                  <span className="text-xs font-medium">Add photos</span>
                </>
              )}
            </button>
          )}

          {!canEdit && count === 0 && (
            <p className="col-span-full text-sm text-gray-400">No photos yet.</p>
          )}
        </div>
      )}

      {message && <p className="mt-3 text-xs text-gray-600">{message}</p>}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={(e) => void handlePickFiles(e)}
      />
    </div>
  );
}
