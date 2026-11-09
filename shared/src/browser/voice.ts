/**
 * Voice playback on the main screen (ported from solo-dm's Player): sentences arrive as AUD0
 * frames (mono int16 AUD1; float32 AUD0 also works), are scheduled back to back with a small jitter buffer before each
 * sentence and a pause between different speakers, and each sentence is reported once heard.
 */
import type { Sfx } from './audio.js';

const AUD0 = 0x30445541; // "AUD0" little-endian: float32 samples
const AUD1 = 0x31445541; // "AUD1": int16 samples (what the server sends)
const HEADER = 24;

interface Sentence {
  sid: number;
  who: string;
  start?: number;
  end: number;
  sources: AudioBufferSourceNode[];
  reported: boolean;
}

export class VoicePlayer {
  jitter = 0.12; // seconds buffered before a sentence starts
  gapMs = 260; // silence between two different speakers
  onPlayed: (sid: number) => void = () => {};
  /** someone starts or stops talking (to show who speaks, and to duck ambience) */
  onSpeaking: (who: string | null) => void = () => {};
  private byJob = new Map<number, Sentence>();
  private bySid = new Map<number, Sentence>();
  private nextTime = 0;
  private lastWho: string | null = null;
  private timers: number[] = [];
  private gain?: GainNode;

  constructor(private sfx: Sfx) {}

  private out(): GainNode | undefined {
    const ctx = this.sfx.ctx;
    if (!ctx || !this.sfx.master || ctx.state !== 'running') return undefined;
    if (!this.gain || this.gain.context !== ctx) {
      this.gain = ctx.createGain();
      this.gain.gain.value = 1.15;
      this.gain.connect(this.sfx.master);
    }
    return this.gain;
  }

  speech(sid: number, job: number, who: string) {
    const s: Sentence = { sid, who, end: 0, sources: [], reported: false };
    this.byJob.set(job, s);
    this.bySid.set(sid, s);
  }

  frame(buf: ArrayBuffer) {
    const v = new DataView(buf);
    if (buf.byteLength < HEADER) return;
    const magic = v.getUint32(0, true);
    const bytes = magic === AUD1 ? 2 : magic === AUD0 ? 4 : 0;
    if (!bytes) return;
    const job = v.getUint32(4, true);
    const sampleRate = v.getUint32(12, true);
    const n = v.getUint32(16, true);
    const s = this.byJob.get(job);
    const out = this.out();
    if (!s || !out || buf.byteLength !== HEADER + bytes * n || !n) return;
    const ctx = out.context as AudioContext;
    const ab = ctx.createBuffer(1, n, sampleRate);
    if (bytes === 4) ab.copyToChannel(new Float32Array(buf, HEADER, n), 0);
    else {
      const pcm = new Int16Array(buf, HEADER, n);
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = pcm[i] / 32768;
      ab.copyToChannel(f, 0);
    }
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.connect(out);
    let t = Math.max(this.nextTime, ctx.currentTime + (s.start === undefined ? this.jitter : 0.02));
    if (s.start === undefined) {
      if (this.lastWho !== null && this.lastWho !== s.who) t = Math.max(t, this.nextTime + this.gapMs / 1000);
      s.start = t;
      this.lastWho = s.who;
      this.after(t, () => this.onSpeaking(s.who));
    }
    src.start(t);
    this.nextTime = t + ab.duration;
    s.end = this.nextTime;
    s.sources.push(src);
  }

  /** Synthesis finished: report the sentence once its audio has played out. */
  end(sid: number) {
    const s = this.bySid.get(sid);
    if (!s) return this.onPlayed(sid);
    const report = () => {
      if (s.reported) return;
      s.reported = true;
      this.bySid.delete(sid);
      for (const [j, x] of this.byJob) if (x === s) this.byJob.delete(j);
      this.onPlayed(sid);
      if (!this.bySid.size) this.onSpeaking(null);
    };
    if (s.start === undefined) report(); // nothing played (muted, or no audio context yet)
    else this.after(s.end, report);
  }

  stop() {
    for (const s of this.bySid.values()) for (const src of s.sources) {
      try {
        src.stop();
      } catch {
        /* not started */
      }
    }
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.byJob.clear();
    this.bySid.clear();
    this.nextTime = 0;
    this.lastWho = null;
    this.onSpeaking(null);
  }

  private after(t: number, fn: () => void) {
    const ms = Math.max(0, (t - (this.sfx.ctx?.currentTime ?? 0)) * 1000);
    this.timers.push(window.setTimeout(fn, ms));
    if (this.timers.length > 200) this.timers = this.timers.slice(-100);
  }
}
