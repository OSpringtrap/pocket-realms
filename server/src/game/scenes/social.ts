import { content, sanitizeText, type ChoiceOption, type Npc, type Skill } from '@pr/shared';
import type { Game } from '../Game.js';
import { applyEffects, avgLevel } from '../effects.js';
import { makeQuest } from '../quests.js';
import type { CombatOutcome } from './combat.js';
import { chooseActor, heroCheck, partyVote, scaledDc } from './event.js';

const APPROACHES: { id: string; label: string; emoji: string; skill: Skill; mini: 'shout' | 'hum'; lines: string[] }[] = [
  { id: 'persuade', label: 'Kind words', emoji: '🕊️', skill: 'persuasion', mini: 'hum', lines: ['"We only want to help — truly."', '"You have our word as heroes."', '"Together, we can fix this."'] },
  { id: 'intimidate', label: 'Lean on them', emoji: '😠', skill: 'intimidation', mini: 'shout', lines: ['"Talk. NOW."', '"You don\'t want to see me angry."', '"Last chance."'] },
  { id: 'deceive', label: 'A clever lie', emoji: '🎭', skill: 'deception', mini: 'hum', lines: ['"The King himself sent us."', '"We\'re, uh, tax inspectors."', '"Of course we\'ve met before! Don\'t you remember?"'] },
  { id: 'perform', label: 'Put on a show', emoji: '🎻', skill: 'performance', mini: 'hum', lines: ['*launches into a dramatic ballad*', '*juggles three daggers*', '*does a little dance*'] },
];

/**
 * NPC encounter: the party votes on an approach, a volunteer delivers the line —
 * spoken aloud into the mic (volume/pitch bonus), written (the group votes on it),
 * or picked from suggestions — then rolls. Attitude, quests, info and reputation follow.
 */
