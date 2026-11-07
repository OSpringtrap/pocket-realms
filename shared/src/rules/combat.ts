/**
 * Combat engine. Deterministic given (state, action, rng, io-results).
 *
 * Interactive rolls/minigames go through `CombatIO`: the server implements it by
 * prompting phones (or the seeded RNG for digital dice); tests and the bot
 * simulator implement it synchronously with the RNG. All rules live here.
 */
import { content } from '../content/index.js';
import type { AbilityDef, Effect, MonsterDef } from '../content/schemas.js';
import { addDice, diceFaces, parseDice, rollDice, type DiceExpr, type DieSides } from '../dice.js';
import type { Rng } from '../rng.js';
import {
  PHYSICAL,
  type Ability,
  type Buff,
  type Character,
  type CombatState,
  type ConditionId,
  type DamageType,
  type Difficulty,
  type MinigameKind,
  type Monster,
  type MonsterAttack,
} from '../types.js';
import { combineAdv, d20Count, miniTier, resolveD20, type AdvState, type MiniTier } from './checks.js';
import { newUid } from './items.js';
import {
  castMod,
  conditionImmunities,
  getAc,
  hasPassive,
  hasTrait,
  healBonus,
  initiativeBonus,
  minigameBonus,
  mod,
  profBonus,
  quirkAttackVs,
  resistances,
  saveBonus,
  spellAttackBonus,
  spellDC,
  statMod,
  weaponProfile,
} from './stats.js';

export type Unit = Character | Monster;
export const isChar = (u: Unit): u is Character => (u as Character).cls !== undefined;

export interface CombatCtx {
  combat: CombatState;
  chars: Record<string, Character>;
  party: string[];
  rng: Rng;
  difficulty: Difficulty;
}

export type CombatEvent =
  | { k: 'log'; text: string; tone?: 'hit' | 'miss' | 'crit' | 'heal' | 'info' | 'bad' | 'good' | 'fumble' }
  | { k: 'damage'; target: string; amount: number; dmg: DamageType; crit?: boolean; weak?: boolean; resist?: boolean }
  | { k: 'heal'; target: string; amount: number }
  | { k: 'miss'; target: string }
  | { k: 'condition'; target: string; id: ConditionId }
  | { k: 'down'; target: string }
  | { k: 'death'; target: string }
  | { k: 'revive'; target: string }
  | { k: 'telegraph'; source: string; target: string; text: string }
  | { k: 'anim'; anim: string; source: string; targets: string[] }
  | { k: 'sound'; name: string }
  | { k: 'enemyRoll'; who: string; label: string; rolls: number[]; total: number; dc?: number; success?: boolean }
  | { k: 'summon'; id: string };

export interface RollRequest {
  kind: 'attack' | 'damage' | 'save' | 'heal' | 'death' | 'check' | 'initiative' | 'loot' | 'fate';
  label: string;
  faces: DieSides[];
  bonus: number;
  dc?: number;
  adv?: AdvState;
}

export interface CombatIO {
  /** player minigame; resolves to a 0..1 score */
  minigame(playerId: string, kind: MinigameKind, label: string, param?: string): Promise<number>;
  /** player dice roll; resolves to face values */
  roll(playerId: string, req: RollRequest): Promise<number[]>;
  /** several players roll at once (AoE saves) */
  rollMany?(reqs: { playerId: string; req: RollRequest }[]): Promise<Record<string, number[]>>;
  /** several players play a minigame at once (bracing) */
  braceMany?(playerIds: string[], kind: MinigameKind, label: string): Promise<Record<string, number>>;
  emit(ev: CombatEvent): void;
  pause(ms: number): Promise<void>;
}

export type CombatAction =
  | { type: 'attack'; targets: string[] }
  | { type: 'ability'; id: string; targets: string[] }
  | { type: 'item'; uid: string; targets: string[] }
  | { type: 'defend' }
  | { type: 'flee' }
  | { type: 'pass' };

// ---------------------------------------------------------------- unit helpers

export function getUnit(ctx: CombatCtx, id: string): Unit | undefined {
  return ctx.chars[id] ?? ctx.combat.monsters.find((m) => m.id === id);
}
export function sideOf(u: Unit): 'party' | 'enemy' {
  return isChar(u) ? 'party' : u.side;
}
export function isActive(u: Unit | undefined): boolean {
  if (!u) return false;
  if (isChar(u)) return !u.down && !u.dead && u.hp > 0;
  return !u.dead && !u.fled && u.hp > 0;
}
export function partyChars(ctx: CombatCtx): Character[] {
  return ctx.party.map((id) => ctx.chars[id]).filter((c): c is Character => !!c);
}
export function allies(ctx: CombatCtx): Unit[] {
  return [...partyChars(ctx), ...ctx.combat.monsters.filter((m) => m.side === 'party' && !m.dead)];
}
export function enemies(ctx: CombatCtx): Monster[] {
  return ctx.combat.monsters.filter((m) => m.side === 'enemy' && isActive(m));
}
export function opponentsOf(ctx: CombatCtx, u: Unit): Unit[] {
  return sideOf(u) === 'party' ? enemies(ctx) : allies(ctx).filter(isActive);
}
export function friendsOf(ctx: CombatCtx, u: Unit): Unit[] {
  return sideOf(u) === 'party' ? allies(ctx) : ctx.combat.monsters.filter((m) => m.side === 'enemy' && !m.dead && !m.fled);
}
export function tagsOf(u: Unit): string[] {
  return isChar(u) ? ['humanoid', u.species] : u.tags;
}
export function acOf(u: Unit): number {
  if (isChar(u)) return getAc(u);
  let ac = u.ac;
  for (const b of u.buffs) {
    if (b.id === 'ac') ac += b.amount ?? 0;
    if (b.id === 'shield') ac += b.amount ?? 5;
  }
  if (u.conditions.some((c) => c.id === 'slowed')) ac -= 2;
  return ac;
}
export const hasCond = (u: Unit, id: ConditionId) => u.conditions.some((c) => c.id === id);
export const getBuff = (u: Unit, id: Buff['id']) => u.buffs.find((b) => b.id === id);
const hpRatio = (u: Unit) => u.hp / Math.max(1, u.maxHp);

function log(io: CombatIO, ctx: CombatCtx, text: string, tone?: Extract<CombatEvent, { k: 'log' }>['tone']) {
  ctx.combat.log.push({ t: ctx.combat.log.length, text, tone });
  if (ctx.combat.log.length > 60) ctx.combat.log.splice(0, ctx.combat.log.length - 60);
  io.emit({ k: 'log', text, tone });
}

function monsterSaveBonus(m: Monster, ab: Ability): number {
  return mod(m.abilities[ab]) + (m.boss ? 3 : Math.floor(m.tier / 2));
}

function auraOfProtection(ctx: CombatCtx, u: Unit): boolean {
  if (sideOf(u) !== 'party') return false;
  return partyChars(ctx).some((c) => isActive(c) && hasPassive(c, 'aura_of_protection'));
}
function auraOfCourage(ctx: CombatCtx): boolean {
  return partyChars(ctx).some((c) => isActive(c) && hasPassive(c, 'aura_of_courage'));
}

// ---------------------------------------------------------------- monsters

export function spawnMonster(def: MonsterDef, rng: Rng, opts: { elite?: boolean; side?: 'enemy' | 'party'; level?: number; hpMult?: number; name?: string } = {}): Monster {
  const hpMult = opts.hpMult ?? 1;
  const m: Monster = {
    id: newUid(rng, 'm'),
    defId: def.id,
    name: opts.name ?? def.name,
    emoji: def.emoji,
    side: opts.side ?? 'enemy',
    family: def.family,
    tier: def.tier,
    hp: Math.max(1, Math.round(def.hp * hpMult)),
    maxHp: Math.max(1, Math.round(def.hp * hpMult)),
    tempHp: 0,
    ac: def.ac,
    abilities: { ...def.stats },
    attacks: def.attacks.map((a) => ({ ...a })) as MonsterAttack[],
    behavior: def.behavior,
    weakness: def.weakness,
    resist: [...def.resist],
    immune: [...def.immune],
    tags: [...def.tags],
    conditions: [],
    buffs: [],
    xp: def.xp,
    boss: def.boss,
    legendary: def.legendary,
    legendaryLeft: def.legendary,
    multiattack: def.multiattack,
  };
  if (opts.elite) {
    m.elite = true;
    m.name = `Elite ${m.name}`;
    m.hp = m.maxHp = Math.round(m.maxHp * 1.4);
    m.ac += 1;
    m.attacks = m.attacks.map((a) => ({ ...a, toHit: a.toHit + 1 }));
    // the extra action keeps big parties busy; only for single-attack monsters so damage doesn't double
    if ((m.multiattack ?? 1) === 1) m.multiattack = 2;
    m.xp = Math.round(m.xp * 1.6);
  }
  return m;
}

/** Scale a boss (or any monster) to a party level: more HP, accuracy and damage dice. */
export function scaleMonsterToLevel(m: Monster, level: number) {
  const nominal = m.tier * 2 - 1; // tier 1 ~ L1, tier 3 ~ L5, tier 5 ~ L9
  const diff = level - nominal;
  if (diff === 0) return;
  const f = Math.max(0.28, 1.16 ** diff);
  m.maxHp = m.hp = Math.max(8, Math.round(m.maxHp * f));
  const hitShift = Math.round(diff * 0.6);
  const dmgF = Math.max(0.33, 1.12 ** diff);
  m.attacks = m.attacks.map((a) => {
    const out = { ...a, toHit: a.toHit + hitShift };
    if (a.save) out.save = { ...a.save, dc: Math.max(9, a.save.dc + hitShift) };
    if (a.damage !== '0') {
      const d = parseDice(a.damage);
      if (d.count > 0) {
        const count = Math.max(1, Math.round(d.count * dmgF));
        const bonus = Math.max(0, Math.round(d.bonus * Math.min(1.5, dmgF)));
        out.damage = `${count}d${d.sides}${bonus ? `+${bonus}` : ''}`;
      }
    }
    if (a.heal) {
      const d = parseDice(a.heal);
      out.heal = `${Math.max(1, Math.round(d.count * dmgF))}d${d.sides}${d.bonus ? `+${Math.max(0, Math.round(d.bonus * dmgF))}` : ''}`;
    }
    return out;
  });
  m.ac = Math.max(10, m.ac + Math.round(diff * 0.3));
  if (diff <= -3) {
    m.legendary = Math.max(0, (m.legendary ?? 0) - Math.ceil(-diff / 3));
    m.legendaryLeft = m.legendary;
    m.multiattack = Math.max(1, (m.multiattack ?? 1) - 1);
    m.xp = Math.round(m.xp * f);
  }
}

