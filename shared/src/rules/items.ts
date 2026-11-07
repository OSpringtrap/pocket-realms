import { content } from '../content/index.js';
import type { AffixDef, ItemBase } from '../content/schemas.js';
import type { Rng } from '../rng.js';
import { RARITIES, type ItemInstance, type ItemSlot, type Rarity } from '../types.js';

export const RARITY_COLOR: Record<Rarity, string> = {
  common: '#6b5b45',
  uncommon: '#2e7d32',
  rare: '#1565c0',
  epic: '#7b1fa2',
  legendary: '#e65100',
};
const RARITY_MULT: Record<Rarity, number> = { common: 1, uncommon: 3, rare: 8, epic: 20, legendary: 50 };

export function rarityIndex(r: Rarity): number {
  return RARITIES.indexOf(r);
}

export function newUid(rng: Rng, prefix = 'it'): string {
  return `${prefix}_${rng.int(0, 2 ** 30).toString(36)}${rng.int(0, 2 ** 20).toString(36)}`;
}

function applyMods(it: ItemInstance, mods: AffixDef['mods'] | ItemBase) {
  if (mods.attackBonus) it.attackBonus = (it.attackBonus ?? 0) + mods.attackBonus;
  if (mods.damageBonus) it.damageBonus = (it.damageBonus ?? 0) + mods.damageBonus;
  if (mods.acBonus) it.acBonus = (it.acBonus ?? 0) + mods.acBonus;
  if (mods.maxHpBonus) it.maxHpBonus = (it.maxHpBonus ?? 0) + mods.maxHpBonus;
  if (mods.spBonus) it.spBonus = (it.spBonus ?? 0) + mods.spBonus;
  if (mods.initBonus) it.initBonus = (it.initBonus ?? 0) + mods.initBonus;
  if (mods.critRange) it.critRange = Math.min(it.critRange ?? 20, mods.critRange);
  if (mods.damageType && it.slot === 'weapon') it.damageType = mods.damageType;
  if (mods.extraDamage) it.extraDamage = mods.extraDamage;
  if (mods.abilityBonus) {
    it.abilityBonus = { ...(it.abilityBonus ?? {}) };
    for (const [k, v] of Object.entries(mods.abilityBonus)) {
      const key = k as keyof typeof it.abilityBonus;
      it.abilityBonus[key] = (it.abilityBonus[key] ?? 0) + (v ?? 0);
    }
  }
  if (mods.skillBonus) {
    it.skillBonus = { ...(it.skillBonus ?? {}) };
    for (const [k, v] of Object.entries(mods.skillBonus)) {
      const key = k as keyof typeof it.skillBonus;
      it.skillBonus[key] = (it.skillBonus[key] ?? 0) + (v ?? 0);
    }
  }
  if (mods.resist?.length) it.resist = [...new Set([...(it.resist ?? []), ...mods.resist])];
}

export function makeItem(baseId: string, rng: Rng, opts: { rarity?: Rarity; affixes?: AffixDef[] } = {}): ItemInstance {
  const base = content().items[baseId];
  if (!base) throw new Error(`Unknown item ${baseId}`);
  const rarity = opts.rarity && rarityIndex(opts.rarity) > rarityIndex(base.rarity) ? opts.rarity : base.rarity;
  const it: ItemInstance = {
    uid: newUid(rng),
    baseId,
    name: base.name,
    slot: base.slot as ItemSlot,
    rarity,
    emoji: base.emoji,
    affixes: [],
    value: base.value,
    desc: base.desc,
    identified: true,
  };
  if (base.damage) it.damage = base.damage;
  if (base.damageType) it.damageType = base.damageType;
  if (base.finesse) it.finesse = true;
  if (base.ranged) it.ranged = true;
  if (base.twoHanded) it.twoHanded = true;
  if (base.acBase !== undefined) it.acBase = base.acBase;
  if (base.dexCap !== undefined) it.dexCap = base.dexCap;
  if (base.setId) it.setId = base.setId;
  if (base.use) it.use = { ...base.use } as ItemInstance['use'];
  applyMods(it, base);
  const affixes = opts.affixes ?? [];
  let prefix = '';
  let suffix = '';
  for (const a of affixes) {
    it.affixes.push({ id: a.id, name: a.name, kind: a.kind });
    applyMods(it, a.mods);
    if (a.cursed) it.cursed = true;
    if (a.kind === 'prefix') prefix = a.name;
    else suffix = a.name;
  }
  if (prefix || suffix) it.name = [prefix, base.name, suffix].filter(Boolean).join(' ');
  if (rarityIndex(rarity) > rarityIndex(base.rarity)) it.value = Math.round(base.value * RARITY_MULT[rarity] + 20 * affixes.length);
  if (affixes.length) it.desc = `${base.desc} ${affixes.map((a) => a.desc).join(' ')}`.trim();
  return it;
}

/** Weighted rarity roll; `boost` (0..100) shifts toward better rarities. d100 can be supplied by a player roll. */
export function rollRarity(rng: Rng, level: number, boost = 0, d100?: number): Rarity {
  const roll = Math.min(100, Math.max(1, d100 ?? rng.int(1, 100))) + boost + level * 2;
  if (roll >= 138) return 'legendary';
  if (roll >= 118) return 'epic';
  if (roll >= 92) return 'rare';
  if (roll >= 55) return 'uncommon';
  return 'common';
}

