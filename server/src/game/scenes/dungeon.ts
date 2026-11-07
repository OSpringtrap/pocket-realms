import {
  Rng,
  buildBossEncounter,
  buildEncounter,
  content,
  miniTier,
  rollDice,
  rollLoot,
  shortRest,
  type ChoiceOption,
  type DungeonRoomView,
  type MinigameKind,
  type Poi,
} from '@pr/shared';
import type { Game } from '../Game.js';
import { applyEffects, avgLevel, partyLevels } from '../effects.js';
import { combatScene, currentBiome, type CombatOutcome } from './combat.js';
import { heroCheck, partyVote, scaledDc } from './event.js';

type RoomKind = DungeonRoomView['kind'];
interface DungeonData {
  rooms: DungeonRoomView[];
  current: number;
  bossId: string;
  family?: string;
  key: boolean;
}

const ROOM_EMOJI: Record<RoomKind, string> = { entrance: '🚪', combat: '⚔️', trap: '🪤', puzzle: '🧩', treasure: '💰', rest: '🔥', boss: '💀', secret: '🗝️', empty: '🕸️' };
const ROOM_NAMES: Record<RoomKind, string[]> = {
  entrance: ['Entrance Hall'],
  combat: ['Guard Room', 'Bone Pit', 'Barracks', 'Echoing Hall', 'Flooded Corridor'],
  trap: ['Narrow Passage', 'Tiled Gallery', 'Collapsing Stairs', 'Pendulum Hall'],
  puzzle: ['Rune Chamber', 'Hall of Statues', 'Mirror Room', 'Bell Tower'],
  treasure: ['Treasury', 'Forgotten Vault', 'Dragon\'s Purse'],
  rest: ['Quiet Chapel', 'Dry Alcove', 'Old Campsite'],
  boss: ['Throne Room', 'Heart of the Dungeon', 'Inner Sanctum'],
  secret: ['Hidden Reliquary'],
  empty: ['Dusty Room'],
};

export function generateDungeon(g: Game, poi: Poi): DungeonData {
  const rng = Rng.derive(g.state.seed, `dungeon:${poi.id}`);
  const depth = Number(poi.data?.depth ?? 3);
  const rooms: DungeonRoomView[] = [];
  const add = (kind: RoomKind) => {
    const r: DungeonRoomView = { id: rooms.length, kind, revealed: false, cleared: false, links: [], emoji: ROOM_EMOJI[kind], name: rng.pick(ROOM_NAMES[kind]) };
    rooms.push(r);
    return r;
  };
  const entrance = add('entrance');
  entrance.revealed = true;
  entrance.cleared = true;
  let prevLayer = [entrance];
  for (let d = 0; d < depth; d++) {
    const width = d === depth - 1 ? 1 : rng.int(1, 2) + (d > 0 ? 0 : 1);
    const layer: DungeonRoomView[] = [];
    for (let i = 0; i < Math.min(2, width); i++) {
      const kind = rng.weighted<RoomKind>([
        { item: 'combat', weight: 40 },
        { item: 'trap', weight: 18 },
        { item: 'puzzle', weight: 16 },
        { item: 'treasure', weight: 12 },
        { item: 'rest', weight: d >= 1 ? 12 : 4 },
      ]);
      layer.push(add(kind));
    }
    for (const p of prevLayer) for (const r of layer) p.links.push(r.id);
    prevLayer = layer;
  }
  const boss = add('boss');
  for (const p of prevLayer) p.links.push(boss.id);
  // a secret room hanging off a random mid room
  if (rooms.length > 3 && rng.chance(0.6)) {
    const host = rng.pick(rooms.slice(1, -1));
    const sec = add('secret');
    host.links.push(sec.id);
    sec.links.push(...host.links.filter((l) => l !== sec.id));
  }
  const w = g.state.world!;
  const lvl = Math.max(1, ...g.partyChars().map((c) => c.level));
  const maxTier = Math.max(2, Math.ceil(lvl / 2) + 1);
  let bosses = content().monsterList.filter((m) => m.boss && m.id !== w.antagonist.bossId && m.tier <= maxTier);
  if (!bosses.length) bosses = content().monsterList.filter((m) => m.boss && m.id !== w.antagonist.bossId).sort((a, b) => a.tier - b.tier).slice(0, 2);
  const ant = content().antagonists.find((a) => a.id === w.antagonist.id);
  return { rooms, current: 0, bossId: rng.pick(bosses).id, family: ant ? rng.pick(ant.minions) : undefined, key: !!poi.data?.key };
}

