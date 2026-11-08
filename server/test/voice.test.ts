import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { VOICE_IDS, content } from '@pr/shared';
import { npcSpeaker } from '../src/game/speech.js';
import { SpeechQueue, cleanForSpeech, splitSentences } from '../src/voice/speech.js';
import type { JobHandlers, TtsWorker } from '../src/voice/worker.js';

const VOICE_DIR = path.resolve(__dirname, '../../voice/voices');

describe('voices', () => {
  it('every voice id has a committed reference clip and transcript', () => {
    for (const v of VOICE_IDS) {
      expect(fs.existsSync(path.join(VOICE_DIR, `${v}.wav`)), v).toBe(true);
      expect(fs.readFileSync(path.join(VOICE_DIR, `${v}.txt`), 'utf8').trim().length, v).toBeGreaterThan(20);
    }
  });

  it('every NPC name has a voice and reaction lines', () => {
    for (const a of content().npcs) {
      expect(a.voices?.length, a.id).toBe(a.names.length);
      expect(a.pleased.length, a.id).toBeGreaterThan(0);
      expect(a.displeased.length, a.id).toBeGreaterThan(0);
      for (const name of a.names) {
        const sp = npcSpeaker({ id: 'n', name, archetypeId: a.id, emoji: '', title: '', motivation: '', attitude: 0 });
        expect(VOICE_IDS).toContain(sp.voice);
      }
    }
  });

  it('every boss speaks', () => {
    for (const m of content().monsterList.filter((x) => x.boss)) {
      const b = content().barks[m.id] ?? content().barks[m.family];
      expect(b?.voice, m.id).toBeTruthy();
      expect(b?.taunt.length, m.id).toBeGreaterThan(0);
    }
  });

  it('cleans text for speech', () => {
    expect(cleanForSpeech('💰 +5 gold.')).toBe('+5 gold.');
    expect(cleanForSpeech("Oak Guard likes that. (Reputation +1)")).toBe('Oak Guard likes that.');
    expect(cleanForSpeech("'Rats in the cellar again. Big ones.'")).toBe('Rats in the cellar again. Big ones.');
    expect(cleanForSpeech("Don't *juggles three daggers* worry — it's fine")).toBe("Don't worry, it's fine");
    expect(cleanForSpeech('⚔️ 🐺')).toBe('');
  });

  it('splits narration into sentences, merging tiny pieces', () => {
    expect(splitSentences('Darkness gathers over the land. The Hollow King stirs in the barrow.')).toEqual(['Darkness gathers over the land.', 'The Hollow King stirs in the barrow.']);
    expect(splitSentences('Victory! The party gains 40 XP each.')).toEqual(['Victory! The party gains 40 XP each.']);
  });
});

/** A worker stand-in that finishes each job when told to. */
function fakeWorker() {
  const jobs = new Map<number, { text: string; voice: string; h: JobHandlers }>();
  const w = {
    status: { state: 'ready' as const },
    voices: new Set<string>(VOICE_IDS),
    ready: true,
    synth(job: number, text: string, voice: string, h: JobHandlers) {
      jobs.set(job, { text, voice, h });
      return true;
    },
    cancel() {},
  };
  return { w: w as unknown as TtsWorker, jobs };
}

describe('speech queue', () => {
  it('keeps two sentences in flight, waits for the screen to report them, and goes idle', async () => {
    const { w, jobs } = fakeWorker();
    const sent: { t: string; sid?: number; who?: string }[] = [];
    const q = new SpeechQueue(w, { hosts: () => 1, json: (m) => sent.push(m as never), binary: () => {} });
    q.narrate('One sentence here. Another one follows. And a third for luck.');
    q.say({ name: 'Goblin', voice: 'goblin' }, 'Stabby stab!');
    expect(jobs.size).toBe(2);
    expect(q.busy()).toBe(true);
    const idle = q.idle(5000);
    for (let round = 0; round < 4; round++) {
      const [job, j] = [...jobs.entries()][0]!;
      jobs.delete(job);
      j.h.end('done', { samples: 24000, sampleRate: 24000 });
      const sid = sent.filter((m) => m.t === 'speech')[round]!.sid!;
      q.played(sid);
    }
    await idle;
    expect(q.busy()).toBe(false);
    expect(sent.filter((m) => m.t === 'speech').map((m) => m.who)).toEqual(['Narrator', 'Narrator', 'Narrator', 'Goblin']);
  });

  it('says nothing when no main screen is connected', () => {
    const { w, jobs } = fakeWorker();
    const q = new SpeechQueue(w, { hosts: () => 0, json: () => {}, binary: () => {} });
    q.narrate('Nobody hears this.');
    expect(jobs.size).toBe(0);
    expect(q.busy()).toBe(false);
  });

  it('drops lines that waited too long', () => {
    const { w, jobs } = fakeWorker();
    let now = 0;
    const q = new SpeechQueue(w, { hosts: () => 1, json: () => {}, binary: () => {} }, () => now);
    q.narrate('First line is long enough. Second line is long enough.');
    q.narrate('This later line is stale by then.');
    now = 60000;
    const first = [...jobs.values()][0]!;
    first.h.end('error', {});
    expect(jobs.size).toBe(2); // the later narration was dropped, not sent
  });

  it('reads a narration that has started to its last sentence (the ending and its motto)', () => {
    const { w, jobs } = fakeWorker();
    let now = 0;
    const sent: { t: string; sid?: number }[] = [];
    const q = new SpeechQueue(w, { hosts: () => 1, json: (m) => sent.push(m as { t: string }), binary: () => {} }, () => now);
    q.narrate('One sentence is long enough. Two sentence is long enough. Three is long enough. Their motto echoes on, never give up.');
    for (let i = 0; i < 4; i++) {
      now += 10000; // each sentence takes a while to play
      const job = [...jobs.values()][i]!;
      job.h.end('done', { samples: 24000, sampleRate: 24000 });
      q.played(sent.filter((m) => m.t === 'speech')[i]!.sid!);
    }
    expect(jobs.size).toBe(4);
  });
});
