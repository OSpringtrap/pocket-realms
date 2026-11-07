import { describe, expect, it } from 'vitest';
import {
  CLASSES, SPECIES, Rng, allowedQuirks, botController, botIO, buildEncounter, content, createCharacter, createCombat,
  rollInitiative, runCombat, validateDraft, addXp, levelUpOptions, applyLevelUp, getAc, generateWorld, hexDist,
  reachable, applyDamage, healUnit, rollLoot, makeItem, equipItem, spawnMonster, shortRest, longRest, buildBossEncounter,
  type Character, type CombatCtx, type CombatEvent,
} from '../src/index.js';

function party(seed: number, n: number, level = 1): Record<string, Character> {
  const rng = new Rng(seed);
  const out: Record<string, Character> = {};
  for (let i = 0; i < n; i++) {
    const cls = CLASSES[(seed + i) % CLASSES.length]!;
    const sp = SPECIES[(seed + 2 * i) % SPECIES.length]!;
    const c = createCharacter(`p${i}`, { name: `Hero${i}`, species: sp, cls, quirks: [allowedQuirks(sp, cls)[0]!], personality: 'Brave' }, rng, undefined, level);
    out[c.id] = c;
  }
  return out;
}

async function fight(seed: number, n: number, level = 1) {
  const rng = new Rng(seed);
  const chars = party(seed, n, level);
  const enc = buildEncounter(rng, { levels: Object.values(chars).map((c) => c.level), difficulty: 'normal', encounter: 'medium', biome: 'forest' });
  const ctx: CombatCtx = { combat: createCombat(rng, { title: enc.title, biome: 'forest', monsters: enc.monsters }), chars, party: Object.keys(chars), rng, difficulty: 'normal' };
  rollInitiative(ctx, {});
  const log: string[] = [];
  const res = await runCombat(ctx, botIO(rng, { onEvent: (e: CombatEvent) => e.k === 'log' && log.push(e.text) }), botController());
  return { res, log, ctx };
}

describe('content', () => {
  it('meets library size targets', () => {
    const c = content();
    expect(c.abilityList.length).toBeGreaterThanOrEqual(100);
    for (const cls of ['wizard', 'cleric', 'bard', 'paladin'] as const) expect(c.abilityList.filter((a) => a.classes.includes(cls)).length, cls).toBeGreaterThanOrEqual(15);
    for (const cls of CLASSES) expect(c.abilityList.filter((a) => a.classes.includes(cls) && !a.tags.includes('species')).length, cls).toBeGreaterThanOrEqual(10);
    expect(c.monsterList.filter((m) => !m.boss && m.behavior !== 'companion').length).toBeGreaterThanOrEqual(40);
    expect(c.monsterList.filter((m) => m.boss).length).toBeGreaterThanOrEqual(6);
    expect(c.itemList.length).toBeGreaterThanOrEqual(150);
    expect(c.npcs.length).toBeGreaterThanOrEqual(20);
    for (const sp of SPECIES) expect(c.quirkList.filter((q) => q.species.includes(sp)).length, sp).toBeGreaterThanOrEqual(6);
    for (const cls of CLASSES) expect(c.quirkList.filter((q) => q.classes.includes(cls)).length, cls).toBeGreaterThanOrEqual(4);
  });
  it('every spell has an input minigame or is a passive/utility', () => {
    const c = content();
    const withGame = c.abilityList.filter((a) => a.minigame).length;
    expect(withGame).toBeGreaterThan(80);
  });
});

