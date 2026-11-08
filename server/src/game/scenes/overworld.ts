import {
  MOVE_COST,
  buildEncounter,
  content,
  hexDist,
  hexKey,
  pathTo,
  reachable,
  revealAround,
  tileAt,
  type ChoiceOption,
  type HexTile,
  type TimeOfDay,
  type Weather,
} from '@pr/shared';
import type { Game } from '../Game.js';
import { partyLevels } from '../effects.js';
import { questAt, questScene } from '../quests.js';
import { combatScene, type CombatOutcome } from './combat.js';
import { finalBattle, handleDefeat } from './ending.js';
import { eventScene, pickEventCard } from './event.js';
import { campScene, jackboxRound } from './jackbox.js';
import { poiScene } from './poi.js';
import { botUpkeep } from '../botUpkeep.js';
import { checkGoals } from '../goals.js';
import { handleLevelUps } from './levelup.js';

const TIMES: TimeOfDay[] = ['morning', 'afternoon', 'evening', 'night'];
const TIME_EMOJI: Record<TimeOfDay, string> = { morning: '🌅', afternoon: '☀️', evening: '🌇', night: '🌙' };
const WEATHER_EMOJI: Record<Weather, string> = { clear: '', rain: '🌧️', fog: '🌫️', storm: '⛈️', snow: '❄️', heat: '🔥' };

function revealRadius(g: Game): number {
  const w = g.state.world!;
  if (w.time === 'night' || w.weather === 'fog' || w.weather === 'storm') return 1;
  const t = tileAt(w, w.party.q, w.party.r);
  return t && (t.biome === 'mountains' || t.biome === 'plains' || t.biome === 'coast') ? 2 : 1;
}

type MoveChoice = { kind: 'move'; q: number; r: number } | { kind: 'camp' };

/** Bot/auto leader: head for the fortress if ready, else the nearest unexplored dungeon; rest when hurt. */
function autoDestination(g: Game): string {
  const w = g.state.world!;
  const reach = reachable(w, w.movesLeft);
  const chars = g.partyChars();
  const hp = chars.reduce((s, c) => s + (c.dead ? 0 : c.hp), 0) / Math.max(1, chars.reduce((s, c) => s + c.maxHp, 0));
  const sp = chars.reduce((s, c) => s + c.sp, 0) / Math.max(1, chars.reduce((s, c) => s + c.maxSp, 0) || 1);
  let goal: HexTile | undefined;
  const pois = w.tiles.filter((t) => t.poi && t.revealed && !t.hidden);
  const ready = w.objective.keys >= w.objective.keysNeeded;
  const needRest = hp < 0.5 || (sp < 0.25 && chars.some((c) => c.maxSp > 0));
  if (chars.some((c) => c.dead)) goal = pois.filter((t) => t.poi!.kind === 'town' || t.poi!.kind === 'shrine').sort((a, b) => hexDist(a, w.party) - hexDist(b, w.party))[0];
  if (!goal && needRest) {
    const rest = pois.filter((t) => t.poi!.kind === 'town' || t.poi!.kind === 'camp').sort((a, b) => hexDist(a, w.party) - hexDist(b, w.party))[0];
    if (!rest || hexDist(rest, w.party) > w.movesLeft + 1) return 'camp';
    goal = rest;
  }
  if (!goal && ready) goal = w.tiles.find((t) => t.poi?.kind === 'fortress');
  if (!goal) {
    const quest = w.quests.find((q) => q.status === 'active' && q.targetTile);
    const dungeon = w.tiles.filter((t) => t.poi?.kind === 'dungeon' && !t.poi.cleared).sort((a, b) => hexDist(a, w.party) - hexDist(b, w.party))[0];
    const questTile = quest ? tileAt(w, quest.targetTile!.q, quest.targetTile!.r) : undefined;
    goal = questTile && (!dungeon || hexDist(questTile, w.party) < hexDist(dungeon, w.party)) ? questTile : dungeon;
  }
  if (!goal) goal = w.tiles.find((t) => t.poi?.kind === 'fortress');
  let best: string | undefined;
  let bestD = Infinity;
  for (const [k, v] of reach) {
    const [q, r] = k.split(',').map(Number) as [number, number];
    const d = goal ? hexDist({ q, r }, goal) : g.rng.next() * 10;
    const t = tileAt(w, q, r)!;
    const score = d * 10 + v.cost - (t.revealed ? 0 : 0.5) + (t.poi?.kind === 'fortress' && !ready ? 50 : 0);
    if (score < bestD) {
      bestD = score;
      best = k;
    }
  }
  return best ?? 'camp';
}