// ---------------------------------------------------------------- start / turn order

export function createCombat(rng: Rng, opts: { title: string; biome: CombatState['biome']; monsters: Monster[]; bossFight?: boolean; isFinal?: boolean }): CombatState {
  return {
    id: newUid(rng, 'c'),
    round: 0,
    order: [],
    initiative: {},
    turn: 0,
    monsters: opts.monsters,
    xpPool: 0,
    goldPool: 0,
    lootRarityBoost: 0,
    bossFight: opts.bossFight,
    isFinal: opts.isFinal,
    title: opts.title,
    biome: opts.biome,
    turnsTaken: 0,
    usedThisCombat: {},
    log: [],
  };
}

/** Sets initiative order. `playerRolls` are the d20 faces players rolled (or the server rolled for them). */
export function rollInitiative(ctx: CombatCtx, playerRolls: Record<string, number>, ambush = false) {
  const init: Record<string, number> = {};
  for (const c of partyChars(ctx)) {
    const r = playerRolls[c.id] ?? ctx.rng.die(20);
    init[c.id] = r + initiativeBonus(c) + (ambush ? -5 : 0) + (hasCond(c, 'slowed') ? -10 : 0);
  }
  for (const m of ctx.combat.monsters) {
    init[m.id] = ctx.rng.die(20) + mod(m.abilities.DEX) + (ambush && m.side === 'enemy' ? 5 : 0) + (m.boss ? 2 : 0);
  }
  ctx.combat.initiative = init;
  ctx.combat.order = Object.keys(init).sort((a, b) => init[b]! - init[a]! || a.localeCompare(b));
  ctx.combat.turn = 0;
  ctx.combat.round = 1;
}

export function currentId(ctx: CombatCtx): string | undefined {
  return ctx.combat.order[ctx.combat.turn];
}

/** Advance to the next creature that can take a turn (skips dead monsters). Returns its id. */
export function advanceTurn(ctx: CombatCtx): string | undefined {
  const c = ctx.combat;
  for (let i = 0; i < c.order.length + 1; i++) {
    c.turn++;
    if (c.turn >= c.order.length) {
      c.turn = 0;
      c.round++;
    }
    const id = c.order[c.turn]!;
    const u = getUnit(ctx, id);
    if (!u) continue;
    if (!isChar(u) && (u.dead || u.fled)) continue;
    return id;
  }
  return currentId(ctx);
}

export function addToInitiative(ctx: CombatCtx, m: Monster) {
  ctx.combat.monsters.push(m);
  const val = ctx.rng.die(20) + mod(m.abilities.DEX);
  ctx.combat.initiative[m.id] = val;
  // insert right after the current creature so it acts next round
  ctx.combat.order.splice(ctx.combat.turn + 1, 0, m.id);
}

export function checkOver(ctx: CombatCtx): CombatState['over'] {
  const c = ctx.combat;
  if (c.over) return c.over;
  if (enemies(ctx).length === 0) c.over = 'victory';
  else if (partyChars(ctx).every((ch) => !isActive(ch))) c.over = 'defeat';
  return c.over;
}

// ---------------------------------------------------------------- damage & healing

export function applyDamage(
  ctx: CombatCtx,
  io: CombatIO,
  target: Unit,
  amount: number,
  dmg: DamageType,
  opts: { crit?: boolean; source?: Unit; silent?: boolean } = {},
): number {
  if (amount <= 0) return 0;
  let a = Math.round(amount);
  let weak = false;
  let resist = false;
  if (isChar(target)) {
    const res = resistances(target);
    const rage = getBuff(target, 'rage');
    if (
      res.includes(dmg) ||
      getBuff(target, 'resistAll') ||
      ((rage || getBuff(target, 'resist')) && PHYSICAL.includes(dmg))
    ) {
      a = Math.floor(a / 2);
      resist = true;
    }
  } else {
    if (target.weakness === dmg) {
      a *= 2;
      weak = true;
    } else if (target.resist.includes(dmg) || getBuff(target, 'resistAll') || (getBuff(target, 'resist') && PHYSICAL.includes(dmg))) {
      a = Math.floor(a / 2);
      resist = true;
    }
    if (dmg === 'fire' || dmg === 'acid') target.burned = true;
  }
  const marked = getBuff(target, 'marked');
  if (marked?.amount && opts.source && sideOf(opts.source) !== sideOf(target)) a += marked.amount;
  // temp HP absorbs first
  if (target.tempHp > 0) {
    const absorbed = Math.min(target.tempHp, a);
    target.tempHp -= absorbed;
    a -= absorbed;
  }
  io.emit({ k: 'damage', target: target.id, amount: a, dmg, crit: opts.crit, weak, resist });
  if (opts.source && isChar(opts.source) && sideOf(target) === 'enemy') opts.source.stats.damageDealt += a;
  // charm breaks on damage
  if (a > 0 && hasCond(target, 'charmed')) target.conditions = target.conditions.filter((c) => c.id !== 'charmed');

  if (isChar(target)) {
    if (target.down) {
      if (a > 0) {
        target.death.failures += opts.crit ? 2 : 1;
        target.death.stable = false;
        log(io, ctx, `${target.name} takes a hit while down! (${target.death.failures}/3 failures)`, 'bad');
        if (target.death.failures >= 3) killChar(ctx, io, target);
      }
      return a;
    }
    const overflow = a - target.hp;
    target.hp = Math.max(0, target.hp - a);
    if (target.hp <= 0) {
      if (target.resources.relentless?.cur && target.species === 'orc') {
        target.resources.relentless.cur = 0;
        target.hp = 1;
        log(io, ctx, `${target.name} refuses to fall! Relentless Endurance keeps them standing at 1 HP.`, 'good');
        return a;
      }
      const usedRR = (ctx.combat.usedThisCombat[target.id]?.relentless_rage ?? 0) > 0;
      if (getBuff(target, 'rage') && hasPassive(target, 'relentless_rage') && !usedRR) {
        (ctx.combat.usedThisCombat[target.id] ??= {}).relentless_rage = 1;
        target.hp = 1;
        log(io, ctx, `${target.name}'s rage won't let them die! (1 HP)`, 'good');
        return a;
      }
      if (ctx.difficulty !== 'story' && overflow >= target.maxHp) {
        log(io, ctx, `${target.name} is struck down by a massive blow!`, 'bad');
        killChar(ctx, io, target);
        return a;
      }
      downChar(ctx, io, target);
    }
  } else {
    target.hp = Math.max(0, target.hp - a);
    if (target.hp <= 0 && !target.dead) {
      target.dead = true;
      target.telegraph = undefined;
      if (target.side === 'enemy') {
        ctx.combat.xpPool += target.xp;
        if (opts.source && isChar(opts.source)) opts.source.stats.kills++;
      }
      io.emit({ k: 'death', target: target.id });
      log(io, ctx, `${target.name} is defeated!`, 'good');
    }
  }
  return a;
}

function downChar(ctx: CombatCtx, io: CombatIO, c: Character) {
  c.hp = 0;
  c.down = true;
  c.death = { successes: 0, failures: 0, stable: false };
  c.buffs = c.buffs.filter((b) => b.id === 'regen');
  c.stats.downs++;
  io.emit({ k: 'down', target: c.id });
  log(io, ctx, `${c.name} falls unconscious!`, 'bad');
}

function killChar(ctx: CombatCtx, io: CombatIO, c: Character) {
  c.hp = 0;
  c.down = true;
  c.dead = true;
  io.emit({ k: 'death', target: c.id });
  log(io, ctx, `💀 ${c.name} has died...`, 'bad');
}

export function healUnit(ctx: CombatCtx, io: CombatIO, target: Unit, amount: number, healer?: Unit): number {
  if (isChar(target) && target.dead) return 0;
  let a = Math.max(0, Math.round(amount));
  if (isChar(target)) a += healBonus(target);
  const before = target.hp;
  target.hp = Math.min(target.maxHp, target.hp + a);
  const healed = target.hp - before;
  if (isChar(target) && target.down && target.hp > 0) {
    target.down = false;
    target.death = { successes: 0, failures: 0, stable: false };
    io.emit({ k: 'revive', target: target.id });
    log(io, ctx, `${target.name} is back on their feet!`, 'good');
  }
  if (healer && isChar(healer)) healer.stats.healed += healed;
  io.emit({ k: 'heal', target: target.id, amount: healed });
  return healed;
}

export function applyCondition(ctx: CombatCtx, io: CombatIO, target: Unit, id: ConditionId, turns: number, source?: string): boolean {
  if (!isActive(target) && !(isChar(target) && !target.dead)) return false;
  const immune = isChar(target) ? conditionImmunities(target) : target.immune;
  if (immune.includes(id)) {
    log(io, ctx, `${target.name} is immune to being ${id}.`, 'info');
    return false;
  }
  if (id === 'frightened' && sideOf(target) === 'party' && auraOfCourage(ctx)) {
    log(io, ctx, `${target.name} stands firm — the Aura of Courage holds!`, 'good');
    return false;
  }
  let t = turns;
  if (!isChar(target) && target.boss && (id === 'stunned' || id === 'charmed')) t = 1;
  if (isChar(target) && id === 'poisoned' && hasTrait(target, 'poison_resistance')) t = Math.max(1, Math.ceil(t / 2));
  const existing = target.conditions.find((c) => c.id === id);
  if (existing) existing.turns = Math.max(existing.turns, t);
  else target.conditions.push({ id, turns: t, source });
  if (id === 'stunned' && !isChar(target) && target.telegraph) {
    target.telegraph = undefined;
    log(io, ctx, `${target.name}'s wind-up is broken!`, 'good');
  }
  io.emit({ k: 'condition', target: target.id, id });
  return true;
}

export function addBuff(target: Unit, buff: Buff) {
  const existing = target.buffs.find((b) => b.id === buff.id && b.name === buff.name);
  if (existing) Object.assign(existing, buff, { turns: Math.max(existing.turns, buff.turns) });
  else target.buffs.push({ ...buff });
}

// ---------------------------------------------------------------- turn hooks