export async function socialScene(g: Game, npcArg?: Npc): Promise<CombatOutcome | undefined> {
  const w = g.state.world!;
  const npc = npcArg ?? w.npcs.find((n) => !n.met) ?? (w.npcs.length ? g.rng.pick(w.npcs) : undefined);
  if (!npc) return undefined;
  const arche = content().npcs.find((a) => a.id === npc.archetypeId);
  npc.met = true;
  const greet = arche ? g.rng.pick(arche.greet) : '"Well met."';
  const ask = arche ? g.rng.pick(arche.ask) : '"Could you help me?"';
  const intro = `${npc.emoji} ${npc.name} the ${npc.title}, who wants to ${npc.motivation}.`;
  g.state.scene = { kind: 'social', npc, text: intro, line: greet };
  g.narrate(intro, 'title');
  g.narrate(`${npc.name}: ${greet}`);
  g.dirty();
  await g.beat(1800);
  g.state.scene = { kind: 'social', npc, text: intro, line: ask };
  g.narrate(`${npc.name}: ${ask}`);
  g.dirty();
  await g.beat(1500);

  const bribe = 10 * avgLevel(g);
  const options: ChoiceOption[] = [
    ...APPROACHES.map((a) => ({ id: a.id, label: a.label, emoji: a.emoji, desc: `${a.skill} check` })),
    { id: 'bribe', label: 'Offer gold', emoji: '💰', cost: `${bribe}g`, disabled: g.state.party.gold < bribe ? 'Not enough gold' : undefined, desc: 'Money talks.' },
    { id: 'leave', label: 'Wish them well and leave', emoji: '🚶' },
  ];
  const idx = await partyVote(g, `${npc.emoji} How do you approach ${npc.name}?`, options);
  const pick = options[idx]!.id;
  if (pick === 'leave') {
    g.narrate(`You bid ${npc.name} farewell.`);
    return undefined;
  }
  let degree: 'crit' | 'success' | 'partial' | 'fail' | 'fumble' = 'success';
  let actorId: string | undefined;
  const app = APPROACHES.find((a) => a.id === pick);
  if (pick === 'bribe') {
    g.state.party.gold -= bribe;
    g.narrate(`Coins change hands. ${npc.name} brightens considerably.`);
  } else if (app) {
    const actor = await chooseActor(g, { label: app.label, skill: app.skill, emoji: app.emoji, dc: 12, group: false, outcomes: { success: { text: [''], effects: [] } } } as never);
    actorId = actor.id;
    // How do you deliver the line?
    const how = await g.choose(
      actor.id,
      `🗣️ ${app.label}: how do you say it to ${npc.name}?`,
      [
        { id: 'speak', label: 'Say it out loud!', emoji: '🎤', desc: app.mini === 'shout' ? 'Speak into the mic — louder is scarier.' : 'Speak or hum warmly into the mic.' },
        { id: 'write', label: 'Write my line', emoji: '✍️', desc: 'Shown on the TV — the party judges it.' },
        { id: 'pick', label: 'Pick a line', emoji: '💬', desc: app.lines[0] },
      ],
      { style: 'cards', timeoutMs: 30000, fallback: 'pick', bot: () => 'pick' },
    );
    let line = g.rng.pick(app.lines);
    let bonusLabel: string | undefined;
    let extraDcShift = 0;
    let minigame: 'shout' | 'hum' | undefined;
    if (how === 'speak') minigame = app.mini;
    if (how === 'write') {
      const text = await g.ask<string>(actor.id, { kind: 'text', title: `Your words to ${npc.name}`, text: `${app.label} — stay in character!`, maxLen: 120, suggestions: app.lines }, {
        timeoutMs: 60000,
        fallback: () => line,
        bot: () => line,
        validate: (v) => sanitizeText(v, 120) || undefined,
      });
      line = `"${text.replace(/^"|"$/g, '')}"`;
      g.state.scene = { kind: 'social', npc, text: intro, line: `${actor.name}: ${line}` };
      g.narrate(`${actor.name}: ${line}`, 'title');
      g.dirty();
      const judges = g.partyIds().filter((id) => id !== actor.id && !g.players.get(id)?.isBot);
      if (judges.length) {
        const votes = await g.askAll<string>(judges, () => ({ kind: 'choice', title: `Was that convincing?`, text: line, style: 'vote', options: [{ id: 'y', label: 'Nailed it!', emoji: '👏' }, { id: 'n', label: 'Hmm...', emoji: '🤨' }] }), { timeoutMs: 25000, fallback: () => 'y', bot: () => 'y' });
        const yes = Object.values(votes).filter((v) => v === 'y').length;
        if (yes * 2 >= judges.length) {
          extraDcShift = yes === judges.length ? 4 : 2;
          bonusLabel = yes === judges.length ? 'The whole party loved it!' : 'The party approves.';
        }
      } else extraDcShift = 2;
    } else if (how === 'pick') {
      g.state.scene = { kind: 'social', npc, text: intro, line: `${actor.name}: ${line}` };
      g.narrate(`${actor.name}: ${line}`);
      g.dirty();
    }
    if (bonusLabel) g.narrate(bonusLabel, 'good');
    const factionRep = npc.factionId ? w.factions.find((f) => f.id === npc.factionId)?.rep ?? 0 : 0;
    const dc = scaledDc(g, 12) - npc.attitude * 2 - extraDcShift - Math.trunc(factionRep / 2) + (pick === 'intimidate' && npc.archetypeId === 'guard_captain' ? 3 : 0);
    degree = (await heroCheck(g, actor, { skill: app.skill, label: `${app.label} (${npc.name})`, minigame }, dc)).degree;
  }
  // outcomes
  const success = degree === 'success' || degree === 'crit';
  if (success || pick === 'bribe') {
    npc.attitude = Math.min(3, npc.attitude + (degree === 'crit' ? 2 : 1));
    const fac = npc.factionId;
    g.narrate(`${npc.name} ${degree === 'crit' ? 'is utterly won over' : 'agrees to help'}!`, 'good');
    const fx: import('@pr/shared').EventEffect[] = [{ type: 'xp', amount: 25 }];
    if (fac) fx.push({ type: 'rep', faction: fac, amount: 1 });
    const q = makeQuest(g);
    if (q && g.rng.chance(0.6)) {
      q.giverNpcId = npc.id;
      w.quests.push(q);
      g.narrate(`📜 ${npc.name} asks a favor: ${q.title} — ${q.desc}`, 'good');
      g.journal('quest', `${npc.name} asked for help: ${q.title}.`);
    } else fx.push({ type: 'reveal', radius: 3 });
    if (degree === 'crit') fx.push({ type: 'item', rarity: avgLevel(g) >= 4 ? 'rare' : 'uncommon' }, { type: 'inspiration', who: actorId ? 'actor' : 'party' });
    await applyEffects(g, fx, actorId);
    g.journal('event', `Met ${npc.name} the ${npc.title}, who now thinks well of the party.`);
  } else {
    npc.attitude = Math.max(-3, npc.attitude - 1);
    g.narrate(`${npc.name} is not impressed.${degree === 'fumble' ? ' At all.' : ''}`, 'bad');
    if (npc.factionId) await applyEffects(g, [{ type: 'rep', faction: npc.factionId, amount: -1 }], actorId);
    g.journal('event', `Met ${npc.name} the ${npc.title}. It went poorly.`);
    if (degree === 'fumble' && pick === 'intimidate') {
      g.narrate(`${npc.name} calls for help!`, 'bad');
      return applyEffects(g, [{ type: 'combat', family: 'bandit', difficulty: 'easy', ambush: false }], actorId);
    }
  }
  return undefined;
}