async function chooseMove(g: Game, leaderId: string): Promise<MoveChoice> {
  const w = g.state.world!;
  const reach = reachable(w, w.movesLeft);
  const opts: ChoiceOption[] = [];
  for (const [k, v] of reach) {
    const [q, r] = k.split(',').map(Number) as [number, number];
    const t = tileAt(w, q, r)!;
    const poi = t.revealed && t.poi && (!t.hidden || t.visited) ? t.poi : undefined;
    opts.push({
      id: k,
      label: poi ? `${poi.emoji} ${poi.name}` : t.revealed ? `${t.name ?? t.biome}` : 'Unexplored land',
      desc: `${v.cost} move${v.cost === 1 ? '' : 's'}${poi?.cleared ? ' — cleared' : ''}`,
      group: poi ? 'Places' : 'Wilds',
      emoji: poi ? poi.emoji : t.revealed ? biomeEmoji(t.biome) : '🌫️',
    });
  }
  opts.sort((a, b) => Number(b.group === 'Places') - Number(a.group === 'Places'));
  opts.push({ id: 'camp', label: 'Make camp here', emoji: '⛺', desc: 'Short rest and a campfire moment. Ends the turn.', group: 'Places' });
  const pick = await g.choose(leaderId, `🧭 You lead! Where to? (${w.movesLeft} moves)`, opts, {
    style: 'map',
    text: 'Tap a glowing tile on the map, or pick from the list.',
    fallback: autoDestination(g),
    bot: () => autoDestination(g),
  });
  if (pick === 'camp') return { kind: 'camp' };
  const [q, r] = pick.split(',').map(Number) as [number, number];
  return { kind: 'move', q, r };
}

function biomeEmoji(b: string): string {
  return ({ plains: '🌾', forest: '🌲', swamp: '🐸', mountains: '⛰️', desert: '🏜️', ruins: '🏛️', coast: '🏖️', water: '🌊' } as Record<string, string>)[b] ?? '❔';
}

async function travel(g: Game, path: { q: number; r: number }[]) {
  const w = g.state.world!;
  for (const step of path) {
    const t = tileAt(w, step.q, step.r)!;
    w.movesLeft = Math.max(0, w.movesLeft - MOVE_COST[t.biome]);
    w.party = { q: step.q, r: step.r };
    revealAround(w, step.q, step.r, revealRadius(g));
    // hidden caches: keen eyes notice them when passing nearby
    for (const h of w.tiles)
      if (h.hidden && h.revealed && hexDist(h, step) <= 1) {
        const keen = g.partyChars().some((c) => c.skills.includes('perception') || c.species === 'elf');
        if (keen || g.rng.chance(0.35)) {
          h.hidden = false;
          h.visited = h.visited || false;
          g.narrate('👀 Someone spots a hidden cache nearby!', 'good');
          h.poi && (h.poi.emoji = '💎');
          g.fx({ kind: 'sound', name: 'discover' });
        }
      }
    g.dirty();
    await g.sleep(g.opts.instantBots ? 0 : 380);
  }
  const dest = tileAt(w, w.party.q, w.party.r)!;
  dest.visited = true;
  if (dest.hidden) dest.hidden = false;
}

