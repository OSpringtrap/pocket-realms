import { content } from '../content/index.js';
import type { Rng } from '../rng.js';
import {
  ABILITIES,
  CLASSES,
  SKILLS,
  SPECIES,
  type Ability,
  type AbilityScores,
  type Character,
  type ClassId,
  type ItemInstance,
  type Skill,
  type SpeciesId,
} from '../types.js';
import { makeItem } from './items.js';
import { MAX_LEVEL, XP_TABLE, levelForXp, maxHp, maxSp, resourceMax } from './stats.js';

export interface CharacterDraft {
  name: string;
  species: SpeciesId;
  cls: ClassId;
  quirks: string[];
  personality: string;
  portrait?: string;
  ancestry?: string;
  extraSkill?: Skill;
}

export interface FateResult {
  roll: number;
  ability: Ability;
  delta: number;
  text: string;
}

export const PERKS: { id: string; name: string; emoji: string; desc: string }[] = [
  { id: 'perk_tough', name: 'Tough', emoji: '🪨', desc: '+2 max HP per level.' },
  { id: 'perk_alert', name: 'Alert', emoji: '👁️', desc: '+5 initiative.' },
  { id: 'perk_skilled', name: 'Jack of All Trades', emoji: '🧰', desc: '+1 to every skill and ability check.' },
  { id: 'perk_resolute', name: 'Resolute', emoji: '🧱', desc: '+1 to all saving throws.' },
  { id: 'perk_nimble', name: 'Nimble Fingers', emoji: '🤹', desc: 'Every minigame is a little easier.' },
  { id: 'perk_mighty', name: 'Mighty Blows', emoji: '💪', desc: '+1 damage on weapon attacks.' },
  { id: 'perk_arcane', name: 'Deep Reserves', emoji: '🔋', desc: '+3 max Spell Points (casters) or +1 class resource.' },
  { id: 'perk_lucky', name: 'Lucky', emoji: '🍀', desc: 'Gain 2 Inspiration now, and 1 more after each long rest.' },
];

const NAME_MAX = 24;
const TEXT_MAX = 140;
export const PORTRAIT_MAX = 90_000;

export function sanitizeText(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  // strip control characters and angle brackets (rendered as text anyway)
  return s.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
}

export function allowedQuirks(species: SpeciesId, cls: ClassId): string[] {
  return content()
    .quirkList.filter(
      (q) =>
        (q.species.length === 0 && q.classes.length === 0) || q.species.includes(species) || q.classes.includes(cls),
    )
    .map((q) => q.id);
}

/** Validate & normalize a draft from an untrusted client. Returns an error string or the clean draft. */
export function validateDraft(raw: unknown): CharacterDraft | string {
  if (typeof raw !== 'object' || raw === null) return 'Invalid character';
  const r = raw as Record<string, unknown>;
  const name = sanitizeText(r.name, NAME_MAX);
  if (!name) return 'Please enter a name';
  if (!SPECIES.includes(r.species as SpeciesId)) return 'Pick a species';
  if (!CLASSES.includes(r.cls as ClassId)) return 'Pick a class';
  const species = r.species as SpeciesId;
  const cls = r.cls as ClassId;
  const quirks = Array.isArray(r.quirks) ? [...new Set(r.quirks.filter((q): q is string => typeof q === 'string'))] : [];
  if (quirks.length < 1 || quirks.length > 2) return 'Pick 1 or 2 quirks';
  const allowed = allowedQuirks(species, cls);
  if (!quirks.every((q) => allowed.includes(q))) return 'That quirk is not available to your hero';
  const personality = sanitizeText(r.personality, TEXT_MAX) || 'Mysterious and quiet.';
  let portrait: string | undefined;
  if (typeof r.portrait === 'string' && r.portrait.length <= PORTRAIT_MAX && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(r.portrait))
    portrait = r.portrait;
  let ancestry: string | undefined;
  if (species === 'dragonborn') {
    const anc = content().species.dragonborn.ancestries ?? [];
    ancestry = anc.find((a) => a.id === r.ancestry)?.id ?? anc[0]?.id;
  }
  let extraSkill: Skill | undefined;
  if (species === 'human') extraSkill = SKILLS.includes(r.extraSkill as Skill) ? (r.extraSkill as Skill) : 'perception';
  return { name, species, cls, quirks, personality, portrait, ancestry, extraSkill };
}

