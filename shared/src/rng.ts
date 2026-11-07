/**
 * Seeded PRNG (mulberry32). The whole state is a single uint32, so it can be
 * stored inside save files and restored exactly — runs are reproducible.
 */
export function hashString(str: string): number {
  // FNV-1a 32-bit, then avalanche
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

export interface Weighted<T> {
  item: T;
  weight: number;
}

export class Rng {
  state: number;
  constructor(seed: number | string) {
    this.state = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
  }
  /** Derive an independent stream (e.g. world gen vs. combat) from a seed and a label. */
  static derive(seed: string | number, label: string): Rng {
    return new Rng(hashString(`${seed}::${label}`));
  }
  /** Float in [0, 1). */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max < min) [min, max] = [max, min];
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('Rng.pick on empty array');
    return arr[Math.floor(this.next() * arr.length)]!;
  }
  weighted<T>(items: readonly Weighted<T>[]): T {
    const total = items.reduce((s, w) => s + Math.max(0, w.weight), 0);
    if (total <= 0) return this.pick(items).item;
    let r = this.next() * total;
    for (const w of items) {
      r -= Math.max(0, w.weight);
      if (r < 0) return w.item;
    }
    return items[items.length - 1]!.item;
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
  }
  /** Roll one die with `sides` faces. d100 returns 1..100. */
  die(sides: number): number {
    return this.int(1, sides);
  }
}

const ADJ = ['BRAVE', 'MERRY', 'GRIM', 'SLY', 'BOLD', 'WILD', 'ODD', 'GOLDEN', 'MISTY', 'IRON', 'LUCKY', 'SILENT', 'ROYAL', 'TINY', 'ELDER', 'RUSTY'];
const NOUN = ['OTTER', 'DRAKE', 'GOBLIN', 'BARD', 'OWL', 'TOAD', 'KNIGHT', 'WYRM', 'BADGER', 'MOTH', 'CROWN', 'LANTERN', 'FERRET', 'GRIFFIN', 'MUSHROOM', 'COMET'];
export function randomSeedName(): string {
  const r = new Rng((Math.random() * 2 ** 32) >>> 0);
  return `${r.pick(ADJ)}-${r.pick(NOUN)}-${r.int(10, 99)}`;
}