/** Start-of-turn effects. Returns false if the creature can't act (stunned/dead). */
export async function startTurn(ctx: CombatCtx, io: CombatIO, id: string): Promise<boolean> {
  const u = getUnit(ctx, id);
  if (!u) return false;
  ctx.combat.actorBonusUsed = false;
  // buffs tick at the start of their owner's turn
  for (const b of u.buffs) b.turns--;
  const expired = u.buffs.filter((b) => b.turns <= 0);
  u.buffs = u.buffs.filter((b) => b.turns > 0);
  for (const b of expired) if (b.name && b.id !== 'shield' && b.id !== 'dodge') log(io, ctx, `${u.name}'s ${b.name} fades.`, 'info');
  if (!isChar(u) && u.legendary) u.legendaryLeft = u.legendary;
  if (!isActive(u)) return false;

  const burning = u.conditions.find((c) => c.id === 'burning');
  if (burning) {
    const r = rollDice(ctx.rng, '1d6');
    log(io, ctx, `${u.name} burns for ${r.total}!`, 'bad');
    applyDamage(ctx, io, u, r.total, 'fire');
  }
  const regen = getBuff(u, 'regen');
  if (regen && isActive(u)) healUnit(ctx, io, u, regen.amount ?? 3);
  if (!isChar(u) && u.tags.includes('regen') && isActive(u)) {
    if (!u.burned && u.hp < u.maxHp) {
      healUnit(ctx, io, u, 10);
      log(io, ctx, `${u.name} regenerates! (Fire or acid stops this.)`, 'bad');
    }
    u.burned = false;
  }
  const sw = getBuff(u, 'spiritWeapon');
  if (sw && isActive(u)) {
    const foes = opponentsOf(ctx, u);
    if (foes.length) {
      const t = ctx.rng.pick(foes);
      const r = rollDice(ctx.rng, sw.dice ?? '1d8');
      log(io, ctx, `${u.name}'s ${sw.name ?? 'spectral weapon'} strikes ${t.name}!`, 'hit');
      io.emit({ k: 'anim', anim: 'holy', source: u.id, targets: [t.id] });
      applyDamage(ctx, io, t, r.total, sw.dmg ?? 'force', { source: u });
    }
  }
  const aura = getBuff(u, 'concentrate');
  if (aura && isActive(u)) {
    const foes = opponentsOf(ctx, u);
    if (foes.length) {
      const r = rollDice(ctx.rng, aura.dice ?? '2d8');
      log(io, ctx, `${aura.name ?? 'Guardians'} sear every foe for ${r.total}!`, 'hit');
      io.emit({ k: 'anim', anim: 'holy', source: u.id, targets: foes.map((f) => f.id) });
      for (const f of foes) applyDamage(ctx, io, f, tagsOf(f).includes('undead') ? r.total : Math.ceil(r.total * 0.75), aura.dmg ?? 'radiant', { source: u });
    }
  }
  if (!isActive(u)) return false;
  if (hasCond(u, 'stunned')) {
    log(io, ctx, `${u.name} is stunned and can't act!`, 'info');
    return false;
  }
  return true;
}

export function endTurn(ctx: CombatCtx, id: string) {
  const u = getUnit(ctx, id);
  if (!u) return;
  for (const c of u.conditions) if (c.turns < 90) c.turns--;
  u.conditions = u.conditions.filter((c) => c.turns > 0);
  ctx.combat.turnsTaken++;
}

// ---------------------------------------------------------------- availability (menu)

export interface ActionOption {
  key: string; // 'attack' | 'defend' | 'flee' | 'ab:<id>' | 'it:<uid>'
  label: string;
  emoji: string;
  desc: string;
  group: 'Actions' | 'Abilities' | 'Spells' | 'Items';
  bonus: boolean;
  cost?: string;
  disabled?: string;
  target: AbilityDef['target'];
  minigame?: MinigameKind;
}

function abilityCostText(c: Character, a: AbilityDef): string | undefined {
  const parts: string[] = [];
  if (a.cost.sp) parts.push(`${a.cost.sp} SP`);
  if (a.cost.resource) parts.push(`${a.cost.amount ?? 1} ${c.resources[a.cost.resource]?.name ?? a.cost.resource}`);
  if (a.usesPerCombat) parts.push(`${a.usesPerCombat}/fight`);
  return parts.join(', ') || (a.kind === 'spell' ? 'free' : undefined);
}

export function abilityUnavailable(ctx: CombatCtx, c: Character, a: AbilityDef): string | undefined {
  if (a.kind === 'passive') return 'Passive';
  if (a.cost.sp && c.sp < a.cost.sp) return 'Not enough SP';
  if (a.cost.resource) {
    const r = c.resources[a.cost.resource];
    if (!r || r.cur < (a.cost.amount ?? 1)) return `No ${r?.name ?? a.cost.resource} left`;
  }
  if (a.usesPerCombat && (ctx.combat.usedThisCombat[c.id]?.[a.id] ?? 0) >= a.usesPerCombat) return 'Used up this fight';
  if (a.effects.some((e) => e.type === 'flee') && ctx.combat.bossFight) return "Can't escape this fight";
  if (a.target === 'downedAlly' && !partyChars(ctx).some((p) => p.down && (!p.dead || a.effects.some((e) => e.type === 'revive' && e.dead)))) return 'Nobody is down';
  if (a.target === 'otherAlly' && allies(ctx).filter((x) => x.id !== c.id && isActive(x)).length === 0) return 'No allies';
  return undefined;
}

export function actionOptions(ctx: CombatCtx, c: Character, bonusOnly: boolean): ActionOption[] {
  const out: ActionOption[] = [];
  if (!bonusOnly) {
    const wp = weaponProfile(c);
    out.push({ key: 'attack', label: `Attack (${wp.name})`, emoji: '⚔️', desc: `${wp.dice}${wp.damageBonus ? (wp.damageBonus > 0 ? `+${wp.damageBonus}` : `${wp.damageBonus}`) : ''} ${wp.dmg}, ${wp.toHit >= 0 ? '+' : ''}${wp.toHit} to hit`, group: 'Actions', bonus: false, target: 'enemy', minigame: 'swing' });
    out.push({ key: 'defend', label: 'Defend', emoji: '🛡️', desc: 'Attacks against you have disadvantage until your next turn.', group: 'Actions', bonus: false, target: 'self' });
  }
  for (const id of c.known) {
    const a = content().abilities[id];
    if (!a || a.kind === 'passive') continue;
    const isBonus = a.action === 'bonus';
    if (bonusOnly && !isBonus) continue;
    if (!bonusOnly && isBonus && ctx.combat.actorBonusUsed) continue;
    out.push({
      key: `ab:${a.id}`,
      label: a.name,
      emoji: a.emoji,
      desc: a.desc,
      group: a.kind === 'spell' ? 'Spells' : 'Abilities',
      bonus: isBonus,
      cost: abilityCostText(c, a),
      disabled: abilityUnavailable(ctx, c, a) ?? (isBonus && ctx.combat.actorBonusUsed ? 'Bonus action used' : undefined),
      target: a.target,
      minigame: a.minigame?.kind,
    });
  }
  if (!bonusOnly) {
    for (const it of c.inventory) {
      if (it.slot !== 'consumable' || !it.use) continue;
      const tgt: AbilityDef['target'] = it.use.target === 'self' ? 'self' : it.use.target === 'ally' ? (it.use.revive ? 'downedAlly' : 'ally') : it.use.target === 'allEnemies' ? 'allEnemies' : 'enemy';
      out.push({ key: `it:${it.uid}`, label: it.name, emoji: it.emoji, desc: it.desc, group: 'Items', bonus: false, target: tgt });
    }
    if (!ctx.combat.bossFight) out.push({ key: 'flee', label: 'Retreat', emoji: '🏃', desc: 'Try to get the whole party out (group Athletics check). Costs time.', group: 'Actions', bonus: false, target: 'self' });
  }
  return out;
}

/** Candidate target ids for a target type, from the acting character's point of view. */
export function targetCandidates(ctx: CombatCtx, actor: Unit, target: AbilityDef['target']): string[] {
  switch (target) {
    case 'enemy':
    case 'enemies2':
    case 'enemies3':
    case 'allEnemies':
      return opponentsOf(ctx, actor).map((u) => u.id);
    case 'ally':
    case 'allAllies':
      return friendsOf(ctx, actor).filter((u) => !isChar(u) || !u.dead).map((u) => u.id);
    case 'otherAlly':
      return friendsOf(ctx, actor).filter((u) => u.id !== actor.id && isActive(u)).map((u) => u.id);
    case 'downedAlly':
      return partyChars(ctx).filter((u) => u.down).map((u) => u.id);
    case 'self':
      return [actor.id];
  }
}

export function maxTargets(target: AbilityDef['target']): number {
  return target === 'enemies2' ? 2 : target === 'enemies3' ? 3 : 1;
}
export function needsTargetChoice(target: AbilityDef['target']): boolean {
  return target === 'enemy' || target === 'ally' || target === 'otherAlly' || target === 'downedAlly' || target === 'enemies2' || target === 'enemies3';
}

/** Expand chosen targets into the actual list (fills AoE and validates against candidates). */
export function resolveTargets(ctx: CombatCtx, actor: Unit, target: AbilityDef['target'], chosen: string[]): string[] {
  const cands = targetCandidates(ctx, actor, target);
  if (target === 'allEnemies' || target === 'allAllies') return cands;
  if (target === 'self') return [actor.id];
  const n = maxTargets(target);
  const picked = [...new Set(chosen.filter((id) => cands.includes(id)))].slice(0, n);
  // auto-fill multi-target abilities with remaining candidates
  for (const id of cands) if (picked.length < n && !picked.includes(id) && (target === 'enemies2' || target === 'enemies3')) picked.push(id);
  if (picked.length === 0 && cands.length) picked.push(cands[0]!);
  return picked;
}

// ---------------------------------------------------------------- attack math

export function attackAdvantage(ctx: CombatCtx, attacker: Unit, target: Unit, ranged: boolean): { adv: number; dis: number; notes: string[] } {
  let adv = 0;
  let dis = 0;
  const notes: string[] = [];
  if (getBuff(attacker, 'invisible')) (adv++, notes.push('unseen'));
  if (getBuff(attacker, 'reckless')) (adv++, notes.push('reckless'));
  if (hasCond(attacker, 'poisoned')) (dis++, notes.push('poisoned'));
  if (hasCond(attacker, 'frightened')) (dis++, notes.push('frightened'));
  if (hasCond(attacker, 'blinded')) (dis++, notes.push('blinded'));
  if (hasCond(attacker, 'prone')) (dis++, notes.push('prone'));
  if (hasCond(target, 'stunned')) (adv++, notes.push('target stunned'));
  if (hasCond(target, 'blinded')) (adv++, notes.push('target blinded'));
  if (hasCond(target, 'prone')) ranged ? (dis++, notes.push('target prone')) : (adv++, notes.push('target prone'));
  if (getBuff(target, 'marked')) (adv++, notes.push('marked'));
  if (getBuff(target, 'reckless')) (adv++, notes.push('target reckless'));
  if (getBuff(target, 'dodge')) (dis++, notes.push('target dodging'));
  if (getBuff(target, 'invisible')) (dis++, notes.push('target unseen'));
  if (isChar(attacker)) {
    const q = quirkAttackVs(attacker, tagsOf(target));
    if (q.dis) (dis++, notes.push('quirk'));
    if (q.adv) (adv++, notes.push('quirk'));
  }
  return { adv, dis, notes };
}