export function baseScores(species: SpeciesId, cls: ClassId, fate?: FateResult): AbilityScores {
  const arr = { ...content().classes[cls].array };
  const sp = content().species[species];
  for (const ab of ABILITIES) arr[ab] += sp.abilityBonus[ab] ?? 0;
  if (fate) arr[fate.ability] = Math.max(3, arr[fate.ability] + fate.delta);
  return arr;
}

/** The "roll for fate" flavor minigame during creation: a d20 that nudges one ability. */
export function resolveFate(roll: number, cls: ClassId, rng: Rng): FateResult {
  const primary = content().classes[cls].primary;
  const others = ABILITIES.filter((a) => a !== primary);
  if (roll === 20) return { roll, ability: primary, delta: 2, text: `Destiny smiles! +2 ${primary}.` };
  if (roll >= 15) return { roll, ability: primary, delta: 1, text: `Fortune favors you: +1 ${primary}.` };
  if (roll >= 2) {
    const ab = rng.pick(others);
    return { roll, ability: ab, delta: 1, text: `A quirk of fate: +1 ${ab}.` };
  }
  const ab = rng.pick(others);
  return { roll, ability: ab, delta: -1, text: `Ill omens... -1 ${ab}, but you start with an extra Inspiration.` };
}

function initResources(c: Character) {
  const cls = content().classes[c.cls];
  for (const r of cls.resources) {
    const max = r.max[c.level - 1]! + (c.passives.includes('perk_arcane') && !cls.sp ? 1 : 0);
    const cur = c.resources[r.id];
    c.resources[r.id] = { name: r.name, recover: r.recover, max, cur: cur ? Math.min(max, cur.cur + Math.max(0, max - cur.max)) : max };
  }
  if (c.species === 'orc') {
    const cur = c.resources.relentless;
    c.resources.relentless = { name: 'Relentless Endurance', recover: 'long', max: 1, cur: cur ? cur.cur : 1 };
  }
}

export function autoPassives(c: Character) {
  for (const ab of content().abilityList) {
    if (ab.kind === 'passive' && ab.classes.includes(c.cls) && ab.level <= c.level && !c.known.includes(ab.id)) c.known.push(ab.id);
  }
}

export function createCharacter(id: string, draft: CharacterDraft, rng: Rng, fate?: FateResult, level = 1): Character {
  const cls = content().classes[draft.cls];
  const sp = content().species[draft.species];
  const skills = new Set<Skill>([...cls.skills, ...sp.skills]);
  if (draft.extraSkill) skills.add(draft.extraSkill);
  const c: Character = {
    id,
    name: draft.name,
    species: draft.species,
    cls: draft.cls,
    ancestry: draft.ancestry,
    level,
    xp: XP_TABLE[level - 1] ?? 0,
    abilities: baseScores(draft.species, draft.cls, fate),
    maxHp: 1,
    hp: 1,
    tempHp: 0,
    skills: [...skills],
    quirks: [...draft.quirks],
    personality: draft.personality,
    portrait: draft.portrait,
    sp: 0,
    maxSp: 0,
    resources: {},
    known: [...new Set([...cls.startAbilities, ...sp.abilities])],
    equipment: {},
    inventory: [],
    conditions: [],
    buffs: [],
    inspiration: fate && fate.delta < 0 ? 1 : 0,
    death: { successes: 0, failures: 0, stable: false },
    down: false,
    dead: false,
    titles: [],
    stats: { kills: 0, crits: 0, fumbles: 0, damageDealt: 0, healed: 0, downs: 0, minigamesAced: 0 },
    pendingLevelUps: 0,
    passives: [],
    asi: {},
  };
  c.equipment.weapon = makeItem(cls.startWeapon, rng);
  if (cls.startArmor) c.equipment.armor = makeItem(cls.startArmor, rng);
  for (const itemId of cls.startItems) {
    const it = makeItem(itemId, rng);
    if (it.slot === 'trinket' && !c.equipment.trinket) c.equipment.trinket = it;
    else c.inventory.push(it);
  }
  autoPassives(c);
  initResources(c);
  c.maxHp = maxHp(c);
  c.hp = c.maxHp;
  c.maxSp = maxSp(c);
  c.sp = c.maxSp;
  return c;
}

