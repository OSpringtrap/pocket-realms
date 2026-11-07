import { content } from '../content/index.js';
import type { QuirkEffect } from '../content/schemas.js';
import {
  ABILITIES,
  SKILL_ABILITY,
  type Ability,
  type AbilityScores,
  type Character,
  type DamageType,
  type ItemInstance,
  type Skill,
} from '../types.js';

export const MAX_LEVEL = 10;
/** Cumulative XP needed to reach level N (index = level-1). */
export const XP_TABLE = [0, 120, 320, 600, 950, 1400, 1950, 2600, 3350, 4200];

export function mod(score: number): number {
  return Math.floor((score - 10) / 2);
}
export function profBonus(level: number): number {
  return level >= 9 ? 4 : level >= 5 ? 3 : 2;
}
export function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

export function equipped(c: Character): ItemInstance[] {
  return [c.equipment.weapon, c.equipment.armor, c.equipment.trinket].filter((x): x is ItemInstance => !!x);
}

/** Active set bonuses from equipped items (2+ pieces of the same set). */
export function activeSets(c: Character): string[] {
  const counts = new Map<string, number>();
  for (const it of equipped(c)) if (it.setId) counts.set(it.setId, (counts.get(it.setId) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n >= 2).map(([id]) => id);
}

interface Mods {
  attackBonus: number;
  damageBonus: number;
  acBonus: number;
  maxHpBonus: number;
  spBonus: number;
  initBonus: number;
  critRange: number;
  abilityBonus: Partial<AbilityScores>;
  skillBonus: Partial<Record<Skill, number>>;
  resist: DamageType[];
  extraDamage: { dice: string; dmg: DamageType }[];
}

/** Sum of all modifiers from equipped items and set bonuses. */
export function itemMods(c: Character): Mods {
  const m: Mods = {
    attackBonus: 0,
    damageBonus: 0,
    acBonus: 0,
    maxHpBonus: 0,
    spBonus: 0,
    initBonus: 0,
    critRange: 20,
    abilityBonus: {},
    skillBonus: {},
    resist: [],
    extraDamage: [],
  };
  const sources: Partial<ItemInstance>[] = [...equipped(c)];
  for (const s of activeSets(c)) {
    const set = content().sets[s];
    if (set) sources.push(set.bonus as Partial<ItemInstance>);
  }
  for (const it of sources) {
    m.attackBonus += it.attackBonus ?? 0;
    m.damageBonus += it.damageBonus ?? 0;
    m.acBonus += it.acBonus ?? 0;
    m.maxHpBonus += it.maxHpBonus ?? 0;
    m.spBonus += it.spBonus ?? 0;
    m.initBonus += it.initBonus ?? 0;
    if (it.critRange) m.critRange = Math.min(m.critRange, it.critRange);
    for (const [k, v] of Object.entries(it.abilityBonus ?? {})) m.abilityBonus[k as Ability] = (m.abilityBonus[k as Ability] ?? 0) + (v ?? 0);
    for (const [k, v] of Object.entries(it.skillBonus ?? {})) m.skillBonus[k as Skill] = (m.skillBonus[k as Skill] ?? 0) + (v ?? 0);
    for (const r of it.resist ?? []) if (!m.resist.includes(r)) m.resist.push(r);
    if (it.extraDamage) m.extraDamage.push(it.extraDamage);
  }
  return m;
}

export function quirkEffects(c: Character): QuirkEffect[] {
  const out: QuirkEffect[] = [];
  for (const q of c.quirks) {
    const def = content().quirks[q];
    if (def) out.push(...def.effects);
  }
  return out;
}

export function hasPassive(c: Character, id: string): boolean {
  return c.known.includes(id) || c.passives.includes(id);
}
export function hasTrait(c: Character, traitId: string): boolean {
  return content().species[c.species].traits.some((t) => t.id === traitId);
}

export function stat(c: Character, ab: Ability): number {
  let v = c.abilities[ab] + (itemMods(c).abilityBonus[ab] ?? 0);
  if (hasPassive(c, 'primal_champion') && (ab === 'STR' || ab === 'CON')) v += 2;
  return Math.min(24, v);
}
export function statMod(c: Character, ab: Ability): number {
  return mod(stat(c, ab));
}

export function castAbility(c: Character): Ability {
  return content().classes[c.cls].castAbility ?? content().classes[c.cls].primary;
}
export function castMod(c: Character): number {
  return statMod(c, castAbility(c));
}
export function spellAttackBonus(c: Character): number {
  return castMod(c) + profBonus(c.level);
}
export function spellDC(c: Character): number {
  return 8 + profBonus(c.level) + castMod(c);
}

export function maxHp(c: Character): number {
  const cls = content().classes[c.cls];
  const con = statMod(c, 'CON');
  // +4 "heroic buffer" keeps level-1 heroes from being one-shot (Pocket Realms house rule)
  let hp = 4 + cls.hitDie + con + (c.level - 1) * (Math.floor(cls.hitDie / 2) + 1 + con);
  for (const e of quirkEffects(c)) if (e.type === 'hp') hp += e.amount;
  if (hasTrait(c, 'dwarven_toughness')) hp += c.level;
  if (c.passives.includes('perk_tough')) hp += 2 * c.level;
  hp += itemMods(c).maxHpBonus;
  return Math.max(c.level, hp);
}

export function maxSp(c: Character): number {
  const cls = content().classes[c.cls];
  if (!cls.sp) return 0;
  let sp = cls.sp[c.level - 1]! + itemMods(c).spBonus + (c.passives.includes('perk_arcane') ? 3 : 0);
  for (const e of quirkEffects(c)) if (e.type === 'sp') sp += e.amount;
  return Math.max(0, sp);
}

export function hasCondition(c: { conditions: { id: string }[] }, id: string): boolean {
  return c.conditions.some((x) => x.id === id);
}

export function getAc(c: Character): number {
  const armor = c.equipment.armor;
  const dex = statMod(c, 'DEX');
  let ac: number;
  if (armor && armor.acBase) {
    const cap = armor.dexCap;
    ac = armor.acBase + (cap === undefined ? dex : Math.min(dex, cap));
  } else {
    ac = 10 + dex + (hasPassive(c, 'unarmored_defense') ? statMod(c, 'CON') : 0);
  }
  ac += itemMods(c).acBonus;
  for (const e of quirkEffects(c)) if (e.type === 'ac') ac += e.amount;
  for (const b of c.buffs) {
    if (b.id === 'ac') ac += b.amount ?? 0;
    if (b.id === 'shield') ac += b.amount ?? 5;
  }
  if (hasCondition(c, 'slowed')) ac -= 2;
  return ac;
}

export function initiativeBonus(c: Character): number {
  let b = statMod(c, 'DEX') + itemMods(c).initBonus;
  for (const e of quirkEffects(c)) if (e.type === 'init') b += e.amount;
  if (c.passives.includes('perk_alert')) b += 5;
  return b;
}

export function isProficient(c: Character, skill: Skill): boolean {
  return c.skills.includes(skill);
}

export function skillBonus(c: Character, skill: Skill, context: { biome?: string } = {}): number {
  let b = statMod(c, SKILL_ABILITY[skill]) + (isProficient(c, skill) ? profBonus(c.level) : 0);
  b += itemMods(c).skillBonus[skill] ?? 0;
  for (const e of quirkEffects(c)) if (e.type === 'skill' && e.skill === skill) b += e.amount;
  if (hasTrait(c, 'stonecunning') && context.biome && ['ruins', 'mountains', 'dungeon'].includes(context.biome)) b += 3;
  if (hasTrait(c, 'keen_senses') && skill === 'perception') b += 1;
  if (c.passives.includes('perk_skilled')) b += 1;
  return b;
}

export function abilityCheckBonus(c: Character, ab: Ability): number {
  return statMod(c, ab) + (c.passives.includes('perk_skilled') ? 1 : 0);
}

export function saveBonus(c: Character, ab: Ability, opts: { auraOfProtection?: boolean } = {}): number {
  const cls = content().classes[c.cls];
  let b = statMod(c, ab) + (cls.saves.includes(ab) ? profBonus(c.level) : 0);
  for (const e of quirkEffects(c)) if (e.type === 'save' && e.ability === ab) b += e.amount;
  if (hasPassive(c, 'indomitable')) b += 3;
  if (opts.auraOfProtection) b += 2;
  if (c.passives.includes('perk_resolute')) b += 1;
  return b;
}

export function resistances(c: Character): DamageType[] {
  const out = new Set<DamageType>(content().species[c.species].resist);
  for (const r of itemMods(c).resist) out.add(r);
  for (const e of quirkEffects(c)) if (e.type === 'resist') out.add(e.dmg);
  if (c.species === 'dragonborn' && c.ancestry) {
    const anc = content().species.dragonborn.ancestries?.find((a) => a.id === c.ancestry);
    if (anc) out.add(anc.dmg);
  }
  return [...out];
}

export function conditionImmunities(c: Character): string[] {
  const out: string[] = [];
  if (hasTrait(c, 'fey_ancestry')) out.push('charmed');
  for (const e of quirkEffects(c)) if (e.type === 'immune') out.push(e.condition);
  return out;
}

export function critRangeFor(c: Character): number {
  let r = itemMods(c).critRange;
  if (hasPassive(c, 'improved_critical')) r = Math.min(r, 19);
  for (const e of quirkEffects(c)) if (e.type === 'critRange') r -= e.amount;
  return Math.max(15, r);
}

export function lootLuck(c: Character): number {
  let l = 0;
  for (const e of quirkEffects(c)) if (e.type === 'lootLuck') l += e.amount;
  return l;
}
export function healBonus(c: Character): number {
  let l = 0;
  for (const e of quirkEffects(c)) if (e.type === 'healBonus') l += e.amount;
  return l;
}
export function minigameBonus(c: Character, kind: string): number {
  let l = 0;
  for (const e of quirkEffects(c)) if (e.type === 'minigame' && e.kind === kind) l += e.amount;
  if (c.passives.includes('perk_nimble')) l += 0.08;
  return l;
}

export interface WeaponProfile {
  name: string;
  dice: string;
  dmg: DamageType;
  ranged: boolean;
  abilityMod: number;
  toHit: number;
  damageBonus: number;
  critRange: number;
  extra: { dice: string; dmg: DamageType }[];
}

export function weaponProfile(c: Character, forceRanged = false): WeaponProfile {
  const w = c.equipment.weapon;
  const im = itemMods(c);
  const str = statMod(c, 'STR');
  const dex = statMod(c, 'DEX');
  const ranged = forceRanged || !!w?.ranged;
  let abilityMod = str;
  if (w?.ranged || forceRanged) abilityMod = Math.max(dex, forceRanged && !w?.ranged ? str : dex);
  else if (w?.finesse) abilityMod = Math.max(str, dex);
  if (w?.damageType === 'force' && w.ranged) abilityMod = Math.max(dex, statMod(c, 'INT'));
  return {
    name: w?.name ?? 'Fists',
    dice: w?.damage ?? '1d4',
    dmg: w?.damageType ?? 'bludgeoning',
    ranged,
    abilityMod,
    toHit: abilityMod + profBonus(c.level) + im.attackBonus,
    damageBonus: abilityMod + im.damageBonus,
    critRange: critRangeFor(c),
    extra: im.extraDamage,
  };
}

export function quirkAttackVs(c: Character, tags: string[]): { bonus: number; dis: boolean; adv: boolean; dmg: number } {
  const r = { bonus: 0, dis: false, adv: false, dmg: 0 };
  for (const e of quirkEffects(c)) {
    const match = (t: string) => t === 'any' || tags.includes(t);
    if (e.type === 'attackVsTag' && match(e.tag)) r.bonus += e.amount;
    if (e.type === 'disadvVsTag' && match(e.tag)) r.dis = true;
    if (e.type === 'advVsTag' && match(e.tag)) r.adv = true;
    if (e.type === 'damageVsTag' && match(e.tag)) r.dmg += e.amount;
  }
  return r;
}

export function levelForXp(xp: number): number {
  let lvl = 1;
  for (let i = 0; i < XP_TABLE.length; i++) if (xp >= XP_TABLE[i]!) lvl = i + 1;
  return Math.min(MAX_LEVEL, lvl);
}

export function resourceMax(c: Character, resId: string): number {
  const def = content().classes[c.cls].resources.find((r) => r.id === resId);
  return def ? def.max[c.level - 1]! : 0;
}

export function sumAbilities(a: AbilityScores): number {
  return ABILITIES.reduce((s, k) => s + a[k], 0);
}
