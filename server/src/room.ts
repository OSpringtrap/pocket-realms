import type { WebSocket } from 'ws';
import { PROTOCOL_VERSION, clone, diff, type C2S, type Fx, type PhoneView, type PublicView, type S2C } from '@pr/shared';
import type { Game } from './game/Game.js';
import { claimCharacter, createHero, creationDraft, creationFate, setReady } from './game/director.js';

interface Conn {
  ws: WebSocket;
  id: number;
  role: 'pending' | 'host' | 'spectator' | 'phone';
  playerId?: string;
  last?: unknown;
  seq: number;
  alive: boolean;
  msgCount: number;
  windowStart: number;
}

const MAX_MSGS_PER_SEC = 40;
const ROOM_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const BAD = /^(FUCK|SHIT|CUNT|DICK|COCK|PISS|TWAT|SLUT|FAGS|NAZI|RAPE|KKKK)$/;

export function makeRoomCode(): string {
  for (;;) {
    let s = '';
    for (let i = 0; i < 4; i++) s += ROOM_LETTERS[Math.floor(Math.random() * ROOM_LETTERS.length)];
    if (!BAD.test(s)) return s;
  }
}

export class Room {
  conns = new Set<Conn>();
  private nextId = 1;
  private flushTimer?: NodeJS.Timeout;
  private heartbeat: NodeJS.Timeout;

  constructor(
    public game: Game,
    public code: string,
    public hostKey: string,
  ) {
    game.onChange = () => this.scheduleFlush();
    game.onFx = (fx, only) => this.sendFx(fx, only);
    this.heartbeat = setInterval(() => this.beat(), 15000);
  }

  close() {
    clearInterval(this.heartbeat);
    for (const c of this.conns) c.ws.close();
  }