interface DamageComponent {
  expr: DiceExpr;
  dmg: DamageType;
}

function scaledExtra(c: Character, a: AbilityDef): DiceExpr[] {
  if (!a.scaling) return [];
  const steps = Math.floor((c.level - a.level) / a.scaling.every);
  if (steps <= 0) return [];
  const d = parseDice(a.scaling.dice);
  return [{ count: d.count * steps, sides: d.sides, bonus: d.bonus * steps }];
}

/** Turn components into the dice the player must roll, handling crit doubling. */
function componentsToRoll(comps: DamageComponent[], crit: boolean): { faces: DieSides[]; bonus: number } {
  const faces: DieSides[] = [];
  let bonus = 0;
  for (const c of comps) {
    const n = crit ? c.expr.count * 2 : c.expr.count;
    for (let i = 0; i < n; i++) faces.push(c.expr.sides);
    bonus += c.expr.bonus;
  }
  return { faces, bonus };
}

/** Distribute rolled face values back to components → per damage type totals. */
function sumByType(comps: DamageComponent[], values: number[], crit: boolean): Map<DamageType, number> {
  const out = new Map<DamageType, number>();
  let i = 0;
  for (const c of comps) {
    const n = crit ? c.expr.count * 2 : c.expr.count;
    let s = c.expr.bonus;
    for (let k = 0; k < n; k++) s += values[i++] ?? 1;
    out.set(c.dmg, (out.get(c.dmg) ?? 0) + Math.max(0, s));
  }
  return out;
}

function sanitizeRolls(faces: DieSides[], values: number[] | undefined, rng: Rng): number[] {
  return faces.map((f, i) => {
    const v = values?.[i];
    return Number.isInteger(v) && v! >= 1 && v! <= f ? v! : rng.die(f);
  });
}

function miniBonus(c: Character, kind: MinigameKind | undefined, raw: number | undefined): { tier: MiniTier; score: number } {
  if (raw === undefined || kind === undefined) return { tier: 'none', score: 0 };
  const score = Math.max(0, Math.min(1, raw + minigameBonus(c, kind)));
  const tier = miniTier(score);
  if (tier === 'great') c.stats.minigamesAced++;
  return { tier, score };
}

const tierBonusDice = (tier: MiniTier) => (tier === 'great' ? 2 : tier === 'good' ? 1 : 0);

// ---------------------------------------------------------------- player actions

export interface ActionResult {
  ok: boolean;
  error?: string;
  bonus?: boolean; // was a bonus action (turn continues)
  extraAction?: boolean;
  fled?: boolean;
}

function payCost(ctx: CombatCtx, c: Character, a: AbilityDef, refund: number) {
  if (a.cost.sp) c.sp = Math.max(0, c.sp - Math.max(0, a.cost.sp - refund));
  if (a.cost.resource) {
    const r = c.resources[a.cost.resource];
    if (r) r.cur = Math.max(0, r.cur - (a.cost.amount ?? 1));
  }
  if (a.usesPerCombat) {
    const u = (ctx.combat.usedThisCombat[c.id] ??= {});
    u[a.id] = (u[a.id] ?? 0) + 1;
  }
}

async function d20ForChar(ctx: CombatCtx, io: CombatIO, c: Character, label: string, adv: AdvState, bonus: number, kind: RollRequest['kind'], dc?: number) {
  const faces: DieSides[] = Array(d20Count(adv)).fill(20);
  const vals = sanitizeRolls(faces, await io.roll(c.id, { kind, label, faces, bonus, adv, dc }), ctx.rng);
  let extra = 0;
  const notes: string[] = [];
  if (hasCond(c, 'blessed') && (kind === 'attack' || kind === 'save')) {
    const b = ctx.rng.die(4);
    extra += b;
    notes.push(`bless +${b}`);
  }
  const insp = c.conditions.find((x) => x.id === 'inspired');
  if (insp) {
    const b = ctx.rng.die(6);
    extra += b;
    notes.push(`inspired +${b}`);
    c.conditions = c.conditions.filter((x) => x !== insp);
  }
  return { vals, extra, notes };
}

export async function performAction(ctx: CombatCtx, io: CombatIO, actorId: string, action: CombatAction): Promise<ActionResult> {
  const c = ctx.chars[actorId];
  if (!c || !isActive(c)) return { ok: false, error: 'You cannot act' };
  switch (action.type) {
    case 'pass':
      log(io, ctx, `${c.name} waits.`, 'info');
      return { ok: true };
    case 'defend':
      addBuff(c, { id: 'dodge', turns: 1, name: 'Defending' });
      log(io, ctx, `${c.name} raises their guard.`, 'info');
      io.emit({ k: 'anim', anim: 'shield', source: c.id, targets: [c.id] });
      return { ok: true };
    case 'flee':
      return flee(ctx, io, c);
    case 'attack':
      return weaponAttackAction(ctx, io, c, action.targets);
    case 'item':
      return useItem(ctx, io, c, action.uid, action.targets);
    case 'ability': {
      const a = content().abilities[action.id];
      if (!a || !c.known.includes(a.id)) return { ok: false, error: 'Unknown ability' };
      const why = abilityUnavailable(ctx, c, a);
      if (why) return { ok: false, error: why };
      if (a.action === 'bonus' && ctx.combat.actorBonusUsed) return { ok: false, error: 'Bonus action already used' };
      const res = await useAbility(ctx, io, c, a, action.targets);
      if (a.action === 'bonus') {
        ctx.combat.actorBonusUsed = true;
        res.bonus = true;
      }
      return res;
    }
  }
}

async function flee(ctx: CombatCtx, io: CombatIO, c: Character): Promise<ActionResult> {
  if (ctx.combat.bossFight) return { ok: false, error: "You can't flee this fight!" };
  const dc = 10 + Math.max(...enemies(ctx).map((m) => m.tier), 1) * 2;
  const bonus = Math.max(statMod(c, 'DEX'), statMod(c, 'STR')) + (c.skills.includes('athletics') || c.skills.includes('acrobatics') ? profBonus(c.level) : 0);
  const { vals, extra } = await d20ForChar(ctx, io, c, `Retreat! (DC ${dc})`, 0, bonus, 'check', dc);
  const r = resolveD20(vals, 0, bonus + extra);
  if (r.total >= dc || r.crit) {
    log(io, ctx, `${c.name} finds an escape route — the party retreats!`, 'good');
    ctx.combat.over = 'fled';
    return { ok: true, fled: true };
  }
  log(io, ctx, `${c.name} can't find a way out! (${r.total} vs DC ${dc})`, 'bad');
  addBuff(c, { id: 'dodge', turns: 1, name: 'Scrambling' });
  return { ok: true };
}

async function weaponAttackAction(ctx: CombatCtx, io: CombatIO, c: Character, targets: string[]): Promise<ActionResult> {
  const attacks = hasPassive(c, 'extra_attack') ? 2 : 1;
  const total = attacks + (getBuff(c, 'haste') ? 1 : 0);
  let first = targets;
  for (let i = 0; i < total; i++) {
    const tgts = resolveTargets(ctx, c, 'enemy', i === 0 ? first : first.filter((id) => isActive(getUnit(ctx, id))));
    if (!tgts.length) break;
    await weaponStrike(ctx, io, c, tgts, { label: total > 1 ? `Attack ${i + 1}/${total}` : 'Attack', minigame: i === 0 ? 'swing' : undefined });
    if (checkOver(ctx)) break;
    first = tgts;
  }
  return { ok: true };
}

interface StrikeOpts {
  label: string;
  ability?: AbilityDef;
  minigame?: MinigameKind;
  attackBonus?: number;
  critRange?: number;
  ranged?: boolean;
  forcedAdv?: boolean;
  extraComps?: DamageComponent[];
  mini?: { tier: MiniTier; bonus?: string };
}

