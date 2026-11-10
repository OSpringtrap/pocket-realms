import { content, type BarkKind, type Monster, type Npc } from '@pr/shared';
import type { Game, Speaker } from './Game.js';

/**
 * Who speaks with which voice, and the short scripted lines monsters say in combat
 * (shared/content/barks.json). Barks are flavour only: they never touch the seeded game RNG, so
 * a seed plays out the same with or without them.
 */

const NPC_FALLBACK = 'man';

export function npcSpeaker(npc: Npc): Speaker {
  return { name: npc.name, voice: npc.voice || NPC_FALLBACK };
}

/** An NPC's reaction after the party's approach, from the archetype's `pleased`/`displeased` lines. */
export function npcReact(g: Game, npc: Npc, pleased: boolean) {
  const arche = content().npcs.find((a) => a.id === npc.archetypeId);
  const lines = pleased ? arche?.pleased : arche?.displeased;
  if (lines?.length) g.say(npcSpeaker(npc), pick(lines));
}

function barkDef(m: Monster) {
  const b = content().barks[m.defId] ?? content().barks[m.family];
  return b && !b.silent && b.voice ? b : undefined;
}

export function canSpeak(m: Monster): boolean {
  return !!barkDef(m);
}

interface BarkState {
  lastAt: number;
  lastLine?: string;
  hurt: Set<string>;
  spokeThisTurn: boolean;
}
const states = new WeakMap<Game, BarkState>();
function state(g: Game): BarkState {
  let s = states.get(g);
  if (!s) states.set(g, (s = { lastAt: -Infinity, hurt: new Set(), spokeThisTurn: false }));
  return s;
}

/** Minimum time between two barks, so a fight is not a shouting match. Taunts, wind-ups and last
 * words matter more than chatter and get a shorter gap. */
const GAP_MS: Record<BarkKind, number> = { taunt: 0, windup: 1500, death: 1500, flee: 1500, hurt: 3500, attack: 5000 };

/** Maybe have `m` say a `kind` line. Returns whether it spoke. */
export function bark(g: Game, m: Monster, kind: BarkKind, chance = 1): boolean {
  if (g.opts.instantBots) return false; // the simulator: no flavour text
  const def = barkDef(m);
  const lines = def?.[kind];
  if (!def || !lines?.length) return false;
  const s = state(g);
  const now = g.clock.now();
  if (now - s.lastAt < GAP_MS[kind] || Math.random() >= chance) return false;
  // Chatter waits its turn rather than piling up behind the narrator.
  if ((kind === 'attack' || kind === 'hurt') && g.voice?.busy()) return false;
  const choices = lines.length > 1 ? lines.filter((l) => l !== s.lastLine) : lines;
  const line = pick(choices);
  s.lastAt = now;
  s.lastLine = line;
  s.spokeThisTurn = true;
  g.say({ name: m.name, voice: def.voice!, source: m.id }, line);
  return true;
}

/** Called when a unit takes damage: the first drop under half HP may draw a cry. */
export function barkHurt(g: Game, m: Monster) {
  const s = state(g);
  if (m.dead || s.hurt.has(m.id) || m.hp > m.maxHp / 2) return;
  s.hurt.add(m.id);
  bark(g, m, 'hurt', m.boss ? 0.9 : 0.5);
}

export function barkTurnStart(g: Game) {
  state(g).spokeThisTurn = false;
}

/** After a monster's turn: a fleeing monster shouts as it goes; otherwise some chatter. */
export function barkTurnEnd(g: Game, m: Monster) {
  const s = state(g);
  if (m.fled) bark(g, m, 'flee', 0.9);
  else if (!m.dead && !s.spokeThisTurn && m.side === 'enemy') bark(g, m, 'attack', m.boss ? 0.45 : 0.25);
  else if (!m.dead && !s.spokeThisTurn) bark(g, m, 'attack', 0.3); // companions
}

export function resetBarks(g: Game) {
  states.delete(g);
}

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}
