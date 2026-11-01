// On-device audio shrinking. Decoding and encoding happen entirely in the browser:
// no upload, no service, and the original File is never modified. Encoding runs through
// MediaRecorder, which muxes the container for us; it works in wall-clock time, so a
// 3-minute song takes about 3 minutes. The UI shows the estimate before starting.

export interface CompressTarget {
  mimeType: string;
  extension: string;
  label: string;
}

// First supported wins. AAC-in-MP4 plays in every current browser; Opus-in-WebM is the
// Chromium fallback (Safari cannot play WebM audio, so it is only offered where produced).
const CANDIDATES: CompressTarget[] = [
  { mimeType: "audio/mp4", extension: "m4a", label: "M4A (AAC)" },
  { mimeType: "audio/webm;codecs=opus", extension: "webm", label: "WebM (Opus)" },
  { mimeType: "audio/webm", extension: "webm", label: "WebM" },
];

export function pickCompressTarget(): CompressTarget | null {
  if (typeof MediaRecorder === "undefined") return null;
  return CANDIDATES.find((c) => MediaRecorder.isTypeSupported(c.mimeType)) ?? null;
}

/** Estimated output bytes at a bitrate, shown before the user commits to converting. */
export function estimateCompressedBytes(durationSeconds: number, bitsPerSecond: number): number {
  return Math.ceil((durationSeconds * bitsPerSecond) / 8);
}

export const COMPRESS_BITRATES = [
  { bits: 96_000, label: "96 kbps - smallest, speech-ish" },
  { bits: 128_000, label: "128 kbps - good music quality" },
  { bits: 192_000, label: "192 kbps - better music quality" },
] as const;

export interface CompressOutcome {
  file: File;
  originalBytes: number;
}

/**
 * Re-encodes one audio file at the chosen bitrate. Plays the decoded buffer into a
 * MediaRecorder in realtime; onProgress reports 0..1. Throws with an honest message on
 * files the browser cannot decode. The source file is left untouched.
 */
export async function compressAudio(
  file: File,
  opts: { bitsPerSecond: number; onProgress?: (fraction: number) => void },
): Promise<CompressOutcome> {
  const target = pickCompressTarget();
  if (!target) throw new Error("This browser cannot re-encode audio. Try Chrome, Edge or Safari 14.1+.");

  const bytes = await file.arrayBuffer();
  const ctx = new AudioContext();
  try {
    await ctx.resume();
    let decoded: AudioBuffer;
    try {
      decoded = await ctx.decodeAudioData(bytes);
    } catch {
      throw new Error(`"${file.name}" could not be decoded by this browser.`);
    }
    const dest = ctx.createMediaStreamDestination();
    const recorder = new MediaRecorder(dest.stream, {
      mimeType: target.mimeType,
      audioBitsPerSecond: opts.bitsPerSecond,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    const source = ctx.createBufferSource();
    source.buffer = decoded;
    source.connect(dest);
    const ended = new Promise<void>((resolve) => {
      source.onended = () => resolve();
    });
    recorder.start(250);
    source.start();
    const tick = window.setInterval(() => {
      opts.onProgress?.(Math.min(1, ctx.currentTime / decoded.duration));
    }, 250);
    await ended;
    // Let the recorder drain the tail of the stream before stopping.
    await new Promise((r) => setTimeout(r, 300));
    recorder.stop();
    await stopped;
    window.clearInterval(tick);
    const blob = new Blob(chunks, { type: target.mimeType });
    if (blob.size === 0) throw new Error("That conversion produced nothing - the browser encoder failed.");
    const base = file.name.replace(/\.[^./\\]+$/, "");
    return { file: new File([blob], `${base}.${target.extension}`, { type: target.mimeType }), originalBytes: file.size };
  } finally {
    void ctx.close();
  }
}