/** One weapon attack roll applied against each target. */
async function weaponStrike(ctx: CombatCtx, io: CombatIO, c: Character, targetIds: string[], o: StrikeOpts): Promise<{ hits: string[] }> {
  const wp = weaponProfile(c, o.ranged);
  const targets = targetIds.map((id) => getUnit(ctx, id)).filter((u): u is Unit => !!u && isActive(u));
  if (!targets.length) return { hits: [] };
  const primary = targets[0]!;
  let mini = o.mini;
  if (!mini && o.minigame) {
    const raw = await io.minigame(c.id, o.minigame, `${o.label}: ${o.minigame === 'swing' ? 'swing your phone!' : 'go!'}`);
    const mb = miniBonus(c, o.minigame, raw);
    mini = { tier: mb.tier, bonus: 'adv' };
  }
  const { adv, dis, notes } = attackAdvantage(ctx, c, primary, wp.ranged);
  let advCount = adv + (o.forcedAdv ? 1 : 0);
  let toHit = wp.toHit + (o.attackBonus ?? 0) + quirkAttackVs(c, tagsOf(primary)).bonus;
  let critRange = Math.min(wp.critRange, o.critRange ?? 20);
  for (const b of c.buffs) if (b.id === 'attack') toHit += b.amount ?? 0;
  if (mini && mini.tier !== 'none') {
    if (mini.bonus === 'adv') mini.tier === 'great' ? advCount++ : (toHit += 2);
    if (mini.bonus === 'critRange') critRange -= mini.tier === 'great' ? 2 : 1;
    if (mini.bonus === 'bonusDie') toHit += mini.tier === 'great' ? 3 : 2;
  }
  const advState = combineAdv(advCount, dis);
  const label = `${o.label} vs ${primary.name}${notes.length ? ` (${notes.join(', ')})` : ''}`;
  const { vals, extra, notes: rollNotes } = await d20ForChar(ctx, io, c, label, advState, toHit, 'attack');
  const res = resolveD20(vals, advState, toHit + extra, critRange);
  if (getBuff(c, 'invisible') && !(o.ability?.id === 'greater_invisibility')) c.buffs = c.buffs.filter((b) => b.id !== 'invisible' || b.name === 'Greater Invisibility');
  const hits = targets.filter((t) => res.crit || (!res.fumble && res.total >= acOf(t)));
  const extraTxt = rollNotes.length ? ` [${rollNotes.join(', ')}]` : '';
  if (res.fumble) {
    c.stats.fumbles++;
    log(io, ctx, `${c.name} fumbles! ${fumbleFlavor(ctx.rng)}`, 'fumble');
    io.emit({ k: 'sound', name: 'fumble' });
    if (ctx.rng.chance(0.35)) applyCondition(ctx, io, c, 'prone', 1);
    return { hits: [] };
  }
  for (const t of targets) if (!hits.includes(t)) {
    io.emit({ k: 'miss', target: t.id });
    log(io, ctx, `${c.name} misses ${t.name} (${res.total} vs AC ${acOf(t)})${extraTxt}.`, 'miss');
  }
  if (!hits.length) return { hits: [] };
  if (res.crit) {
    c.stats.crits++;
    io.emit({ k: 'sound', name: 'crit' });
  }

  // Build damage components
  const comps: DamageComponent[] = [];
  const weaponDice = parseDice(wp.dice);
  const flat = wp.damageBonus + (c.passives.includes('perk_mighty') ? 1 : 0) + c.buffs.filter((b) => b.id === 'damage').reduce((s, b) => s + (b.amount ?? 0), 0) + (!wp.ranged ? getBuff(c, 'rage')?.amount ?? 0 : 0) + quirkAttackVs(c, tagsOf(primary)).dmg;
  const weaponEffect = o.ability?.effects.find((e): e is Extract<Effect, { type: 'damage' }> => e.type === 'damage');
  if (!o.ability || weaponEffect?.weapon !== false) comps.push({ expr: { ...weaponDice, bonus: flat }, dmg: wp.dmg });
  else comps.push({ expr: { count: 0, sides: 6, bonus: flat }, dmg: wp.dmg });
  if (weaponEffect) {
    const d = parseDice(weaponEffect.dice);
    if (d.count || d.bonus) comps.push({ expr: d, dmg: weaponEffect.weapon ? wp.dmg : weaponEffect.dmg });
  }
  if (o.ability) for (const s of scaledExtra(c, o.ability)) comps.push({ expr: s, dmg: weaponEffect?.dmg ?? wp.dmg });
  for (const e of wp.extra) comps.push({ expr: parseDice(e.dice), dmg: e.dmg });
  for (const b of c.buffs) if (b.id === 'imbue' && b.dice) comps.push({ expr: parseDice(b.dice), dmg: b.dmg ?? 'radiant' });
  const smite = getBuff(c, 'smite');
  if (smite?.dice) {
    const sd = parseDice(smite.dice);
    const undeadBonus = smite.dmg === 'radiant' && tagsOf(hits[0]!).includes('undead') ? sd.count : 0;
    comps.push({ expr: { ...sd, count: sd.count + undeadBonus }, dmg: smite.dmg ?? 'radiant' });
    c.buffs = c.buffs.filter((b) => b !== smite);
    log(io, ctx, `${smite.name ?? 'Smite'} erupts!`, 'crit');
  }
  const sneakUsed = (ctx.combat.usedThisCombat[c.id]?.[`sneak_${ctx.combat.round}`] ?? 0) > 0;
  if (hasPassive(c, 'sneak_attack') && !sneakUsed) {
    const allyUp = allies(ctx).some((a) => a.id !== c.id && isActive(a));
    if (advState === 1 || allyUp || hits[0]!.conditions.length > 0) {
      comps.push({ expr: { count: Math.ceil(c.level / 2), sides: 6, bonus: 0 }, dmg: wp.dmg });
      (ctx.combat.usedThisCombat[c.id] ??= {})[`sneak_${ctx.combat.round}`] = 1;
      log(io, ctx, `Sneak Attack!`, 'crit');
    }
  }
  if (res.crit && hasPassive(c, 'brutal_critical')) comps.push({ expr: { count: 1, sides: weaponDice.sides, bonus: 0 }, dmg: wp.dmg });
  if (o.extraComps) comps.push(...o.extraComps);
  if (mini && (mini.bonus === 'damage' || mini.bonus === 'potency') && mini.tier !== 'none') comps.push({ expr: { count: tierBonusDice(mini.tier), sides: 6, bonus: 0 }, dmg: wp.dmg });

  const roll = componentsToRoll(comps, res.crit);
  const dmgVals = sanitizeRolls(roll.faces, roll.faces.length ? await io.roll(c.id, { kind: 'damage', label: `${res.crit ? 'CRITICAL! ' : ''}Damage`, faces: roll.faces, bonus: roll.bonus }) : [], ctx.rng);
  const byType = sumByType(comps, dmgVals, res.crit);
  io.emit({ k: 'anim', anim: o.ability?.anim ?? 'slash', source: c.id, targets: hits.map((h) => h.id) });
  for (const t of hits) {
    const tot = [...byType.values()].reduce((a, b) => a + b, 0);
    log(io, ctx, `${res.crit ? '💥 CRIT! ' : ''}${c.name} hits ${t.name} (${res.total} vs AC ${acOf(t)})${extraTxt} for ${tot}.`, res.crit ? 'crit' : 'hit');
    for (const [dmg, amt] of byType) applyDamage(ctx, io, t, amt, dmg, { crit: res.crit, source: c });
    thorns(ctx, io, c, t, wp.ranged);
  }
  return { hits: hits.map((h) => h.id) };
}

function thorns(ctx: CombatCtx, io: CombatIO, attacker: Unit, target: Unit, ranged: boolean) {
  const th = getBuff(target, 'thorns');
  if (!th || ranged || !isActive(attacker)) return;
  const r = rollDice(ctx.rng, th.dice ?? '1d6');
  log(io, ctx, `${target.name} counters! ${attacker.name} takes ${r.total}.`, 'hit');
  applyDamage(ctx, io, attacker, r.total, th.dmg ?? 'piercing', { source: target });
}

const FUMBLES = [
  'Their weapon slips and clatters across the floor.',
  'They trip over a suspiciously placed rock.',
  'They swing so hard they spin around twice.',
  'A bird chooses this exact moment to land on their head.',
  'They sneeze mid-swing.',
  'They hit the wall. The wall wins.',
];
function fumbleFlavor(rng: Rng) {
  return rng.pick(FUMBLES);
}

async function useAbility(ctx: CombatCtx, io: CombatIO, c: Character, a: AbilityDef, chosen: string[]): Promise<ActionResult> {
  const targetIds = resolveTargets(ctx, c, a.target, chosen);
  if (!targetIds.length && a.target !== 'self') return { ok: false, error: 'No valid targets' };
  let mini: { tier: MiniTier; score: number } = { tier: 'none', score: 0 };
  if (a.minigame) {
    const raw = await io.minigame(c.id, a.minigame.kind, a.name, a.minigame.param);
    mini = miniBonus(c, a.minigame.kind, raw);
  }
  const refund = a.minigame?.bonus === 'cost' ? (mini.tier === 'great' ? 99 : mini.tier === 'good' ? 1 : 0) : 0;
  payCost(ctx, c, a, refund);
  io.emit({ k: 'sound', name: a.sound });
  log(io, ctx, `${c.name} uses ${a.emoji} ${a.name}!${mini.tier !== 'none' ? ` (${mini.tier === 'great' ? 'PERFECT' : 'Nice'} ${a.minigame?.kind}!)` : ''}`, 'info');
  const res: ActionResult = { ok: true };
  const bonusKind = a.minigame?.bonus;
  const potency = bonusKind === 'potency' || bonusKind === 'damage' ? tierBonusDice(mini.tier) : 0;

  if (a.resolve === 'weapon') {
    const tgts = targetIds;
    const strikes = a.target === 'allEnemies' || a.target === 'enemies2' || a.target === 'enemies3' ? [tgts] : [tgts.slice(0, 1)];
    for (const group of strikes) {
      const forcedAdv = a.tags.includes('advantage');
      const { hits } = await weaponStrike(ctx, io, c, group, {
        label: a.name,
        ability: a,
        attackBonus: a.attackBonus,
        critRange: a.critRange,
        ranged: a.ranged,
        forcedAdv,
        mini: { tier: mini.tier, bonus: bonusKind },
      });
      for (const hid of hits) {
        const t = getUnit(ctx, hid)!;
        await applySecondaryEffects(ctx, io, c, a, [t], mini.tier, potency);
      }
    }
    for (const e of a.effects) if (e.type === 'buff' && e.buff.id === 'reckless') addBuff(c, { ...e.buff });
    return res;
  }

  const targets = targetIds.map((id) => getUnit(ctx, id)).filter((u): u is Unit => !!u);
  io.emit({ k: 'anim', anim: a.anim, source: c.id, targets: targets.map((t) => t.id) });

  // Damage components from effects
  const comps: DamageComponent[] = [];
  for (const e of a.effects) {
    if (e.type !== 'damage') continue;
    const d = parseDice(e.dice);
    let dmg = e.dmg;
    if (a.tags.includes('ancestry') && c.ancestry) dmg = content().species.dragonborn.ancestries?.find((x) => x.id === c.ancestry)?.dmg ?? dmg;
    comps.push({ expr: { ...d, bonus: d.bonus + (e.addMod ? castMod(c) : 0) }, dmg });
  }
  if (comps.length) {
    for (const s of scaledExtra(c, a)) comps.push({ expr: s, dmg: comps[0]!.dmg });
    if (potency) comps.push({ expr: { count: potency, sides: Math.min(8, comps[0]!.expr.sides || 6) as DieSides, bonus: 0 }, dmg: comps[0]!.dmg });
  }

  if (a.resolve === 'spellAttack') {
    const t = targets[0];
    if (!t || !isActive(t)) return res;
    const { adv, dis, notes } = attackAdvantage(ctx, c, t, true);
    let advCount = adv;
    let critRange = a.critRange ?? 20;
    let toHit = spellAttackBonus(c);
    if (bonusKind === 'adv' && mini.tier !== 'none') mini.tier === 'great' ? advCount++ : (toHit += 2);
    if (bonusKind === 'critRange' && mini.tier !== 'none') critRange -= mini.tier === 'great' ? 2 : 1;
    if (bonusKind === 'bonusDie' && mini.tier !== 'none') toHit += mini.tier === 'great' ? 3 : 2;
    const advState = combineAdv(advCount, dis);
    const { vals, extra } = await d20ForChar(ctx, io, c, `${a.name} vs ${t.name}${notes.length ? ` (${notes.join(', ')})` : ''}`, advState, toHit, 'attack');
    const r = resolveD20(vals, advState, toHit + extra, critRange);
    if (getBuff(c, 'invisible')) c.buffs = c.buffs.filter((b) => b.id !== 'invisible' || b.name === 'Greater Invisibility');
    if (r.fumble || (!r.crit && r.total < acOf(t))) {
      if (r.fumble) {
        c.stats.fumbles++;
        log(io, ctx, `${c.name}'s spell fizzles spectacularly! ${ctx.rng.pick(['Sparks singe their eyebrows.', 'A small cloud rains on them.', 'It summons a confused pigeon.'])}`, 'fumble');
      } else log(io, ctx, `${a.name} misses ${t.name} (${r.total} vs AC ${acOf(t)}).`, 'miss');
      io.emit({ k: 'miss', target: t.id });
      return res;
    }
    if (r.crit) {
      c.stats.crits++;
      io.emit({ k: 'sound', name: 'crit' });
    }
    const roll = componentsToRoll(comps, r.crit);
    const vals2 = sanitizeRolls(roll.faces, await io.roll(c.id, { kind: 'damage', label: `${r.crit ? 'CRITICAL! ' : ''}${a.name} damage`, faces: roll.faces, bonus: roll.bonus }), ctx.rng);
    const byType = sumByType(comps, vals2, r.crit);
    const tot = [...byType.values()].reduce((x, y) => x + y, 0);
    log(io, ctx, `${r.crit ? '💥 CRIT! ' : ''}${a.name} hits ${t.name} for ${tot}!`, r.crit ? 'crit' : 'hit');
    for (const [dmg, amt] of byType) applyDamage(ctx, io, t, amt * (a.tags.includes('undeadBane') && tagsOf(t).includes('undead') ? 2 : 1), dmg, { crit: r.crit, source: c });
    await applySecondaryEffects(ctx, io, c, a, [t], mini.tier, potency);
    return res;
  }

  if (a.resolve === 'save') {
    const dc = a.kind === 'spell' || content().classes[c.cls].castAbility ? spellDC(c) : 8 + profBonus(c.level) + statMod(c, content().classes[c.cls].primary);
    let byType = new Map<DamageType, number>();
    if (comps.length) {
      const roll = componentsToRoll(comps, false);
      const vals = sanitizeRolls(roll.faces, await io.roll(c.id, { kind: 'damage', label: `${a.name} damage`, faces: roll.faces, bonus: roll.bonus }), ctx.rng);
      byType = sumByType(comps, vals, false);
    }
    const saveAb = a.save?.ability ?? 'DEX';
    const failed: Unit[] = [];
    for (const t of targets) {
      if (!isActive(t)) continue;
      const saved = enemySave(ctx, io, t, saveAb, dc, bonusKind === 'adv' ? mini.tier : 'none');
      const mult = (a.tags.includes('undeadBane') && tagsOf(t).includes('undead') ? 2 : 1) * (saved ? (a.save?.half ? 0.5 : 0) : 1);
      for (const [dmg, amt] of byType) if (mult > 0) applyDamage(ctx, io, t, Math.floor(amt * mult), dmg, { source: c });
      if (!saved) failed.push(t);
    }
    await applySecondaryEffects(ctx, io, c, a, failed, mini.tier, potency, true);
    return res;
  }

  // auto
  if (comps.length) {
    const roll = componentsToRoll(comps, false);
    const vals = sanitizeRolls(roll.faces, await io.roll(c.id, { kind: 'damage', label: `${a.name} damage`, faces: roll.faces, bonus: roll.bonus }), ctx.rng);
    const byType = sumByType(comps, vals, false);
    for (const t of targets) for (const [dmg, amt] of byType) if (isActive(t)) applyDamage(ctx, io, t, amt, dmg, { source: c });
  }
  const r2 = await applySecondaryEffects(ctx, io, c, a, targets, mini.tier, potency);
  if (r2.extraAction) res.extraAction = true;
  if (r2.fled) res.fled = true;
  return res;
}

