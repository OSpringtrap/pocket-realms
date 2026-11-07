import {
  SKILL_ABILITY,
  abilityCheckBonus,
  checkDegree,
  combineAdv,
  content,
  miniTier,
  resolveD20,
  skillBonus,
  type Character,
  type ChoiceOption,
  type Degree,
  type EventCard,
  type EventOption,
  type EventView,
} from '@pr/shared';
import type { Game } from '../Game.js';
import { applyEffects, avgLevel } from '../effects.js';
import { currentBiome, type CombatOutcome } from './combat.js';

export function scaledDc(g: Game, dc: number): number {
  const diff = g.state.settings.difficulty;
  return dc + Math.floor((avgLevel(g) - 1) / 2) + (diff === 'story' ? -2 : diff === 'heroic' ? 2 : 0);
}

function bestFitText(o: EventOption): string | undefined {
  const parts = [...(o.best?.classes ?? []).map((c) => content().classes[c].name), ...(o.best?.species ?? []).map((s) => content().species[s].name)];
  return parts.length ? parts.join(' / ') : undefined;
}

/** Day/night and weather shift some checks: night favors stealth, fog hurts perception, storms hurt footing. */
export function envModifier(g: Game, skill?: string): number {
  const w = g.state.world;
  if (!w || !skill) return 0;
  let m = 0;
  if (w.time === 'night' && skill === 'stealth') m += 2;
  if ((w.time === 'night' || w.weather === 'fog') && skill === 'perception') m -= 2;
  if (w.weather === 'storm' && (skill === 'athletics' || skill === 'acrobatics')) m -= 2;
  if (w.weather === 'heat' && skill === 'athletics') m -= 1;
  if (w.weather === 'rain' && skill === 'stealth') m += 1;
  return m;
}

export function checkBonus(g: Game, c: Character, o: EventOption): number {
  if (o.skill) return skillBonus(c, o.skill, { biome: currentBiome(g) }) + envModifier(g, o.skill);
  if (o.ability) return abilityCheckBonus(c, o.ability);
  return 0;
}

function isBestFit(c: Character, o: EventOption): boolean {
  return !!(o.best?.classes?.includes(c.cls) || o.best?.species?.includes(c.species));
}

/** Party vote with a dice-roll tie-breaker. Returns the winning option index. */
export async function partyVote(g: Game, title: string, options: ChoiceOption[], opts: { text?: string; onTally?: (votes: Record<string, number>) => void; timeoutMs?: number; bot?: () => string } = {}): Promise<number> {
  const voters = g.partyIds().filter((id) => g.players.get(id));
  const enabled = options.filter((o) => !o.disabled);
  if (enabled.length === 1) return options.indexOf(enabled[0]!);
  const tally: Record<string, number> = {};
  const answers = await g.askAll<string>(
    voters,
    () => ({ kind: 'choice', title, text: opts.text, options, style: 'vote' }),
    {
      timeoutMs: opts.timeoutMs ?? 45000,
      fallback: () => '__abstain',
      bot: opts.bot ?? (() => g.rng.pick(enabled).id),
      validate: (v) => (typeof v === 'string' && options.some((o) => o.id === v && !o.disabled) ? v : undefined),
    },
  );
  for (const v of Object.values(answers)) if (v !== '__abstain') tally[v] = (tally[v] ?? 0) + 1;
  opts.onTally?.(tally);
  g.dirty();
  const max = Math.max(0, ...Object.values(tally));
  let tied = enabled.filter((o) => (tally[o.id] ?? 0) === max);
  if (max === 0) tied = enabled;
  if (tied.length === 1) return options.indexOf(tied[0]!);
  // Tie-breaker: the leader rolls a d20
  const leader = g.leaderId() ?? voters[0]!;
  g.narrate(`A tie! ${g.players.get(leader)?.name ?? 'The leader'} rolls to decide...`);
  const [v] = await g.rollDice(leader, { kind: 'check', label: `Tie-breaker: ${tied.map((t, i) => `${i + 1}=${t.label}`).join(', ')}`, faces: [20], bonus: 0 });
  const pick = tied[((v ?? 1) - 1) % tied.length]!;
  g.narrate(`The dice choose: ${pick.label}!`);
  return options.indexOf(pick);
}

