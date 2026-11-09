import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@pr/shared';
import { instantClock } from '../src/clock.js';
import { Game } from '../src/game/Game.js';
import { installHandlers, toTitle } from '../src/game/director.js';
import { JoinGuard, Room, clientAddress } from '../src/room.js';

/** just enough of a ws socket for Room: messages in, sent frames recorded */
class FakeWs extends EventEmitter {
  readyState = 1;
  sent: unknown[] = [];
  binary = 0;
  send(data: unknown, opts?: { binary?: boolean }) {
    if (opts?.binary) this.binary++;
    else this.sent.push(JSON.parse(String(data)));
  }
  ping() {}
  terminate() {}
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  msg(m: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(m)), false);
  }
}

function setup() {
  const g = new Game({ clock: instantClock(), code: 'TEST', lanUrl: '', instantBots: true });
  installHandlers(g);
  toTitle(g);
  const room = new Room(g, 'TEST', 'hostkey1');
  const played: number[] = [];
  room.onSpeechPlayed = (sid) => played.push(sid);
  const connect = (hello: object) => {
    const ws = new FakeWs();
    room.attach(ws as unknown as WebSocket);
    ws.msg({ t: 'hello', v: PROTOCOL_VERSION, ...hello });
    return ws;
  };
  return { g, room, played, connect };
}

describe('room: wrong room codes', () => {
  it('locks an address out after repeated wrong codes, for a while', () => {
    let now = 0;
    const guard = new JoinGuard(() => now);
    for (let i = 0; i < JoinGuard.MAX_FAILS - 1; i++) guard.fail('1.2.3.4');
    expect(guard.locked('1.2.3.4')).toBe(0); // typos are fine
    guard.fail('1.2.3.4');
    expect(guard.locked('1.2.3.4')).toBe(JoinGuard.LOCK_MS);
    expect(guard.locked('5.6.7.8')).toBe(0); // others are not affected
    now += JoinGuard.LOCK_MS;
    expect(guard.locked('1.2.3.4')).toBe(0);
  });

  it('forgets old mistakes and clears on a right code', () => {
    let now = 0;
    const guard = new JoinGuard(() => now);
    for (let i = 0; i < JoinGuard.MAX_FAILS - 1; i++) guard.fail('a');
    now += JoinGuard.FAIL_WINDOW_MS + 1;
    guard.fail('a');
    expect(guard.locked('a')).toBe(0);
    for (let i = 0; i < JoinGuard.MAX_FAILS - 2; i++) guard.fail('a');
    guard.ok('a');
    guard.fail('a');
    expect(guard.locked('a')).toBe(0);
  });

  it('trusts the tunnel header only on connections from this machine', () => {
    expect(clientAddress('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' })).toBe('203.0.113.7');
    expect(clientAddress('::ffff:127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' })).toBe('203.0.113.7');
    expect(clientAddress('192.168.1.50', { 'cf-connecting-ip': '203.0.113.7' })).toBe('192.168.1.50'); // spoofed on the LAN
    expect(clientAddress('127.0.0.1', {})).toBe('127.0.0.1');
  });

  it('refuses joins from a locked-out address, even with the right code', () => {
    const { g, room, connect } = setup();
    const host = connect({ role: 'host', key: 'hostkey1' });
    host.msg({ t: 'host', command: { cmd: 'newCampaign', settings: {} } });
    expect(g.state.phase).not.toBe('title');
    const guesser = new FakeWs();
    room.attach(guesser as unknown as WebSocket, '203.0.113.7');
    for (let i = 0; i < JoinGuard.MAX_FAILS; i++) guesser.msg({ t: 'join', v: PROTOCOL_VERSION, code: 'ZZZZ', name: 'Eve' });
    guesser.msg({ t: 'join', v: PROTOCOL_VERSION, code: 'TEST', name: 'Eve' });
    expect(guesser.sent.at(-1)).toEqual({ t: 'error', msg: 'Too many wrong room codes. Try again in 5 min.' });
    const friend = new FakeWs();
    room.attach(friend as unknown as WebSocket, '198.51.100.2');
    friend.msg({ t: 'join', v: PROTOCOL_VERSION, code: 'TEST', name: 'Remote' });
    expect(friend.sent.some((m) => (m as { t: string }).t === 'welcome')).toBe(true);
    room.close();
  });
});

describe('room: watch screens', () => {
  it('voices go to the host and to watch screens, never to phones', () => {
    const { room, connect } = setup();
    const host = connect({ role: 'host', key: 'hostkey1' });
    const watch = connect({ role: 'host' });
    const phone = new FakeWs();
    room.attach(phone as unknown as WebSocket);
    expect(room.screenCount()).toBe(2);
    room.sendScreens({ t: 'speech', sid: 1, job: 1, who: 'Narrator', voice: 'narrator' });
    room.sendScreens(Buffer.alloc(24));
    for (const ws of [host, watch]) {
      expect(ws.sent).toContainEqual({ t: 'speech', sid: 1, job: 1, who: 'Narrator', voice: 'narrator' });
      expect(ws.binary).toBe(1);
    }
    expect(phone.sent.some((m) => (m as { t: string }).t === 'speech')).toBe(false);
    expect(phone.binary).toBe(0);
    room.close();
  });

  it('the host screen sets the speech pace; a watch screen only when no host is connected', () => {
    const { room, played, connect } = setup();
    const host = connect({ role: 'host', key: 'hostkey1' });
    const watch = connect({ role: 'host' });
    watch.msg({ t: 'speech:played', sid: 1 }); // muted watch screen: would rush the game
    expect(played).toEqual([]);
    host.msg({ t: 'speech:played', sid: 1 });
    expect(played).toEqual([1]);
    host.close();
    watch.msg({ t: 'speech:played', sid: 2 });
    expect(played).toEqual([1, 2]);
    room.close();
  });

  it('a watch screen cannot run host commands', () => {
    const { room, connect } = setup();
    const watch = connect({ role: 'host', key: 'wrong' });
    watch.msg({ t: 'host', command: { cmd: 'newCampaign', settings: {} } });
    expect(watch.sent).toContainEqual({ t: 'error', msg: 'Only the main screen can do that.' });
    expect(room.game.state.phase).toBe('title');
    room.close();
  });
});
