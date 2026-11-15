import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Window } from '~/ui95/Window';
import { LESSONS, gatePitch, newGate, noteName, readPitch } from '~/piano/lesson';
import './learn-piano.css';

type Mic = { stream: MediaStream; context: AudioContext; node: AudioWorkletNode; source: MediaStreamAudioSourceNode; mute: GainNode };
export function meta() { return [{ title: 'Piano room · Everybody is Cool' }, { name: 'description', content: 'A playful piano practice room with a touch keyboard and optional local single-note listening.' }]; }
export default function LearnPiano() {
  const [lessonIndex, setLessonIndex] = useState(0), [step, setStep] = useState(0);
  const [mode, setMode] = useState<'touch' | 'mic'>('touch');
  const [listening, setListening] = useState(false), [pending, setPending] = useState(false);
  const [message, setMessage] = useState('Touch mode. Tap a key to begin.'), [heard, setHeard] = useState('No note yet');
  const [octave, setOctave] = useState(3), [active, setActive] = useState<number | null>(null);
  const [windowMs, setWindowMs] = useState<number | null>(null), [demo, setDemo] = useState(false);
  const [bpm, setBpm] = useState(60), [beat, setBeat] = useState(0), [pulse, setPulse] = useState(false);
  const startingContext = useRef<AudioContext | null>(null);
  const mic = useRef<Mic | null>(null), token = useRef(0), gate = useRef(newGate());
  const tone = useRef<AudioContext | null>(null), state = useRef({ lessonIndex, step, mode });
  state.current = { lessonIndex, step, mode };
  const lesson = LESSONS[lessonIndex], complete = step >= lesson.notes.length, target = lesson.notes[step];
  const accept = useRef<(midi: number) => void>(() => {});
  accept.current = (midi) => {
    const current = state.current, notes = LESSONS[current.lessonIndex].notes;
    if (current.step >= notes.length) return;
    if (notes[current.step] !== midi) { setMessage(`Heard ${noteName(midi)}. Try ${noteName(notes[current.step])}.`); return; }
    const next = current.step + 1;
    state.current = { ...current, step: next };
    setStep(next);
    if (next === notes.length && current.mode === 'mic') stopMic();
    setMessage(next === notes.length ? 'Phrase complete! Try it on your piano, then choose another drill.' : `Nice. Next: ${noteName(notes[next])}.`);
    if (next < notes.length) setOctave(Math.floor(notes[next] / 12) - 1);
  };
  function releaseResources() {
    token.current++;
    const starting = startingContext.current; startingContext.current = null;
    if (starting && starting.state !== 'closed') void starting.close().catch(() => {});
    const current = mic.current;
    mic.current = null;
    if (current) {
      current.node.port.onmessage = null;
      current.stream.getTracks().forEach(t => { t.onended = null; t.stop(); });
      current.source.disconnect(); current.node.disconnect(); current.mute.disconnect();
      void current.context.close().catch(() => {});
    }
    gate.current = newGate();
  }
  function stopMic() { releaseResources(); setListening(false); setPending(false); setWindowMs(null); }
  useEffect(() => {
    function hidden() {
      if (document.hidden) {
        releaseResources(); setListening(false); setPending(false); setPulse(false);
        void tone.current?.close().catch(() => {}); tone.current = null;
        setMessage('Audio stopped while this page is hidden. Start again when ready.');
      }
    }
    document.addEventListener('visibilitychange', hidden);
    return () => { document.removeEventListener('visibilitychange', hidden); releaseResources(); void tone.current?.close().catch(() => {}); };
  }, []);
  useEffect(() => {
    if (!pulse) return;
    const interval = window.setInterval(() => setBeat(b => (b + 1) % 4), 60000 / bpm);
    return () => window.clearInterval(interval);
  }, [pulse, bpm]);
  function choose(index: number) {
    stopMic(); setPulse(false); setLessonIndex(index); setStep(0); setHeard('No note yet');
    setOctave(Math.floor(LESSONS[index].notes[0] / 12) - 1);
    setMessage('New drill. Progress stays in this session only.');
  }
  async function startMic() {
    stopMic(); setPending(true);
    const id = token.current;
    let stream: MediaStream | null = null, context: AudioContext | null = null;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) throw new Error('unsupported');
      // Start/resume AudioContext in the gesture, before the permission request resolves.
      context = new AudioContext({ latencyHint: 'interactive' });
      startingContext.current = context;
      await context.resume();
      if (id !== token.current) { if (context.state !== 'closed') await context.close(); return; }
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      if (id !== token.current) { stream.getTracks().forEach(t => t.stop()); await context.close(); return; }
      await context.audioWorklet.addModule('/piano-worklet.js');
      if (id !== token.current) { stream.getTracks().forEach(t => t.stop()); await context.close(); return; }
      const source = context.createMediaStreamSource(stream), node = new AudioWorkletNode(context, 'piano-pitch'), mute = context.createGain();
      mute.gain.value = 0;
      source.connect(node); node.connect(mute); mute.connect(context.destination);
      startingContext.current = null;
      mic.current = { stream, context, node, source, mute };
      for (const track of stream.getTracks()) track.onended = () => { stopMic(); setMessage('Microphone disconnected. Reconnect it or use Touch mode.'); };
      node.onprocessorerror = () => { stopMic(); setMessage('Listening stopped after an audio error. Use Touch mode or try again.'); };
      node.port.onmessage = ({ data }) => {
        if (id !== token.current) return;
        const pitch = data.pitch?.confidence >= 0.88 ? readPitch(data.pitch.hz) : null;
        setHeard(pitch ? `${noteName(pitch.midi)} · ${pitch.cents > 0 ? '+' : ''}${pitch.cents} cents` : 'Quiet / no stable single note');
        setWindowMs(data.windowMs);
        const edge = gatePitch(gate.current, pitch);
        if (edge !== null && state.current.mode === 'mic') accept.current(edge);
      };
      setListening(true); setPending(false); setMessage('Listening locally. Play one clean note, then lift. No chords or singing while checking pitch.');
    } catch (error) {
      stream?.getTracks().forEach(t => t.stop());
      if (context && context.state !== 'closed') await context.close().catch(() => {});
      if (id !== token.current) return;
      startingContext.current = null;
      setPending(false); setListening(false);
      setMessage(error instanceof Error && error.message === 'unsupported' ? 'Microphone listening needs HTTPS and AudioWorklet support. Touch mode still works.' : 'Microphone could not start. Check browser permission and your input device, or use Touch mode.');
    }
  }
  async function play(midi: number) {
    if (mode !== 'touch' || complete) return;
    setActive(midi); accept.current(midi);
    if (!demo) return;
    try {
      if (!tone.current || tone.current.state === 'closed') tone.current = new AudioContext({ latencyHint: 'interactive' });
      const context = tone.current;
      await context.resume();
      if (context.state === 'closed') return;
      const oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.frequency.value = 440 * 2 ** ((midi - 69) / 12); oscillator.type = 'triangle';
      gain.gain.setValueAtTime(0.001, context.currentTime); gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.01); gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.25);
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.27);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    } catch { setMessage('Touch input worked, but your browser could not play the demo tone.'); }
  }
  const white = [0, 2, 4, 5, 7, 9, 11], black = [[1, 1], [3, 2], [6, 4], [8, 5], [10, 6]];
  const base = (octave + 1) * 12;
  function key(midi: number, dark: boolean, position?: number) {
    return <button key={midi} type="button" className={`piano-key ${dark ? 'piano-black' : 'piano-white'} ${midi === target ? 'piano-target' : ''} ${midi === active ? 'piano-played' : ''}`} style={dark ? { left: `calc(${position! / 7 * 100}% - 22px)` } : undefined} aria-label={`Play ${noteName(midi)}`} aria-disabled={mode !== 'touch' || complete} onPointerDown={(e) => { if (e.pointerType === 'mouse' && e.button !== 0) return; e.preventDefault(); e.currentTarget.focus(); void play(midi); }} onClick={(e) => { if (e.detail === 0) void play(midi); }}><span>{noteName(midi)}</span></button>;
  }
  return <main className="piano-room w95-desktop"><div className="piano-shell"><Link className="piano-home" to="/">← EIC home</Link>
    <div className="piano-global-mic">{(listening || pending) && <button type="button" onClick={() => { stopMic(); setMessage("Microphone off."); }}>Microphone {pending ? "request pending" : "on"} · Stop</button>}</div>
    <Window title={listening ? "Piano room.exe · microphone on" : "Piano room.exe"}><div className="piano-stack"><header><p className="piano-eyebrow">SINGER-SONGWRITER LAB</p><h1>Piano, one small phrase at a time.</h1><p>Find the shape. Hear the movement. Make room for your voice.</p></header>
      <label className="piano-label">Practice room<select value={lessonIndex} onChange={e => choose(Number(e.target.value))}>{LESSONS.map((l, i) => <option key={l.id} value={i}>{l.title}</option>)}</select></label>
      <div className="piano-card"><p>{lesson.block} · {lesson.week}</p><h2>{lesson.title}</h2><p>{lesson.cue}</p><p className="piano-tip">{lesson.tip}</p></div>
      <fieldset className="piano-modes"><legend>Your input</legend>{(['touch', 'mic'] as const).map(m => <label key={m}><input type="radio" name="input" value={m} checked={mode === m} onChange={() => { stopMic(); void tone.current?.close().catch(() => {}); tone.current = null; setMode(m); setActive(null); setMessage(m === 'mic' ? 'Microphone is off. Start listening when ready.' : 'Touch mode. Tap a key.'); }} />{m === 'touch' ? 'Touch keyboard' : 'Listen to my piano'}</label>)}</fieldset>
      {mode === 'mic' ? <div className="piano-mic"><p>Optional microphone: raw audio stays in this browser’s audio graph. This feature does not record, store or upload it. It checks single notes C2–C6, not chords, singing, pedal or rhythm.</p><button type="button" onClick={listening || pending ? () => { stopMic(); setMessage('Microphone off.'); } : () => void startMic()}>{pending ? 'Cancel microphone request' : listening ? 'Stop microphone' : 'Start listening'}</button><p data-testid="heard">{heard}</p>{windowMs !== null && <small>Analysis window: {Math.round(windowMs)} ms, plus device buffering and note stability. Not a measured end-to-end latency.</small>}</div> : <label><input type="checkbox" checked={demo} onChange={e => setDemo(e.target.checked)} /> Play a quiet synthesized tone when I touch a key</label>}
      <div className="piano-goal"><p>{complete ? 'PHRASE COMPLETE' : `NOTE ${step + 1} OF ${lesson.notes.length}`}</p><strong data-testid="target-note">{complete ? 'You found the phrase!' : noteName(target)}</strong><progress aria-label="Phrase progress" max={lesson.notes.length} value={step} /><p role="status">{message}</p></div>
      <div className="piano-register"><label>Keyboard octave<select value={octave} onChange={e => setOctave(Number(e.target.value))}>{[2, 3, 4, 5].map(o => <option key={o} value={o}>{`C${o}–B${o}`}</option>)}</select></label><span>Blue = next note. Lift between repeated notes. Swipe keys sideways on narrow screens.</span></div>
      <div className="piano-key-scroll"><div className="piano-keyboard" aria-label={`Piano octave ${octave}`}>{white.map(n => key(base + n, false))}{black.map(([n, p]) => key(base + n, true, p))}</div></div>
      <div className="piano-actions"><button onClick={() => choose(lessonIndex)}>Restart phrase</button><button disabled={!complete} onClick={() => choose((lessonIndex + 1) % LESSONS.length)}>Next drill →</button></div>
      <details><summary>Bring the whole lesson to life</summary><div className="piano-stack"><p>The plan suggests 30–45 minutes across four blocks. These six short drills adapt its landmarks, bass and voice-leading into note-by-note practice, not a complete eight-week course.</p><ol><li>8–10 min: feel the black-key twins and triplets on your real piano.</li><li>10–12 min: keep the bass moving, with relaxed wrists.</li><li>10 min: try the and-of-2 push and small sus changes.</li><li>10–12 min: speak a phrase over a steady vamp, then sing. Stop microphone grading first; it cannot separate voice from piano.</li></ol><p>Self-check: did your pulse slow, did your hands tense, did you need a glance? Isolate one difficult bar. No recording is required here.</p><label>Visual pulse: {bpm} BPM<input type="range" min="40" max="100" value={bpm} onChange={e => setBpm(Number(e.target.value))} /></label><button onClick={() => { setBeat(0); setPulse(!pulse); }}>{pulse ? 'Stop visual pulse' : 'Start visual pulse'}</button><div className="piano-beats" aria-label="Visual practice pulse, not a timing score">{[0, 1, 2, 3].map(b => <span key={b} className={pulse && beat === b ? 'on' : ''}>{b + 1}</span>)}</div><small>A visual guide, not a precision metronome or a rhythm score. Keep eyes-open controls accessible; close your eyes only when safe at a physical keyboard.</small></div></details>
      <footer>Free browser practice. No account needed. Progress lasts for this visit. Microphone accuracy and latency depend on your instrument, room and device. No cloud inference.</footer>
    </div></Window></div></main>;
}
