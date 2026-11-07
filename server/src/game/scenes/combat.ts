import {
  addXp,
  botAction,
  botBonus,
  clearCombatState,
  content,
  createCombat,
  enemies,
  getUnit,
  isActive,
  isChar,
  maxTargets,
  needsTargetChoice,
  partyChars,
  rollInitiative,
  rollLoot,
  runCombat,
  spawnMonster,
  scaleMonsterToLevel,
  targetCandidates,
  type ActionOption,
  type BuiltEncounter,
  type Character,
  type ChoiceOption,
  type CombatCtx,
  type CombatEvent,
  type CombatIO,
  type CombatController,
  type Fx,
  type RollRequest,
  type TurnChoice,
} from '@pr/shared';
import type { Game } from '../Game.js';
import { handleLevelUps } from './levelup.js';
import { checkGoals } from '../goals.js';

export interface CombatOptions {
  encounter: BuiltEncounter;
  ambush?: boolean;
  bossFight?: boolean;
  isFinal?: boolean;
  title?: string;
  rewardMult?: number;
  difficultyLabel?: 'easy' | 'medium' | 'hard' | 'deadly' | 'boss';
  noFlee?: boolean;
}

export type CombatOutcome = 'victory' | 'defeat' | 'fled';

function hpBar(u: { hp: number; maxHp: number }) {
  return `${u.hp}/${u.maxHp} HP`;
}

export function gameCombatIO(g: Game, ctx: CombatCtx): CombatIO {
  return {
    minigame: (pid, kind, label, param) => g.minigame(pid, kind, label, param),
    roll: (pid, req) => g.rollDice(pid, req),
    rollMany: async (reqs) => {
      const res = await Promise.all(reqs.map((r) => g.rollDice(r.playerId, r.req, { quiet: true })));
      await g.beat(1500);
      return Object.fromEntries(reqs.map((r, i) => [r.playerId, res[i]!]));
    },
    braceMany: async (ids, kind, label) => {
      const res = await Promise.all(ids.map((id) => g.minigame(id, kind, label)));
      return Object.fromEntries(ids.map((id, i) => [id, res[i]!]));
    },
    emit: (e: CombatEvent) => {
      const fx = combatFx(e);
      if (fx) g.fx(fx);
      g.dirty();
    },
    pause: (ms) => g.sleep(ms),
  };
  void ctx;
}

function combatFx(e: CombatEvent): Fx | undefined {
  switch (e.k) {
    case 'damage':
      return { kind: 'damage', target: e.target, amount: e.amount, dmg: e.dmg, crit: e.crit, weak: e.weak, resist: e.resist };
    case 'heal':
      return { kind: 'heal', target: e.target, amount: e.amount };
    case 'miss':
      return { kind: 'miss', target: e.target };
    case 'anim':
      return { kind: 'anim', anim: e.anim, source: e.source, targets: e.targets };
    case 'sound':
      return { kind: 'sound', name: e.name };
    case 'telegraph':
      return { kind: 'telegraph', source: e.source, target: e.target, text: e.text };
    case 'enemyRoll':
      return { kind: 'enemyRoll', who: e.who, label: e.label, rolls: e.rolls, total: e.total, dc: e.dc, success: e.success };
    case 'down':
      return { kind: 'sound', name: 'down' };
    case 'death':
      return { kind: 'sound', name: 'death' };
    case 'revive':
      return { kind: 'sound', name: 'revive' };
    default:
      return undefined;
  }
}

function optionToChoice(o: ActionOption): ChoiceOption {
  return {
    id: o.key,
    label: o.label,
    emoji: o.emoji,
    desc: o.desc,
    disabled: o.disabled,
    cost: o.cost,
    group: o.group,
    tag: o.bonus ? 'Bonus' : o.minigame ? minigameTag(o.minigame) : undefined,
  };
}

