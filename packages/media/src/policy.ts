// Compression policy shared by every platform, so a post made on the phone
// and one made on the web end up about the same size.
export const IMAGE_MAX_DIMENSION = 1920;
export const IMAGE_TARGET_BYTES = 600 * 1024;
// Tried in order until the encoded image fits IMAGE_TARGET_BYTES; the last one is kept regardless.
export const IMAGE_QUALITY_LADDER = [0.85, 0.7, 0.55, 0.4] as const;

export const THUMB_MAX_DIMENSION = 320;
export const THUMB_QUALITY = 0.7;

export const MAX_IMAGE_INPUT_BYTES = 25 * 1024 * 1024;
export const MAX_MEDIA_PER_ITEM = 6;

export interface Size {
  width: number;
  height: number;
}

/** Scales down to fit inside a square of `maxDimension`. Never upscales. */
export function fitWithin(size: Size, maxDimension: number): Size {
  const longest = Math.max(size.width, size.height);
  if (longest <= maxDimension) return { width: size.width, height: size.height };
  const scale = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/** Whole-number percent saved. 0 when the output is not smaller. */
export function reductionPercent(originalBytes: number, compressedBytes: number): number {
  if (originalBytes <= 0 || compressedBytes >= originalBytes) return 0;
  return Math.round((1 - compressedBytes / originalBytes) * 100);
}
