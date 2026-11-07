/**
 * Bot policy for player characters: used by the balance simulator, by
 * "auto-defend" when a phone disconnects, and by the solo companion.
 */
import { content } from '../content/index.js';
import type { AbilityDef } from '../content/schemas.js';
import { averageDice, parseDice } from '../dice.js';
import type { Character } from '../types.js';
import {
  abilityUnavailable,
  allies,
  enemies,
  getBuff,
  isActive,
  partyChars,
  type CombatAction,
  type CombatCtx,
} from './combat.js';
import { castMod, weaponProfile } from './stats.js';

function known(c: Character): AbilityDef[] {
  return c.known.map((id) => content().abilities[id]).filter((a): a is AbilityDef => !!a && a.kind !== 'passive');
}

function usable(ctx: CombatCtx, c: Character, a: AbilityDef): boolean {
  if (abilityUnavailable(ctx, c, a)) return false;
  if (a.action === 'bonus' && ctx.combat.actorBonusUsed) return false;
  return true;
}

function expectedDamage(c: Character, a: AbilityDef, targets: number): number {
  let dmg = 0;
  for (const e of a.effects) if (e.type === 'damage') dmg += averageDice(e.dice) + (e.addMod ? castMod(c) : 0);
  if (a.resolve === 'weapon') {
    const wp = weaponProfile(c, a.ranged);
    dmg += averageDice(wp.dice) + wp.damageBonus;
  }
  if (a.scaling) {
    const steps = Math.floor((c.level - a.level) / a.scaling.every);
    if (steps > 0) dmg += averageDice(a.scaling.dice) * steps;
  }
  const n = a.target === 'allEnemies' ? targets : a.target === 'enemies3' ? Math.min(3, targets) : a.target === 'enemies2' ? Math.min(2, targets) : 1;
  return dmg * n * (a.resolve === 'save' ? 0.75 : a.resolve === 'auto' ? 1 : 0.65);
}

function lowestFoe(ctx: CombatCtx): string | undefined {
  const foes = enemies(ctx);
  const tele = foes.find((f) => f.telegraph);
  if (tele) return tele.id;
  return foes.sort((a, b) => a.hp - b.hp)[0]?.id;
}

/** Choose a bonus action to take before the main action (or null). */
export function botBonus(ctx: CombatCtx, c: Character): CombatAction | null {
  const abs = known(c).filter((a) => a.action === 'bonus' && usable(ctx, c, a));
  const party = partyChars(ctx);
  const downed = party.find((p) => p.down && !p.dead);
  const pick = (id: string) => abs.find((a) => a.id === id);
  const healWord = pick('healing_word') ?? pick('mass_healing_word');
  if (downed && healWord) return { type: 'ability', id: healWord.id, targets: [downed.id] };
  const low = allies(ctx).filter(isActive).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
  if (low && low.hp / low.maxHp < 0.35 && healWord) return { type: 'ability', id: healWord.id, targets: [low.id] };
  if (pick('rage') && !getBuff(c, 'rage')) return { type: 'ability', id: 'rage', targets: [] };
  if (pick('second_wind') && c.hp / c.maxHp < 0.5) return { type: 'ability', id: 'second_wind', targets: [] };
  if (pick('action_surge')) return { type: 'ability', id: 'action_surge', targets: [] };
  if (pick('spiritual_weapon') && !getBuff(c, 'spiritWeapon') && enemies(ctx).length) return { type: 'ability', id: 'spiritual_weapon', targets: [] };
  if (!getBuff(c, 'smite') && c.sp >= 2 && enemies(ctx).some((e) => e.hp > 12)) {
    for (const id of ['banishing_smite', 'branding_smite', 'thunderous_smite', 'divine_smite']) if (pick(id)) return { type: 'ability', id, targets: [] };
  }
  if (pick('poison_blade') && !getBuff(c, 'smite')) return { type: 'ability', id: 'poison_blade', targets: [] };
  if (pick('aggressive_charge') && !getBuff(c, 'smite')) return { type: 'ability', id: 'aggressive_charge', targets: [] };
  if (pick('frenzy') && getBuff(c, 'rage')) {
    const t = lowestFoe(ctx);
    if (t) return { type: 'ability', id: 'frenzy', targets: [t] };
  }
  if (pick('taunt') && c.hp / c.maxHp > 0.6 && !getBuff(c, 'taunt') && party.length > 1) return { type: 'ability', id: 'taunt', targets: [] };
  if (pick('bardic_inspiration')) {
    const ally = party.find((p) => p.id !== c.id && isActive(p) && !p.conditions.some((x) => x.id === 'inspired'));
    if (ally) return { type: 'ability', id: 'bardic_inspiration', targets: [ally.id] };
  }
  if (pick('cutting_words')) {
    const tele = enemies(ctx).find((e) => e.telegraph);
    if (tele) return { type: 'ability', id: 'cutting_words', targets: [tele.id] };
  }
  if (pick('shield') && c.hp / c.maxHp < 0.6 && c.sp > 3) return { type: 'ability', id: 'shield', targets: [] };
  if (pick('cunning_action') && c.hp / c.maxHp < 0.4) return { type: 'ability', id: 'cunning_action', targets: [] };
  if (pick('uncanny_dodge') && c.hp / c.maxHp < 0.4) return { type: 'ability', id: 'uncanny_dodge', targets: [] };
  if (pick('shield_of_faith') && c.sp > 3 && ctx.combat.round === 1) {
    const tank = party.filter(isActive).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
    if (tank) return { type: 'ability', id: 'shield_of_faith', targets: [tank.id] };
  }
  return null;
}