/** Ask who attempts the check: first volunteer wins; otherwise the best-suited hero. */
export async function chooseActor(g: Game, o: EventOption): Promise<Character> {
  const chars = g.partyChars().filter((c) => !c.dead && !c.down);
  const ranked = [...chars].sort((a, b) => checkBonus(g, b, o) + (isBestFit(b, o) ? 2 : 0) - (checkBonus(g, a, o) + (isBestFit(a, o) ? 2 : 0)));
  if (chars.length <= 1) return chars[0] ?? g.partyChars()[0]!;
  const humans = chars.filter((c) => !g.players.get(c.id)?.isBot);
  if (!humans.length) return ranked[0]!;
  const best = bestFitText(o);
  const ep = g.epoch;
  return new Promise<Character>((resolve) => {
    let done = false;
    let passes = 0;
    const finish = (c: Character) => {
      if (done) return;
      done = true;
      for (const h of humans) g.cancelPromptsFor(h.id);
      resolve(c);
    };
    for (const c of humans) {
      const bonus = checkBonus(g, c, o);
      g.choose(c.id, `Who attempts: ${o.label}?`, [{ id: 'me', label: `I'll do it! (${bonus >= 0 ? '+' : ''}${bonus})`, emoji: '🙋', tag: isBestFit(c, o) ? 'Best fit' : undefined }, { id: 'pass', label: 'Someone else', emoji: '🙅' }], {
        text: best ? `Best fit: ${best}. ${o.skill ? `Skill: ${o.skill}` : ''}` : o.skill ? `Skill: ${o.skill}` : undefined,
        style: 'vote',
        timeoutMs: 15000,
        fallback: 'pass',
      })
        .then((v) => {
          if (ep !== g.epoch) return;
          if (v === 'me') finish(c);
          else if (++passes >= humans.length) finish(ranked[0]!);
        })
        .catch(() => {});
    }
  });
}

/** Roll a check for one character. Minigame (if any) grants a bonus or advantage. Returns degree. */
export async function heroCheck(g: Game, c: Character, o: { skill?: EventOption['skill']; ability?: EventOption['ability']; label: string; minigame?: EventOption['minigame'] }, dc: number): Promise<{ degree: Degree; total: number }> {
  let adv = 0;
  let dis = 0;
  let bonus = checkBonus(g, c, o as EventOption);
  if (o.minigame) {
    const score = await g.minigame(c.id, o.minigame, o.label);
    const t = miniTier(score);
    if (t === 'great') adv++;
    else if (t === 'good') bonus += 2;
  }
  if (c.conditions.some((x) => x.id === 'poisoned' || x.id === 'frightened')) dis++;
  if (c.inspiration > 0 && dc - bonus > 12) {
    // Inspiration spends itself on hard checks
    c.inspiration--;
    adv++;
    g.narrate(`✨ ${c.name} spends Inspiration for advantage!`);
  }
  const st = combineAdv(adv, dis);
  const ab = o.skill ? SKILL_ABILITY[o.skill] : o.ability ?? 'WIS';
  const vals = await g.rollDice(c.id, { kind: 'check', label: `${o.label} — ${o.skill ?? ab} check (DC ${dc})`, faces: st === 0 ? [20] : [20, 20], bonus, adv: st, dc });
  let extra = 0;
  const insp = c.conditions.find((x) => x.id === 'inspired');
  if (insp) {
    extra += g.rng.die(6);
    c.conditions = c.conditions.filter((x) => x !== insp);
  }
  if (c.conditions.some((x) => x.id === 'blessed')) extra += g.rng.die(4);
  const res = resolveD20(vals, st, bonus + extra);
  if (res.crit && res.kept === 20) c.stats.crits++;
  if (res.fumble) c.stats.fumbles++;
  return { degree: checkDegree(res, dc), total: res.total };
}