function pickAffix(rng: Rng, slot: ItemSlot, rarity: Rarity, kind: 'prefix' | 'suffix', allowCursed: boolean): AffixDef | undefined {
  const opts = content().affixes.filter(
    (a) =>
      a.kind === kind &&
      (a.slots as string[]).includes(slot) &&
      rarityIndex(a.minRarity) <= rarityIndex(rarity) &&
      (allowCursed || !a.cursed),
  );
  if (!opts.length) return undefined;
  return rng.weighted(opts.map((a) => ({ item: a, weight: a.weight * (a.cursed ? 0.6 : 1) })));
}

export function rollLoot(
  rng: Rng,
  opts: { level: number; boost?: number; slot?: ItemSlot; rarity?: Rarity; d100?: number; allowCursed?: boolean },
): ItemInstance {
  const rarity = opts.rarity ?? rollRarity(rng, opts.level, opts.boost ?? 0, opts.d100);
  const slot: ItemSlot =
    opts.slot ??
    rng.weighted<ItemSlot>([
      { item: 'consumable', weight: 38 },
      { item: 'weapon', weight: 22 },
      { item: 'armor', weight: 14 },
      { item: 'trinket', weight: 26 },
    ]);
  const ri = rarityIndex(rarity);
  const all = content().itemList.filter((b) => b.slot === slot && !b.unique);
  // Named items of exactly this rarity are sometimes chosen outright
  const named = all.filter((b) => b.rarity === rarity && rarityIndex(b.rarity) >= 2);
  if (named.length && (slot === 'consumable' || rng.chance(0.45))) return makeItem(rng.pick(named).id, rng, { rarity });
  let pool = all.filter((b) => rarityIndex(b.rarity) <= Math.min(ri, slot === 'consumable' ? ri : 1));
  if (slot === 'consumable') pool = all.filter((b) => rarityIndex(b.rarity) <= ri && rarityIndex(b.rarity) >= Math.max(0, ri - 1));
  if (!pool.length) pool = all;
  const base = rng.pick(pool);
  if (slot === 'consumable' || slot === 'quest') return makeItem(base.id, rng);
  const affixes: AffixDef[] = [];
  const allowCursed = opts.allowCursed ?? true;
  const cursedRoll = allowCursed && ri >= 1 && rng.chance(0.08);
  if (ri >= 1) {
    const first = rng.chance(0.5) ? 'prefix' : 'suffix';
    const a = pickAffix(rng, slot, rarity, first, cursedRoll);
    if (a) affixes.push(a);
  }
  if (ri >= 2) {
    const kind = affixes[0]?.kind === 'prefix' ? 'suffix' : 'prefix';
    const a = pickAffix(rng, slot, rarity, kind, false);
    if (a) affixes.push(a);
  }
  return makeItem(base.id, rng, { rarity, affixes });
}

export function sellValue(it: ItemInstance): number {
  return Math.max(1, Math.floor(it.value / 2));
}
export function buyPrice(it: ItemInstance, repDiscount = 0): number {
  return Math.max(1, Math.round(it.value * (1 - repDiscount)));
}

export function itemStatLine(it: ItemInstance): string {
  const parts: string[] = [];
  if (it.damage) parts.push(`${it.damage} ${it.damageType}`);
  if (it.acBase) parts.push(`AC ${it.acBase}${it.dexCap === 0 ? '' : '+DEX'}`);
  if (it.acBonus) parts.push(`${it.acBonus > 0 ? '+' : ''}${it.acBonus} AC`);
  if (it.attackBonus) parts.push(`${it.attackBonus > 0 ? '+' : ''}${it.attackBonus} hit`);
  if (it.damageBonus) parts.push(`${it.damageBonus > 0 ? '+' : ''}${it.damageBonus} dmg`);
  if (it.extraDamage) parts.push(`+${it.extraDamage.dice} ${it.extraDamage.dmg}`);
  if (it.spBonus) parts.push(`${it.spBonus > 0 ? '+' : ''}${it.spBonus} SP`);
  if (it.maxHpBonus) parts.push(`${it.maxHpBonus > 0 ? '+' : ''}${it.maxHpBonus} HP`);
  if (it.initBonus) parts.push(`${it.initBonus > 0 ? '+' : ''}${it.initBonus} init`);
  if (it.critRange && it.critRange < 20) parts.push(`crit ${it.critRange}+`);
  for (const [k, v] of Object.entries(it.abilityBonus ?? {})) parts.push(`${(v ?? 0) > 0 ? '+' : ''}${v} ${k}`);
  for (const [k, v] of Object.entries(it.skillBonus ?? {})) parts.push(`${(v ?? 0) > 0 ? '+' : ''}${v} ${k}`);
  if (it.resist?.length) parts.push(`resist ${it.resist.join('/')}`);
  if (it.cursed) parts.push('CURSED');
  return parts.join(' · ');
}
