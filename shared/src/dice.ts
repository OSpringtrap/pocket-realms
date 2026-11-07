import type { Rng } from './rng.js';

export const DIE_SIDES = [4, 6, 8, 10, 12, 20, 100] as const;
export type DieSides = (typeof DIE_SIDES)[number];

export function isDieSides(n: number): n is DieSides {
  return (DIE_SIDES as readonly number[]).includes(n);
}

/** A parsed dice expression such as "2d6+3". */
export interface DiceExpr {
  count: number;
  sides: DieSides;
  bonus: number;
}

const RE = /^\s*(\d*)\s*d\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/i;

export function parseDice(expr: string): DiceExpr {
  const flat = /^\s*([+-]?\d+)\s*$/.exec(expr);
  if (flat) return { count: 0, sides: 6, bonus: parseInt(flat[1]!, 10) };
  const m = RE.exec(expr);
  if (!m) throw new Error(`Bad dice expression: "${expr}"`);
  const count = m[1] ? parseInt(m[1], 10) : 1;
  const sides = parseInt(m[2]!, 10);
  if (!isDieSides(sides)) throw new Error(`Unsupported die d${sides} in "${expr}"`);
  const bonus = m[3] ? (m[3] === '-' ? -1 : 1) * parseInt(m[4]!, 10) : 0;
  return { count, sides, bonus };
}

export function isValidDice(expr: string): boolean {
  try {
    parseDice(expr);
    return true;
  } catch {
    return false;
  }
}

export function formatDice(d: DiceExpr): string {
  const base = d.count > 0 ? `${d.count}d${d.sides}` : '';
  if (!d.bonus) return base || '0';
  return `${base}${d.bonus > 0 && base ? '+' : ''}${d.bonus}`;
}

export function rollDice(rng: Rng, expr: string | DiceExpr): { values: number[]; total: number; expr: DiceExpr } {
  const d = typeof expr === 'string' ? parseDice(expr) : expr;
  const values: number[] = [];
  for (let i = 0; i < d.count; i++) values.push(rng.die(d.sides));
  return { values, total: values.reduce((a, b) => a + b, 0) + d.bonus, expr: d };
}

export function averageDice(expr: string | DiceExpr): number {
  const d = typeof expr === 'string' ? parseDice(expr) : expr;
  return d.count * ((d.sides + 1) / 2) + d.bonus;
}

export function maxDice(expr: string | DiceExpr): number {
  const d = typeof expr === 'string' ? parseDice(expr) : expr;
  return d.count * d.sides + d.bonus;
}

/** Validate a physically-rolled value set against a die list. */
export function validPhysical(sides: number[], values: unknown): values is number[] {
  if (!Array.isArray(values) || values.length !== sides.length) return false;
  return values.every((v, i) => Number.isInteger(v) && v >= 1 && v <= sides[i]!);
}

/** Combine dice expressions with the same die type: "1d6"+"2d6" -> "3d6". Mixed types are kept as a list. */
export function addDice(exprs: (string | DiceExpr)[]): DiceExpr[] {
  const map = new Map<number, DiceExpr>();
  let bonus = 0;
  for (const e of exprs) {
    const d = typeof e === 'string' ? parseDice(e) : e;
    bonus += d.bonus;
    if (d.count === 0) continue;
    const cur = map.get(d.sides);
    if (cur) cur.count += d.count;
    else map.set(d.sides, { count: d.count, sides: d.sides, bonus: 0 });
  }
  const list = [...map.values()].sort((a, b) => b.sides - a.sides);
  if (list.length === 0) list.push({ count: 0, sides: 6, bonus });
  else list[0]!.bonus = bonus;
  return list;
}

/** Expand dice list into the individual die faces to show/roll: [{sides:6},{sides:6},{sides:8}] */
export function diceFaces(list: DiceExpr[]): DieSides[] {
  const out: DieSides[] = [];
  for (const d of list) for (let i = 0; i < d.count; i++) out.push(d.sides);
  return out;
}
