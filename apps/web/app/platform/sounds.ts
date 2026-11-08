import { useThemeStore } from "./theme-store";

// Tiny synthesized UI sounds (no audio files). Off by default; only plays after a user
// gesture because browsers refuse audio before one anyway.
let ctx: AudioContext | null = null;

type Blip = "click" | "open" | "close" | "tada";

const NOTES: Record<Blip, Array<[freq: number, start: number, dur: number]>> = {
  click: [[880, 0, 0.03]],
  open: [[523, 0, 0.06], [784, 0.06, 0.08]],
  close: [[784, 0, 0.06], [392, 0.06, 0.08]],
  tada: [[523, 0, 0.09], [659, 0.09, 0.09], [784, 0.18, 0.09], [1047, 0.27, 0.2]],
};

export function playBlip(kind: Blip): void {
  const { sounds, soundScheme } = useThemeStore.getState().theme;
  if (!sounds || soundScheme === "silent") return;
  // Optional, gesture-driven haptic tick follows the same opt-in and Silent gate.
  try { if (typeof navigator !== "undefined") navigator.vibrate?.(8); } catch { /* Unsupported or blocked. */ }
  try {
    ctx ??= new AudioContext();
    const now = ctx.currentTime;
    for (const [freq, start, dur] of NOTES[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = soundScheme === "eightBit" ? "square" : "sine";
      osc.frequency.value = soundScheme === "eightBit" ? freq * 1.5 : freq;
      gain.gain.setValueAtTime(0.04, now + start);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.02);
    }
  } catch {
    // No audio support: stay silent.
  }
}
