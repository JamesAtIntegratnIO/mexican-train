// Table noises, synthesised rather than sampled — a handful of oscillators costs
// nothing to ship and there are no files to 404.

export const Snd = {
  on: localStorage.getItem('mt.mute') !== '1', ctx: null,
  ready() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); if (this.ctx.state === 'suspended') this.ctx.resume(); return this.ctx; },
  tone(freq, dur, type = 'sine', vol = 0.09, delay = 0) {
    if (!this.on) return;
    try {
      const c = this.ready(), t = c.currentTime + delay;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
    } catch {}
  },
  clack() { this.tone(190, 0.07, 'triangle', 0.13); this.tone(95, 0.11, 'sine', 0.09, 0.01); },
  draw()  { this.tone(140, 0.13, 'sine', 0.1); },
  tap()   { this.tone(420, 0.05, 'square', 0.05); },
  turn()  { this.tone(660, 0.15, 'sine', 0.07); this.tone(880, 0.22, 'sine', 0.06, 0.09); },
  foot()  { [392, 523, 659].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.07, i * 0.06)); },
  alert() { this.tone(880, 0.1, 'square', 0.05); this.tone(1174, 0.14, 'square', 0.045, 0.1); },
  win()   { [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.3, 'triangle', 0.08, i * 0.09)); },
  toggle() { this.on = !this.on; localStorage.setItem('mt.mute', this.on ? '0' : '1'); return this.on; },
};
