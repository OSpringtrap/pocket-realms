import { content } from '../content/index.js';
import { Rng, hashString } from '../rng.js';
import { NameBook, VOICE_GENDER, antagonistName, dungeonName, npcName, poiName, regionName, townName, type Gender } from './names.js';
import type { Biome, HexTile, Npc, Poi, PoiKind, RunLength, WorldState } from '../types.js';

// ---------------------------------------------------------------- hex math (axial)

export const HEX_DIRS: [number, number][] = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];
export const hexKey = (q: number, r: number) => `${q},${r}`;
export function hexDist(a: { q: number; r: number }, b: { q: number; r: number }): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
}
export function hexNeighbors(q: number, r: number): [number, number][] {
  return HEX_DIRS.map(([dq, dr]) => [q + dq, r + dr]);
}
export function hexRing(radius: number): [number, number][] {
  const out: [number, number][] = [];
  for (let q = -radius; q <= radius; q++)
    for (let r = Math.max(-radius, -q - radius); r <= Math.min(radius, -q + radius); r++) out.push([q, r]);
  return out;
}

export const MOVE_COST: Record<Biome, number> = { plains: 1, forest: 1, swamp: 2, mountains: 2, desert: 1, ruins: 1, coast: 1, water: 99 };

// ---------------------------------------------------------------- noise

