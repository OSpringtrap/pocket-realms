import { content, hexDist, type Quest, type QuestType } from '@pr/shared';
import type { Game } from './Game.js';

const ITEMS = ['Moonpetal', 'Silver Locket', 'Old Ledger', 'Star-Iron Ingot', 'Crown Jewel', 'Sealed Letter', 'Golden Idol', 'Lost Map'];

/** Build a quest from a template, targeting a real place on the map. */
export function makeQuest(g: Game, type?: QuestType, opts: { privateFor?: string } = {}): Quest | undefined {
  const w = g.state.world;
  if (!w) return undefined;
  const tpl = type ? content().quests.find((q) => q.type === type) : g.rng.pick(content().quests);
  if (!tpl) return undefined;
  const cands = w.tiles.filter((t) => t.biome !== 'water' && hexDist(t, w.party) >= 2 && hexDist(t, w.party) <= w.radius + 1 && (!t.poi || t.poi.kind === 'ruin' || t.poi.kind === 'lair' || t.poi.kind === 'camp'));
  if (!cands.length) return undefined;
  const tile = g.rng.pick(cands);
  const giver = w.npcs.length ? g.rng.pick(w.npcs) : undefined;
  if (giver) giver.met = true;
  const npc = g.rng.pick(content().npcs);
  const monsters = content().monsterList.filter((m) => !m.boss && m.behavior !== 'companion' && m.tier <= Math.ceil((Math.max(1, ...g.partyChars().map((c) => c.level)) + 2) / 2));
  const monster = g.rng.pick(monsters);
  const place = tile.poi?.name ?? tile.name ?? `the ${tile.biome} to the ${dirName(w.party, tile)}`;
  const vars: Record<string, string> = {
    npc: g.rng.pick(npc.names),
    giver: giver ? `${giver.name} the ${giver.title}` : 'A worried villager',
    place,
    item: g.rng.pick(ITEMS),
    monster: monster.name,
    biome: tile.biome,
  };
  const fill = (s: string) => g.fillTemplate(s, vars);
  const level = Math.max(1, ...g.partyChars().map((c) => c.level));
  const q: Quest = {
    id: `q${w.quests.length}_${g.rng.int(0, 1e6)}`,
    type: tpl.type,
    title: fill(g.rng.pick(tpl.titles)),
    desc: fill(g.rng.pick(tpl.desc)),
    giverNpcId: giver?.id,
    targetTile: { q: tile.q, r: tile.r },
    factionId: giver?.factionId ?? (w.factions.length ? g.rng.pick(w.factions).id : undefined),
    reward: {
      gold: 30 + level * 15,
      xp: 40 + level * 10,
      rep: 1,
      item: level >= 4 ? 'rare' : 'uncommon',
      // campaign side quests can lead to one of the antagonist's seal-keys (ties side quests to the main arc)
      key: g.state.settings.length === 'campaign' && w.objective.keys + w.quests.filter((x) => x.reward.key && x.status === 'active').length < w.objective.keysNeeded - 1 && g.rng.chance(0.25),
    },
    status: 'active',
    privateFor: opts.privateFor,
    goal: tpl.goal,
    progress: 0,
  };
  // monster hint for hunts
  (q as Quest & { monsterId?: string }).monsterId = monster.id;
  tile.revealed = true;
  return q;
}

