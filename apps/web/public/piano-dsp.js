// Local monophonic YIN pitch estimate. Shared verbatim by worklet and fixture tests.
export function detectPitch(samples, sampleRate) {
  const size = Math.floor(samples.length / 2);
  let energy = 0;
  for (const x of samples) energy += x * x;
  const rms = Math.sqrt(energy / samples.length);
  if (rms < 0.012) return null;
  const min = Math.floor(sampleRate / 1050), max = Math.min(size - 1, Math.ceil(sampleRate / 65));
  const diff = new Float32Array(max + 1);
  for (let tau = 1; tau <= max; tau++) {
    let sum = 0;
    for (let i = 0; i < size; i++) { const d = samples[i] - samples[i + tau]; sum += d * d; }
    diff[tau] = sum;
  }
  let running = 0;
  diff[0] = 1;
  for (let tau = 1; tau <= max; tau++) { running += diff[tau]; diff[tau] = running ? diff[tau] * tau / running : 1; }
  for (let tau = Math.max(2, min); tau < max; tau++) {
    if (diff[tau] < 0.12) {
      while (tau + 1 < max && diff[tau + 1] < diff[tau]) tau++;
      const a = diff[tau - 1], b = diff[tau], c = diff[tau + 1];
      const offset = (a - c) / (2 * (a - 2 * b + c)) || 0;
      const hz = sampleRate / (tau + Math.max(-1, Math.min(1, offset)));
      return hz >= 65 && hz <= 1050 ? { hz, confidence: 1 - b, rms } : null;
    }
  }
  return null;
}