function lattice(seed: number, x: number, y: number): number {
  return (hashString(`${seed}:${x}:${y}`) % 10000) / 10000;
}
function smooth(t: number) {
  return t * t * (3 - 2 * t);
}
function valueNoise(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const a = lattice(seed, x0, y0);
  const b = lattice(seed, x0 + 1, y0);
  const c = lattice(seed, x0, y0 + 1);
  const d = lattice(seed, x0 + 1, y0 + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(seed: number, x: number, y: number): number {
  return valueNoise(seed, x, y) * 0.6 + valueNoise(seed + 17, x * 2.1, y * 2.1) * 0.3 + valueNoise(seed + 31, x * 4.3, y * 4.3) * 0.1;
}

// ---------------------------------------------------------------- generation

const POI_EMOJI: Record<PoiKind, string> = {
  town: '🏘️',
  dungeon: '🕳️',
  camp: '⛺',
  shrine: '⛩️',
  merchant: '🛒',
  lair: '🐉',
  cache: '💎',
  fortress: '🏰',
  ruin: '🏛️',
  portal: '🌀',
};

const ANTAGONIST_BIOME: Record<string, Biome[]> = {
  grizzlefang: ['mountains', 'forest'],
  mother_murk: ['swamp'],
  silk_mother: ['forest', 'ruins'],
  hollow_king: ['ruins', 'plains'],
  vex_morrow: ['ruins', 'desert'],
  ashmaw: ['mountains', 'desert'],
  iron_colossus: ['ruins', 'mountains'],
};

export interface WorldGenOptions {
  seed: string;
  length: RunLength;
  partySize: number;
}

export function generateWorld(opts: WorldGenOptions): WorldState {
  const rng = Rng.derive(opts.seed, 'world');
  const campaign = opts.length === 'campaign';
  const R = campaign ? 7 : 4;
  const s1 = hashString(`${opts.seed}:elev`);
  const s2 = hashString(`${opts.seed}:moist`);
  const s3 = hashString(`${opts.seed}:ruin`);
  const scale = campaign ? 0.28 : 0.38;

  const tiles: HexTile[] = [];
  for (const [q, r] of hexRing(R)) {
    const x = (q + r / 2) * scale;
    const y = r * 0.866 * scale;
    const ring = hexDist({ q, r }, { q: 0, r: 0 });
    let e = fbm(s1, x + 10, y + 10);
    const m = fbm(s2, x + 50, y + 50);
    const edge = ring / R;
    e = e * 0.85 + 0.15 - Math.max(0, edge - 0.75) * 0.6;
    let biome: Biome;
    if (ring === R && e < 0.42) biome = 'water';
    else if (ring >= R - 1 && e < 0.48) biome = 'coast';
    else if (e > 0.7) biome = 'mountains';
    else if (m > 0.6 && e < 0.5) biome = 'swamp';
    else if (m > 0.47) biome = 'forest';
    else if (m < 0.3) biome = 'desert';
    else biome = 'plains';
    if (biome !== 'water' && biome !== 'coast' && biome !== 'mountains' && fbm(s3, x * 1.7, y * 1.7) > 0.74) biome = 'ruins';
    tiles.push({ q, r, biome, revealed: false, visited: false, elevation: Math.round(e * 100) / 100 });
  }
  const tileAt = (q: number, r: number) => tiles.find((t) => t.q === q && t.r === r);
  const land = () => tiles.filter((t) => t.biome !== 'water' && !t.poi);

  // Names come from their own stream, so growing the name tables never moves the map a seed draws.
  const nrng = Rng.derive(opts.seed, 'names');
  const book = new NameBook();

  // Antagonist and fortress
  const ant = rng.pick(content().antagonists);
  const antName = antagonistName(nrng, ant.id) ?? ant.name;
  const renamed = (s: string) => (antName === ant.name ? s : s.split(ant.name).join(antName));
  const outer = land().filter((t) => hexDist(t, { q: 0, r: 0 }) >= R - 1);
  const start = rng.pick(outer.length ? outer : land());
  const prefer = ANTAGONIST_BIOME[ant.id] ?? [];
  const far = land()
    .filter((t) => hexDist(t, start) >= Math.max(3, R))
    .sort((a, b) => hexDist(b, start) - hexDist(a, start));
  const fortressTile = far.find((t) => prefer.includes(t.biome)) ?? far[0] ?? land()[land().length - 1]!;
  if (prefer.length && !prefer.includes(fortressTile.biome)) fortressTile.biome = prefer[0]!;
  // make the land around the fortress match its master
  for (const [q, r] of hexNeighbors(fortressTile.q, fortressTile.r)) {
    const t = tileAt(q, r);
    if (t && t.biome !== 'water' && prefer.length && rng.chance(0.5)) t.biome = prefer[0]!;
  }

  let poiN = 0;
  const place = (t: HexTile, kind: PoiKind, name: string, data?: Record<string, unknown>) => {
    t.poi = { id: `poi${poiN++}`, kind, name, emoji: POI_EMOJI[kind], data };
    return t.poi;
  };
  const startTown = book.take(() => townName(nrng));
  if (start.biome === 'swamp' || start.biome === 'mountains') start.biome = 'plains';
  place(start, 'town', startTown, { home: true });
  place(fortressTile, 'fortress', ant.fortress.replace(/^the /, 'The '));

  const counts: Record<PoiKind, number> = campaign
    ? { town: 3, dungeon: 5, camp: 4, shrine: 4, merchant: 3, lair: 3, cache: 5, ruin: 3, portal: 0, fortress: 0 }
    : { town: 1, dungeon: 2, camp: 2, shrine: 1, merchant: 1, lair: 1, cache: 2, ruin: 1, portal: 0, fortress: 0 };
  const placeKind = (kind: PoiKind, n: number, minSpacing: number, filter: (t: HexTile) => boolean = () => true) => {
    for (let i = 0; i < n; i++) {
      const cands = land().filter(
        (t) => filter(t) && tiles.every((o) => !o.poi || hexDist(o, t) >= minSpacing) && hexDist(t, start) >= 2,
      );
      const pool = cands.length ? cands : land().filter(filter);
      if (!pool.length) return;
      const t = rng.pick(pool);
      const name =
        kind === 'town'
          ? book.take(() => townName(nrng))
          : kind === 'dungeon'
            ? book.take(() => dungeonName(nrng))
            : kind === 'cache'
              ? 'Hidden Cache'
              : book.take(() => poiName(nrng, kind as 'camp' | 'shrine' | 'merchant' | 'lair' | 'ruin'));
      const p = place(t, kind, name);
      if (kind === 'cache') t.hidden = true;
      if (kind === 'dungeon') p.data = { key: true, depth: campaign ? 4 + (i % 2) : 3 };
    }
  };
  placeKind('dungeon', counts.dungeon, 2, (t) => hexDist(t, fortressTile) >= 2);
  placeKind('town', counts.town, 3);
  placeKind('shrine', counts.shrine, 2);
  placeKind('camp', counts.camp, 2);
  placeKind('merchant', counts.merchant, 2);
  placeKind('lair', counts.lair, 2, (t) => hexDist(t, start) >= 3);
  placeKind('ruin', counts.ruin, 2);
  placeKind('cache', counts.cache, 1);

  // Name some wilderness tiles
  for (const t of tiles)
    if (!t.poi && rng.chance(0.15)) {
      const curated = content().names.wild[t.biome];
      t.name = book.take(() => (curated?.length && nrng.chance(0.35) ? nrng.pick(curated) : regionName(nrng, t.biome)));
    }

  // Connectivity: guarantee a land path from start to every POI by draining water on the way
  ensureConnected(tiles, start);

  // Fog: reveal around start and the ominous fortress silhouette
  for (const t of tiles) if (hexDist(t, start) <= 2) t.revealed = true;
  fortressTile.revealed = true;
  start.visited = true;

  const factions = rng.shuffle([...content().factions]).slice(0, campaign ? 5 : 3).map((f) => ({ ...f, rep: 0 }));
  const npcs: Npc[] = [];
  const archetypes = rng.shuffle([...content().npcs]);
  for (let i = 0; i < (campaign ? 14 : 8) && i < archetypes.length; i++) {
    const a = archetypes[i]!;
    rng.int(0, 3); // keeps the world stream where it was when archetypes carried hand-written names
    // Every NPC gets a fresh name, matched to the gender of one of the archetype's voices.
    const voice = a.voices?.length ? nrng.pick(a.voices) : undefined;
    const gender: Gender = VOICE_GENDER[voice ?? ''] ?? (nrng.chance(0.5) ? 'f' : 'm');
    const name = book.take(() => npcName(nrng, a.id, gender));
    npcs.push({
      id: `npc${i}`,
      name,
      voice,
      archetypeId: a.id,
      emoji: a.emoji,
      title: a.title,
      motivation: rng.pick(a.motivations),
      factionId: factions.find((f) => f.id === a.faction)?.id,
      attitude: 0,
    });
  }

  const keysNeeded = campaign ? 3 : 1;
  return {
    seed: opts.seed,
    radius: R,
    tiles,
    party: { q: start.q, r: start.r },
    day: 1,
    time: 'morning',
    weather: 'clear',
    doom: 0,
    doomMax: campaign ? 36 : 14,
    doomEvents: [],
    antagonist: { id: ant.id, name: antName, baseName: ant.name, title: ant.title, emoji: ant.emoji, bossId: ant.bossId, desc: renamed(ant.desc) },
    objective: { text: renamed(ant.objective), fortress: { q: fortressTile.q, r: fortressTile.r }, keysNeeded, keys: 0, keyName: ant.keyName },
    factions,
    npcs,
    quests: [],
    kingdomName: 'the Realm',
    lore: { startTown, fortress: ant.fortress },
    home: { name: startTown, inn: 1, shop: 1, shrine: 1, q: start.q, r: start.r },
    recentEvents: [],
    combatStreak: 0,
    hardSinceRest: false,
    directorMod: 0,
    winStreak: 0,
    turn: 1,
    moveBudget: 3,
    movesLeft: 3,
    leaderIdx: 0,
    turnsSincePrompt: 0,
  };
}

function ensureConnected(tiles: HexTile[], start: HexTile) {
  const key = (t: { q: number; r: number }) => hexKey(t.q, t.r);
  const map = new Map(tiles.map((t) => [key(t), t]));
  for (let pass = 0; pass < 4; pass++) {
    const seen = new Set<string>([key(start)]);
    const queue = [start];
    while (queue.length) {
      const t = queue.shift()!;
      for (const [q, r] of hexNeighbors(t.q, t.r)) {
        const n = map.get(hexKey(q, r));
        if (!n || seen.has(key(n)) || n.biome === 'water') continue;
        seen.add(key(n));
        queue.push(n);
      }
    }
    const unreached = tiles.filter((t) => t.poi && !seen.has(key(t)));
    if (!unreached.length) return;
    // Convert water neighbours of unreached POIs into coast
    for (const t of tiles) if (t.biome === 'water') t.biome = 'coast';
  }
}

export function tileAt(w: WorldState, q: number, r: number): HexTile | undefined {
  return w.tiles.find((t) => t.q === q && t.r === r);
}

/** Dijkstra over move costs from the party position. Returns cost and previous step per tile key. */
export function reachable(w: WorldState, budget: number): Map<string, { cost: number; prev?: string }> {
  const out = new Map<string, { cost: number; prev?: string }>();
  const startKey = hexKey(w.party.q, w.party.r);
  out.set(startKey, { cost: 0 });
  const frontier: { key: string; q: number; r: number; cost: number }[] = [{ key: startKey, q: w.party.q, r: w.party.r, cost: 0 }];
  while (frontier.length) {
    frontier.sort((a, b) => a.cost - b.cost);
    const cur = frontier.shift()!;
    for (const [q, r] of hexNeighbors(cur.q, cur.r)) {
      const t = tileAt(w, q, r);
      if (!t || t.biome === 'water') continue;
      const cost = cur.cost + MOVE_COST[t.biome] + (w.weather === 'snow' || w.weather === 'storm' ? 0.5 : 0);
      if (cost > budget) continue;
      const k = hexKey(q, r);
      const prev = out.get(k);
      if (prev && prev.cost <= cost) continue;
      out.set(k, { cost, prev: cur.key });
      // POIs stop movement: can't path through them
      if (!t.poi || t.poi.cleared) frontier.push({ key: k, q, r, cost });
    }
  }
  out.delete(startKey);
  return out;
}

export function pathTo(w: WorldState, q: number, r: number, budget: number): { q: number; r: number }[] | null {
  const reach = reachable(w, budget);
  let k: string | undefined = hexKey(q, r);
  if (!reach.has(k)) return null;
  const path: { q: number; r: number }[] = [];
  while (k && reach.has(k)) {
    const [a, b] = k.split(',').map(Number) as [number, number];
    path.unshift({ q: a, r: b });
    k = reach.get(k)!.prev;
  }
  return path;
}

export function revealAround(w: WorldState, q: number, r: number, radius: number): HexTile[] {
  const out: HexTile[] = [];
  for (const t of w.tiles)
    if (!t.revealed && hexDist(t, { q, r }) <= radius) {
      t.revealed = true;
      out.push(t);
    }
  return out;
}

export function poiAt(w: WorldState, q: number, r: number): Poi | undefined {
  return tileAt(w, q, r)?.poi;
}