  private beat() {
    for (const c of this.conns) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        /* ignore */
      }
    }
  }

  attach(ws: WebSocket) {
    const conn: Conn = { ws, id: this.nextId++, role: 'pending', seq: 0, alive: true, msgCount: 0, windowStart: Date.now() };
    this.conns.add(conn);
    ws.on('pong', () => (conn.alive = true));
    ws.on('message', (data, isBinary) => {
      conn.alive = true;
      if (isBinary) return;
      const now = Date.now();
      if (now - conn.windowStart > 1000) {
        conn.windowStart = now;
        conn.msgCount = 0;
      }
      if (++conn.msgCount > MAX_MSGS_PER_SEC) return;
      let msg: C2S;
      try {
        msg = JSON.parse(data.toString()) as C2S;
      } catch {
        return this.send(conn, { t: 'error', msg: 'Malformed message' });
      }
      if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return;
      try {
        this.handle(conn, msg);
      } catch (e) {
        console.error('[room] handler error:', e);
        this.send(conn, { t: 'error', msg: 'Something went wrong handling that.' });
      }
    });
    ws.on('close', () => {
      this.conns.delete(conn);
      if (conn.playerId && ![...this.conns].some((c) => c.playerId === conn.playerId)) this.game.setConnected(conn.playerId, false);
    });
    ws.on('error', () => {});
  }

  private send(conn: Conn, msg: S2C) {
    if (conn.ws.readyState !== 1) return;
    try {
      conn.ws.send(JSON.stringify(msg));
    } catch {
      /* ignore */
    }
  }

  private bindPlayer(conn: Conn, pid: string) {
    conn.role = 'phone';
    conn.playerId = pid;
    conn.last = undefined;
    this.game.setConnected(pid, true);
    const p = this.game.players.get(pid)!;
    this.send(conn, { t: 'welcome', v: PROTOCOL_VERSION, role: 'phone', playerId: pid, token: p.token, code: this.code });
    this.flushConn(conn);
  }

  private handle(conn: Conn, msg: C2S) {
    const g = this.game;
    const err = (m: string | null | undefined) => m && this.send(conn, { t: 'error', msg: m });
    if ('v' in msg && msg.v !== PROTOCOL_VERSION) return this.send(conn, { t: 'error', msg: 'The game was updated — please refresh this page.', fatal: true });
    switch (msg.t) {
      case 'ping':
        return this.send(conn, { t: 'pong', at: Number(msg.at) || 0 });
      case 'hello': {
        conn.role = msg.key === this.hostKey ? 'host' : 'spectator';
        conn.last = undefined;
        this.send(conn, { t: 'welcome', v: PROTOCOL_VERSION, role: conn.role, code: this.code });
        return this.flushConn(conn);
      }
      case 'resume': {
        const p = g.findByToken(String(msg.token));
        if (!p) return this.send(conn, { t: 'error', msg: 'unknown-token' });
        return this.bindPlayer(conn, p.id);
      }
      case 'join': {
        if (String(msg.code ?? '').trim().toUpperCase() !== this.code) return err('Wrong room code — check the TV screen.');
        const byToken = msg.token ? g.findByToken(String(msg.token)) : undefined;
        if (byToken) return this.bindPlayer(conn, byToken.id);
        if (g.state.phase === 'title') return err('The host is still on the title screen — ask them to start a campaign!');
        const p = g.addPlayer(String(msg.name ?? ''));
        if (typeof p === 'string') return err(p);
        return this.bindPlayer(conn, p.id);
      }
    }
    // --- everything below needs an identity
    if (msg.t === 'host') {
      if (conn.role !== 'host') return err('Only the main screen can do that.');
      const res = g.hostCommandHandler ? g.hostCommandHandler(msg.command) : 'Not available';
      return err(res);
    }
    const pid = conn.playerId;
    if (conn.role !== 'phone' || !pid || !g.players.has(pid)) return err('Join the game first.');
    switch (msg.t) {
      case 'claim': {
        const r = claimCharacter(g, pid, String(msg.charId));
        if (!r.ok) return err(r.error);
        for (const c of this.conns) if (c.playerId === pid) this.bindPlayer(c, r.player.id);
        return;
      }
      case 'creation:draft':
        return creationDraft(g, pid, msg);
      case 'creation:fate':
        return err(creationFate(g, pid));
      case 'character:create':
        return err(createHero(g, pid, msg.draft));
      case 'ready':
        return setReady(g, pid, !!msg.ready);
      case 'answer':
        return err(g.answer(pid, String(msg.id), msg.value));
      case 'roll:throw':
        return err(g.rollThrow(pid, String(msg.id)));
      case 'roll:physical':
        return err(g.rollPhysical(pid, String(msg.id), msg.values));
      case 'input:result':
        return err(g.inputResult(pid, String(msg.id), msg.data));
      case 'intent':
        return err(g.intentHandler ? g.intentHandler(pid, msg.intent) : 'Not available');
    }
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushAll();
    }, 40);
  }

  /** Build the shared public view once per flush; phones extend it with their private bits. */
  private flushAll() {
    const pub = clone(this.game.publicView());
    for (const c of this.conns) this.flushConn(c, pub);
  }

  private viewFor(conn: Conn, pub?: PublicView): PublicView | PhoneView | undefined {
    if (conn.role === 'phone' && conn.playerId && this.game.players.has(conn.playerId)) return this.game.phoneView(conn.playerId, pub);
    if (conn.role === 'host' || conn.role === 'spectator') return pub ?? this.game.publicView();
    return undefined;
  }

  private flushConn(conn: Conn, pub?: PublicView) {
    const view = this.viewFor(conn, pub);
    if (!view) return;
    // public part is already a private copy; phone views add fresh objects on top
    const snapshot = pub && view === pub ? pub : clone(view);
    if (conn.last === undefined) {
      conn.seq++;
      this.send(conn, { t: 'state', seq: conn.seq, view: snapshot });
    } else {
      const ops = diff(conn.last, snapshot);
      if (!ops.length) return;
      conn.seq++;
      this.send(conn, { t: 'patch', seq: conn.seq, ops });
    }
    conn.last = snapshot;
  }

  private sendFx(fx: Fx[], only?: string) {
    // flush state first so fx refer to fresh state
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
      this.flushAll();
    }
    for (const c of this.conns) {
      if (c.role === 'pending') continue;
      if (only && c.role === 'phone' && c.playerId !== only) continue;
      if (only && c.role !== 'phone') continue;
      // haptics targeted at one phone
      const list = fx.filter((f) => f.kind !== 'haptic' || !f.playerId || f.playerId === c.playerId);
      if (list.length) this.send(c, { t: 'fx', fx: list });
    }
  }
}