function minigameTag(kind: string): string {
  const map: Record<string, string> = {
    rune: '✍️ draw',
    swing: '🏏 swing',
    shout: '📣 shout',
    tilt: '🎯 tilt',
    shake: '🫨 shake',
    hold: '✊ hold',
    rhythm: '🥁 rhythm',
    steady: '🧘 steady',
    blow: '🌬️ blow',
    hum: '🎵 hum',
    quiet: '🤫 quiet',
    twofinger: '✌️ 2-finger',
    tap: '👆 tap',
  };
  return map[kind] ?? kind;
}

function gameController(g: Game, ctx: CombatCtx): CombatController {
  const bonusTried = new Set<string>();
  return {
    async chooseAction(c: Character, options: ActionOption[], cctx: CombatCtx, error?: string): Promise<TurnChoice> {
      const player = g.players.get(c.id);
      const auto = (): TurnChoice => {
        const key = `${cctx.combat.round}:${c.id}`;
        if (!bonusTried.has(key) && !cctx.combat.actorBonusUsed) {
          bonusTried.add(key);
          const b = botBonus(cctx, c);
          if (b) return b;
        }
        return botAction(cctx, c);
      };
      if (!player || player.isBot) {
        await g.sleep(g.opts.instantBots ? 0 : 700);
        return auto();
      }
      const timeout = g.state.settings.turnTimer > 0 ? g.state.settings.turnTimer * 1000 : undefined;
      const choices = options.map(optionToChoice);
      if (cctx.combat.actorBonusUsed) choices.push({ id: 'endTurn', label: 'End turn', emoji: '⏭️', group: 'Actions', desc: 'Finish your turn now.' });
      const status = `${hpBar(c)}${c.maxSp ? ` — ${c.sp}/${c.maxSp} SP` : ''}${c.conditions.length ? ` — ${c.conditions.map((x) => x.id).join(', ')}` : ''}`;
      let picked: string;
      for (;;) {
        picked = await g.choose(c.id, `Your turn, ${c.name}!`, choices, {
          text: error ? `⚠️ ${error}\n${status}` : status,
          style: 'action',
          timeoutMs: timeout,
          fallback: '__auto',
          allowNone: undefined,
          urgent: true,
        });
        if (picked === '__auto' || !picked) return g.players.get(c.id)?.connected === false ? { type: 'defend' } : auto();
        if (picked === 'endTurn') return { type: 'endTurn' };
        const opt = options.find((o) => o.key === picked);
        if (!opt) return auto();
        if (picked === 'attack' || picked === 'defend' || picked === 'flee') {
          if (picked === 'defend') return { type: 'defend' };
          if (picked === 'flee') return { type: 'flee' };
        }
        let targets: string[] = [];
        if (needsTargetChoice(opt.target)) {
          const cands = targetCandidates(cctx, c, opt.target);
          if (cands.length === 0) {
            error = 'No valid targets.';
            continue;
          }
          const n = maxTargets(opt.target);
          if (cands.length === 1 || (n > 1 && cands.length <= n)) targets = cands;
          else {
            const tOpts: ChoiceOption[] = cands.map((id) => {
              const u = getUnit(cctx, id)!;
              const tele = !isChar(u) && u.telegraph ? ' ⚠️ winding up!' : '';
              const conds = u.conditions.map((x) => x.id).join(', ');
              return { id, label: isChar(u) ? `🧑 ${u.name}` : u.name, desc: `${hpBar(u)}${conds ? ` — ${conds}` : ''}${tele}`, emoji: isChar(u) ? '🛡️' : u.emoji, monster: isChar(u) ? undefined : u.defId };
            });
            tOpts.push({ id: '__back', label: 'Back', emoji: '↩️' });
            const t = await g.choose(c.id, n > 1 ? `Pick your first target (up to ${n} hit)` : `Target for ${opt.label}`, tOpts, { style: 'target', timeoutMs: timeout, fallback: cands[0], urgent: true });
            if (t === '__back') continue;
            targets = [t];
          }
        }
        if (picked === 'attack') return { type: 'attack', targets };
        if (picked.startsWith('ab:')) return { type: 'ability', id: picked.slice(3), targets };
        if (picked.startsWith('it:')) return { type: 'item', uid: picked.slice(3), targets };
        return auto();
      }
    },
    async chooseSpiritTarget(c: Character, cctx: CombatCtx) {
      const player = g.players.get(c.id);
      const allies = partyChars(cctx).filter((p) => isActive(p) && p.id !== c.id);
      const foes = enemies(cctx);
      if (!allies.length && !foes.length) return null;
      if (!player || player.isBot) return allies[0]?.id ?? foes[0]?.id ?? null;
      const opts: ChoiceOption[] = [
        ...allies.map((a) => ({ id: a.id, label: `Inspire ${a.name}`, emoji: '✨', desc: 'They add 1d6 to their next roll.' })),
        ...foes.map((f) => ({ id: f.id, label: `Haunt ${f.name}`, emoji: '👻', desc: 'Frighten it for a turn.' })),
      ];
      return g.choose(c.id, '👻 Your spirit lingers on the battlefield...', opts, { style: 'target', timeoutMs: 30000, fallback: opts[0]!.id });
    },
    async onTurnStart(id: string, cctx: CombatCtx) {
      (g.state.scene as { combat?: { current?: string } }).combat!.current = id;
      const u = getUnit(cctx, id);
      if (u && isChar(u) && !u.dead) g.fx({ kind: 'haptic', pattern: [80, 60, 80], playerId: id });
      g.dirty();
    },
    async onTurnEnd(id: string, cctx: CombatCtx) {
      const u = getUnit(cctx, id);
      g.dirty();
      await g.sleep(g.opts.instantBots ? 0 : u && !isChar(u) ? 1100 : 500);
    },
  };
  void ctx;
}