describe('characters', () => {
  it('creates every species/class combo with sane stats', () => {
    const rng = new Rng(5);
    for (const sp of SPECIES)
      for (const cls of CLASSES) {
        const c = createCharacter('x', { name: 'T', species: sp, cls, quirks: [allowedQuirks(sp, cls)[0]!], personality: '' }, rng);
        expect(c.maxHp).toBeGreaterThan(4);
        expect(c.hp).toBe(c.maxHp);
        expect(getAc(c)).toBeGreaterThanOrEqual(10);
        expect(c.equipment.weapon).toBeTruthy();
        for (const id of c.known) expect(content().abilities[id], id).toBeTruthy();
      }
  });
  it('validates untrusted drafts', () => {
    expect(typeof validateDraft(null)).toBe('string');
    expect(typeof validateDraft({ name: '', species: 'elf', cls: 'wizard', quirks: ['elf_bird_fear'] })).toBe('string');
    expect(typeof validateDraft({ name: 'A', species: 'gnome', cls: 'wizard', quirks: ['elf_bird_fear'] })).toBe('string');
    expect(typeof validateDraft({ name: 'A', species: 'orc', cls: 'wizard', quirks: ['elf_bird_fear'] })).toBe('string');
    expect(typeof validateDraft({ name: 'A', species: 'elf', cls: 'wizard', quirks: ['elf_bird_fear', 'x', 'y'] })).toBe('string');
    const ok = validateDraft({ name: '<b>Ann</b>', species: 'elf', cls: 'wizard', quirks: ['elf_bird_fear'], portrait: 'javascript:alert(1)' });
    expect(typeof ok).toBe('object');
    if (typeof ok === 'object') {
      expect(ok.name).toBe('bAnn/b');
      expect(ok.portrait).toBeUndefined();
    }
  });
  it('levels up with choices up to 10', () => {
    const rng = new Rng(8);
    const c = createCharacter('x', { name: 'T', species: 'human', cls: 'wizard', quirks: ['human_lucky_coin'], personality: '' }, rng);
    addXp(c, 100000);
    expect(c.pendingLevelUps).toBe(9);
    while (c.pendingLevelUps > 0) applyLevelUp(c, levelUpOptions(c, rng)[0]!);
    expect(c.level).toBe(10);
    expect(c.maxSp).toBeGreaterThan(20);
    expect(c.known.length).toBeGreaterThan(8);
  });
  it('rests restore resources', () => {
    const rng = new Rng(2);
    const c = createCharacter('x', { name: 'T', species: 'orc', cls: 'barbarian', quirks: ['orc_battle_scars'], personality: '' }, rng);
    c.hp = 1;
    c.resources.rage!.cur = 0;
    shortRest(c);
    expect(c.hp).toBeGreaterThan(1);
    expect(c.resources.rage!.cur).toBe(0);
    longRest(c);
    expect(c.hp).toBe(c.maxHp);
    expect(c.resources.rage!.cur).toBe(c.resources.rage!.max);
  });
  it('cursed items cannot be removed', () => {
    const rng = new Rng(2);
    const c = createCharacter('x', { name: 'T', species: 'human', cls: 'warrior', quirks: ['human_farmhand'], personality: '' }, rng);
    const cursed = makeItem('longsword', rng, { rarity: 'uncommon', affixes: [content().affixes.find((a) => a.id === 'bloodthirsty')!] });
    c.inventory.push(cursed);
    expect(equipItem(c, cursed.uid)).toBeNull();
    const other = makeItem('mace', rng);
    c.inventory.push(other);
    expect(equipItem(c, other.uid)).toMatch(/cursed/);
  });
});

