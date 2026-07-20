"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import Cropper from "react-easy-crop";
import type { Area } from "react-easy-crop";
import { ImageIcon, Loader2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cropAreaToBlob } from "./crop-image";

// Mirrors convex/shops.ts OWNER_ROLES — UI gating only; the mutations
// enforce ownership server-side regardless.
const OWNER_ROLES = new Set(["owner", "shop_owner", "admin"]);
const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

export default function ShopLogoUploader({
  shopId,
  logoUrl,
  memberRole,
}: {
  shopId: Id<"shops">;
  logoUrl: string | null;
  memberRole?: string;
}) {
  const generateUploadUrl = useMutation(api.shops.generateShopLogoUploadUrl);
  const setShopLogo = useMutation(api.shops.setShopLogo);
  const clearShopLogo = useMutation(api.shops.clearShopLogo);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [sourceType, setSourceType] = useState("image/png");
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [areaPixels, setAreaPixels] = useState<Area | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [message, setMessage] = useState("");

  const canEdit = OWNER_ROLES.has(memberRole ?? "");

  // Revoke the temporary object URL when it's replaced or on unmount.
  useEffect(() => {
    return () => {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    };
  }, [sourceUrl]);

  function handlePickFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setMessage("");
    if (!ACCEPTED_TYPES.has(file.type)) {
      setMessage("Please choose a PNG, JPEG, or WebP image.");
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      setMessage("Image is too large — max 10 MB.");
      return;
    }
    setSourceType(file.type);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setAreaPixels(null);
    setDialogError("");
    setSourceUrl(URL.createObjectURL(file));
  }

  const onCropComplete = useCallback((_area: Area, croppedAreaPixels: Area) => {
    setAreaPixels(croppedAreaPixels);
  }, []);

  function closeDialog() {
    if (isSaving) return;
    setSourceUrl(null); // the effect above revokes the object URL
    setDialogError("");
  }

  async function handleSave() {
    if (!sourceUrl || !areaPixels) return;
    setIsSaving(true);
    setDialogError("");
    try {
      const blob = await cropAreaToBlob(sourceUrl, areaPixels, sourceType);
      const uploadUrl = await generateUploadUrl({ shopId });
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": blob.type },
        body: blob,
      });
      if (!response.ok) throw new Error(`Upload failed (${response.status}).`);
      const { storageId } = await response.json();
      await setShopLogo({ shopId, storageId });
      setSourceUrl(null);
      setMessage("Logo updated.");
    } catch (error: unknown) {
      setDialogError(error instanceof Error ? error.message : "Could not save the logo.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRemove() {
    setIsRemoving(true);
    setMessage("");
    try {
      await clearShopLogo({ shopId });
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "Could not remove the logo.");
    } finally {
      setIsRemoving(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-full border border-gray-200 bg-gray-100">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- Convex storage
          // URLs aren't in next.config images.remotePatterns; plain <img> by design.
          <img src={logoUrl} alt="Shop logo" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <ImageIcon className="h-6 w-6 text-gray-400" />
          </div>
        )}
        {(isSaving || isRemoving) && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70">
            <Loader2 className="h-5 w-5 animate-spin text-gray-500" />
          </div>
        )}
      </div>

      {canEdit && (
        <div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isSaving || isRemoving}
              className="text-sm font-medium text-blue-600 hover:underline disabled:opacity-60"
            >
              {logoUrl ? "Change logo" : "Upload logo"}
            </button>
            {logoUrl && (
              <button
                type="button"
                onClick={() => void handleRemove()}
                disabled={isSaving || isRemoving}
                className="text-sm font-medium text-red-600 hover:underline disabled:opacity-60"
              >
                Remove
              </button>
            )}
          </div>
          {message && <p className="mt-1 max-w-[200px] text-xs text-gray-600">{message}</p>}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={handlePickFile}
          />
        </div>
      )}

      {sourceUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6">
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-900">
              Crop logo
            </h3>
            <div className="relative h-72 w-full overflow-hidden rounded-lg bg-gray-900">
              <Cropper
                image={sourceUrl}
                crop={crop}
                zoom={zoom}
                aspect={1}
                cropShape="round"
                showGrid={false}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={onCropComplete}
              />
            </div>
            <div className="mt-4 flex items-center gap-3">
              <span className="text-xs text-gray-500">Zoom</span>
              <input
                type="range"
                min={1}
                max={3}
                step={0.05}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                disabled={isSaving}
                className="w-full"
              />
            </div>
            {dialogError && <p className="mt-3 text-sm text-red-600">{dialogError}</p>}
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={closeDialog}
                disabled={isSaving}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={isSaving || !areaPixels}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
              >
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Save logo
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
