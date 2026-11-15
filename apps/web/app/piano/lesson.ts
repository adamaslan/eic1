export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (midi: number) => `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
export function readPitch(hz: number) {
  if (!Number.isFinite(hz) || hz <= 0) return null;
  const exact = 69 + 12 * Math.log2(hz / 440), midi = Math.round(exact);
  return { midi, cents: Math.round((exact - midi) * 100) };
}
export type Lesson = { id: string; title: string; block: string; week: string; cue: string; notes: number[]; tip: string };
export const LESSONS: Lesson[] = [
  { id: 'landmarks', title: 'Find home without looking', block: '1 · Tactile warm-up', week: 'Weeks 1–2', cue: 'Find the twins (two black keys). C is just to their left. Play C, then F beside the triplets, then G, A and home.', notes: [48, 53, 55, 57, 48], tip: 'Touch the black-key groups gently on a real keyboard. The screen teaches the route; it cannot assess eyes-closed technique.' },
  { id: 'anchor', title: 'Heavy anchor', block: '2 · Left-hand bass', week: 'Weeks 1–2', cue: 'Play C2 four times, relaxed and even. Lift between notes. Then move to F2, G2 and home. Start around 60 BPM.', notes: [36, 36, 36, 36, 41, 41, 43, 43, 36], tip: 'Single upper bass notes adapt the plan’s octaves for note-by-note microphone practice. Accent beats 1 and 3 yourself; dynamics and timing are not graded.' },
  { id: 'voice-leading', title: 'Keep C as your pivot', block: '1 · Voice-leading', week: 'Weeks 1–2', cue: 'Explore C–E–G, then C–F–A, then C–E–G, then B–D–G. Play each shape one note at a time here.', notes: [60, 64, 67, 60, 65, 69, 60, 64, 67, 59, 62, 67], tip: 'On your piano, turn the notes into chords after this drill. Microphone mode checks single notes, not full chords.' },
  { id: 'walk', title: 'Walk into the next chord', block: '2 · Alternating bass', week: 'Weeks 3–4', cue: 'C–G–C–E leads toward F. Then F–C–F–F# leads toward G. Keep a loose wrist.', notes: [36, 43, 48, 40, 41, 36, 41, 42, 43], tip: 'The low F1 from the source is moved to F2 for this C2+ drill. Octave ranges are shown explicitly, not silently treated as interchangeable.' },
  { id: 'sus', title: 'A small sus-chord wave', block: '3 · Syncopation & inner voices', week: 'Weeks 3–4', cue: 'Hear the top voice change E–D–E while C stays home. Then try B–C–B–A–B over G on your piano.', notes: [64, 62, 64, 59, 60, 59, 57, 59], tip: 'Try the and-of-2 push after the notes feel easy. This version advances on pitch, not rhythmic accuracy.' },
  { id: 'chromatic', title: 'A descending bass story', block: '2 · Chromatic line', week: 'Weeks 5–8', cue: 'Walk A–G#–G–F#–F–E–D–E. Let each note lead into the next, without rushing.', notes: [45, 44, 43, 42, 41, 40, 38, 40], tip: 'The source pairs this bass with Am, Am/G#, Am/G, D7/F#, Fmaj7, C/E, Dm7, E7. Practice the chord shapes separately; chord recognition is not enabled.' },
];
// Pure edge/stability gate. Sustaining one note never solves repeated targets.
export function newGate() { return { candidate: -1, frames: 0, held: -1, quiet: 0 }; }
export type Gate = ReturnType<typeof newGate>;
export function gatePitch(gate: Gate, pitch: { midi: number; cents: number } | null) {
  if (!pitch) {
    gate.quiet++; gate.frames = 0; gate.candidate = -1;
    if (gate.quiet >= 4) gate.held = -1;
    return null;
  }
  gate.quiet = 0;
  if (Math.abs(pitch.cents) > 40) { gate.frames = 0; return null; }
  if (gate.candidate !== pitch.midi) { gate.candidate = pitch.midi; gate.frames = 0; }
  gate.frames++;
  if (gate.frames >= 2 && gate.held !== pitch.midi) { gate.held = pitch.midi; return pitch.midi; }
  return null;
}