/** Monster (or party companion) save vs a player's effect. Shown on the host as an enemy roll. */
function enemySave(ctx: CombatCtx, io: CombatIO, t: Unit, ab: Ability, dc: number, casterMini: MiniTier): boolean {
  if (isChar(t)) return false;
  let adv = 0;
  let dis = casterMini === 'great' ? 1 : 0;
  const pen = casterMini === 'good' ? 2 : 0;
  if (hasCond(t, 'stunned') && (ab === 'STR' || ab === 'DEX')) {
    io.emit({ k: 'enemyRoll', who: t.id, label: `${ab} save`, rolls: [], total: 0, dc, success: false });
    return false;
  }
  if (hasCond(t, 'slowed') && ab === 'DEX') dis++;
  if (t.boss) adv++;
  const st = combineAdv(adv, dis);
  const rolls = Array.from({ length: d20Count(st) }, () => ctx.rng.die(20));
  const r = resolveD20(rolls, st, monsterSaveBonus(t, ab) - pen);
  const success = r.total >= dc && !r.fumble;
  io.emit({ k: 'enemyRoll', who: t.id, label: `${ab} save`, rolls: r.rolls, total: r.total, dc, success });
  log(io, ctx, `${t.name} ${success ? 'resists' : 'fails to resist'} (${ab} save ${r.total} vs DC ${dc}).`, success ? 'miss' : 'hit');
  return success;
}

async function applySecondaryEffects(
  ctx: CombatCtx,
  io: CombatIO,
  c: Character,
  a: AbilityDef,
  targets: Unit[],
  tier: MiniTier,
  potency: number,
  savedAlready = false,
): Promise<{ extraAction?: boolean; fled?: boolean }> {
  const out: { extraAction?: boolean; fled?: boolean } = {};
  const extraTurns = a.minigame?.bonus === 'potency' ? tierBonusDice(tier) : 0;
  for (const e of a.effects) {
    switch (e.type) {
      case 'damage':
        break;
      case 'heal': {
        const d = parseDice(e.dice);
        const scale = scaledExtra(c, a);
        const list = addDice([d, ...scale, ...(potency ? [{ count: potency, sides: d.sides, bonus: 0 }] : [])]);
        const faces = diceFaces(list);
        const bonus = list.reduce((s, x) => s + x.bonus, 0) + (e.addMod ? castMod(c) : 0);
        const vals = sanitizeRolls(faces, await io.roll(c.id, { kind: 'heal', label: `${a.name} healing`, faces, bonus }), ctx.rng);
        const amt = vals.reduce((s, v) => s + v, 0) + bonus;
        for (const t of targets) {
          const h = healUnit(ctx, io, t, amt, c);
          log(io, ctx, `${t.name} recovers ${h} HP.`, 'heal');
        }
        break;
      }
      case 'tempHp': {
        const d = parseDice(e.dice);
        const list = addDice([d, ...scaledExtra(c, a), ...(potency ? [{ count: potency, sides: d.sides, bonus: 0 }] : [])]);
        const r = rollDice(ctx.rng, list[0]!);
        const extra = list.slice(1).reduce((s, x) => s + rollDice(ctx.rng, x).total, 0);
        const amt = r.total + extra + (e.addMod ? castMod(c) : 0) + c.level;
        for (const t of targets) {
          t.tempHp = Math.max(t.tempHp, amt);
          log(io, ctx, `${t.name} gains ${amt} temporary HP.`, 'good');
        }
        break;
      }
      case 'condition': {
        for (const t of targets) {
          if (!isActive(t) && e.id !== 'inspired' && e.id !== 'blessed') continue;
          // weapon abilities with a save: target saves vs the condition
          if (a.resolve === 'weapon' && a.save && !savedAlready && !isChar(t)) {
            const dc = 8 + profBonus(c.level) + statMod(c, content().classes[c.cls].primary);
            if (enemySave(ctx, io, t, a.save.ability, dc, a.minigame?.bonus === 'adv' ? tier : 'none')) continue;
          }
          if (applyCondition(ctx, io, t, e.id, e.turns + (sideOf(t) === 'party' ? extraTurns : 0), c.id))
            log(io, ctx, `${t.name} is ${e.id}!`, sideOf(t) === 'party' ? 'good' : 'hit');
        }
        break;
      }
      case 'removeCondition':
        for (const t of targets) {
          const before = t.conditions.length;
          t.conditions = t.conditions.filter((x) => (e.ids ? !e.ids.includes(x.id) : x.id === 'blessed' || x.id === 'inspired'));
          if (t.conditions.length < before) log(io, ctx, `${t.name} is cleansed.`, 'good');
        }
        break;
      case 'buff': {
        if (e.buff.id === 'reckless') break; // applied to self by caller
        const recipients = a.target === 'self' ? [c] : targets;
        for (const t of recipients) {
          const b: Buff = { ...e.buff, source: c.id, turns: e.buff.turns + (sideOf(t) === 'party' ? extraTurns : 0) };
          if (b.id === 'smite' && b.dice && potency) {
            const d = parseDice(b.dice);
            b.dice = `${d.count + potency}d${d.sides}${d.bonus ? `+${d.bonus}` : ''}`;
          }
          if (b.dice && a.scaling && (b.id === 'smite' || b.id === 'spiritWeapon' || b.id === 'concentrate')) {
            const ex = scaledExtra(c, a)[0];
            if (ex) {
              const d = parseDice(b.dice);
              if (d.sides === ex.sides) b.dice = `${d.count + ex.count}d${d.sides}${d.bonus ? `+${d.bonus}` : ''}`;
            }
          }
          if (b.id === 'rage' && c.level >= 9) b.amount = (b.amount ?? 2) + 1;
          if (b.id === 'rage' && tier !== 'none') b.amount = (b.amount ?? 2) + (tier === 'great' ? 2 : 1);
          addBuff(t, b);
          log(io, ctx, `${t.name} gains ${b.name ?? b.id}.`, sideOf(t) === 'party' ? 'good' : 'hit');
        }
        break;
      }
      case 'revive':
        for (const t of targets) {
          if (!isChar(t) || !t.down) continue;
          if (t.dead && !e.dead) continue;
          t.dead = false;
          t.down = false;
          t.hp = Math.min(t.maxHp, e.hp + potency * 5 + c.level);
          t.death = { successes: 0, failures: 0, stable: false };
          io.emit({ k: 'revive', target: t.id });
          log(io, ctx, `✨ ${t.name} returns to life!`, 'good');
        }
        break;
      case 'restoreSp':
        for (const t of targets) if (isChar(t)) t.sp = Math.min(t.maxSp, t.sp + e.amount);
        break;
      case 'cancelTelegraph':
        for (const t of targets)
          if (!isChar(t) && t.telegraph) {
            t.telegraph = undefined;
            log(io, ctx, `${t.name}'s big attack is interrupted!`, 'good');
          }
        break;
      case 'extraAction':
        out.extraAction = true;
        log(io, ctx, `${c.name} surges with energy — an extra action!`, 'good');
        break;
      case 'flee': {
        if (ctx.combat.bossFight) {
          log(io, ctx, `There's no escaping this fight!`, 'bad');
          break;
        }
        if (tier === 'none' && ctx.rng.chance(0.25)) {
          log(io, ctx, `${c.name}'s escape is spotted! It fails.`, 'bad');
          break;
        }
        ctx.combat.over = 'fled';
        out.fled = true;
        log(io, ctx, `In a puff of smoke, the party vanishes!`, 'good');
        break;
      }
      case 'steal': {
        const r = rollDice(ctx.rng, e.gold);
        const amt = r.total * (1 + potency);
        ctx.combat.goldPool += amt;
        log(io, ctx, `${c.name} lifts ${amt} gold from ${targets[0]?.name ?? 'someone'}!`, 'good');
        io.emit({ k: 'sound', name: 'coin' });
        break;
      }
      case 'push':
        for (const t of targets) applyCondition(ctx, io, t, 'prone', e.turns);
        break;
      case 'execute':
        for (const t of targets)
          if (!isChar(t) && !t.boss && t.hp <= e.threshold * c.level && isActive(t)) {
            log(io, ctx, `${c.name} finishes ${t.name}!`, 'crit');
            applyDamage(ctx, io, t, t.hp, 'force', { source: c });
          }
        break;
      case 'summonAlly': {
        const def = content().monsters[e.monsterId];
        if (def && ctx.combat.monsters.filter((m) => m.side === 'party' && !m.dead).length < 2) {
          const m = spawnMonster(def, ctx.rng, { side: 'party' });
          addToInitiative(ctx, m);
          io.emit({ k: 'summon', id: m.id });
          log(io, ctx, `${m.name} joins the fight!`, 'good');
        }
        break;
      }
      case 'reveal':
        break;
    }
  }
  return out;
}

