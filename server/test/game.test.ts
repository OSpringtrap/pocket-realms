import { describe, expect, it } from 'bun:test';
import { instantClock } from '../src/clock.js';
import { Game } from '../src/game/Game.js';
import { hostCommand, installHandlers, playerIntent, startNewCampaign } from '../src/game/director.js';

async function runToEnd(g: Game, ms = 20000) {
  const t0 = Date.now();
  while (g.state.phase !== 'ended' && Date.now() - t0 < ms) await new Promise((r) => setImmediate(r));
}

function newGame(seed: string, bots: number, settings = {}) {
  const g = new Game({ clock: instantClock(), code: 'TEST', lanUrl: '', instantBots: true });
  installHandlers(g);
  startNewCampaign(g, { difficulty: 'normal', length: 'oneshot', ...settings }, seed);
  for (let i = 0; i < bots; i++) expect(hostCommand(g, { cmd: 'addBot' })).toBeNull();
  return g;
}

describe('server game flow', () => {
  it('the narrator calls titled heroes by their title, now and then', () => {
    const g = newGame('EPI', 0);
    g.state.chars.h1 = { id: 'h1', name: 'Doob', titles: ['the Bold'] } as never;
    g.state.chars.h2 = { id: 'h2', name: 'Mira', titles: ['Monster Slayer'] } as never;
    const said: string[] = [];
    for (const t of ['Doob swings and Mira strikes the goblin.', 'Doob misses.', 'Doob misses.', "Doob's shield cracks.", 'Doob misses.', 'Doob misses.', 'Mira falls!']) {
      g.narrate(t);
      said.push(g.state.narration[g.state.narration.length - 1]!.text);
    }
    expect(said[0]).toBe('Doob the Bold swings and Mira, Monster Slayer, strikes the goblin.');
    expect(said[1]).toBe('Doob misses.'); // not every line
    expect(said[3]).toBe("Doob's shield cracks."); // possessives stay plain
    expect(said[4]).toBe('Doob the Bold misses.');
    expect(said[6]).toBe('Mira, Monster Slayer, falls!');
    g.narrate('From now on, the bards call them Doob the Bold!');
    expect(g.state.narration[g.state.narration.length - 1]!.text).toBe('From now on, the bards call them Doob the Bold!');
  });

  it('refuses to start without ready heroes', () => {
    const g = new Game({ clock: instantClock(), code: 'TEST', lanUrl: '', instantBots: true });
    installHandlers(g);
    startNewCampaign(g, {}, 'X');
    expect(hostCommand(g, { cmd: 'start' })).toMatch(/hero/);
    const p = g.addPlayer('Human');
    expect(typeof p).toBe('object');
    expect(hostCommand(g, { cmd: 'start' })).toMatch(/hero|Waiting/);
  });

  it('plays complete one-shot runs for 1, 2, 4 and 6 bot heroes', async () => {
    for (const n of [1, 2, 4, 6]) {
      const g = newGame(`FLOW-${n}`, n);
      expect(hostCommand(g, { cmd: 'start' })).toBeNull();
      await runToEnd(g);
      expect(g.state.phase, `party of ${n}`).toBe('ended');
      expect(g.state.outcome).toBeTruthy();
      expect(g.state.stats.combats).toBeGreaterThan(0);
    }
  });

  it('same seed generates the same world', () => {
    const a = newGame('SAME-SEED', 2);
    hostCommand(a, { cmd: 'start' });
    const b = newGame('SAME-SEED', 2);
    hostCommand(b, { cmd: 'start' });
    expect(JSON.stringify(a.state.world?.tiles)).toBe(JSON.stringify(b.state.world?.tiles));
    a.reset();
    b.reset();
  });

  it('rejects invalid intents and answers without throwing', () => {
    const g = newGame('BAD-INPUT', 1);
    const pid = [...g.players.keys()][0]!;
    expect(g.answer(pid, 'nope', 1)).toBeTruthy();
    expect(g.rollPhysical(pid, 'nope', [99])).toBeTruthy();
    expect(g.inputResult(pid, 'nope', { score: 5 })).toBeTruthy();
    expect(playerIntent(g, pid, { kind: 'equip', uid: 'missing' })).toBeTruthy();
    expect(playerIntent(g, pid, { kind: 'move', q: 999, r: 999 })).toBeTruthy();
    expect(playerIntent(g, pid, { kind: 'ping', q: NaN, r: 0 } as never)).toBeTruthy();
    expect(playerIntent(g, pid, null as never)).toBeTruthy();
    expect(hostCommand(g, { cmd: 'continue', saveId: '../../etc/passwd' })).toBeTruthy();
    g.reset();
  });

  it('physical dice values are validated', async () => {
    const g = new Game({ clock: instantClock(), code: 'TEST', lanUrl: '' });
    const p = g.addPlayer('Rolly');
    if (typeof p === 'string') throw new Error(p);
    p.physicalDice = true;
    const promise = g.rollDice(p.id, { kind: 'check', label: 'test', faces: [8, 6], bonus: 0 }, { quiet: true });
    const id = [...g.pending.keys()][0]!;
    expect(g.rollPhysical(p.id, id, [9, 1])).toMatch(/1–8/);
    expect(g.rollPhysical(p.id, id, [8, 6])).toBeNull();
    await expect(promise).resolves.toEqual([8, 6]);
  });
});