function dirName(from: { q: number; r: number }, to: { q: number; r: number }): string {
  const dx = to.q + to.r / 2 - (from.q + from.r / 2);
  const dy = to.r - from.r;
  const ang = Math.atan2(dy, dx);
  const dirs = ['east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'north', 'northeast'];
  return dirs[(Math.round((ang / (2 * Math.PI)) * 8) + 8) % 8]!;
}

export function questAt(g: Game, tile: { q: number; r: number }): Quest | undefined {
  const w = g.state.world!;
  return w.quests.find((q) => q.status === 'active' && q.targetTile && q.targetTile.q === tile.q && q.targetTile.r === tile.r);
}

/** Resolve a quest at its target location; success pays out gold, XP, reputation and loot. */
export async function questScene(g: Game, q: Quest): Promise<import('./scenes/combat.js').CombatOutcome | undefined> {
  const { combatScene } = await import('./scenes/combat.js');
  const { heroCheck, scaledDc, partyVote } = await import('./scenes/event.js');
  const { applyEffects, partyLevels } = await import('./effects.js');
  const { buildEncounter } = await import('@pr/shared');
  const w = g.state.world!;
  g.state.scene = { kind: 'event', event: { cardId: q.id, title: q.title, emoji: '📜', text: q.desc, options: [] } };
  g.narrate(`📜 Quest: ${q.title}`, 'title');
  g.narrate(q.desc);
  g.dirty();
  await g.beat(1500);
  let success = false;
  const chars = g.partyChars().filter((c) => !c.dead && !c.down);
  const best = (skill: 'persuasion' | 'insight' | 'perception' | 'stealth' | 'athletics') =>
    [...chars].sort((a, b) => Number(b.skills.includes(skill)) - Number(a.skills.includes(skill)))[0]!;
  switch (q.type) {
    case 'hunt':
    case 'rescue': {
      const mid = (q as Quest & { monsterId?: string }).monsterId;
      const enc = buildEncounter(g.rng, { levels: partyLevels(g), difficulty: g.state.settings.difficulty, encounter: q.type === 'hunt' ? 'hard' : 'medium', biome: 'forest', monsterIds: q.type === 'hunt' && mid ? [mid] : undefined, directorMod: w.directorMod });
      const res = await combatScene(g, { encounter: enc, difficultyLabel: q.type === 'hunt' ? 'hard' : 'medium' });
      if (res === 'defeat') return res;
      success = res === 'victory';
      break;
    }
    case 'negotiate': {
      const idx = await partyVote(g, 'How do you settle it?', [
        { id: 'p', label: 'Sweet words (Persuasion)', emoji: '🕊️' },
        { id: 'i', label: 'Veiled threats (Intimidation)', emoji: '😠' },
        { id: 'd', label: 'A clever lie (Deception)', emoji: '🎭' },
      ]);
      const skill = (['persuasion', 'intimidation', 'deception'] as const)[idx]!;
      const actor = [...chars].sort((a, b) => Number(b.skills.includes(skill)) - Number(a.skills.includes(skill)))[0]!;
      const r = await heroCheck(g, actor, { skill, label: q.title, minigame: skill === 'persuasion' ? 'hum' : 'shout' }, scaledDc(g, 13));
      success = r.degree !== 'fail' && r.degree !== 'fumble';
      break;
    }
    case 'heist': {
      const actor = best('stealth');
      const r = await heroCheck(g, actor, { skill: 'stealth', label: q.title, minigame: 'quiet' }, scaledDc(g, 13));
      success = r.degree !== 'fail' && r.degree !== 'fumble';
      if (!success) {
        g.narrate('Alarm bells! Guards come running!', 'bad');
        const enc = buildEncounter(g.rng, { levels: partyLevels(g), difficulty: g.state.settings.difficulty, encounter: 'medium', biome: 'plains', family: 'bandit' });
        const res = await combatScene(g, { encounter: enc, difficultyLabel: 'medium' });
        if (res === 'defeat') return res;
        success = res === 'victory';
      }
      break;
    }
    default: {
      const skill = q.type === 'investigate' ? 'insight' : q.type === 'escort' ? 'athletics' : 'perception';
      const actor = best(skill);
      const r = await heroCheck(g, actor, { skill, label: q.title, minigame: q.type === 'investigate' ? 'scan' : undefined }, scaledDc(g, 12));
      success = r.degree !== 'fail' && r.degree !== 'fumble';
    }
  }
  if (success) {
    q.status = 'done';
    g.fx({ kind: 'banner', text: `📜 Quest complete: ${q.title}`, style: 'good' });
    g.journal('quest', `Completed "${q.title}".`);
    const fx: import('@pr/shared').EventEffect[] = [{ type: 'gold', amount: q.reward.gold }, { type: 'xp', amount: q.reward.xp }];
    if (q.factionId && q.reward.rep) fx.push({ type: 'rep', faction: q.factionId, amount: q.reward.rep + 1 });
    if (q.reward.item) fx.push({ type: 'item', rarity: q.reward.item });
    if (q.reward.key) {
      g.narrate(`Among the rewards: a clue to a ${w.objective.keyName}!`, 'good');
      fx.push({ type: 'key' });
    }
    if (g.rng.chance(0.25)) fx.push({ type: 'doom', amount: -1 });
    await applyEffects(g, fx, undefined);
  } else {
    q.status = 'failed';
    g.narrate(`The quest "${q.title}" fails.`, 'bad');
    if (q.factionId) await applyEffects(g, [{ type: 'rep', faction: q.factionId, amount: -1 }], undefined);
    g.journal('quest', `Failed "${q.title}".`);
  }
  return undefined;
}
