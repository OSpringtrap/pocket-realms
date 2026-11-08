import { describe, expect, it } from 'vitest';
import { Rng, hashString } from '../src/rng.js';
import { parseDice, rollDice, validPhysical, addDice, maxDice } from '../src/dice.js';
import { diff, applyPatch, clone } from '../src/diff.js';
import { RUNE_SHAPES, scoreRune } from '../src/gestures.js';
import { resolveD20, checkDegree, combineAdv, miniTier } from '../src/rules/checks.js';

describe('rng', () => {
  it('is deterministic per seed', () => {
    const a = new Rng('hello');
    const b = new Rng('hello');
    const xs = Array.from({ length: 20 }, () => a.next());
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(xs);
    expect(new Rng('other').next()).not.toBe(xs[0]);
  });
  it('restores from stored state', () => {
    const a = new Rng(123);
    a.next();
    const saved = a.state;
    const n1 = a.next();
    const b = new Rng(0);
    b.state = saved;
    expect(b.next()).toBe(n1);
  });
  it('int stays in range and covers it', () => {
    const r = new Rng(9);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = r.int(1, 6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect(seen.size).toBe(6);
  });
  it('derive gives independent streams', () => {
    expect(Rng.derive('s', 'a').next()).not.toBe(Rng.derive('s', 'b').next());
    expect(hashString('x')).toBe(hashString('x'));
  });
});

describe('dice', () => {
  it('parses expressions', () => {
    expect(parseDice('2d6+3')).toEqual({ count: 2, sides: 6, bonus: 3 });
    expect(parseDice('d20')).toEqual({ count: 1, sides: 20, bonus: 0 });
    expect(parseDice('1d100-2')).toEqual({ count: 1, sides: 100, bonus: -2 });
    expect(parseDice('5')).toEqual({ count: 0, sides: 6, bonus: 5 });
    expect(() => parseDice('2d7')).toThrow();
    expect(() => parseDice('banana')).toThrow();
  });
  it('rolls within bounds for every die type', () => {
    const r = new Rng(1);
    for (const s of [4, 6, 8, 10, 12, 20, 100]) {
      for (let i = 0; i < 200; i++) {
        const res = rollDice(r, `1d${s}`);
        expect(res.total).toBeGreaterThanOrEqual(1);
        expect(res.total).toBeLessThanOrEqual(s);
      }
    }
    expect(maxDice('3d6+2')).toBe(20);
  });
  it('validates physical dice entries', () => {
    expect(validPhysical([8], [8])).toBe(true);
    expect(validPhysical([8], [9])).toBe(false);
    expect(validPhysical([8], [0])).toBe(false);
    expect(validPhysical([6, 6], [3])).toBe(false);
    expect(validPhysical([20], [2.5])).toBe(false);
    expect(validPhysical([100], ['50'])).toBe(false);
  });
  it('combines dice of the same type', () => {
    const d = addDice(['1d6', '2d6+1', '1d8']);
    expect(d).toEqual([
      { count: 1, sides: 8, bonus: 1 },
      { count: 3, sides: 6, bonus: 0 },
    ]);
  });
});

describe('diff/patch', () => {
  it('round-trips arbitrary changes', () => {
    const a = { x: 1, list: [1, 2, 3], nested: { a: 'hi', gone: true }, arr: [{ k: 1 }, { k: 2 }] };
    const b = { x: 2, list: [1, 5], nested: { a: 'hi', added: [1] }, arr: [{ k: 1 }, { k: 3 }, { k: 4 }], extra: null };
    const ops = diff(a, b);
    expect(applyPatch(clone(a), ops)).toEqual(b);
    expect(diff(b, b)).toEqual([]);
  });
});

describe('d20 checks', () => {
  it('handles advantage and crits', () => {
    expect(resolveD20([3, 17], 1, 2).total).toBe(19);
    expect(resolveD20([3, 17], -1, 2).total).toBe(5);
    expect(resolveD20([20], 0, 0).crit).toBe(true);
    expect(resolveD20([19], 0, 0, 19).crit).toBe(true);
    expect(resolveD20([1], 0, 10).fumble).toBe(true);
    expect(combineAdv(2, 1)).toBe(0);
    expect(combineAdv(1, 0)).toBe(1);
  });
  it('grades check degrees', () => {
    expect(checkDegree(resolveD20([20], 0, 0), 30)).toBe('crit');
    expect(checkDegree(resolveD20([1], 0, 30), 10)).toBe('fumble');
    expect(checkDegree(resolveD20([10], 0, 2), 12)).toBe('success');
    expect(checkDegree(resolveD20([8], 0, 2), 12)).toBe('partial');
    expect(checkDegree(resolveD20([3], 0, 2), 12)).toBe('fail');
    expect(miniTier(0.9)).toBe('great');
    expect(miniTier(0.5)).toBe('good');
    expect(miniTier(0.1)).toBe('none');
  });
});

describe('rune recognizer', () => {
  it('scores clean templates highly and wrong shapes low', () => {
    for (const [name, def] of Object.entries(RUNE_SHAPES)) {
      const pts = def.points.map(([x, y]) => [x * 100 + 200, y * 100 + 200]);
      expect(scoreRune(pts, name).score, name).toBeGreaterThan(0.8);
    }
    const circle = RUNE_SHAPES.circle!.points.map(([x, y]) => [x * 100, y * 100]);
    expect(scoreRune(circle, 'zigzag').score).toBeLessThan(0.5);
  });
  it('tolerates noise', () => {
    const r = new Rng(3);
    const pts = RUNE_SHAPES.triangle!.points.map(([x, y]) => [x * 120 + r.next() * 10, y * 120 + r.next() * 10]);
    expect(scoreRune(pts, 'triangle').score).toBeGreaterThan(0.55);
  });
  it('rejects garbage safely', () => {
    expect(scoreRune('nope', 'circle').score).toBe(0);
    expect(scoreRune([[1, 1]], 'circle').score).toBe(0);
    expect(scoreRune([[NaN, 1], [2, 'x']], 'circle').score).toBe(0);
  });
});

describe('name generators', () => {
  it('give a world distinct place names and rename the antagonist in its own text', async () => {
    const { generateWorld } = await import('../src/gen/world.js');
    for (const seed of ['A', 'B', 'C', 'D', 'E', 'F']) {
      const w = generateWorld({ seed, length: 'campaign', partySize: 4 });
      const names = w.tiles.map((t) => t.poi?.name).filter((n): n is string => !!n && n !== 'Hidden Cache');
      expect(new Set(names).size).toBe(names.length);
      expect(new Set(w.npcs.map((n) => n.name)).size).toBe(w.npcs.length);
      if (w.antagonist.baseName && w.antagonist.baseName !== w.antagonist.name) expect(w.objective.text).not.toContain(w.antagonist.baseName);
    }
  });
  it('NameBook avoids repeats', async () => {
    const { NameBook, monsterName } = await import('../src/gen/names.js');
    const { Rng } = await import('../src/rng.js');
    const r = new Rng(1);
    const book = new NameBook();
    const got = Array.from({ length: 40 }, () => book.take(() => monsterName(r, 'goblin')));
    expect(new Set(got).size).toBe(40);
  });
});

describe('dice throw hand-off', () => {
  it('sanitizes what a phone sends', async () => {
    const { sanitizeThrow } = await import('../src/protocol.js');
    expect(sanitizeThrow({ edge: 'top', pos: 3, angle: 99, speed: -1, spin: 'x' })).toEqual({ edge: 'top', pos: 1, angle: Math.PI, speed: 0, spin: 20 });
    expect(sanitizeThrow({ edge: 'sideways' })).toBeUndefined();
    expect(sanitizeThrow(null)).toBeUndefined();
  });
  it('brings dice in through the opposite edge, heading inward', async () => {
    const { entryFromThrow } = await import('../src/browser/dicephys.js');
    const up = entryFromThrow({ edge: 'top', pos: 0.25, angle: -Math.PI / 2, speed: 6, spin: 20 }, 1920, 1080, 40);
    expect(up.edge).toBe('bottom');
    expect(up.x).toBeCloseTo(480);
    expect(up.y).toBeGreaterThan(1080);
    expect(up.vy).toBeLessThan(0);
    const right = entryFromThrow({ edge: 'right', pos: 0.5, angle: 0.2, speed: 6, spin: 20 }, 1920, 1080, 40);
    expect(right.edge).toBe('left');
    expect(right.x).toBeLessThan(0);
    expect(right.vx).toBeGreaterThan(0);
    // a heading that would leave the screen again is bent inward
    const skim = entryFromThrow({ edge: 'top', pos: 0.5, angle: Math.PI / 2, speed: 6, spin: 20 }, 1920, 1080, 40);
    expect(skim.vy).toBeLessThan(0);
  });
});
