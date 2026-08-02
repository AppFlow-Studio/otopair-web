// Renders the user's chosen crop of a source image to a square Blob for
// upload. Kept separate from the uploader component so the canvas math is
// isolated from React state.

export type CropAreaPixels = { x: number; y: number; width: number; height: number };

// The map card renders 56px and the settings avatar 64px — 512px output is
// plenty while keeping files far below the 2 MB contract cap.
const OUTPUT_MAX_PX = 512;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not read that image file."));
    image.src = src; // object URL — same-origin, no crossOrigin needed
  });
}

export async function cropAreaToBlob(
  sourceUrl: string,
  area: CropAreaPixels,
  sourceType: string,
): Promise<Blob> {
  const image = await loadImage(sourceUrl);
  // Modern browsers apply EXIF orientation when decoding, so `area` (from
  // react-easy-crop, measured on the displayed image) maps 1:1 onto
  // drawImage source coordinates.
  const size = Math.max(1, Math.round(Math.min(OUTPUT_MAX_PX, area.width)));
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable in this browser.");
  ctx.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, size, size);

  // JPEG for opaque photos (small files); PNG for formats that may carry
  // transparency (png/webp sources) so logos keep their alpha channel.
  const outputType = sourceType === "image/jpeg" ? "image/jpeg" : "image/png";
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, outputType, 0.9),
  );
  if (!blob) throw new Error("Could not process the cropped image.");
  return blob;
}
