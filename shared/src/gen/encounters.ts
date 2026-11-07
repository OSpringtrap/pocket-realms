import { content } from '../content/index.js';
import type { MonsterDef } from '../content/schemas.js';
import { parseDice } from '../dice.js';
import type { Rng } from '../rng.js';
import { scaleMonsterToLevel, spawnMonster } from '../rules/combat.js';
import type { Biome, Difficulty, Monster, TimeOfDay } from '../types.js';

/** 5e-style per-character XP thresholds [easy, medium, hard, deadly] by level. */
export const XP_THRESHOLDS: Record<number, [number, number, number, number]> = {
  1: [25, 50, 75, 100],
  2: [50, 100, 150, 200],
  3: [75, 150, 225, 400],
  4: [125, 250, 375, 500],
  5: [250, 500, 750, 1100],
  6: [300, 600, 900, 1400],
  7: [350, 750, 1100, 1700],
  8: [450, 900, 1400, 2100],
  9: [550, 1100, 1600, 2400],
  10: [600, 1200, 1900, 2800],
};
export const DIFF_MULT: Record<Difficulty, number> = { story: 0.65, normal: 1.0, heroic: 1.3 };
/** Pocket Realms heroes are stronger than 5e baselines (minigames, potions, rerolls). */
export const POCKET_SCALE = [0, 1.25, 1.5, 1.9, 2.25, 2.45, 2.65];
export const POCKET_HP = [0, 0.9, 0.95, 1.1, 1.25, 1.35, 1.45];
export type EncounterDifficulty = 'easy' | 'medium' | 'hard' | 'deadly';
const DIFF_IDX: Record<EncounterDifficulty, number> = { easy: 0, medium: 1, hard: 2, deadly: 3 };

export function groupMultiplier(n: number): number {
  return n <= 1 ? 1 : n === 2 ? 1.5 : n <= 6 ? 2 : n <= 10 ? 2.5 : 3;
}
/** Enemy HP scales with party size so small parties aren't ground down and big ones aren't bored. */
export function hpMultForParty(size: number): number {
  return POCKET_HP[Math.max(1, Math.min(6, size))]!;
}

export interface EncounterSpec {
  levels: number[]; // party levels
  difficulty: Difficulty;
  encounter: EncounterDifficulty;
  biome: Biome;
  time?: TimeOfDay;
  family?: string;
  families?: string[];
  monsterIds?: string[];
  directorMod?: number;
  minTier?: number;
}

export function encounterBudget(spec: EncounterSpec): number {
  const base = spec.levels.reduce((s, l) => s + XP_THRESHOLDS[Math.max(1, Math.min(10, l))]![DIFF_IDX[spec.encounter]], 0);
  const avg = spec.levels.reduce((a, b) => a + b, 0) / Math.max(1, spec.levels.length);
  // Pocket Realms heroes gain fewer tools per level than 5e characters: ease budgets as levels rise
  const levelDamp = Math.max(0.62, 1 - 0.045 * (avg - 1));
  return base * levelDamp * POCKET_SCALE[Math.max(1, Math.min(6, spec.levels.length))]! * DIFF_MULT[spec.difficulty] * (1 + (spec.directorMod ?? 0));
}

function candidates(spec: EncounterSpec, maxTier: number): MonsterDef[] {
  const all = content().monsterList.filter((m) => !m.boss && m.behavior !== 'companion' && m.tier <= maxTier && m.tier >= (spec.minTier ?? 1));
  let list: MonsterDef[] = [];
  if (spec.family) list = all.filter((m) => m.family === spec.family);
  else if (spec.families?.length) list = all.filter((m) => spec.families!.includes(m.family));
  if (!list.length) {
    list = all.filter((m) => m.biomes.includes(spec.biome) && (!m.night || spec.time === 'night' || spec.time === 'evening'));
  }
  if (!list.length) list = all.filter((m) => m.biomes.includes(spec.biome));
  if (!list.length) list = all.filter((m) => m.tier <= maxTier);
  // fall back to lower-tier members of the family if it has none at this tier
  if (!list.length && spec.family) list = content().monsterList.filter((m) => m.family === spec.family && !m.boss);
  return list;
}

export interface BuiltEncounter {
  monsters: Monster[];
  budget: number;
  adjustedXp: number;
  title: string;
}

