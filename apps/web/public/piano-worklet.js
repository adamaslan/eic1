import { detectPitch } from './piano-dsp.js';
class PianoPitch extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(2048); this.filled = 0; this.hop = 0; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    this.buffer.copyWithin(0, input.length);
    this.buffer.set(input, this.buffer.length - input.length);
    this.filled += input.length; this.hop += input.length;
    if (this.filled >= this.buffer.length && this.hop >= 1024) {
      this.hop = 0;
      const start = currentTime;
      const pitch = detectPitch(this.buffer, sampleRate);
      this.port.postMessage({ pitch, windowMs: 2048 / sampleRate * 1000, audioTime: start });
    }
    return true;
  }
}
registerProcessor('piano-pitch', PianoPitch);