function pickOutcome(o: EventOption, degree: Degree) {
  const oc = o.outcomes;
  switch (degree) {
    case 'crit':
      return oc.crit ?? oc.success;
    case 'success':
      return oc.success;
    case 'partial':
      return oc.partial ?? oc.fail ?? oc.success;
    case 'fail':
      return oc.fail ?? { text: ['It doesn\'t work out, but no harm done.'], effects: [] };
    case 'fumble':
      return oc.fumble ?? oc.fail ?? { text: ['Things go comically wrong — but nobody is hurt.'], effects: [] };
  }
}

export async function eventScene(g: Game, card: EventCard): Promise<CombatOutcome | undefined> {
  const s = g.state;
  s.stats.events++;
  const w = s.world!;
  w.recentEvents = [card.id, ...w.recentEvents].slice(0, 6);
  const text = g.fillTemplate(g.rng.pick(card.text));
  const view: EventView = {
    cardId: card.id,
    title: card.title,
    emoji: card.emoji,
    text,
    options: card.options.map((o) => ({
      label: o.label,
      emoji: o.emoji,
      skill: o.skill,
      dc: o.skill || o.ability ? scaledDc(g, o.dc) : undefined,
      best: bestFitText(o),
      cost: o.cost?.gold ? `${o.cost.gold} gold` : undefined,
      group: o.group,
    })),
  };
  s.scene = { kind: 'event', event: view };
  g.fx({ kind: 'sound', name: 'event' });
  g.narrate(`${card.emoji} ${card.title}`, 'title');
  g.narrate(text);
  g.dirty();
  await g.beat(1800);

  const options: ChoiceOption[] = card.options.map((o, i) => ({
    id: String(i),
    label: o.label,
    emoji: o.emoji,
    desc: [o.skill ? `${o.skill} DC ${scaledDc(g, o.dc)}` : '', o.group ? 'everyone rolls' : '', bestFitText(o) ? `best: ${bestFitText(o)}` : '', o.minigame ? `minigame: ${o.minigame}` : ''].filter(Boolean).join(' — ') || undefined,
    cost: o.cost?.gold ? `${o.cost.gold}g` : undefined,
    disabled: o.cost?.gold && s.party.gold < o.cost.gold ? 'Not enough gold' : undefined,
  }));
  const tempt = maybeTempt(g, card.options.map((o) => o.label));
  const idx = await partyVote(g, `${card.emoji} ${card.title}: what do you do?`, options, {
    text,
    onTally: (t) => {
      view.votes = Object.fromEntries(Object.entries(t).map(([k, v]) => [Number(k), v]));
    },
  });
  const opt = card.options[idx]!;
  view.chosen = idx;
  if (tempt) resolveTemptation(g, tempt, idx);
  g.narrate(`The party decides: ${opt.emoji} ${opt.label}.`);
  g.dirty();
  await g.beat(900);
  if (opt.cost?.gold) s.party.gold = Math.max(0, s.party.gold - opt.cost.gold);

  let degree: Degree = 'success';
  let actor: Character | undefined;
  if (opt.skill || opt.ability) {
    const dc = scaledDc(g, opt.dc);
    if (opt.group) {
      const chars = g.partyChars().filter((c) => !c.dead && !c.down);
      g.narrate(`Everyone rolls ${opt.skill ?? opt.ability} (DC ${dc})!`);
      const results = await Promise.all(chars.map((c) => heroCheck(g, c, { ...opt, label: opt.label }, dc)));
      const passes = results.filter((r) => r.degree === 'success' || r.degree === 'crit').length;
      const crits = results.filter((r) => r.degree === 'crit').length;
      const fumbles = results.filter((r) => r.degree === 'fumble').length;
      degree = passes === chars.length && crits > 0 ? 'crit' : passes * 2 >= chars.length ? 'success' : passes > 0 ? 'partial' : fumbles > 0 ? 'fumble' : 'fail';
      actor = chars.find((c, i) => results[i]!.degree === 'fail' || results[i]!.degree === 'fumble') ?? chars[0];
    } else {
      actor = await chooseActor(g, opt);
      view.actorId = actor.id;
      g.narrate(`${actor.name} steps forward.`);
      g.dirty();
      degree = (await heroCheck(g, actor, opt, dc)).degree;
    }
  } else actor = g.partyChars().find((c) => c.id === g.leaderId());

  const outcome = pickOutcome(opt, degree);
  const outText = g.fillTemplate(g.rng.pick(outcome.text), { actor: actor?.name ?? 'The hero' });
  view.outcome = { degree, text: outText };
  const label = { crit: '🌟 Critical success!', success: '✅ Success!', partial: '➗ Partial success', fail: '❌ Failure', fumble: '💥 Fumble!' }[degree];
  if (opt.skill || opt.ability) g.fx({ kind: 'banner', text: label, style: degree === 'crit' || degree === 'success' ? 'good' : 'bad' });
  g.narrate(outText, degree === 'fail' || degree === 'fumble' ? 'bad' : 'good');
  g.journal('event', `${card.title}: ${outText}`);
  g.dirty();
  await g.beat(2200);
  const res = await applyEffects(g, outcome.effects, actor?.id);
  if (!outcome.effects.some((e) => e.type === 'combat') && w) w.combatStreak = 0;
  return res;
}