export function botAction(ctx: CombatCtx, c: Character): CombatAction {
  const abs = known(c).filter((a) => a.action !== 'bonus' && usable(ctx, c, a));
  const party = partyChars(ctx);
  const foes = enemies(ctx);
  if (!foes.length) return { type: 'defend' };
  const downed = party.filter((p) => p.down);
  // revive / heal
  const reviver = abs.find((a) => a.effects.some((e) => e.type === 'revive'));
  const dead = downed.find((d) => d.dead);
  if (dead && reviver) return { type: 'ability', id: reviver.id, targets: [dead.id] };
  const healers = abs.filter((a) => a.effects.some((e) => e.type === 'heal'));
  const dying = downed.find((d) => !d.dead);
  const lowAlly = allies(ctx).filter(isActive).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
  if (healers.length && (dying || (lowAlly && lowAlly.hp / lowAlly.maxHp < 0.35))) {
    const group = healers.find((a) => a.target === 'allAllies');
    const hurtCount = party.filter((p) => p.hp / p.maxHp < 0.5).length;
    if (group && hurtCount >= 2) return { type: 'ability', id: group.id, targets: [] };
    const single = healers.find((a) => a.target === 'ally') ?? healers[0]!;
    return { type: 'ability', id: single.id, targets: [(dying ?? lowAlly)!.id] };
  }
  const potion = c.inventory.find((i) => i.use?.heal && i.use.target !== 'enemy');
  if (potion && (dying || c.hp / c.maxHp < 0.25)) return { type: 'item', uid: potion.uid, targets: [(dying ?? c).id] };
  // counter a telegraph
  const tele = foes.find((f) => f.telegraph);
  if (tele) {
    const counter = abs.find((a) => a.tags.includes('counter'));
    if (counter) return { type: 'ability', id: counter.id, targets: [tele.id] };
  }
  // party buffs early in the fight
  if (ctx.combat.round <= 1 && party.length >= 3) {
    const bless = abs.find((a) => a.id === 'bless' || a.id === 'song_of_courage' || a.id === 'crusaders_mantle');
    if (bless && c.sp >= 3) return { type: 'ability', id: bless.id, targets: [] };
  }
  // best damage option
  const spPct = c.maxSp ? c.sp / c.maxSp : 1;
  let best: { a?: AbilityDef; score: number } = { score: 0 };
  const wp = weaponProfile(c);
  const basic = (averageDice(parseDice(wp.dice)) + wp.damageBonus) * 0.65 * (c.known.includes('extra_attack') ? 2 : 1);
  best.score = basic;
  for (const a of abs) {
    if (!a.effects.some((e) => e.type === 'damage' || e.type === 'condition')) continue;
    let s = expectedDamage(c, a, foes.length);
    if (a.effects.some((e) => e.type === 'condition' && (e.id === 'stunned' || e.id === 'charmed'))) s += 6 * (a.target === 'allEnemies' ? foes.length : 1);
    const cost = a.cost.sp ?? 0;
    if (cost > 0 && spPct < 0.3 && !ctx.combat.bossFight) s *= 0.4;
    if (a.cost.resource && !ctx.combat.bossFight && foes.length <= 1) s *= 0.7;
    if (s > best.score) best = { a, score: s };
  }
  const target = lowestFoe(ctx)!;
  if (best.a) {
    const multi = best.a.target === 'enemies2' || best.a.target === 'enemies3';
    return { type: 'ability', id: best.a.id, targets: multi ? foes.map((f) => f.id) : [target] };
  }
  // thrown consumables vs tough foes
  const bomb = c.inventory.find((i) => i.use?.damage);
  if (bomb && foes.some((f) => f.boss)) return { type: 'item', uid: bomb.uid, targets: [target] };
  return { type: 'attack', targets: [target] };
}