export async function combatScene(g: Game, opts: CombatOptions): Promise<CombatOutcome> {
  const s = g.state;
  const ids = g.partyIds();
  const monsters = [...opts.encounter.monsters];
  const alive = ids.filter((id) => !s.chars[id]!.dead);
  if (alive.length === 1 && !opts.isFinal) {
    // Solo heroes get a companion
    const def = content().monsters.companion_squire!;
    const comp = spawnMonster(def, g.rng, { side: 'party' });
    scaleMonsterToLevel(comp, s.chars[alive[0]!]!.level);
    monsters.push(comp);
  } else if (alive.length === 1) {
    const comp = spawnMonster(content().monsters.companion_squire!, g.rng, { side: 'party' });
    scaleMonsterToLevel(comp, s.chars[alive[0]!]!.level);
    monsters.push(comp);
  }
  const combat = createCombat(g.rng, {
    title: opts.title ?? opts.encounter.title,
    biome: currentBiome(g),
    monsters,
    bossFight: opts.bossFight || opts.noFlee,
    isFinal: opts.isFinal,
  });
  const ctx: CombatCtx = { combat, chars: s.chars, party: ids, rng: g.rng, difficulty: s.settings.difficulty };
  s.scene = { kind: 'combat', combat: combat as never };
  g.stateCombat = ctx;
  s.stats.combats++;
  g.fx({ kind: 'banner', text: opts.isFinal ? `⚔️ ${combat.title} ⚔️` : opts.ambush ? '⚠️ AMBUSH!' : '⚔️ Battle!', style: opts.ambush || opts.isFinal ? 'bad' : 'title' });
  g.fx({ kind: 'sound', name: opts.isFinal || opts.bossFight ? 'boss' : 'battle' });
  const foes = monsters.filter((m) => m.side === 'enemy');
  g.narrate(`${opts.ambush ? 'Ambush! ' : ''}${listNames(foes.map((m) => `${m.emoji} ${m.name}`))} ${foes.length > 1 ? 'block' : 'blocks'} the way!`, 'bad');
  await g.beat(1200);

  // Initiative: everyone rolls at once on their phones
  const rollers = ids.filter((id) => !s.chars[id]!.dead);
  const initRolls = await Promise.all(
    rollers.map((id) => g.rollDice(id, { kind: 'initiative', label: 'Roll initiative!', faces: [20], bonus: 0 } satisfies RollRequest, { quiet: true, timeoutMs: 20000 })),
  );
  rollInitiative(ctx, Object.fromEntries(rollers.map((id, i) => [id, initRolls[i]![0]!])), opts.ambush);
  await g.beat(1200);
  g.dirty();

  const io = gameCombatIO(g, ctx);
  const outcome = await runCombat(ctx, io, gameController(g, ctx));
  g.stateCombat = undefined;
  await g.beat(900);
  return resolveCombatEnd(g, ctx, opts, outcome);
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? 'Enemies';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function currentBiome(g: Game) {
  const w = g.state.world;
  if (!w) return 'plains' as const;
  return w.tiles.find((t) => t.q === w.party.q && t.r === w.party.r)?.biome ?? 'plains';
}

async function resolveCombatEnd(g: Game, ctx: CombatCtx, opts: CombatOptions, outcome: CombatOutcome): Promise<CombatOutcome> {
  const s = g.state;
  const w = s.world;
  const chars = g.partyChars();
  if (outcome === 'victory') {
    s.stats.victories++;
    const label = opts.difficultyLabel ?? 'medium';
    const base = { easy: 45, medium: 70, hard: 100, deadly: 130, boss: 180 }[label];
    const lengthMult = s.settings.length === 'oneshot' ? 1.6 : 1.35;
    const xpEach = Math.round(base * lengthMult * (opts.rewardMult ?? 1) * (1 + Math.min(1, ctx.combat.xpPool / 2000) * 0.3));
    const goldFromMonsters = ctx.combat.monsters.filter((m) => m.side === 'enemy' && (m.dead || m.fled)).reduce((sum, m) => sum + (content().monsters[m.defId]?.gold ?? 0), 0);
    const gold = Math.round((goldFromMonsters + ctx.combat.goldPool + g.rng.int(5, 15) * chars.length) * (opts.rewardMult ?? 1));
    s.party.gold += gold;
    g.fx({ kind: 'banner', text: '🏆 Victory!', style: 'good' }, { kind: 'sound', name: 'victory' });
    g.narrate(`Victory! The party gains ${xpEach} XP each and ${gold} gold.`, 'good');
    for (const c of chars) if (!c.dead) addXp(c, xpEach);
    // MVP rolls the percentile die for loot quality
    const mvp = chars.filter((c) => !c.dead).sort((a, b) => b.stats.damageDealt + b.stats.healed - (a.stats.damageDealt + a.stats.healed))[0];
    const lootCount = label === 'easy' ? (g.rng.chance(0.5) ? 1 : 0) : label === 'medium' ? 1 : label === 'hard' ? 2 : 3;
    if (mvp && lootCount > 0) {
      const levels = chars.map((c) => c.level);
      const avg = Math.round(levels.reduce((a, b) => a + b, 0) / levels.length);
      const [d100] = await g.rollDice(mvp.id, { kind: 'loot', label: `🎁 ${mvp.name}, roll the percentile die for loot!`, faces: [100], bonus: 0 }, { timeoutMs: 20000 });
      const luck = chars.reduce((sum, c) => sum + (c.quirks.length ? 0 : 0), 0);
      const boost = (opts.bossFight ? 25 : 0) + (label === 'hard' ? 8 : 0) + ctx.combat.lootRarityBoost + luck;
      const found = [];
      for (let i = 0; i < lootCount; i++) found.push(rollLoot(g.rng, { level: avg, boost, d100: i === 0 ? d100 : undefined }));
      s.party.stash.push(...found);
      g.narrate(`Loot! ${found.map((f) => `${f.emoji} ${f.name} (${f.rarity})`).join(', ')} — added to the party stash.`, 'good');
      g.journal('combat', `Defeated ${ctx.combat.title}. Found ${found.map((f) => f.name).join(', ')}.`);
    } else g.journal('combat', `Defeated ${ctx.combat.title}.`);
    if (w) {
      w.winStreak++;
      if (label === 'hard' || label === 'deadly' || label === 'boss') w.hardSinceRest = true;
    }
  } else if (outcome === 'fled') {
    g.narrate('The party escapes — bruised, empty-handed, and a little embarrassed.', 'normal');
    if (w) w.doom = Math.min(w.doomMax, w.doom + 1);
    g.journal('combat', `Fled from ${ctx.combat.title}.`);
  }
  updateDirector(g, ctx, outcome);
  for (const c of chars) clearCombatState(c);
  checkGoals(g);
  g.dirty();
  if (outcome === 'defeat') return outcome;
  await handleDeaths(g);
  await handleLevelUps(g);
  return outcome;
}

function updateDirector(g: Game, ctx: CombatCtx, outcome: CombatOutcome) {
  const w = g.state.world;
  if (!w || !g.state.settings.adaptive) return;
  const chars = g.partyChars();
  const hpPct = chars.reduce((s, c) => s + (c.dead ? 0 : c.hp), 0) / Math.max(1, chars.reduce((s, c) => s + c.maxHp, 0));
  const downs = chars.filter((c) => c.down || c.dead).length;
  let d = 0;
  if (outcome === 'victory' && hpPct > 0.7 && downs === 0) d += 0.06;
  if (outcome === 'victory' && hpPct > 0.85 && ctx.combat.round <= 2) d += 0.04;
  if (hpPct < 0.35 || downs > 0) d -= 0.08;
  if (outcome !== 'victory') d -= 0.12;
  w.directorMod = Math.max(-0.3, Math.min(0.3, w.directorMod + d));
}

/** Fallen heroes choose: return from the Veil (with a scar), or pass the torch. Nobody sits out long. */
export async function handleDeaths(g: Game) {
  const dead = g.partyChars().filter((c) => c.dead);
  if (!dead.length) return;
  const w = g.state.world;
  await Promise.all(
    dead.map(async (c) => {
      const pick = await g.choose(
        c.id,
        `💀 ${c.name} has fallen.`,
        [
          { id: 'veil', label: 'Return from the Veil', emoji: '👻', desc: 'Come back now with half HP and the "Death-Touched" scar (+1 Doom).' },
          { id: 'legacy', label: 'Pass the torch', emoji: '🕯️', desc: 'Create a new hero (a relative or friend) at the same level who inherits your gear.' },
        ],
        { style: 'cards', timeoutMs: 90000, fallback: 'veil', bot: () => 'veil' },
      );
      if (pick === 'veil') {
        c.dead = false;
        c.down = false;
        c.spirit = true;
        c.hp = Math.max(1, Math.ceil(c.maxHp / 2));
        if (!c.titles.includes('Death-Touched')) c.titles.push('Death-Touched');
        if (w) w.doom = Math.min(w.doomMax, w.doom + 1);
        g.narrate(`${c.name} gasps back to life, eyes glowing faintly. The Veil remembers. (+1 Doom)`, 'whisper');
        g.journal('death', `${c.name} died and returned from the Veil.`);
      } else {
        g.journal('death', `${c.name} fell. Their legacy lives on.`);
        g.narrate(`${c.name}'s story ends here... but someone picks up their pack.`, 'whisper');
        g.legacyQueue.push({ playerId: c.id, level: c.level, gear: [c.equipment.weapon, c.equipment.armor, c.equipment.trinket, ...c.inventory].filter((x) => !!x) as never, oldName: c.name });
        delete g.state.chars[c.id];
        const p = g.players.get(c.id);
        if (p) p.ready = false;
      }
    }),
  );
  g.dirty();
}