/** Recompute derived maxima after equipment / level changes, preserving damage taken. */
export function refreshDerived(c: Character) {
  const oldMax = c.maxHp;
  c.maxHp = maxHp(c);
  if (c.maxHp > oldMax) c.hp += c.maxHp - oldMax;
  c.hp = Math.min(c.hp, c.maxHp);
  const oldSp = c.maxSp;
  c.maxSp = maxSp(c);
  if (c.maxSp > oldSp) c.sp += c.maxSp - oldSp;
  c.sp = Math.min(c.sp, c.maxSp);
  initResources(c);
}

/** Adds XP; returns number of new levels gained (queued as pendingLevelUps). */
export function addXp(c: Character, amount: number): number {
  if (c.level >= MAX_LEVEL) return 0;
  c.xp += Math.max(0, Math.round(amount));
  const target = levelForXp(c.xp);
  const gained = Math.max(0, target - c.level - c.pendingLevelUps);
  c.pendingLevelUps += gained;
  return gained;
}

export type LevelChoice =
  | { kind: 'ability'; id: string; label: string; emoji: string; desc: string }
  | { kind: 'asi'; ability: Ability; label: string; emoji: string; desc: string }
  | { kind: 'perk'; id: string; label: string; emoji: string; desc: string };

export function levelUpOptions(c: Character, rng: Rng, newLevel = c.level + 1): LevelChoice[] {
  const pool = content()
    .abilityList.filter(
      (a) =>
        a.kind !== 'passive' &&
        a.classes.includes(c.cls) &&
        !a.tags.includes('species') &&
        a.level <= newLevel &&
        !c.known.includes(a.id),
    )
    .sort((a, b) => b.level - a.level);
  const out: LevelChoice[] = [];
  // Prefer the newest tier, then fill with random older ones
  const newest = pool.filter((a) => a.level === Math.max(...pool.map((p) => p.level)));
  const picks = rng.shuffle([...newest]).slice(0, 2);
  for (const a of rng.shuffle(pool.filter((p) => !picks.includes(p)))) if (picks.length < 2) picks.push(a);
  for (const a of picks)
    out.push({ kind: 'ability', id: a.id, label: a.name, emoji: a.emoji, desc: `${a.kind === 'spell' ? `Spell (L${a.level})` : 'Ability'}: ${a.desc}` });
  const primary = content().classes[c.cls].primary;
  if (c.abilities[primary] < 20)
    out.push({ kind: 'asi', ability: primary, label: `+2 ${primary}`, emoji: '⬆️', desc: `Raise your ${primary} from ${c.abilities[primary]} to ${Math.min(20, c.abilities[primary] + 2)}.` });
  const perks = PERKS.filter((p) => !c.passives.includes(p.id) || p.id === 'perk_lucky');
  const perk = rng.pick(perks);
  out.push({ kind: 'perk', id: perk.id, label: perk.name, emoji: perk.emoji, desc: perk.desc });
  return out;
}

