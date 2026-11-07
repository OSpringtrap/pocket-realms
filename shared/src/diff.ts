/**
 * Minimal structural JSON diff used for `state:patch` messages.
 * Ops: set value at path ({p, v}), delete key ({p, d:1}), truncate array ({p, n}).
 */
export type Path = (string | number)[];
export type PatchOp = { p: Path; v: unknown } | { p: Path; d: 1 } | { p: Path; n: number };

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function diff(a: unknown, b: unknown, path: Path = [], ops: PatchOp[] = []): PatchOp[] {
  if (a === b) return ops;
  if (Array.isArray(a) && Array.isArray(b)) {
    // Big structural changes: just replace
    if (Math.abs(a.length - b.length) > 8 && b.length > 0) {
      ops.push({ p: path, v: b });
      return ops;
    }
    const min = Math.min(a.length, b.length);
    for (let i = 0; i < min; i++) diff(a[i], b[i], [...path, i], ops);
    for (let i = min; i < b.length; i++) ops.push({ p: [...path, i], v: b[i] });
    if (a.length > b.length) ops.push({ p: path, n: b.length });
    return ops;
  }
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(b)) {
      if (b[k] === undefined) {
        if (k in a && a[k] !== undefined) ops.push({ p: [...path, k], d: 1 });
        continue;
      }
      if (!(k in a) || a[k] === undefined) ops.push({ p: [...path, k], v: b[k] });
      else diff(a[k], b[k], [...path, k], ops);
    }
    for (const k of Object.keys(a)) if (!(k in b) && a[k] !== undefined) ops.push({ p: [...path, k], d: 1 });
    return ops;
  }
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return ops;
  ops.push({ p: path, v: b });
  return ops;
}

export function applyPatch<T>(root: T, ops: PatchOp[]): T {
  let doc: unknown = root;
  for (const op of ops) {
    if (op.p.length === 0) {
      if ('v' in op) doc = clone(op.v);
      continue;
    }
    let cur = doc as Record<string | number, unknown>;
    for (let i = 0; i < op.p.length - 1; i++) {
      const k = op.p[i]!;
      if (cur[k] === undefined || cur[k] === null || typeof cur[k] !== 'object') {
        cur[k] = typeof op.p[i + 1] === 'number' ? [] : {};
      }
      cur = cur[k] as Record<string | number, unknown>;
    }
    const last = op.p[op.p.length - 1]!;
    if ('d' in op) delete cur[last];
    else if ('n' in op) (cur[last] as unknown[]).length = op.n;
    else cur[last] = clone(op.v);
  }
  return doc as T;
}

export function clone<T>(x: T): T {
  if (x === undefined) return x;
  return JSON.parse(JSON.stringify(x)) as T;
}

export type { Json };