async function wildEncounter(g: Game, tile: HexTile): Promise<CombatOutcome | undefined> {
  const w = g.state.world!;
  let chance = 0.6 + (w.time === 'night' ? 0.15 : 0) + (w.weather === 'storm' ? 0.1 : 0);
  if (tile.visited && tile.poi?.cleared) chance -= 0.2;
  if (!g.rng.chance(chance)) {
    g.narrate(g.rng.pick([
      `The ${tile.biome} is quiet. Too quiet? No — just quiet.`,
      `You pass through ${tile.name ?? `the ${tile.biome}`} without incident.`,
      'A peaceful stretch of road. Birds, wind, the creak of boots.',
      'You find an old milestone with a rude carving on it. Classic.',
    ]));
    return undefined;
  }
  const safeNeeded = w.hardSinceRest && g.rng.chance(0.6);
  const tooManyFights = w.combatStreak >= 2;
  if (!safeNeeded && !tooManyFights && g.rng.chance(0.3)) {
    w.combatStreak++;
    const ant = content().antagonists.find((a) => a.id === w.antagonist.id);
    const useMinions = ant && g.rng.chance(0.3 + w.doom / w.doomMax / 2);
    const enc = buildEncounter(g.rng, {
      levels: partyLevels(g),
      difficulty: g.state.settings.difficulty,
      encounter: g.rng.chance(0.25 + (w.doom / w.doomMax) * 0.3) ? 'hard' : g.rng.chance(0.4) ? 'easy' : 'medium',
      biome: tile.biome,
      time: w.time,
      families: useMinions ? ant!.minions : undefined,
      directorMod: w.directorMod,
    });
    g.narrate(w.time === 'night' ? 'Shapes move in the darkness...' : 'Trouble on the road!', 'bad');
    const diff = enc.adjustedXp > enc.budget * 1.1 ? 'hard' : 'medium';
    return combatScene(g, { encounter: enc, difficultyLabel: diff, ambush: w.time === 'night' && g.rng.chance(0.3) });
  }
  // Event card; after hard fights prefer safe/social ones, never more than 2 fights in a row
  const card = pickEventCard(g, (c) => (safeNeeded ? c.tags.includes('safe') || c.tags.includes('social') || c.tags.includes('shop') : true) && (!tooManyFights || !c.tags.includes('danger')));
  if (safeNeeded) w.hardSinceRest = false;
  return eventScene(g, card);
}

function rollWeather(g: Game): Weather {
  const w = g.state.world!;
  const t = tileAt(w, w.party.q, w.party.r);
  const opts: { item: Weather; weight: number }[] = [
    { item: 'clear', weight: 50 },
    { item: 'rain', weight: t?.biome === 'swamp' || t?.biome === 'forest' ? 25 : 14 },
    { item: 'fog', weight: t?.biome === 'swamp' || t?.biome === 'coast' ? 18 : 8 },
    { item: 'storm', weight: 7 },
    { item: 'snow', weight: t?.biome === 'mountains' ? 20 : 0 },
    { item: 'heat', weight: t?.biome === 'desert' ? 25 : 0 },
  ];
  return g.rng.weighted(opts);
}