export function applyLevelUp(c: Character, choice: LevelChoice): string {
  if (c.pendingLevelUps <= 0) return '';
  c.pendingLevelUps--;
  c.level = Math.min(MAX_LEVEL, c.level + 1);
  let text = `${c.name} reached level ${c.level}!`;
  if (choice.kind === 'ability') {
    if (!c.known.includes(choice.id)) c.known.push(choice.id);
    text += ` Learned ${choice.label}.`;
  } else if (choice.kind === 'asi') {
    c.abilities[choice.ability] = Math.min(20, c.abilities[choice.ability] + 2);
    c.asi[choice.ability] = (c.asi[choice.ability] ?? 0) + 2;
    text += ` ${choice.label}.`;
  } else {
    if (choice.id === 'perk_lucky') c.inspiration += 2;
    if (!c.passives.includes(choice.id)) c.passives.push(choice.id);
    text += ` Gained the ${choice.label} perk.`;
  }
  const newPassives = content()
    .abilityList.filter((a) => a.kind === 'passive' && a.classes.includes(c.cls) && a.level === c.level)
    .map((a) => a.name);
  autoPassives(c);
  if (newPassives.length) text += ` New passive: ${newPassives.join(', ')}.`;
  refreshDerived(c);
  return text;
}

export function clearCombatState(c: Character) {
  c.buffs = [];
  c.conditions = c.conditions.filter((x) => x.id === 'inspired');
  c.tempHp = 0;
  c.death = { successes: 0, failures: 0, stable: false };
  if (c.down && !c.dead) {
    c.down = false;
    c.hp = Math.max(1, c.hp);
  }
}

export function shortRest(c: Character, opts: { bonusHeal?: number } = {}): number {
  if (c.dead) return 0;
  let heal = Math.ceil(c.maxHp * 0.5) + (opts.bonusHeal ?? 0);
  if (content().species[c.species].traits.some((t) => t.id === 'trance')) heal = Math.ceil(heal * 1.25);
  const before = c.hp;
  c.hp = Math.min(c.maxHp, c.hp + heal);
  c.down = false;
  for (const r of Object.values(c.resources)) if (r.recover === 'short') r.cur = r.max;
  const spGain = Math.ceil(c.maxSp / 2) + (content().species[c.species].traits.some((t) => t.id === 'trance') ? 2 : 0);
  c.sp = Math.min(c.maxSp, c.sp + spGain);
  c.conditions = c.conditions.filter((x) => x.id === 'inspired' || x.id === 'blessed');
  return c.hp - before;
}

export function longRest(c: Character) {
  if (c.dead) return;
  c.hp = c.maxHp;
  c.down = false;
  c.sp = c.maxSp;
  for (const r of Object.values(c.resources)) r.cur = r.max;
  c.conditions = c.conditions.filter((x) => x.id === 'inspired');
  c.buffs = [];
  if (c.passives.includes('perk_lucky')) c.inspiration += 1;
  if (c.species === 'human' && c.inspiration === 0) c.inspiration = 1;
}

export function equipItem(c: Character, uid: string): string | null {
  const idx = c.inventory.findIndex((i) => i.uid === uid);
  if (idx < 0) return 'Item not found';
  const it = c.inventory[idx]!;
  if (it.slot !== 'weapon' && it.slot !== 'armor' && it.slot !== 'trinket') return 'That cannot be equipped';
  const current = c.equipment[it.slot];
  if (current?.cursed) return `Your ${current.name} is cursed and won't come off!`;
  c.inventory.splice(idx, 1);
  if (current) c.inventory.push(current);
  c.equipment[it.slot] = it;
  refreshDerived(c);
  return null;
}

export function unequipItem(c: Character, slot: 'weapon' | 'armor' | 'trinket'): string | null {
  const it = c.equipment[slot];
  if (!it) return 'Nothing equipped';
  if (it.cursed) return `Your ${it.name} is cursed and won't come off!`;
  delete c.equipment[slot];
  c.inventory.push(it);
  refreshDerived(c);
  return null;
}

export function removeCurses(c: Character): number {
  let n = 0;
  for (const it of [c.equipment.weapon, c.equipment.armor, c.equipment.trinket, ...c.inventory]) if (it?.cursed) {
    it.cursed = false;
    it.name = it.name.replace(/^(Bloodthirsty|Leaden|Whispering|Greedy) /, 'Cleansed ');
    n++;
  }
  return n;
}

export function findItem(c: Character, uid: string): ItemInstance | undefined {
  return c.inventory.find((i) => i.uid === uid);
}