async function trapRoom(g: Game): Promise<void> {
  const chars = g.partyChars().filter((c) => !c.dead && !c.down);
  const scout = [...chars].sort((a, b) => (b.skills.includes('perception') ? 1 : 0) - (a.skills.includes('perception') ? 1 : 0))[0]!;
  g.narrate(`${scout.name} leads, eyes on the floor...`);
  const spot = await heroCheck(g, scout, { skill: 'perception', label: 'Spot the trap', minigame: 'scan' }, scaledDc(g, 13));
  if (spot.degree === 'success' || spot.degree === 'crit') {
    g.narrate(`${scout.name} spots a pressure plate and guides everyone around it. (+XP)`, 'good');
    await applyEffects(g, [{ type: 'xp', amount: 15 }], scout.id);
    return;
  }
  g.narrate('CLICK. Blades swing from the walls! Everyone dodge!', 'bad');
  const dmg = `${Math.max(1, Math.ceil(avgLevel(g) / 2) + 1)}d6`;
  const results = await Promise.all(chars.map((c) => heroCheck(g, c, { ability: 'DEX', label: 'Dodge the blades!', minigame: 'shake' }, scaledDc(g, 12))));
  chars.forEach((c, i) => {
    const r = rollDice(g.rng, dmg);
    const ok = results[i]!.degree === 'success' || results[i]!.degree === 'crit';
    const amt = ok ? Math.floor(r.total / 2) : r.total;
    c.hp = Math.max(1, c.hp - amt);
    g.fx({ kind: 'damage', target: c.id, amount: amt, dmg: 'slashing' });
  });
  g.dirty();
}

async function puzzleRoom(g: Game): Promise<void> {
  const chars = g.partyChars().filter((c) => !c.dead && !c.down);
  const kinds: MinigameKind[] = ['sequence', 'rune', 'plates', 'plates'];
  const kind = g.rng.pick(kinds);
  const desc =
    kind === 'sequence'
      ? 'Glowing tiles flash in a pattern. Everyone must repeat it — together!'
      : kind === 'rune'
        ? 'A great rune is carved into the door. Everyone traces their part of it.'
        : 'Pressure plates! Everyone must hold their plate down at the same time — together!';
  g.narrate(`🧩 ${desc}`);
  const param = kind === 'rune' ? g.rng.pick(['circle', 'triangle', 'star', 'spiral', 'zigzag']) : undefined;
  const scores = await Promise.all(chars.map((c) => g.minigame(c.id, kind, `Puzzle: ${desc}`, param)));
  const avg = scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
  // pressure plates only work if EVERYONE holds theirs
  const tier = miniTier(kind === 'plates' ? Math.min(...scores) + 0.1 : avg);
  if (tier !== 'none') {
    g.narrate(`The mechanism clunks open — ${tier === 'great' ? 'flawlessly!' : 'just barely.'}`, 'good');
    const it = rollLoot(g.rng, { level: avgLevel(g), boost: tier === 'great' ? 25 : 10 });
    g.state.party.stash.push(it);
    g.narrate(`🎁 Behind it: ${it.emoji} ${it.name} (${it.rarity}).`, 'good');
    await applyEffects(g, [{ type: 'xp', amount: 25 }], undefined);
  } else {
    g.narrate('Wrong! The room shakes and dust pours down. You force your way through, bruised.', 'bad');
    await applyEffects(g, [{ type: 'damage', dice: `${Math.max(1, Math.ceil(avgLevel(g) / 2))}d6`, who: 'party' }], undefined);
  }
}