export function pickEventCard(g: Game, filter: (c: EventCard) => boolean = () => true): EventCard {
  const w = g.state.world!;
  const biome = currentBiome(g);
  const all = content().events;
  const fits = (c: EventCard) =>
    (c.biomes.includes('any') || c.biomes.includes(biome)) &&
    (!c.time || c.time.includes(w.time)) &&
    (!c.weather || c.weather.includes(w.weather)) &&
    c.minDoom <= w.doom &&
    !w.recentEvents.slice(0, 5).includes(c.id) &&
    filter(c);
  let pool = all.filter(fits);
  if (!pool.length) pool = all.filter((c) => !w.recentEvents.slice(0, 5).includes(c.id) && filter(c));
  if (!pool.length) pool = all;
  return g.rng.weighted(pool.map((c) => ({ item: c, weight: c.weight })));
}

// ------------------------------------------------------------ traitor-style temptations

interface Temptation {
  playerId: string;
  target: number;
  label: string;
}

/** Occasionally one hero is privately tempted to steer the vote. Shown only on their phone. */
export function maybeTempt(g: Game, labels: string[]): Temptation | undefined {
  const humans = g.partyIds().filter((id) => !g.players.get(id)?.isBot && !g.state.chars[id]?.dead);
  if (humans.length < 3 || labels.length < 2 || !g.rng.chance(0.18)) return undefined;
  const pid = g.rng.pick(humans);
  const target = g.rng.int(0, labels.length - 1);
  const label = labels[target]!;
  const text = `A cold voice in your ear: "Make them choose '${label}'. Do it, and I will reward you..." (Keep it secret! If the party picks it, you gain a reward — but the Doom Clock ticks.)`;
  (g.state.secrets[pid] ??= []).push({ id: `t${g.rng.int(0, 1e9)}`, text: `You were tempted to steer the party toward "${label}".`, kind: 'traitor' });
  g.fxFor(pid, { kind: 'haptic', pattern: [30, 60, 30, 60, 30], playerId: pid });
  void g.ask(pid, { kind: 'notice', title: '🤫 A whisper...', text, okLabel: 'I understand', urgent: false }, { timeoutMs: 40000, fallback: () => true, bot: () => true }).catch(() => {});
  g.dirty();
  return { playerId: pid, target, label };
}

function resolveTemptation(g: Game, t: Temptation, chosen: number) {
  g.cancelPromptsFor(t.playerId);
  const c = g.state.chars[t.playerId];
  if (!c) return;
  if (chosen === t.target) {
    c.inspiration++;
    g.state.party.gold += 25;
    if (g.state.world) g.state.world.doom = Math.min(g.state.world.doomMax, g.state.world.doom + 1);
    (g.state.secrets[t.playerId] ??= []).push({ id: `t${g.rng.int(0, 1e9)}`, text: 'The voice kept its promise: +1 Inspiration, and 25 gold mysteriously appeared in the party purse.', kind: 'traitor' });
    g.narrate('Somewhere, something laughs softly. (The Doom Clock ticks.)', 'whisper');
  }
  g.dirty();
}
