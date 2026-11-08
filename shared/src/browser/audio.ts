/**
 * Procedural sound effects and biome ambience with WebAudio. No audio assets.
 */
type Biome = 'plains' | 'forest' | 'swamp' | 'mountains' | 'desert' | 'ruins' | 'coast' | 'water' | 'dungeon' | 'combat' | 'town' | 'none';

export class Sfx {
  ctx?: AudioContext;
  master?: GainNode;
  ambGain?: GainNode;
  volume = 0.8;
  music = true;
  private noiseBuf?: AudioBuffer;
  private amb?: { biome: Biome; stop: () => void };

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    this.ambGain = this.ctx.createGain();
    this.ambGain.gain.value = 0.25;
    this.ambGain.connect(this.master);
    const len = this.ctx.sampleRate * 1.5;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  /** Lower the ambience while someone speaks. */
  duck(on: boolean) {
    if (this.ctx && this.ambGain) this.ambGain.gain.setTargetAtTime(on ? 0.07 : 0.25, this.ctx.currentTime, on ? 0.08 : 0.4);
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  private tone(freq: number, dur: number, opts: { type?: OscillatorType; gain?: number; at?: number; slide?: number; attack?: number; dest?: AudioNode; vibrato?: number } = {}) {
    const c = this.ctx;
    if (!c || !this.master) return;
    const t = c.currentTime + (opts.at ?? 0);
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = opts.type ?? 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (opts.slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, opts.slide), t + dur);
    if (opts.vibrato) {
      const lfo = c.createOscillator();
      const lg = c.createGain();
      lfo.frequency.value = 6;
      lg.gain.value = opts.vibrato;
      lfo.connect(lg).connect(o.frequency);
      lfo.start(t);
      lfo.stop(t + dur);
    }
    const peak = opts.gain ?? 0.2;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (opts.attack ?? 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(opts.dest ?? this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private noise(dur: number, opts: { at?: number; gain?: number; freq?: number; q?: number; type?: BiquadFilterType; sweep?: number; dest?: AudioNode } = {}) {
    const c = this.ctx;
    if (!c || !this.master || !this.noiseBuf) return;
    const t = c.currentTime + (opts.at ?? 0);
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = c.createBiquadFilter();
    f.type = opts.type ?? 'bandpass';
    f.frequency.setValueAtTime(opts.freq ?? 1200, t);
    if (opts.sweep) f.frequency.exponentialRampToValueAtTime(opts.sweep, t + dur);
    f.Q.value = opts.q ?? 1;
    const g = c.createGain();
    g.gain.setValueAtTime(opts.gain ?? 0.3, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(opts.dest ?? this.master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  /** One die hitting a wall or the table; `v` 0..1 is how hard. Throttled so a cupful of dice
   * rattles rather than roars. */
  clack(v: number) {
    if (!this.ctx || v < 0.04) return;
    const now = performance.now();
    if (now - this.lastClack < 28) return;
    this.lastClack = now;
    const g = Math.min(0.45, 0.08 + v * 0.4);
    this.noise(0.03 + v * 0.03, { freq: 1800 + Math.random() * 2600, q: 5, gain: g });
    if (v > 0.35) this.tone(260 + Math.random() * 160, 0.05, { type: 'triangle', gain: g * 0.35 });
  }
  private lastClack = 0;

  play(name: string) {
    if (!this.ctx) return;
    const n = (f: number, d: number, o: Parameters<Sfx['tone']>[2] = {}) => this.tone(f, d, o);
    switch (name) {
      case 'dice':
        for (let i = 0; i < 6; i++) this.noise(0.05, { at: i * 0.07 + Math.random() * 0.03, freq: 2500 + Math.random() * 2500, q: 4, gain: 0.25 });
        break;
      case 'diceLand':
        this.noise(0.08, { freq: 900, q: 2, gain: 0.35 });
        n(180, 0.12, { type: 'triangle', gain: 0.15 });
        break;
      case 'slash':
      case 'whoosh':
        this.noise(0.25, { freq: 600, sweep: 3500, q: 1.5, gain: 0.3 });
        break;
      case 'hit':
      case 'thud':
        n(120, 0.18, { type: 'sine', slide: 50, gain: 0.5 });
        this.noise(0.08, { freq: 400, gain: 0.3 });
        break;
      case 'crit':
        [660, 880, 1320, 1760].forEach((f, i) => n(f, 0.35, { at: i * 0.05, type: 'triangle', gain: 0.18 }));
        n(90, 0.3, { slide: 40, gain: 0.5 });
        break;
      case 'fumble':
        [392, 370, 349, 262].forEach((f, i) => n(f, 0.3, { at: i * 0.18, type: 'sawtooth', gain: 0.08, vibrato: 4 }));
        break;
      case 'heal':
      case 'revive':
        [523, 659, 784, 1047].forEach((f, i) => n(f, 0.5, { at: i * 0.08, gain: 0.12 }));
        break;
      case 'spell':
      case 'arcane':
        n(300, 0.5, { type: 'sine', slide: 1200, gain: 0.15, vibrato: 30 });
        this.noise(0.4, { freq: 3000, q: 8, gain: 0.08 });
        break;
      case 'fire':
        this.noise(0.6, { type: 'lowpass', freq: 400, sweep: 2500, gain: 0.4 });
        break;
      case 'ice':
        [1800, 2400, 3000].forEach((f, i) => n(f, 0.3, { at: i * 0.04, gain: 0.06, type: 'sine' }));
        break;
      case 'zap':
        for (let i = 0; i < 5; i++) this.noise(0.04, { at: i * 0.05, freq: 4000, q: 0.5, gain: 0.3 });
        n(80, 0.4, { type: 'square', gain: 0.06 });
        break;
      case 'holy':
        [523, 659, 784].forEach((f) => n(f, 1.0, { gain: 0.08, attack: 0.2 }));
        break;
      case 'boom':
        this.noise(0.8, { type: 'lowpass', freq: 600, sweep: 60, gain: 0.7 });
        n(70, 0.7, { slide: 30, gain: 0.6 });
        break;
      case 'shout':
        n(220, 0.45, { type: 'sawtooth', gain: 0.1, vibrato: 12, slide: 180 });
        break;
      case 'song':
        [523, 587, 659, 784, 659].forEach((f, i) => n(f, 0.22, { at: i * 0.13, type: 'triangle', gain: 0.12 }));
        break;
      case 'coin':
      case 'loot':
        n(1568, 0.12, { type: 'square', gain: 0.06 });
        n(2093, 0.25, { at: 0.08, type: 'square', gain: 0.06 });
        break;
      case 'potion':
      case 'poison':
        for (let i = 0; i < 5; i++) n(300 + Math.random() * 500, 0.08, { at: i * 0.06, gain: 0.08, slide: 900 });
        break;
      case 'smoke':
        this.noise(0.7, { type: 'highpass', freq: 2000, gain: 0.2 });
        break;
      case 'victory':
      case 'fanfare':
        [523, 659, 784, 1047, 784, 1047].forEach((f, i) => n(f, i === 5 ? 0.8 : 0.18, { at: i * 0.14, type: 'square', gain: 0.07 }));
        break;
      case 'defeat':
        [392, 349, 311, 262].forEach((f, i) => n(f, 0.6, { at: i * 0.35, type: 'triangle', gain: 0.12 }));
        break;
      case 'levelup':
        [392, 523, 659, 784, 1047, 1319].forEach((f, i) => n(f, 0.3, { at: i * 0.07, type: 'triangle', gain: 0.1 }));
        break;
      case 'doom':
        n(55, 2.2, { gain: 0.5, type: 'sine' });
        n(82, 2.2, { gain: 0.25, type: 'triangle' });
        break;
      case 'battle':
        for (let i = 0; i < 4; i++) {
          n(90, 0.15, { at: i * 0.22, slide: 50, gain: 0.5 });
          this.noise(0.05, { at: i * 0.22, freq: 300, gain: 0.25 });
        }
        break;
      case 'boss':
        [110, 104, 98].forEach((f, i) => n(f, 0.9, { at: i * 0.5, type: 'sawtooth', gain: 0.1 }));
        break;
      case 'event':
      case 'jackbox':
        this.noise(0.15, { freq: 2500, q: 0.7, gain: 0.15 });
        n(880, 0.15, { at: 0.05, gain: 0.08 });
        break;
      case 'town':
        [784, 659, 523].forEach((f, i) => n(f, 0.8, { at: i * 0.3, gain: 0.1, type: 'sine' }));
        break;
      case 'rest':
        [262, 330, 392].forEach((f) => n(f, 1.6, { gain: 0.06, attack: 0.4 }));
        break;
      case 'dungeon':
        for (let i = 0; i < 3; i++) n(1200 + Math.random() * 800, 0.2, { at: i * 0.6, gain: 0.06, slide: 600 });
        break;
      case 'ping':
      case 'discover':
      case 'good':
        n(1320, 0.15, { gain: 0.08 });
        n(1760, 0.2, { at: 0.08, gain: 0.08 });
        break;
      case 'down':
        n(150, 0.5, { slide: 60, gain: 0.3, type: 'triangle' });
        break;
      case 'death':
        n(110, 1.5, { slide: 55, gain: 0.3, type: 'sawtooth' });
        break;
      case 'tick':
        n(1000, 0.04, { gain: 0.05, type: 'square' });
        break;
      case 'turn':
        n(660, 0.12, { gain: 0.1 });
        n(990, 0.18, { at: 0.1, gain: 0.1 });
        break;
      case 'bad':
        n(200, 0.3, { type: 'square', gain: 0.06, slide: 120 });
        break;
      default:
        n(600, 0.1, { gain: 0.05 });
    }
  }

  /** Ambient loop per biome (soft pad + texture). */
  ambient(biome: Biome) {
    if (!this.ctx || !this.ambGain) return;
    if (!this.music) biome = 'none';
    if (this.amb?.biome === biome) return;
    this.amb?.stop();
    this.amb = undefined;
    if (biome === 'none') return;
    const c = this.ctx;
    const out = c.createGain();
    out.gain.value = 0;
    out.gain.linearRampToValueAtTime(1, c.currentTime + 2);
    out.connect(this.ambGain);
    const nodes: AudioScheduledSourceNode[] = [];
    const chords: Record<string, number[]> = {
      plains: [196, 247, 294],
      forest: [174, 220, 262],
      swamp: [131, 156, 196],
      mountains: [147, 220, 294],
      desert: [165, 196, 247],
      ruins: [139, 165, 208],
      coast: [196, 262, 330],
      water: [196, 262, 330],
      dungeon: [110, 131, 165],
      combat: [110, 147, 165],
      town: [262, 330, 392],
    };
    for (const f of chords[biome] ?? chords.plains!) {
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = c.createGain();
      g.gain.value = 0.05;
      const lfo = c.createOscillator();
      lfo.frequency.value = 0.07 + Math.random() * 0.1;
      const lg = c.createGain();
      lg.gain.value = 0.03;
      lfo.connect(lg).connect(g.gain);
      o.connect(g).connect(out);
      o.start();
      lfo.start();
      nodes.push(o, lfo);
    }
    if (this.noiseBuf && ['coast', 'mountains', 'swamp', 'desert', 'water'].includes(biome)) {
      const src = c.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = biome === 'coast' || biome === 'water' ? 500 : 900;
      const g = c.createGain();
      g.gain.value = 0.06;
      const lfo = c.createOscillator();
      lfo.frequency.value = biome === 'coast' ? 0.12 : 0.05;
      const lg = c.createGain();
      lg.gain.value = 0.05;
      lfo.connect(lg).connect(g.gain);
      src.connect(f).connect(g).connect(out);
      src.start();
      lfo.start();
      nodes.push(src, lfo);
    }
    let alive = true;
    const chirp = () => {
      if (!alive) return;
      if (biome === 'forest' || biome === 'plains') this.tone(2000 + Math.random() * 1500, 0.1, { gain: 0.03, slide: 2500 + Math.random() * 1000, dest: out });
      if (biome === 'swamp') this.tone(120 + Math.random() * 60, 0.15, { type: 'square', gain: 0.02, dest: out });
      if (biome === 'dungeon' || biome === 'ruins') this.tone(1500 + Math.random() * 600, 0.3, { gain: 0.015, slide: 700, dest: out });
      setTimeout(chirp, 1500 + Math.random() * 4000);
    };
    setTimeout(chirp, 1000);
    this.amb = {
      biome,
      stop: () => {
        alive = false;
        out.gain.linearRampToValueAtTime(0, c.currentTime + 1);
        setTimeout(() => {
          for (const nd of nodes)
            try {
              nd.stop();
            } catch {
              /* already stopped */
            }
          out.disconnect();
        }, 1200);
      },
    };
  }
}

export const sfx = new Sfx();
