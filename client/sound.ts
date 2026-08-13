// Table noises, synthesised rather than sampled — a handful of oscillators costs
// nothing to ship and there are no files to 404.

interface Sound {
  on: boolean;
  ctx: AudioContext | null;
  ready(): AudioContext;
  tone(freq: number, dur: number, type?: OscillatorType, vol?: number, delay?: number, hold?: number): void;
  noise(freq: number, dur: number, vol?: number, delay?: number, hold?: number): void;
  clack(): void; draw(): void; tap(): void; turn(): void;
  foot(): void; alert(): void; win(): void; whistle(): void;
  toggle(): boolean;
}

export const Snd: Sound = {
  on: localStorage.getItem('mt.mute') !== '1',
  ctx: null,
  ready() { if (!this.ctx) this.ctx = new ((window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext)(); if (this.ctx.state === 'suspended') this.ctx.resume(); return this.ctx; },
  // `dur` is the whole length of the note. `hold` is how much of that is spent
  // at full level before the decay starts — nothing needs it but a whistle,
  // which has to sound blown rather than struck.
  tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.09, delay = 0, hold = 0) {
    if (!this.on) return;
    try {
      const c = this.ready(), t = c.currentTime + delay;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.008);
      if (hold > 0) g.gain.setValueAtTime(vol, t + Math.min(hold, dur));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
    } catch {}
  },
  // Steam, for the one sound that isn't a tone: white noise through a bandpass,
  // which is as close to escaping air as an oscillator can get.
  noise(freq: number, dur: number, vol = 0.05, delay = 0, hold = 0) {
    if (!this.on) return;
    try {
      const c = this.ready(), t = c.currentTime + delay;
      const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const src = c.createBufferSource(); src.buffer = buf;
      const band = c.createBiquadFilter();
      band.type = 'bandpass'; band.frequency.setValueAtTime(freq, t); band.Q.setValueAtTime(0.9, t);
      const g = c.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.04);
      if (hold > 0) g.gain.setValueAtTime(vol, t + Math.min(hold, dur));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(band).connect(g).connect(c.destination); src.start(t); src.stop(t + dur + 0.02);
    } catch {}
  },
  clack() { this.tone(190, 0.07, 'triangle', 0.13); this.tone(95, 0.11, 'sine', 0.09, 0.01); },
  draw()  { this.tone(140, 0.13, 'sine', 0.1); },
  tap()   { this.tone(420, 0.05, 'square', 0.05); },
  turn()  { this.tone(660, 0.15, 'sine', 0.07); this.tone(880, 0.22, 'sine', 0.06, 0.09); },
  foot()  { [392, 523, 659].forEach((f: number, i: number) => this.tone(f, 0.18, 'triangle', 0.07, i * 0.06)); },
  alert() { this.tone(880, 0.1, 'square', 0.05); this.tone(1174, 0.14, 'square', 0.045, 0.1); },
  win()   { [523, 659, 784, 1046].forEach((f: number, i: number) => this.tone(f, 0.3, 'triangle', 0.08, i * 0.09)); },
  // A marker going up: two blasts, short then long and held, the way a
  // locomotive calls out. A steam whistle is a chord rather than a note, and
  // the pairs two hertz apart are what give it the wobble a single oscillator
  // can't. Roughly a second and a half all told — long enough to be a whistle
  // rather than a beep, short enough to be over before the next turn.
  whistle() {
    for (const [at, dur, hold] of [[0, 0.42, 0.24], [0.5, 1.0, 0.6]] as const) {
      for (const f of [330, 332, 392, 494, 496, 588]) this.tone(f, dur, 'triangle', 0.035, at, hold);
      this.noise(1500, dur * 0.9, 0.04, at, hold * 0.7);
    }
  },
  toggle() { this.on = !this.on; localStorage.setItem('mt.mute', this.on ? '0' : '1'); return this.on; },
};