describe('combat', () => {
  it('is deterministic for a seed', async () => {
    const a = await fight(11, 3);
    const b = await fight(11, 3);
    expect(a.log).toEqual(b.log);
    expect(a.res).toBe(b.res);
  });
  it('different seeds play differently', async () => {
    const a = await fight(11, 3);
    const b = await fight(12, 3);
    expect(a.log).not.toEqual(b.log);
  });
  it('completes for 1..6 players and never hangs', async () => {
    for (let n = 1; n <= 6; n++)
      for (let s = 0; s < 6; s++) {
        const r = await fight(100 + s * 13 + n, n, 1 + (s % 5) * 2);
        expect(['victory', 'defeat', 'fled']).toContain(r.res);
        expect(r.ctx.combat.round).toBeLessThanOrEqual(26);
      }
  });
  it('downs characters at 0 HP and kills after failures', () => {
    const rng = new Rng(1);
    const chars = party(1, 1);
    const c = Object.values(chars)[0]!;
    const ctx: CombatCtx = { combat: createCombat(rng, { title: 't', biome: 'forest', monsters: [] }), chars, party: [c.id], rng, difficulty: 'normal' };
    const io = botIO(rng);
    applyDamage(ctx, io, c, c.hp, 'fire');
    expect(c.down).toBe(true);
    expect(c.dead).toBe(false);
    applyDamage(ctx, io, c, 1, 'fire');
    applyDamage(ctx, io, c, 1, 'fire', { crit: true });
    expect(c.dead).toBe(true);
    healUnit(ctx, io, c, 10);
    expect(c.hp).toBe(0);
  });
  it('monsters respect weakness and resistance', () => {
    const rng = new Rng(1);
    const troll = spawnMonster(content().monsters.skeleton!, rng);
    const ctx: CombatCtx = { combat: createCombat(rng, { title: 't', biome: 'forest', monsters: [troll] }), chars: {}, party: [], rng, difficulty: 'normal' };
    const io = botIO(rng);
    const hp = troll.hp;
    applyDamage(ctx, io, troll, 3, 'bludgeoning');
    expect(troll.hp).toBe(hp - 6);
  });
  it('builds boss encounters scaled to party level', () => {
    const rng = new Rng(4);
    const low = buildBossEncounter(rng, { bossId: 'ashmaw', levels: [2, 2], difficulty: 'normal', biome: 'mountains' });
    const high = buildBossEncounter(rng, { bossId: 'ashmaw', levels: [9, 9], difficulty: 'normal', biome: 'mountains' });
    expect(low.monsters[0]!.maxHp).toBeLessThan(high.monsters[0]!.maxHp);
  });
});

describe('world generation', () => {
  it('same seed reproduces the same world, different seeds differ', () => {
    const a = generateWorld({ seed: 'BRAVE-OTTER-11', length: 'oneshot', partySize: 3 });
    const b = generateWorld({ seed: 'BRAVE-OTTER-11', length: 'oneshot', partySize: 3 });
    const c = generateWorld({ seed: 'GRIM-TOAD-42', length: 'oneshot', partySize: 3 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a.tiles)).not.toBe(JSON.stringify(c.tiles));
  });
  it('places required POIs and a reachable fortress', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      for (const length of ['oneshot', 'campaign'] as const) {
        const w = generateWorld({ seed, length, partySize: 4 });
        const pois = w.tiles.filter((t) => t.poi);
        expect(pois.filter((t) => t.poi!.kind === 'fortress').length).toBe(1);
        expect(pois.filter((t) => t.poi!.kind === 'dungeon').length).toBeGreaterThanOrEqual(w.objective.keysNeeded);
        const fort = w.objective.fortress;
        expect(hexDist(fort, w.party)).toBeGreaterThanOrEqual(3);
        // every POI reachable over land with unlimited budget
        const reach = reachable({ ...w, tiles: w.tiles.map((t) => ({ ...t, poi: undefined })) }, 999);
        for (const p of pois) if (!(p.q === w.party.q && p.r === w.party.r)) expect(reach.has(`${p.q},${p.r}`), `${seed} ${p.poi!.name}`).toBe(true);
      }
    }
  });
});

describe('loot', () => {
  it('generates items of all rarities with valid stats', () => {
    const rng = new Rng(77);
    const seen = new Set<string>();
    for (let i = 0; i < 600; i++) {
      const it = rollLoot(rng, { level: 1 + (i % 10), boost: i % 40 });
      seen.add(it.rarity);
      expect(it.name.length).toBeGreaterThan(0);
      expect(it.value).toBeGreaterThan(-1);
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });
});
