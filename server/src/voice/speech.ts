import type { VoiceStatus } from '@pr/shared';
import type { Speaker, VoiceHooks } from '../game/Game.js';
import type { TtsWorker } from './worker.js';

/**
 * One global speech queue for the main screen (as in solo-dm): never two voices at once, the
 * narrator and the characters take turns. Narration is split into sentences so the first one
 * plays while the next is synthesized. Lines that waited too long are dropped rather than read
 * late, because the game has moved on. A sentence counts as heard when the main screen reports
 * it played (or after its length plus a margin, if no report comes).
 */

export interface SpeechSink {
  /** connected screens that play speech (host and watch screens) */
  hosts(): number;
  json(msg: unknown): void;
  binary(buf: Buffer): void;
}

interface Item {
  sid: number;
  who: string;
  voice: string;
  text: string;
  at: number;
  kind: 'narr' | 'say';
  /** sentences of one narrate() call share a block: once it starts playing it is read to the end */
  block: number;
}

const STALE_MS = { narr: 14000, say: 7000 };
const MAX_PENDING = 8;
const IN_FLIGHT = 2; // sentences sent to the worker ahead of playback

export class SpeechQueue implements VoiceHooks {
  private pending: Item[] = [];
  /** sent to the worker, not yet heard: sid -> job + expiry timer */
  private live = new Map<number, { job: number; synthDone: boolean; timer?: NodeJS.Timeout }>();
  private sid = 0;
  private job = 0;
  private block = 0;
  /** block of the sentence most recently sent to the worker */
  private playing = 0;
  private idleWaiters: (() => void)[] = [];

  constructor(
    private worker: TtsWorker,
    private sink: SpeechSink,
    private now: () => number = Date.now,
  ) {}

  status(): VoiceStatus {
    return this.worker.status;
  }

  narrate(text: string) {
    const block = ++this.block;
    for (const s of splitSentences(cleanForSpeech(text))) this.push({ who: 'Narrator', voice: 'narrator', text: s, kind: 'narr', block });
  }

  say(speaker: Speaker, text: string) {
    const clean = cleanForSpeech(text);
    if (clean) this.push({ who: speaker.name, voice: this.worker.voices.has(speaker.voice) ? speaker.voice : 'narrator', text: clean, kind: 'say', block: ++this.block });
  }

  busy(): boolean {
    return this.pending.length > 0 || this.live.size > 0;
  }

  idle(maxMs: number): Promise<void> {
    if (!this.busy()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((w) => w !== done);
        resolve();
      }, maxMs);
      this.idleWaiters.push(done);
    });
  }

  stop() {
    this.pending = [];
    if (this.live.size) {
      this.worker.cancel([...this.live.values()].map((l) => l.job));
      for (const l of this.live.values()) clearTimeout(l.timer);
      this.live.clear();
    }
    this.sink.json({ t: 'speechStop' });
    this.wake();
  }

  /** The main screen finished playing sentence `sid`. */
  played(sid: number) {
    const l = this.live.get(sid);
    if (!l) return;
    clearTimeout(l.timer);
    this.live.delete(sid);
    this.pump();
  }

  private push(it: Omit<Item, 'sid' | 'at'>) {
    if (!it.text || !/[a-z]/i.test(it.text)) return;
    if (!this.worker.ready || this.sink.hosts() === 0) return; // nobody to hear it
    this.pending.push({ ...it, sid: ++this.sid, at: this.now() });
    // Too much backlog: drop the oldest narration first, characters last.
    while (this.pending.length > MAX_PENDING) {
      const i = this.pending.findIndex((p) => p.kind === 'narr' && p.block !== this.playing);
      this.pending.splice(i >= 0 ? i : 0, 1);
    }
    this.pump();
  }

  private pump() {
    const now = this.now();
    // CPU synthesis runs behind real time, so lines wait longer there before they count as stale.
    const slack = this.worker.status.device === 'cpu' ? 2 : 1;
    this.pending = this.pending.filter((p) => now - p.at < STALE_MS[p.kind] * slack);
    while (this.live.size < IN_FLIGHT && this.pending.length) {
      const it = this.pending.shift()!;
      // The rest of a block that has started is not stale: a long narration (the ending) is read
      // to its last sentence instead of being cut when its tail waited behind the first ones.
      this.playing = it.block;
      for (const p of this.pending) if (p.block === it.block) p.at = now;
      const job = ++this.job;
      const entry: { job: number; synthDone: boolean; timer?: NodeJS.Timeout } = { job, synthDone: false };
      const ok = this.worker.synth(job, it.text, it.voice, {
        frame: (buf) => this.sink.binary(buf),
        end: (status, info) => {
          this.sink.json({ t: 'speechEnd', sid: it.sid });
          entry.synthDone = true;
          if (status !== 'done' || !info.samples) return this.played(it.sid);
          // If the screen never reports back (tab closed), give up after the audio's length.
          const ms = (info.samples / (info.sampleRate || 24000)) * 1000 * (this.live.size + 1) + 4000;
          entry.timer = setTimeout(() => this.played(it.sid), ms);
        },
      });
      if (!ok) {
        this.pending = [];
        break;
      }
      this.live.set(it.sid, entry);
      this.sink.json({ t: 'speech', sid: it.sid, job, who: it.who, voice: it.voice });
    }
    if (!this.busy()) this.wake();
  }

  private wake() {
    const w = this.idleWaiters;
    this.idleWaiters = [];
    for (const f of w) f();
  }
}

/** Text as it should be spoken: no emoji, no stage directions, no bookkeeping in brackets. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/\*[^*]*\*/g, ' ') // *does a little dance*
    .replace(/\([^)]*[\d+%/][^)]*\)/g, ' ') // (Reputation +1), (3/3), (+1 Doom)
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}❖]/gu, '')
    .replace(/[“”"]/g, '')
    .replace(/(^|\s)'|'(\s|$)/g, '$1$2') // single quotes used as speech marks, not apostrophes
    .replace(/[—–]/g, ', ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.:;!?-]+/, '')
    .trim();
}

/** Split narration into sentences (so speech starts sooner), merging very short pieces. */
export function splitSentences(text: string, max = 220): string[] {
  if (!text) return [];
  const parts = text.match(/[^.!?…]+(?:[.!?…]+|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const out: string[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && (last.length < 18 || p.length < 12) && last.length + p.length < max) out[out.length - 1] = `${last} ${p}`;
    else out.push(p.length > max ? p.slice(0, max) : p);
  }
  return out;
}
