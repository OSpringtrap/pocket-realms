import WebSocket from 'ws';
import { applyPatch, type PhoneView, type S2C } from '../../shared/src/index.js';

export const URL_ = process.env.WS_URL ?? 'wss://localhost:9443/ws';

export class Client {
  ws!: WebSocket;
  view?: PhoneView;
  seq = 0;
  token?: string;
  playerId?: string;
  errors: string[] = [];
  answered = new Set<string>();
  auto = false;
  constructor(public name: string) {}
  open(): Promise<void> {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(URL_, { rejectUnauthorized: false });
      this.ws.on('open', () => res());
      this.ws.on('error', rej);
      this.ws.on('message', (d) => this.onMsg(JSON.parse(d.toString()) as S2C));
    });
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  onMsg(m: S2C) {
    if (m.t === 'welcome') {
      this.token = m.token ?? this.token;
      this.playerId = m.playerId ?? this.playerId;
    } else if (m.t === 'state') {
      this.view = m.view as PhoneView;
      this.seq = m.seq;
    } else if (m.t === 'patch') {
      if (m.seq !== this.seq + 1) this.errors.push(`seq gap ${this.seq}->${m.seq}`);
      this.view = applyPatch(this.view, m.ops);
      this.seq = m.seq;
    } else if (m.t === 'error') this.errors.push(m.msg);
    if (this.auto) this.autoplay();
  }
  autoplay() {
    const p = this.view?.me?.prompts?.[0];
    if (!p || this.answered.has(p.id)) return;
    this.answered.add(p.id);
    setTimeout(() => {
      switch (p.kind) {
        case 'choice': {
          const opts = p.options.filter((o) => !o.disabled);
          const pick = p.style === 'action' ? opts.find((o) => o.id === 'attack') ?? opts[0] : opts[Math.floor(Math.random() * opts.length)];
          this.send({ t: 'answer', id: p.id, value: pick?.id });
          break;
        }
        case 'roll':
          this.send({ t: 'roll:throw', id: p.id });
          break;
        case 'minigame':
          this.send({ t: 'input:result', id: p.id, data: { score: 0.6 } });
          break;
        case 'text':
          this.send({ t: 'answer', id: p.id, value: `Answer from ${this.name}` });
          break;
        case 'draw':
          this.send({ t: 'answer', id: p.id, value: 'data:image/png;base64,iVBORw0KGgo=' });
          break;
        case 'notice':
          this.send({ t: 'answer', id: p.id, value: true });
          break;
      }
    }, 30 + Math.random() * 120);
  }
  close() {
    this.ws.close();
  }
}

export function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
