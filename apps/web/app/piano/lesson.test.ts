import { describe, expect, it } from 'vitest';
import { LESSONS, gatePitch, newGate, noteName, readPitch } from './lesson';
// @ts-expect-error Shared public AudioWorklet module is plain JS.
import { detectPitch } from '../../public/piano-dsp.js';
const rate = 48000;
function wave(hz: number, harmonics = false, sampleRate = rate) {
  return Float32Array.from({ length: 2048 }, (_, i) => {
    const t = i / sampleRate;
    return 0.2 * Math.sin(2 * Math.PI * hz * t) + (harmonics ? 0.13 * Math.sin(4 * Math.PI * hz * t) + 0.05 * Math.sin(6 * Math.PI * hz * t) : 0);
  });
}
describe('real pitch detector at AudioWorklet window size', () => {
  it('detects every lesson note at exact octave, also with piano-like harmonics', () => {
    for (const midi of new Set(LESSONS.flatMap(l => l.notes))) {
      const hz = 440 * 2 ** ((midi - 69) / 12);
      for (const rich of [false, true]) {
        const result = detectPitch(wave(hz, rich), rate);
        expect(result, `midi${midi}`).not.toBeNull();
        expect(readPitch(result.hz)?.midi).toBe(midi);
        expect(Math.abs(readPitch(result.hz)!.cents)).toBeLessThan(12);
      }
    }
  });
  it('covers the advertised C2-C6 range at common device sample rates', () => {
    for (const sampleRate of [44100, 48000]) for (let midi = 36; midi <= 84; midi++) {
      const result = detectPitch(wave(440 * 2 ** ((midi - 69) / 12), true, sampleRate), sampleRate);
      expect(result, `${sampleRate} Hz / MIDI ${midi}`).not.toBeNull();
      expect(readPitch(result.hz)?.midi).toBe(midi);
    }
  });
  it('rejects silence and deterministic broadband noise', () => {
    expect(detectPitch(new Float32Array(2048), rate)).toBeNull();
    let seed = 123;
    const noise = Float32Array.from({ length: 2048 }, () => { seed = (1664525 * seed + 1013904223) >>> 0; return (seed / 2 ** 32 - 0.5) * 0.5; });
    expect(detectPitch(noise, rate)).toBeNull();
  });
});
describe('honest progression', () => {
  it('does not count held notes twice; requires a release or a different stable pitch', () => {
    const g = newGate(), c = { midi: 60, cents: 0 };
    expect(gatePitch(g, c)).toBeNull(); expect(gatePitch(g, c)).toBe(60);
    for (let i = 0; i < 30; i++) expect(gatePitch(g, c)).toBeNull();
    for (let i = 0; i < 4; i++) gatePitch(g, null);
    gatePitch(g, c); expect(gatePitch(g, c)).toBe(60);
    gatePitch(g, { midi: 62, cents: 0 }); expect(gatePitch(g, { midi: 62, cents: 0 })).toBe(62);
  });
  it('rejects invalid pitch and detuned estimates and keeps explicit octaves in all drills', () => {
    expect(readPitch(NaN)).toBeNull(); expect(readPitch(0)).toBeNull();
    const g = newGate(); for (let i = 0; i < 10; i++) expect(gatePitch(g, { midi: 60, cents: 49 })).toBeNull();
    expect(noteName(36)).toBe('C2'); expect(noteName(60)).toBe('C4');
    expect(new Set(LESSONS.map(l => l.id)).size).toBe(LESSONS.length);
    for (const l of LESSONS) expect(l.notes.every(m => m >= 36 && m <= 84)).toBe(true);
  });
});
