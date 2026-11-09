import { applyPatch } from '../diff.js';
import { PROTOCOL_VERSION, type C2S, type Fx, type PhoneView, type PublicView, type S2C } from '../protocol.js';

export type Status = 'connecting' | 'open' | 'closed';

export interface NetHandlers<V extends PublicView | PhoneView> {
  onState(view: V): void;
  onFx?(fx: Fx[]): void;
  onWelcome?(msg: Extract<S2C, { t: 'welcome' }>): void;
  onError?(msg: string, fatal?: boolean): void;
  onStatus?(s: Status): void;
  /** speech messages and binary audio frames (main screen only) */
  onSpeech?(msg: Extract<S2C, { t: 'speech' | 'speechEnd' | 'speechStop' }>): void;
  onAudio?(buf: ArrayBuffer): void;
  /** called on every (re)connect: send hello/resume */
  onOpen(net: Net<V>): void;
}

/** WebSocket client with automatic reconnect, state + patch application. */
export class Net<V extends PublicView | PhoneView> {
  ws?: WebSocket;
  view?: V;
  seq = 0;
  status: Status = 'connecting';
  private retry = 0;
  private pingTimer?: number;
  latency = 0;

  constructor(private h: NetHandlers<V>) {
    this.connect();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && (!this.ws || this.ws.readyState > 1)) this.connect();
    });
    window.addEventListener('online', () => this.connect());
  }

  private setStatus(s: Status) {
    this.status = s;
    this.h.onStatus?.(s);
  }

  connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    this.setStatus('connecting');
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus('open');
      this.h.onOpen(this);
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping', at: Date.now() }), 10000);
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        this.h.onAudio?.(ev.data);
        return;
      }
      let msg: S2C;
      try {
        msg = JSON.parse(ev.data as string) as S2C;
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      this.setStatus('closed');
      const delay = Math.min(5000, 400 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  private handle(msg: S2C) {
    switch (msg.t) {
      case 'welcome':
        this.h.onWelcome?.(msg);
        break;
      case 'state':
        this.view = msg.view as V;
        this.seq = msg.seq;
        this.h.onState(this.view);
        break;
      case 'patch':
        if (!this.view || msg.seq !== this.seq + 1) {
          // out of sync: ask for a fresh state by reconnecting
          this.ws?.close();
          return;
        }
        this.view = applyPatch(this.view, msg.ops);
        this.seq = msg.seq;
        this.h.onState(this.view);
        break;
      case 'fx':
        this.h.onFx?.(msg.fx);
        break;
      case 'error':
        this.h.onError?.(msg.msg, msg.fatal);
        break;
      case 'pong':
        this.latency = Date.now() - msg.at;
        break;
      case 'speech':
      case 'speechEnd':
      case 'speechStop':
        this.h.onSpeech?.(msg);
        break;
    }
  }

  send(msg: C2S) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  hello(role: 'host', key?: string, code?: string) {
    this.send({ t: 'hello', v: PROTOCOL_VERSION, role, key, code });
  }
}
