export type SoundName = "card-draw" | "card-flip" | "pair" | "turn" | "joker-reveal" | "game-over" | "victory";

/** Synthesised tones only – no audio assets, no copyrighted music. Safe to call anywhere; silently no-ops without WebAudio. */
let ctx: AudioContext | null = null;
let enabled = true;
let musicOn = false;
let droneNodes: { stop(): void } | null = null;

type AC = typeof AudioContext;
function ac(): AudioContext | null {
  if (ctx) return ctx;
  const g = globalThis as unknown as { AudioContext?: AC; webkitAudioContext?: AC };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (!Ctor) return null;
  try { ctx = new Ctor(); } catch { ctx = null; }
  return ctx;
}

export function configureSound(opts: { sound: boolean; music: boolean }): void {
  enabled = opts.sound;
  if (opts.music !== musicOn) {
    musicOn = opts.music;
    musicOn ? startDrone() : stopDrone();
  }
}

function tone(freq: number, dur: number, type: OscillatorType, gain = 0.06, delay = 0, slideTo?: number): void {
  const c = ac();
  if (!c) return;
  try {
    const t0 = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  } catch { /* audio is optional */ }
}

export function playSound(name: SoundName): void {
  if (!enabled) return;
  ac()?.resume?.().catch(() => undefined);
  switch (name) {
    case "card-draw": tone(300, 0.09, "triangle", 0.05, 0, 180); break;
    case "card-flip": tone(520, 0.07, "square", 0.025); tone(380, 0.08, "square", 0.02, 0.05); break;
    case "pair": tone(440, 0.12, "sine", 0.05); tone(660, 0.18, "sine", 0.05, 0.08); break;
    case "turn": tone(220, 0.12, "sine", 0.04); break;
    case "joker-reveal": tone(110, 0.9, "sawtooth", 0.05, 0, 60); tone(165, 0.9, "sine", 0.04, 0.05, 90); break;
    case "game-over": tone(196, 0.5, "sawtooth", 0.05, 0, 98); tone(147, 0.8, "sine", 0.05, 0.3, 73); break;
    case "victory": [392, 494, 587, 784].forEach((f, i) => tone(f, 0.28, "triangle", 0.05, i * 0.12)); break;
  }
}

function startDrone(): void {
  const c = ac();
  if (!c || droneNodes) return;
  try {
    const gain = c.createGain();
    gain.gain.value = 0.018;
    const lfo = c.createOscillator();
    const lfoGain = c.createGain();
    lfo.frequency.value = 0.07;
    lfoGain.gain.value = 0.01;
    lfo.connect(lfoGain).connect(gain.gain);
    const a = c.createOscillator(); a.type = "sine"; a.frequency.value = 55;
    const b = c.createOscillator(); b.type = "sine"; b.frequency.value = 55.6;
    a.connect(gain); b.connect(gain); gain.connect(c.destination);
    a.start(); b.start(); lfo.start();
    droneNodes = { stop: () => { for (const n of [a, b, lfo]) { try { n.stop(); } catch { /* already stopped */ } } gain.disconnect(); } };
  } catch { droneNodes = null; }
}
function stopDrone(): void {
  droneNodes?.stop();
  droneNodes = null;
}