export function buildEncounter(rng: Rng, spec: EncounterSpec): BuiltEncounter {
  const size = spec.levels.length;
  const avg = spec.levels.reduce((a, b) => a + b, 0) / Math.max(1, size);
  const budget = encounterBudget(spec);
  const hpMult = hpMultForParty(size);
  const maxTier = Math.max(1, Math.min(5, Math.ceil((avg + 1) / 2) + (size >= 4 && avg <= 4 ? 1 : 0)));
  let defs: MonsterDef[] = [];
  if (spec.monsterIds?.length) {
    defs = spec.monsterIds.map((id) => content().monsters[id]).filter((m): m is MonsterDef => !!m);
    // add more copies for big parties
    const extra = Math.max(0, Math.round((size - 3) / 2));
    for (let i = 0; i < extra; i++) defs.push(defs[i % defs.length]!);
  } else {
    const cands = candidates(spec, maxTier);
    const k = spec.encounter === 'easy' ? 0.7 : spec.encounter === 'medium' ? 0.9 : 1.15;
    const nMin = Math.max(1, Math.round(size * k * 0.6));
    const cap = size === 1 ? 2 : size === 2 ? 3 : 7;
    const extra = spec.encounter === 'easy' ? 0 : spec.encounter === 'medium' ? 1 : 2;
    const lowLevel = avg <= 2 ? 1 : 0;
    const nMax = Math.max(nMin, Math.min(cap, size + extra - lowLevel, Math.round(size * k * 1.3) + 1));
    let best: MonsterDef[] = [];
    let bestScore = Infinity;
    for (let attempt = 0; attempt < 60; attempt++) {
      const n = rng.int(nMin, nMax);
      const pick: MonsterDef[] = [];
      for (let i = 0; i < n; i++) pick.push(rng.pick(cands));
      const adj = pick.reduce((s, m) => s + m.xp, 0) * groupMultiplier(n);
      const score = Math.abs(Math.log(adj / budget)) + (n < size * 0.5 ? 0.3 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = pick;
      }
    }
    defs = best;
  }
  const monsters: Monster[] = [];
  const eliteCount = size >= 6 && spec.encounter !== 'medium' ? 2 : size >= 4 ? 1 : 0;
  const sorted = [...defs].sort((a, b) => b.xp - a.xp);
  sorted.forEach((d, i) => {
    const elite = i < eliteCount && spec.encounter !== 'easy';
    const m = spawnMonster(d, rng, { hpMult, elite });
    // monsters far below party level are buffed a little so they still matter
    if (d.tier * 2 + 1 < avg) scaleMonsterToLevel(m, Math.min(avg, d.tier * 2 + 2));
    monsters.push(m);
  });
  // disambiguate names: Goblin A, Goblin B
  const counts = new Map<string, number>();
  for (const m of monsters) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const m of monsters)
    if ((counts.get(m.name) ?? 0) > 1) {
      const i = (seen.get(m.name) ?? 0) + 1;
      seen.set(m.name, i);
      m.name = `${m.name} ${String.fromCharCode(64 + i)}`;
    }
  const adjustedXp = defs.reduce((s, m) => s + m.xp, 0) * groupMultiplier(defs.length);
  const lead = sorted[0];
  return { monsters, budget, adjustedXp, title: lead ? `${lead.name}${defs.length > 1 ? ' & company' : ''}` : 'Ambush' };
}

export function buildBossEncounter(rng: Rng, opts: { bossId: string; levels: number[]; difficulty: Difficulty; families?: string[]; biome: Biome; empowered?: boolean; directorMod?: number }): BuiltEncounter {
  const def = content().monsters[opts.bossId];
  if (!def) throw new Error(`Unknown boss ${opts.bossId}`);
  const size = opts.levels.length;
  const avg = opts.levels.reduce((a, b) => a + b, 0) / Math.max(1, size);
  const bossHp = [0, 0.55, 0.64, 0.84, 1, 1.12, 1.25][Math.max(1, Math.min(6, size))]!;
  const boss = spawnMonster(def, rng, { hpMult: bossHp * DIFF_MULT[opts.difficulty] ** 0.5 });
  scaleMonsterToLevel(boss, Math.max(1, Math.round(avg + 0.5)));
  if (size >= 5) {
    boss.legendary = (boss.legendary ?? 0) + 1;
    boss.legendaryLeft = boss.legendary;
  }
  // Small parties: fewer legendary actions and softer hits so a duo isn't one bad round from a wipe
  if (size <= 2) {
    boss.legendary = Math.max(0, (boss.legendary ?? 0) - (size === 1 ? 2 : 1));
    boss.legendaryLeft = boss.legendary;
    const f = size === 1 ? 0.6 : 0.75;
    boss.attacks = boss.attacks.map((a) => {
      if (a.damage === '0') return a;
      const d = parseDice(a.damage);
      return { ...a, toHit: a.toHit - (size === 1 ? 1 : 0), damage: `${Math.max(1, Math.round(d.count * f))}d${d.sides}${d.bonus ? `+${Math.round(d.bonus * f)}` : ''}` };
    });
  }
  if (opts.empowered) {
    boss.maxHp = boss.hp = Math.round(boss.maxHp * 1.3);
    boss.attacks = boss.attacks.map((a) => ({ ...a, toHit: a.toHit + 2 }));
    boss.name = `${boss.name} (Empowered)`;
  }
  const minions =
    size >= 3
      ? buildEncounter(rng, {
          levels: opts.levels.slice(0, Math.max(1, size - 1)),
          difficulty: opts.difficulty,
          encounter: 'easy',
          biome: opts.biome,
          families: opts.families,
          directorMod: opts.directorMod,
        }).monsters.slice(0, Math.max(1, Math.floor((size - 1) / 2)))
      : [];
  return { monsters: [boss, ...minions], budget: 0, adjustedXp: def.xp, title: boss.name };
}
