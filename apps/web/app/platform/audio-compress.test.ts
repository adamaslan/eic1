import { afterEach, describe, expect, it, vi } from "vitest";
import { compressAudio } from "./audio-compress";

describe("compressAudio input byte bound", () => {
  it("rejects an over-256MB file before any decode or encoder work", async () => {
    const big = new File(["x"], "huge.mp3", { type: "audio/mpeg" });
    Object.defineProperty(big, "size", { value: 300 * 1024 * 1024 });
    await expect(compressAudio(big, { bitsPerSecond: 128_000 })).rejects.toThrow(/too large/);
  });
});

describe("conversion stall watchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rejects on a bounded wall-clock timeout when the context stops progressing, and clears its timers", async () => {
    vi.useFakeTimers();

    class FakeRecorder {
      static isTypeSupported() { return true; }
      state = "recording";
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(_stream: unknown, _opts: unknown) {}
      start() {}
      stop() { this.state = "inactive"; this.onstop?.(); }
    }

    class FakeContext {
      // A suspended context: the clock never advances and the source never ends.
      currentTime = 0;
      resume() { return Promise.resolve(); }
      close() { return Promise.resolve(); }
      decodeAudioData(_bytes: ArrayBuffer) { return Promise.resolve({ duration: 10 }); }
      createMediaStreamDestination() { return { stream: {} }; }
      createBufferSource() {
        return { buffer: null, onended: null, connect() {}, start() {}, stop() {} };
      }
    }

    vi.stubGlobal("MediaRecorder", FakeRecorder);
    vi.stubGlobal("AudioContext", FakeContext);
    vi.stubGlobal("window", {
      setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
      clearInterval: (id: Parameters<typeof clearInterval>[0]) => clearInterval(id),
    });

    const file = new File(["tiny"], "song.mp3", { type: "audio/mpeg" });
    const pending = compressAudio(file, { bitsPerSecond: 128_000 });
    const assertion = expect(pending).rejects.toThrow(/stalled/);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    // The finally block must clear both intervals so nothing leaks after the failure.
    expect(vi.getTimerCount()).toBe(0);
  });
});