export async function dungeonScene(g: Game, poi: Poi): Promise<CombatOutcome | 'retreat' | 'cleared'> {
  const w = g.state.world!;
  const data = (poi.data?.dungeon as DungeonData | undefined) ?? generateDungeon(g, poi);
  poi.data = { ...(poi.data ?? {}), dungeon: data };
  const view = () => {
    g.state.scene = { kind: 'dungeon', name: poi.name, rooms: data.rooms, current: data.current, text: data.rooms[data.current]!.name };
    g.dirty();
  };
  data.current = 0;
  view();
  g.fx({ kind: 'sound', name: 'dungeon' });
  g.narrate(`🕳️ ${poi.name}. Cold air breathes from the dark.`, 'title');
  await g.beat(1500);
  // Shortcut: on a return visit, skip straight to the deepest room you reached
  const deepest = [...data.rooms].filter((r) => r.cleared && r.kind !== 'entrance' && r.kind !== 'secret').sort((a, b) => b.id - a.id)[0];
  if (deepest) {
    data.current = deepest.id;
    g.narrate(`You remember the way: a shortcut leads straight back to the ${deepest.name}.`, 'good');
    view();
    await g.beat(1000);
  }
  for (let guard = 0; guard < 30; guard++) {
    const room = data.rooms[data.current]!;
    room.revealed = true;
    view();
    if (!room.cleared) {
      g.narrate(`${room.emoji} ${room.name}`, 'title');
      await g.beat(900);
      switch (room.kind) {
        case 'combat': {
          const enc = buildEncounter(g.rng, { levels: partyLevels(g), difficulty: g.state.settings.difficulty, encounter: g.rng.chance(0.3) ? 'hard' : 'medium', biome: 'ruins', family: data.family, directorMod: w.directorMod });
          const res = await combatScene(g, { encounter: enc, difficultyLabel: 'medium', title: room.name });
          if (res === 'defeat') return res;
          if (res === 'fled') return 'retreat';
          break;
        }
        case 'trap':
          await trapRoom(g);
          break;
        case 'puzzle':
          await puzzleRoom(g);
          break;
        case 'treasure':
        case 'secret': {
          const gold = g.rng.int(20, 40) * avgLevel(g);
          g.state.party.gold += gold;
          const it = rollLoot(g.rng, { level: avgLevel(g), boost: room.kind === 'secret' ? 35 : 15 });
          g.state.party.stash.push(it);
          g.fx({ kind: 'sound', name: 'loot' });
          g.narrate(`💰 ${gold} gold and ${it.emoji} ${it.name} (${it.rarity})!`, 'good');
          break;
        }
        case 'rest':
          for (const c of g.partyChars()) if (!c.dead) shortRest(c);
          g.narrate('🔥 A safe corner. The party catches its breath (short rest).', 'good');
          break;
        case 'boss': {
          const enc = buildBossEncounter(g.rng, { bossId: data.bossId, levels: partyLevels(g), difficulty: g.state.settings.difficulty, families: data.family ? [data.family] : undefined, biome: currentBiome(g), directorMod: w.directorMod });
          // Dungeon bosses are a notch below final-boss strength
          for (const m of enc.monsters.slice(0, 1)) {
            m.maxHp = m.hp = Math.round(m.maxHp * 0.8);
            m.legendary = Math.max(0, (m.legendary ?? 0) - 1);
          }
          g.narrate(`💀 ${enc.monsters[0]!.emoji} ${enc.monsters[0]!.name} rises to face you!`, 'bad');
          const res = await combatScene(g, { encounter: enc, bossFight: true, difficultyLabel: 'boss', title: enc.monsters[0]!.name });
          if (res === 'defeat') return res;
          room.cleared = true;
          poi.cleared = true;
          if (data.key) await applyEffects(g, [{ type: 'key' }], undefined);
          await applyEffects(g, [{ type: 'item', rarity: avgLevel(g) >= 5 ? 'epic' : 'rare' }, { type: 'xp', amount: 40 }], undefined);
          g.journal('quest', `Cleared ${poi.name}, defeating ${enc.monsters[0]!.name}.`);
          return 'cleared';
        }
        default:
          break;
      }
      room.cleared = true;
      view();
    }
    // choose next door
    const next = room.links.map((id) => data.rooms[id]!).filter(Boolean);
    const perceptive = g.partyChars().some((c) => c.skills.includes('perception'));
    const opts: ChoiceOption[] = next.map((r) => ({
      id: String(r.id),
      label: r.revealed || perceptive ? `${r.emoji} ${r.name}` : '🚪 Unknown door',
      desc: r.cleared ? 'Already explored' : r.revealed || perceptive ? (r.kind === 'boss' ? 'You sense something terrible beyond.' : `Looks like a ${r.kind} room.`) : 'Who knows?',
      emoji: r.revealed || perceptive ? r.emoji : '🚪',
    }));
    opts.push({ id: 'retreat', label: 'Retreat to the surface', emoji: '🏃', desc: 'Progress is kept. Come back later.' });
    const hpPct = g.partyChars().reduce((a, c) => a + (c.dead ? 0 : c.hp), 0) / Math.max(1, g.partyChars().reduce((a, c) => a + c.maxHp, 0));
    const botPick = () => {
      if (hpPct < 0.3) return 'retreat';
      const fresh = next.filter((r) => !r.cleared && r.kind !== 'boss');
      const pickRoom = (fresh.length ? g.rng.pick(fresh) : next.find((r) => r.kind === 'boss') ?? next[0]) as DungeonRoomView | undefined;
      return pickRoom ? String(pickRoom.id) : 'retreat';
    };
    const idx = await partyVote(g, `${poi.name}: which way?`, opts, { bot: botPick });
    const pick = opts[idx]!.id;
    if (pick === 'retreat') {
      g.narrate('The party retreats to daylight. The dungeon will wait.');
      return 'retreat';
    }
    data.current = Number(pick);
  }
  return 'retreat';
}