async function useItem(ctx: CombatCtx, io: CombatIO, c: Character, uid: string, chosen: string[]): Promise<ActionResult> {
  const idx = c.inventory.findIndex((i) => i.uid === uid);
  const it = c.inventory[idx];
  if (!it || !it.use) return { ok: false, error: 'Item not found' };
  const u = it.use;
  const tgtType: AbilityDef['target'] = u.target === 'self' ? 'self' : u.target === 'ally' ? (u.revive ? 'downedAlly' : 'ally') : u.target === 'allEnemies' ? 'allEnemies' : 'enemy';
  let targets = resolveTargets(ctx, c, tgtType, chosen).map((id) => getUnit(ctx, id)).filter((x): x is Unit => !!x);
  if (u.revive && !targets.length) targets = [c];
  if (!targets.length) return { ok: false, error: 'No valid target' };
  c.inventory.splice(idx, 1);
  log(io, ctx, `${c.name} uses ${it.emoji} ${it.name}!`, 'info');
  io.emit({ k: 'sound', name: u.damage ? 'boom' : 'potion' });
  io.emit({ k: 'anim', anim: u.damage ? (u.damageType === 'fire' ? 'fire' : 'arcane') : 'heal', source: c.id, targets: targets.map((t) => t.id) });
  for (const t of targets) {
    if (u.revive && isChar(t) && t.down) {
      t.dead = false;
      t.down = false;
      t.hp = 1;
      io.emit({ k: 'revive', target: t.id });
      log(io, ctx, `${t.name} rises from the brink!`, 'good');
    }
  }
  if (u.heal) {
    const d = parseDice(u.heal);
    const faces = diceFaces([d]);
    const vals = sanitizeRolls(faces, await io.roll(c.id, { kind: 'heal', label: `${it.name}`, faces, bonus: d.bonus }), ctx.rng);
    const amt = vals.reduce((s, v) => s + v, 0) + d.bonus;
    for (const t of targets) log(io, ctx, `${t.name} recovers ${healUnit(ctx, io, t, amt, c)} HP.`, 'heal');
  }
  if (u.sp) for (const t of targets) if (isChar(t)) t.sp = Math.min(t.maxSp, t.sp + u.sp);
  if (u.cleanse) for (const t of targets) t.conditions = t.conditions.filter((x) => x.id === 'blessed' || x.id === 'inspired');
  if (u.damage) {
    const d = parseDice(u.damage);
    const faces = diceFaces([d]);
    const vals = sanitizeRolls(faces, await io.roll(c.id, { kind: 'damage', label: `${it.name} damage`, faces, bonus: d.bonus }), ctx.rng);
    const amt = vals.reduce((s, v) => s + v, 0) + d.bonus;
    for (const t of targets) if (isActive(t)) applyDamage(ctx, io, t, amt * (u.damageType === 'radiant' && tagsOf(t).includes('undead') ? 2 : 1), u.damageType ?? 'force', { source: c });
  }
  if (u.condition) for (const t of targets) if (isActive(t) && applyCondition(ctx, io, t, u.condition, 1, c.id)) log(io, ctx, `${t.name} is ${u.condition}!`, 'hit');
  if (u.buff) for (const t of targets) addBuff(t, { ...u.buff });
  return { ok: true };
}

// ---------------------------------------------------------------- death saves & spirits

export async function deathSave(ctx: CombatCtx, io: CombatIO, c: Character): Promise<void> {
  if (!c.down || c.dead || c.death.stable) return;
  const faces: DieSides[] = [20];
  const v = sanitizeRolls(faces, await io.roll(c.id, { kind: 'death', label: `☠️ Death save (${c.death.successes}✔ ${c.death.failures}✖)`, faces, bonus: 0, dc: 10 }), ctx.rng)[0]!;
  if (v === 20) {
    c.down = false;
    c.hp = 1;
    c.death = { successes: 0, failures: 0, stable: false };
    io.emit({ k: 'revive', target: c.id });
    log(io, ctx, `🌟 NATURAL 20! ${c.name} surges back to consciousness!`, 'crit');
    return;
  }
  if (v === 1) c.death.failures += 2;
  else if (v >= 10) c.death.successes++;
  else c.death.failures++;
  log(io, ctx, `${c.name} rolls a death save: ${v} — ${v >= 10 ? 'holding on' : 'slipping away'} (${c.death.successes}✔ ${c.death.failures}✖).`, v >= 10 ? 'good' : 'bad');
  if (c.death.failures >= 3) killChar(ctx, io, c);
  else if (c.death.successes >= 3) {
    c.death.stable = true;
    log(io, ctx, `${c.name} is stable.`, 'info');
    if (ctx.difficulty === 'story') {
      c.down = false;
      c.hp = 1;
      io.emit({ k: 'revive', target: c.id });
      log(io, ctx, `${c.name} staggers back up with 1 HP!`, 'good');
    }
  }
}

/** Spirits of fallen heroes still help: a ghostly nudge to an ally or a chill on a foe. */
export function spiritNudge(ctx: CombatCtx, io: CombatIO, c: Character, targetId: string) {
  const t = getUnit(ctx, targetId);
  if (!t || !isActive(t)) return;
  if (sideOf(t) === 'party') {
    applyCondition(ctx, io, t, 'inspired', 99, c.id);
    log(io, ctx, `👻 ${c.name}'s spirit whispers encouragement to ${t.name}. (Inspired!)`, 'good');
  } else {
    applyCondition(ctx, io, t, 'frightened', 1, c.id);
    log(io, ctx, `👻 ${c.name}'s spirit haunts ${t.name}! (Frightened)`, 'good');
  }
}

// ---------------------------------------------------------------- monster AI

function pickAttack(ctx: CombatCtx, m: Monster): MonsterAttack {
  const hurtAlly = friendsOf(ctx, m).some((f) => f.id !== m.id && isActive(f) && hpRatio(f) < 0.6) || hpRatio(m) < 0.5;
  const enemyCount = ctx.combat.monsters.filter((x) => x.side === m.side && isActive(x)).length;
  const usable = m.attacks.filter((a) => {
    if (a.heal && !hurtAlly) return false;
    if (a.summon && (enemyCount >= 6 || ctx.combat.round < 2)) return false;
    if (a.telegraph && ctx.combat.round < 2 && !m.boss) return false;
    return true;
  });
  const list = usable.length ? usable : m.attacks.filter((a) => !a.heal && !a.summon);
  const weights = list.map((a) => ({ item: a, weight: (a.weight ?? 1) * (a.telegraph && m.boss ? 1.6 : 1) * (a.heal && m.behavior === 'support' ? 2 : 1) }));
  return ctx.rng.weighted(weights.length ? weights : [{ item: m.attacks[0]!, weight: 1 }]);
}

function pickTarget(ctx: CombatCtx, m: Monster): Unit | undefined {
  const foes = opponentsOf(ctx, m);
  if (!foes.length) return undefined;
  const taunter = foes.find((f) => getBuff(f, 'taunt'));
  if (taunter && !hasCond(m, 'blinded')) return taunter;
  let pool = foes;
  // sanctuary: enemies must pass a WIS save to target
  pool = pool.filter((f) => {
    if (!getBuff(f, 'sanctuary')) return true;
    const r = ctx.rng.die(20) + monsterSaveBonus(m, 'WIS');
    return r >= 13;
  });
  if (!pool.length) pool = foes.filter((f) => !getBuff(f, 'sanctuary'));
  if (!pool.length) return undefined;
  switch (m.behavior) {
    case 'skirmisher':
      return ctx.rng.chance(0.45) ? pool.reduce((a, b) => (b.hp < a.hp ? b : a)) : ctx.rng.pick(pool);
    case 'brute':
      return ctx.rng.chance(0.5) ? pool.reduce((a, b) => (acOf(b) < acOf(a) ? b : a)) : ctx.rng.pick(pool);
    default:
      return ctx.rng.pick(pool);
  }
}