async function endTurn(g: Game) {
  const s = g.state;
  const w = s.world!;
  w.turn++;
  s.stats.turns++;
  w.doom = Math.min(w.doomMax, w.doom + 1);
  const ti = TIMES.indexOf(w.time);
  if (ti === TIMES.length - 1) {
    w.time = 'morning';
    w.day++;
  } else w.time = TIMES[ti + 1]!;
  if (g.rng.chance(0.4)) w.weather = rollWeather(g);
  w.leaderIdx++;
  // Doom thresholds: regional events
  const ant = content().antagonists.find((a) => a.id === w.antagonist.id);
  for (const [i, frac] of [0.34, 0.67].entries()) {
    const thr = Math.ceil(w.doomMax * frac);
    if (w.doom >= thr && !w.doomEvents.includes(thr)) {
      w.doomEvents.push(thr);
      g.fx({ kind: 'banner', text: `⏳ The Doom Clock: ${w.doom}/${w.doomMax}`, style: 'bad' }, { kind: 'sound', name: 'doom' });
      g.narrate(ant?.doomText[i] ?? 'The darkness spreads.', 'bad');
      g.journal('world', ant?.doomText[i] ?? 'The darkness spreads.');
      if (i === 0) {
        // a new lair springs up somewhere nearby
        const cands = w.tiles.filter((t) => !t.poi && t.biome !== 'water' && hexDist(t, w.party) >= 2 && hexDist(t, w.party) <= 3);
        if (cands.length) {
          const t = g.rng.pick(cands);
          t.poi = { id: `poi_doom${thr}`, kind: 'lair', name: `${w.antagonist.name}'s Outpost`, emoji: '🐉' };
          t.revealed = true;
        }
      }
      await g.beat(2200);
    }
  }
  if (w.doom >= w.doomMax - 2 && w.doom < w.doomMax) g.narrate(`⚠️ The Doom Clock nearly strikes! ${w.doomMax - w.doom} turn${w.doomMax - w.doom > 1 ? 's' : ''} left!`, 'bad');
  checkGoals(g);
  g.dirty();
  g.save();
}

export async function overworldLoop(g: Game) {
  for (;;) {
    const s = g.state;
    if (s.phase !== 'playing') return;
    const w = s.world!;
    if (w.doom >= w.doomMax) {
      await finalBattle(g, { empowered: true });
      return;
    }
    // Jackbox interludes keep everyone engaged between scenes
    const humans = g.partyIds().filter((id) => !g.players.get(id)?.isBot).length;
    const every = s.settings.length === 'oneshot' ? 4 : 5;
    if (humans >= 2 && w.turn > 1 && w.turnsSincePrompt >= every) {
      w.turnsSincePrompt = 0;
      await jackboxRound(g, g.rng.pick(['deed', 'lore', 'motto', 'title'] as const));
    }
    w.turnsSincePrompt++;
    botUpkeep(g);
    if (g.partyChars().some((c) => c.pendingLevelUps > 0)) await handleLevelUps(g);
    w.movesLeft = w.moveBudget + (w.bonusMoves ?? 0);
    w.bonusMoves = 0;
    s.scene = { kind: 'overworld' };
    const leader = g.leaderId();
    if (!leader) return;
    g.narrate(`${TIME_EMOJI[w.time]} Day ${w.day}, ${w.time}${w.weather !== 'clear' ? ` ${WEATHER_EMOJI[w.weather]} ${w.weather}` : ''}. ${s.chars[leader]?.name ?? 'The leader'} leads the way.`);
    g.dirty();
    const choice = await chooseMove(g, leader);
    let res: CombatOutcome | 'ended' | undefined;
    if (choice.kind === 'camp') {
      const r = await campScene(g, { canLongRest: false });
      void r;
    } else {
      const path = pathTo(w, choice.q, choice.r, w.movesLeft) ?? [{ q: choice.q, r: choice.r }];
      await travel(g, path);
      const tile = tileAt(w, w.party.q, w.party.r)!;
      const quest = questAt(g, tile);
      if (quest) res = await questScene(g, quest);
      else if (tile.poi && (!tile.poi.cleared || ['town', 'merchant', 'camp', 'fortress', 'shrine'].includes(tile.poi.kind))) res = await poiScene(g, tile);
      else res = await wildEncounter(g, tile);
    }
    if (g.state.phase !== 'playing') return;
    if (res === 'ended') return;
    if (res === 'defeat') {
      const rescued = await handleDefeat(g);
      if (!rescued) return;
    }
    await endTurn(g);
  }
}

export { hexKey };
