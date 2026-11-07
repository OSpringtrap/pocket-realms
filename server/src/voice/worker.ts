import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import type { VoiceStatus } from '@pr/shared';

/**
 * Client for the TTS worker (voice/pr_voice, Python). It is optional: without it the game plays
 * silently. If `voice/.venv` exists (made by `npm run voice:setup`) the server starts the worker
 * itself and stops it on exit; a worker someone started by hand on the same port is used as is.
 */

export interface JobHandlers {
  frame(buf: Buffer): void;
  end(status: 'done' | 'cancelled' | 'error', info: { message?: string; samples?: number; sampleRate?: number }): void;
}

interface Ready {
  backend: string;
  device: string;
  model: string;
  voices: string[];
  sample_rate: number;
  error?: string | null;
}

export class TtsWorker {
  status: VoiceStatus = { state: 'off' };
  voices = new Set<string>();
  onStatus: () => void = () => {};
  private ws?: WebSocket;
  private jobs = new Map<number, JobHandlers>();
  private retry?: NodeJS.Timeout;
  private child?: ChildProcess;
  private closed = false;
  private attempts = 0;

  constructor(
    private root: string,
    private port = Number(process.env.VOICE_PORT ?? 8766),
  ) {}

  get ready() {
    return this.status.state === 'ready' && this.ws?.readyState === WebSocket.OPEN;
  }

  start() {
    if (process.env.VOICE === '0') return this.set({ state: 'off', detail: 'VOICE=0' });
    const py = this.python();
    if (!py && process.env.VOICE !== '1') return this.set({ state: 'off', detail: 'not installed (npm run voice:setup)' });
    this.set({ state: 'starting' });
    // Try an already running worker first; spawn ours only if nothing answers.
    this.connect(() => {
      if (py) this.spawnWorker(py);
    });
  }

  stop() {
    this.closed = true;
    clearTimeout(this.retry);
    this.ws?.close();
    if (this.child && this.child.exitCode === null) this.child.kill();
  }

  synth(job: number, text: string, voice: string, h: JobHandlers): boolean {
    if (!this.ready) return false;
    this.jobs.set(job, h);
    this.ws!.send(JSON.stringify({ type: 'tts', job, text, voice }));
    return true;
  }

  cancel(jobs: number[] | 'all') {
    if (!this.ready) return;
    this.ws!.send(JSON.stringify(jobs === 'all' ? { type: 'cancel', all: true } : { type: 'cancel', jobs }));
  }

  private python(): string | undefined {
    const venv = path.join(this.root, 'voice', '.venv');
    const py = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    return fs.existsSync(py) ? py : undefined;
  }

  private config(): { backend?: string; model?: string } {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.root, 'voice', 'config.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  private spawnWorker(py: string) {
    const cfg = this.config();
    const args = ['-m', 'pr_voice', '--port', String(this.port)];
    if (cfg.backend) args.push('--backend', process.env.VOICE_BACKEND ?? cfg.backend);
    if (cfg.model && !process.env.VOICE_TTS_MODEL) args.push('--model', cfg.model);
    console.log(`🎙️  Starting the voice worker (${cfg.backend ?? 'auto'})...`);
    const child = spawn(py, args, { cwd: path.join(this.root, 'voice'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    this.child = child;
    const log = (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) if (line.trim() && !/warn/i.test(line)) console.log(`   [voice] ${line}`);
    };
    child.stdout?.on('data', log);
    child.stderr?.on('data', log);
    child.on('exit', (code) => {
      if (this.closed) return;
      this.set({ state: 'unavailable', detail: `voice worker exited (${code})` });
      console.warn(`⚠️  The voice worker stopped (exit ${code}). The game continues without voices.`);
    });
    this.scheduleConnect(1500);
  }

  private scheduleConnect(ms: number) {
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect(), ms);
  }

  /** Connect; `onFail` runs once if nobody is listening on the first attempt. */
  private connect(onFail?: () => void) {
    if (this.closed) return;
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}`, { maxPayload: 8 * 1024 * 1024 });
    let opened = false;
    ws.on('open', () => {
      opened = true;
      this.attempts = 0;
      this.ws = ws;
    });
    ws.on('message', (data, isBinary) => {
      const buf = data as Buffer;
      if (isBinary) {
        if (buf.length < 24) return;
        this.jobs.get(buf.readUInt32LE(4))?.frame(buf);
        return;
      }
      let m: { type: string; job?: number; message?: string; samples?: number; sample_rate?: number } & Partial<Ready>;
      try {
        m = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (m.type === 'ready') {
        this.voices = new Set(m.voices ?? []);
        if (m.error) this.set({ state: 'unavailable', backend: m.backend, device: m.device, detail: m.error });
        else {
          this.set({ state: 'ready', backend: m.backend, device: m.device, detail: m.model });
          console.log(`🎙️  Voices ready: ${m.backend} on ${m.device} (${m.voices?.length ?? 0} voices).`);
        }
        return;
      }
      const h = m.job !== undefined ? this.jobs.get(m.job) : undefined;
      if (!h) return;
      if (m.type === 'done' || m.type === 'cancelled' || m.type === 'error') {
        this.jobs.delete(m.job!);
        h.end(m.type, { message: m.message, samples: m.samples, sampleRate: m.sample_rate });
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (this.ws === ws) this.ws = undefined;
      for (const [job, h] of this.jobs) {
        this.jobs.delete(job);
        h.end('error', { message: 'voice worker disconnected' });
      }
      if (this.closed) return;
      if (!opened && onFail) return onFail();
      if (this.status.state === 'ready') this.set({ state: 'starting', detail: 'reconnecting' });
      // Loading models can take a while on first run; keep trying.
      const dead = this.child && this.child.exitCode !== null;
      if (!dead) this.scheduleConnect(Math.min(5000, 1000 + 500 * this.attempts++));
    });
  }

  private set(s: VoiceStatus) {
    this.status = s;
    this.onStatus();
  }
}