async function monsterAttackOne(ctx: CombatCtx, io: CombatIO, m: Monster, atk: MonsterAttack, targets: Unit[], braced?: Record<string, number>) {
  const atkMod = m.buffs.filter((b) => b.id === 'attack').reduce((s, b) => s + (b.amount ?? 0), 0);
  if (atk.save) {
    // Player saving throws are rolled on the phones
    const dmgRoll = rollDice(ctx.rng, atk.damage);
    const reqs = targets.filter(isActive).map((t) => {
      const br = braced?.[t.id];
      let adv = 0;
      let dis = 0;
      let bonus = isChar(t) ? saveBonus(t, atk.save!.ability, { auraOfProtection: auraOfProtection(ctx, t) }) : monsterSaveBonus(t as Monster, atk.save!.ability);
      if (isChar(t) && atk.save!.ability === 'DEX' && hasPassive(t, 'danger_sense') && atk.telegraph) adv++;
      if (hasCond(t, 'slowed') && atk.save!.ability === 'DEX') dis++;
      const tier = miniTier(br);
      if (tier === 'great') adv++;
      else if (tier === 'good') bonus += 2;
      return { t, adv: combineAdv(adv, dis), bonus };
    });
    let results: Record<string, number[]> = {};
    const charReqs = reqs.filter((r) => isChar(r.t));
    const mkReq = (r: (typeof reqs)[number]): RollRequest => ({ kind: 'save', label: `${atk.save!.ability} save vs ${m.name}'s ${atk.name}!`, faces: Array(d20Count(r.adv)).fill(20), bonus: r.bonus, adv: r.adv, dc: atk.save!.dc });
    if (io.rollMany && charReqs.length > 1) results = await io.rollMany(charReqs.map((r) => ({ playerId: r.t.id, req: mkReq(r) })));
    else for (const r of charReqs) results[r.t.id] = await io.roll(r.t.id, mkReq(r));
    for (const r of reqs) {
      const t = r.t;
      let saved: boolean;
      let total: number;
      if (isChar(t)) {
        if (hasCond(t, 'stunned') && (atk.save.ability === 'DEX' || atk.save.ability === 'STR')) {
          saved = false;
          total = 0;
        } else {
          const vals = sanitizeRolls(Array(d20Count(r.adv)).fill(20), results[t.id], ctx.rng);
          let extra = 0;
          if (hasCond(t, 'blessed')) extra += ctx.rng.die(4);
          const insp = t.conditions.find((x) => x.id === 'inspired');
          if (insp) {
            extra += ctx.rng.die(6);
            t.conditions = t.conditions.filter((x) => x !== insp);
          }
          const res = resolveD20(vals, r.adv, r.bonus + extra);
          total = res.total;
          saved = (res.total >= atk.save.dc || res.crit) && !res.fumble;
        }
      } else {
        const res = resolveD20([ctx.rng.die(20)], 0, r.bonus);
        total = res.total;
        saved = res.total >= atk.save.dc;
      }
      const evasion = isChar(t) && atk.save.ability === 'DEX' && (hasPassive(t, 'evasion') || getBuff(t, 'evasive'));
      let amt = dmgRoll.total;
      if (saved) amt = evasion ? 0 : atk.save.half ? Math.floor(amt / 2) : 0;
      else if (evasion) amt = Math.floor(amt / 2);
      log(io, ctx, `${t.name} ${saved ? 'saves' : 'fails'} (${total} vs DC ${atk.save.dc})${amt ? ` and takes ${amt}` : ''}.`, saved ? 'good' : 'bad');
      if (amt > 0) applyDamage(ctx, io, t, amt, atk.dmg, { source: m });
      if (!saved && atk.condition && isActive(t) && (atk.condition.chance === undefined || ctx.rng.chance(atk.condition.chance)))
        if (applyCondition(ctx, io, t, atk.condition.id, atk.condition.turns, m.id)) log(io, ctx, `${t.name} is ${atk.condition.id}!`, 'bad');
    }
    return;
  }
  for (const t of targets) {
    if (!isActive(t)) continue;
    const ranged = /bow|sling|bolt|ray|lance|spit|crossbow|throw|toss/i.test(atk.name);
    const { adv, dis } = attackAdvantage(ctx, m, t, ranged);
    let d = dis;
    let acBonus = 0;
    const tier = miniTier(braced?.[t.id]);
    if (tier === 'great') d++;
    else if (tier === 'good') acBonus = 2;
    const st = combineAdv(adv, d);
    const rolls = Array.from({ length: d20Count(st) }, () => ctx.rng.die(20));
    const r = resolveD20(rolls, st, atk.toHit + atkMod);
    const ac = acOf(t) + acBonus;
    io.emit({ k: 'enemyRoll', who: m.id, label: `${atk.name} → ${t.name}`, rolls: r.rolls, total: r.total, dc: ac, success: r.crit || (!r.fumble && r.total >= ac) });
    if (r.fumble || (!r.crit && r.total < ac)) {
      io.emit({ k: 'miss', target: t.id });
      log(io, ctx, `${m.name}'s ${atk.name} misses ${t.name} (${r.total} vs AC ${ac}).`, 'miss');
      continue;
    }
    if (atk.damage === '0') {
      log(io, ctx, `${m.name}'s ${atk.name} hits ${t.name}!`, 'bad');
    } else {
      const d0 = parseDice(atk.damage);
      const dr = rollDice(ctx.rng, r.crit ? { ...d0, count: d0.count * 2 } : d0);
      log(io, ctx, `${r.crit ? '💥 CRIT! ' : ''}${m.name}'s ${atk.name} hits ${t.name} for ${dr.total}.`, 'bad');
      applyDamage(ctx, io, t, dr.total, atk.dmg, { crit: r.crit, source: m });
      thorns(ctx, io, m, t, ranged);
    }
    if (atk.condition && isActive(t) && (atk.condition.chance === undefined || ctx.rng.chance(atk.condition.chance)))
      if (applyCondition(ctx, io, t, atk.condition.id, atk.condition.turns, m.id)) log(io, ctx, `${t.name} is ${atk.condition.id}!`, 'bad');
  }
}

/** One monster's turn (enemy or party companion). */
export async function monsterTurn(ctx: CombatCtx, io: CombatIO, m: Monster): Promise<void> {
  if (!isActive(m)) return;
  if (hasCond(m, 'charmed')) {
    log(io, ctx, `${m.name} is charmed and just... smiles at you.`, 'info');
    return;
  }
  if (m.behavior === 'coward' && hpRatio(m) < 0.3 && ctx.rng.chance(0.5) && !ctx.combat.bossFight) {
    m.fled = true;
    ctx.combat.xpPool += Math.round(m.xp / 2);
    log(io, ctx, `${m.name} flees in terror!`, 'good');
    return;
  }
  // Resolve a wound-up attack
  if (m.telegraph) {
    const tg = m.telegraph;
    m.telegraph = undefined;
    const atk = m.attacks[tg.attackIndex]!;
    let targets: Unit[];
    if (tg.targetId === 'all') targets = opponentsOf(ctx, m);
    else {
      const t = getUnit(ctx, tg.targetId);
      targets = t && isActive(t) ? [t] : [pickTarget(ctx, m)].filter((x): x is Unit => !!x);
    }
    log(io, ctx, `⚠️ ${m.name} unleashes ${atk.name}!`, 'bad');
    io.emit({ k: 'anim', anim: atk.dmg === 'fire' ? 'fire' : 'slash', source: m.id, targets: targets.map((t) => t.id) });
    io.emit({ k: 'sound', name: 'boom' });
    await monsterAttackOne(ctx, io, m, { ...atk, aoe: tg.targetId === 'all' }, targets, tg.braced);
    return;
  }
  const actions = Math.max(1, m.multiattack ?? 1);
  for (let i = 0; i < actions; i++) {
    if (!isActive(m) || checkOver(ctx)) return;
    const atk = pickAttack(ctx, m);
    if (atk.heal) {
      const hurt = friendsOf(ctx, m).filter(isActive).sort((a, b) => hpRatio(a) - hpRatio(b))[0];
      if (hurt) {
        const r = rollDice(ctx.rng, atk.heal);
        log(io, ctx, `${m.name} ${atk.text ?? 'heals'}: ${hurt.name} +${r.total} HP.`, 'bad');
        healUnit(ctx, io, hurt, r.total);
      }
      return;
    }
    if (atk.summon) {
      const def = content().monsters[atk.summon];
      if (def) {
        const s = spawnMonster(def, ctx.rng, { side: m.side });
        addToInitiative(ctx, s);
        io.emit({ k: 'summon', id: s.id });
        log(io, ctx, `${m.name} ${atk.text ?? 'calls for help'}! A ${s.name} appears.`, 'bad');
      }
      return;
    }
    if (atk.telegraph && i === 0 && m.side === 'enemy') {
      const target = atk.aoe ? undefined : pickTarget(ctx, m);
      const targetId = atk.aoe ? 'all' : target?.id;
      if (!targetId) return;
      const text = `${m.name} ${atk.text ?? `prepares ${atk.name}`}${target ? ` — aimed at ${target.name}!` : '!'}`;
      m.telegraph = { attackIndex: m.attacks.indexOf(m.attacks.find((x) => x.name === atk.name)!), targetId, text, dc: atk.save?.dc ?? atk.toHit + 10 };
      io.emit({ k: 'telegraph', source: m.id, target: targetId, text });
      log(io, ctx, `⚠️ ${text}`, 'bad');
      // The threatened players brace on their phones
      const ids = (targetId === 'all' ? opponentsOf(ctx, m) : [target!]).filter((u) => isChar(u)).map((u) => u.id);
      if (ids.length && io.braceMany) {
        const kind: MinigameKind = atk.save?.ability === 'DEX' || !atk.save ? 'shake' : 'steady';
        const scores = await io.braceMany(ids, kind, `BRACE! ${m.name}'s ${atk.name} is coming!`);
        m.telegraph.braced = scores;
      }
      return;
    }
    if (atk.aoe) {
      await monsterAttackOne(ctx, io, m, atk, opponentsOf(ctx, m));
      continue;
    }
    const target = pickTarget(ctx, m);
    if (!target) return;
    io.emit({ k: 'anim', anim: 'slash', source: m.id, targets: [target.id] });
    await monsterAttackOne(ctx, io, m, atk, [target]);
  }
}

/** Bosses get legendary actions between party turns so big parties don't trivialize them. */
export async function legendaryActions(ctx: CombatCtx, io: CombatIO): Promise<void> {
  for (const m of ctx.combat.monsters) {
    if (!m.boss || !isActive(m) || !m.legendaryLeft || hasCond(m, 'stunned')) continue;
    if (!ctx.rng.chance(0.5)) continue;
    m.legendaryLeft--;
    const atk = m.attacks.find((a) => !a.telegraph && !a.summon && !a.heal && !a.save) ?? m.attacks[0]!;
    const t = pickTarget(ctx, m);
    if (!t) continue;
    log(io, ctx, `⚡ Legendary action! ${m.name} lashes out at ${t.name}.`, 'bad');
    await monsterAttackOne(ctx, io, m, atk, [t]);
  }
}

// ---------------------------------------------------------------- shortcuts

export function companionsFor(partySize: number): string[] {
  return partySize === 1 ? ['companion_squire'] : [];
}
export function monsterDefsByFamily(family: string): MonsterDef[] {
  return content().monsterList.filter((m) => m.family === family && !m.boss && m.behavior !== 'companion');
}
