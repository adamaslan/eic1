import type { Bytes } from "@veil/core";
import type { ComposedMedia } from "@veil/features";
import {
  IMAGE_MAX_DIMENSION,
  IMAGE_QUALITY_LADDER,
  IMAGE_TARGET_BYTES,
  MAX_IMAGE_INPUT_BYTES,
  THUMB_MAX_DIMENSION,
  THUMB_QUALITY,
  fitWithin,
  reductionPercent,
} from "@veil/media";

export interface CompressedImage extends ComposedMedia {
  name: string;
  originalBytes: number;
  reducedPercent: number;
}

export class UnsupportedMediaError extends Error {}

// WebP where the browser can encode it, JPEG otherwise (Safari's canvas cannot write WebP).
function pickMime(): "image/webp" | "image/jpeg" {
  const probe = document.createElement("canvas");
  probe.width = probe.height = 1;
  return probe.toDataURL("image/webp").startsWith("data:image/webp") ? "image/webp" : "image/jpeg";
}

async function encode(bitmap: ImageBitmap, maxDimension: number, mime: string, quality: number): Promise<Bytes> {
  const { width, height } = fitWithin({ width: bitmap.width, height: bitmap.height }, maxDimension);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new UnsupportedMediaError("This browser cannot process images.");
  context.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality));
  if (!blob) throw new UnsupportedMediaError("This browser could not encode the image.");
  return new Uint8Array(await blob.arrayBuffer());
}

// Re-encoding through a canvas also drops EXIF (including GPS) from the stored copy.
export async function compressImage(
  file: File,
  onProgress?: (phase: string, percent: number) => void,
): Promise<CompressedImage> {
  if (file.type.startsWith("video/")) {
    throw new UnsupportedMediaError("Video is not supported yet. Pick a photo.");
  }
  if (!file.type.startsWith("image/")) {
    throw new UnsupportedMediaError(`${file.name} is not an image.`);
  }
  if (file.size > MAX_IMAGE_INPUT_BYTES) {
    throw new UnsupportedMediaError(`${file.name} is over ${MAX_IMAGE_INPUT_BYTES / 1024 / 1024} MB.`);
  }

  const mime = pickMime();
  onProgress?.("Reading file…", 10);
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new UnsupportedMediaError(`${file.name} could not be opened as an image.`);
  });
  try {
    onProgress?.("Compressing…", 30);
    let bytes: Bytes = await encode(bitmap, IMAGE_MAX_DIMENSION, mime, IMAGE_QUALITY_LADDER[0]);
    for (const quality of IMAGE_QUALITY_LADDER.slice(1)) {
      if (bytes.byteLength <= IMAGE_TARGET_BYTES) break;
      bytes = await encode(bitmap, IMAGE_MAX_DIMENSION, mime, quality);
    }
    onProgress?.("Building thumbnail…", 80);
    const thumb = await encode(bitmap, THUMB_MAX_DIMENSION, mime, THUMB_QUALITY);
    onProgress?.("Done", 100);
    return {
      name: file.name,
      bytes,
      thumb,
      mime,
      originalBytes: file.size,
      reducedPercent: reductionPercent(file.size, bytes.byteLength),
    };
  } finally {
    bitmap.close();
  }
}
