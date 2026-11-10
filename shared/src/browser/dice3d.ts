import { diceColours, diceFont, hexRgb, mixHex, type DiceMaterial, type DiceStyle } from '../dicestyle.js';
/**
 * Lightweight 3D dice on a 2D canvas: convex polyhedra, back-face culling,
 * flat shading, numbers mapped onto faces with an affine transform.
 * Dice tumble freely, then settle so the rolled face points at the viewer.
 */
type V3 = [number, number, number];
type Q = [number, number, number, number]; // w, x, y, z

const PHI = (1 + Math.sqrt(5)) / 2;

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

function qmul(a: Q, b: Q): Q {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
function qaxis(axis: V3, ang: number): Q {
  const n = norm(axis);
  const s = Math.sin(ang / 2);
  return [Math.cos(ang / 2), n[0] * s, n[1] * s, n[2] * s];
}
function qrot(q: Q, v: V3): V3 {
  const [w, x, y, z] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}
function qnorm(q: Q): Q {
  const l = Math.hypot(...q) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
function qslerp(a: Q, b: Q, t: number): Q {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) {
    d = -d;
    bb = [-b[0], -b[1], -b[2], -b[3]];
  }
  if (d > 0.9995) return qnorm([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);
  const th = Math.acos(d);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
}
/** Quaternion rotating unit vector a onto unit vector b. */
function qfromTo(a: V3, b: V3): Q {
  const d = dot(a, b);
  if (d < -0.99999) {
    const ax = Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]);
    return qaxis(ax, Math.PI);
  }
  const c = cross(a, b);
  return qnorm([1 + d, c[0], c[1], c[2]]);
}

interface Face {
  idx: number[];
  normal: V3;
  center: V3;
  up: V3; // in-plane up direction for the label
}
interface Shape {
  verts: V3[];
  faces: Face[];
}

function facesByNormals(verts: V3[], normals: V3[], k: number): Face[] {
  return normals.map((n0) => {
    const n = norm(n0);
    const ranked = verts.map((v, i) => ({ i, d: dot(v, n) })).sort((a, b) => b.d - a.d).slice(0, k);
    const center = mul(ranked.reduce<V3>((s, r) => add(s, verts[r.i]!), [0, 0, 0]), 1 / k);
    const ref = norm(sub(verts[ranked[0]!.i]!, center));
    const other = cross(n, ref);
    const idx = ranked
      .map((r) => {
        const d = sub(verts[r.i]!, center);
        return { i: r.i, a: Math.atan2(dot(d, other), dot(d, ref)) };
      })
      .sort((a, b) => a.a - b.a)
      .map((r) => r.i);
    return { idx, normal: n, center, up: ref };
  });
}

/** Scale a shape so its circumradius is r (keeps every die the same visual size). */
function normalize(sh: Shape, r: number): Shape {
  const R = Math.max(...sh.verts.map((v) => Math.hypot(v[0], v[1], v[2])));
  const k = r / R;
  return { verts: sh.verts.map((v) => mul(v, k)), faces: sh.faces.map((f) => ({ ...f, center: mul(f.center, k) })) };
}

/**
 * Re-order faces so index i shows value i+1 and opposite faces add up to n+1,
 * like real dice. Shapes without opposite faces (d4) keep their order.
 */
function pairOpposites(faces: Face[]): Face[] {
  const n = faces.length;
  const out: (Face | undefined)[] = new Array(n);
  const used = new Set<number>();
  let lo = 0;
  for (let i = 0; i < n; i++) {
    if (used.has(i)) continue;
    let j = -1;
    for (let k = 0; k < n; k++) if (k !== i && !used.has(k) && dot(faces[i]!.normal, faces[k]!.normal) < -0.999) j = k;
    if (j < 0) return faces;
    used.add(i).add(j);
    out[lo] = faces[i];
    out[n - 1 - lo] = faces[j];
    lo++;
  }
  return out as Face[];
}

function buildShapes(): Record<string, Shape> {
  const s: Record<string, Shape> = {};
  // d4 (tetrahedra read small, so give it a slightly larger radius)
  {
    const v: V3[] = [
      [1, 1, 1],
      [1, -1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
    ];
    s[4] = normalize({ verts: v, faces: facesByNormals(v, v.map((x) => mul(x, -1)), 3) }, 1.12);
  }
  // d6
  {
    const verts: V3[] = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) verts.push([x, y, z]);
    const normals: V3[] = [[0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0]];
    // label "up" points at an edge midpoint, not a corner, so a settled cube reads square-on
    const faces = facesByNormals(verts, normals, 4).map((f) => ({ ...f, up: norm(sub(mul(add(verts[f.idx[0]!]!, verts[f.idx[1]!]!), 0.5), f.center)) }));
    s[6] = normalize({ verts, faces: pairOpposites(faces) }, 0.98);
  }
  // d8
  {
    const verts: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const normals: V3[] = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) normals.push([x, y, z]);
    s[8] = normalize({ verts, faces: pairOpposites(facesByNormals(verts, normals, 3)) }, 1);
  }
  // d10 (pentagonal trapezohedron); ring height chosen so every kite is planar
  {
    const h = 1;
    const c36 = Math.cos(Math.PI / 5);
    const z0 = (h * (1 - c36)) / (1 + c36);
    const verts: V3[] = [[0, 0, h], [0, 0, -h]];
    for (let k = 0; k < 10; k++) {
      const a = (k * Math.PI) / 5;
      verts.push([Math.cos(a) * 0.9, Math.sin(a) * 0.9, k % 2 === 0 ? z0 : -z0]);
    }
    const R = (k: number) => 2 + (((k % 10) + 10) % 10);
    const faces: Face[] = [];
    for (let i = 0; i < 5; i++) {
      const up = [0, R(2 * i), R(2 * i + 1), R(2 * i + 2)];
      const lo = [1, R(2 * i + 3), R(2 * i + 2), R(2 * i + 1)];
      for (const idx of [up, lo]) {
        const pts = idx.map((j) => verts[j]!);
        const center = mul(pts.reduce<V3>((a, p) => add(a, p), [0, 0, 0]), 1 / 4);
        let n = norm(cross(sub(pts[1]!, pts[0]!), sub(pts[2]!, pts[0]!)));
        if (dot(n, center) < 0) n = mul(n, -1);
        faces.push({ idx, normal: n, center, up: norm(sub(pts[0]!, center)) });
      }
    }
    s[10] = normalize({ verts, faces: pairOpposites(faces) }, 1);
  }
  // d12: vertices are the cube corners plus cyclic (0, ±1/φ, ±φ); face normals are cyclic (0, ±φ, ±1)
  {
    const verts: V3[] = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) verts.push([x, y, z]);
    for (const a of [-1, 1])
      for (const b of [-1, 1]) {
        verts.push([0, a / PHI, b * PHI]);
        verts.push([a / PHI, b * PHI, 0]);
        verts.push([b * PHI, 0, a / PHI]);
      }
    const normals: V3[] = [];
    for (const a of [-1, 1]) for (const b of [-1, 1]) normals.push([0, a * PHI, b], [a * PHI, b, 0], [b, 0, a * PHI]);
    s[12] = normalize({ verts, faces: pairOpposites(facesByNormals(verts, normals, 5)) }, 1);
  }
  // d20: vertices are cyclic (0, ±1, ±φ); face normals are the cube corners plus cyclic (0, ±φ, ±1/φ)
  {
    const verts: V3[] = [];
    for (const a of [-1, 1]) for (const b of [-1, 1]) verts.push([0, a, b * PHI], [a, b * PHI, 0], [b * PHI, 0, a]);
    const normals: V3[] = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) normals.push([x, y, z]);
    for (const a of [-1, 1])
      for (const b of [-1, 1]) {
        normals.push([0, a * PHI, b / PHI]);
        normals.push([a * PHI, b / PHI, 0]);
        normals.push([b / PHI, 0, a * PHI]);
      }
    s[20] = normalize({ verts, faces: pairOpposites(facesByNormals(verts, normals, 3)) }, 1);
  }
  return s;
}

const SHAPES = buildShapes();

/** Camera distance (in die radii) for the perspective projection. */
const CAM = 5;
/** Max projected radius of a die (circumradius ≤ 1.12 under perspective). */
const DIE_EXTENT = (1.12 * CAM) / (CAM - 1.12);
/** Radius of the crit/kept highlight ring. */
const RING = DIE_EXTENT + 0.12;
/** Half-size of a die's layout cell, in die sizes: ring + stroke + a bounce/shadow margin. */
const CELL_EXTENT = RING + 0.2;

export type DieKind = 4 | 6 | 8 | 10 | 12 | 20 | 100 | 1000; // 1000 = percentile tens die

function labelFor(kind: DieKind, faceIdx: number): string {
  if (kind === 1000) return faceIdx === 0 ? '00' : `${faceIdx * 10}`;
  if (kind === 100 || kind === 10) return faceIdx === 9 ? '0' : `${faceIdx + 1}`;
  return `${faceIdx + 1}`;
}
/** Which face index shows value v. */
function faceForValue(kind: DieKind, v: number): number {
  if (kind === 1000) return Math.floor((v % 100) / 10);
  if (kind === 100) return (v % 10 === 0 ? 10 : v % 10) - 1;
  return Math.max(0, v - 1);
}

interface DieAnim {
  kind: DieKind;
  shape: Shape;
  q: Q;
  axis: V3;
  spin: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  targetX: number;
  targetY: number;
  value?: number;
  settleFrom?: Q;
  settleTo?: Q;
  settleStart?: number;
  done: boolean;
  color: string;
  highlight?: 'crit' | 'fumble' | 'kept' | 'dropped';
}

export interface TrayOptions {
  color?: string;
  ink?: string;
  size?: number;
}

export class DiceTray {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dice: DieAnim[] = [];
  private raf = 0;
  private t0 = 0;
  private lastT = 0;
  private size = 40;
  private settleResolve?: () => void;
  ink = '#2b1d0e';
  reduceMotion = false;

  constructor(canvas: HTMLCanvasElement, private opts: TrayOptions = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    if (opts.ink) this.ink = opts.ink;
  }

  private fit() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(10, Math.round(r.width * dpr));
    const hh = Math.max(10, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== hh) {
      this.canvas.width = w;
      this.canvas.height = hh;
    }
  }

  /** Start tumbling the given dice (d100 shows as tens + units). */
  throw(faces: number[], opts: { color?: string; intensity?: number } = {}) {
    this.fit();
    const expanded: DieKind[] = [];
    for (const f of faces) {
      if (f === 100) expanded.push(1000, 100);
      else expanded.push(f as DieKind);
    }
    const W = this.canvas.width;
    const H = this.canvas.height;
    const n = expanded.length;
    const { size, cols, rows } = this.layout(n);
    this.size = size;
    const intensity = Math.max(0.4, Math.min(2, opts.intensity ?? 1));
    const cellW = W / cols;
    const cellH = H / rows;
    this.dice = expanded.map((kind, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      // centre a partially filled last row
      const inRow = row === rows - 1 ? n - row * cols : cols;
      const targetX = W / 2 + (col - (inRow - 1) / 2) * cellW;
      const targetY = cellH * (row + 0.5) - size * 0.1;
      return {
        kind,
        shape: SHAPES[kind === 1000 || kind === 100 ? 10 : kind]!,
        q: qnorm([Math.random(), Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]),
        axis: norm([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]),
        spin: (10 + Math.random() * 8) * intensity,
        x: targetX + (Math.random() - 0.5) * cellW * 0.4,
        y: -size * DIE_EXTENT - Math.random() * size,
        vx: (Math.random() - 0.5) * cellW * 0.8,
        vy: 200 + Math.random() * 200,
        targetX,
        targetY,
        done: false,
        color: opts.color ?? this.opts.color ?? '#f4ead2',
      };
    });
    this.t0 = performance.now();
    this.lastT = 0;
    cancelAnimationFrame(this.raf);
    const loop = (t: number) => {
      this.step(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /**
   * Pick a grid and die size so every die (including its highlight ring and
   * bounce) stays inside its own cell: no clipping at the canvas edge and no
   * dice drawn over each other once they land.
   */
  private layout(n: number) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const base = this.opts.size ?? Math.min(W, H) * 0.3;
    let best = { size: 0, cols: 1, rows: 1 };
    for (let cols = 1; cols <= Math.max(1, n); cols++) {
      const rows = Math.ceil(n / cols);
      const size = Math.min(base, W / cols / (2 * CELL_EXTENT), H / rows / (2 * CELL_EXTENT));
      if (size > best.size) best = { size, cols, rows };
    }
    best.size = Math.max(10, best.size);
    return best;
  }

  /** Settle on server values. Returns a promise resolving when the dice land. */
  settle(values: number[], highlights: (DieAnim['highlight'] | undefined)[] = []): Promise<void> {
    const vals: number[] = [];
    const hl: (DieAnim['highlight'] | undefined)[] = [];
    let vi = 0;
    for (const d of this.dice) {
      if (d.kind === 1000) {
        vals.push(values[vi] ?? 1);
        hl.push(highlights[vi]);
      } else if (d.kind === 100) {
        vals.push(values[vi] ?? 1);
        hl.push(highlights[vi]);
        vi++;
      } else {
        vals.push(values[vi] ?? 1);
        hl.push(highlights[vi]);
        vi++;
      }
    }
    const now = performance.now();
    const minTumble = this.reduceMotion ? 0 : 650;
    const startAt = Math.max(now, this.t0 + minTumble);
    this.dice.forEach((d, i) => {
      d.value = vals[i];
      d.highlight = hl[i];
      const face = d.shape.faces[faceForValue(d.kind, vals[i]!) % d.shape.faces.length]!;
      // rotate face normal to +z (toward viewer), then align label up with screen up (-y)
      const q1 = qfromTo(face.normal, [0, 0, 1]);
      const up1 = qrot(q1, face.up);
      const ang = Math.atan2(up1[0], -up1[1]);
      const q2 = qaxis([0, 0, 1], -ang);
      // rest square-on: the rolled face looks straight at the screen
      d.settleTo = qmul(q2, q1);
      d.settleStart = startAt;
    });
    return new Promise((res) => {
      this.settleResolve = res;
    });
  }

  /** Throw and immediately settle (used to mirror a result). */
  async show(faces: number[], values: number[], opts: { color?: string; highlights?: (DieAnim['highlight'] | undefined)[] } = {}) {
    this.throw(faces, opts);
    await this.settle(values, opts.highlights);
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  private step(t: number) {
    this.fit();
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    // real frame time (clamped) so dice move at the same speed on 60/120 Hz screens
    const dt = this.lastT ? Math.min(1 / 30, Math.max(1 / 240, (t - this.lastT) / 1000)) : 1 / 60;
    this.lastT = t;
    const f60 = dt * 60;
    let allDone = this.dice.length > 0;
    const size = this.size;
    for (const d of this.dice) {
      if (d.settleTo && d.settleStart !== undefined && t >= d.settleStart) {
        const dur = this.reduceMotion ? 120 : 520;
        if (!d.settleFrom) d.settleFrom = d.q;
        const k = Math.min(1, (t - d.settleStart) / dur);
        const e = 1 - (1 - k) ** 3;
        d.q = qslerp(d.settleFrom, d.settleTo, e);
        const pull = 1 - 0.8 ** f60;
        d.x += (d.targetX - d.x) * pull;
        d.y += (d.targetY - d.y) * pull;
        if (k >= 1) d.done = true;
      } else {
        // free tumble with bounces inside the tray
        d.q = qnorm(qmul(qaxis(d.axis, d.spin * dt), d.q));
        d.spin = Math.max(6, d.spin * 0.992 ** f60);
        d.vy += 1600 * dt;
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        const floor = d.targetY + size * 0.2;
        if (d.y > floor) {
          d.y = floor;
          d.vy = -Math.abs(d.vy) * 0.55;
          d.vx *= 0.8;
          d.axis = norm(add(d.axis, [Math.random() - 0.5, Math.random() - 0.5, 0]));
        }
        const m = size * DIE_EXTENT;
        if (d.x < m) (d.x = m), (d.vx = Math.abs(d.vx));
        if (d.x > W - m) (d.x = W - m), (d.vx = -Math.abs(d.vx));
        d.x += (d.targetX - d.x) * (1 - 0.98 ** f60);
      }
      if (!d.done) allDone = false;
    }
    // far-back rows first so nearer dice overlap them cleanly mid-tumble
    for (const d of [...this.dice].sort((a, b) => a.y - b.y)) this.drawDie(d, size);
    if (allDone && this.settleResolve) {
      const r = this.settleResolve;
      this.settleResolve = undefined;
      r();
    }
  }

  private drawDie(d: DieAnim, size: number) {
    drawDie(this.ctx, d, d.x, d.y, size, this.ink, { shadowX: d.x + size * 0.12, shadowY: d.targetY + size * 1.02, flatShadow: true });
  }
}

export interface DieLook {
  kind: DieKind;
  q: Q;
  color: string;
  done?: boolean;
  highlight?: 'crit' | 'fumble' | 'kept' | 'dropped';
  /** the hero's chosen dice; without one the die is drawn plain in `color` */
  style?: DiceStyle;
}

/** Draw one die centred at (x, y), `size` pixels per die radius. The shadow sits at (shadowX, shadowY):
 * under the die for a top-down table, or on the tray floor for the side-on tray. */
export function drawDie(ctx: CanvasRenderingContext2D, d: DieLook, x: number, y: number, size: number, ink: string, o: { shadowX?: number; shadowY?: number; flatShadow?: boolean; shadowAlpha?: number } = {}) {
  if (d.style) return drawStyledDie(ctx, d, x, y, size, d.style, o);
  const shape = SHAPES[d.kind === 1000 || d.kind === 100 ? 10 : d.kind]!;
  const light = norm([-0.3, -0.2, 1]);
  const proj = (v: V3): [number, number] => {
    const persp = CAM / (CAM - v[2]);
    return [x + v[0] * size * persp, y + v[1] * size * persp];
  };
  const rv = shape.verts.map((v) => qrot(d.q, v));
  // Perspective back-face test: a face is visible when it faces the camera
  // point, not merely +z (that test dropped faces near the silhouette).
  const faces = shape.faces
    .map((f, fi) => ({ f, fi, n: qrot(d.q, f.normal), c: qrot(d.q, f.center), u: qrot(d.q, f.up) }))
    .filter((v) => dot(v.n, sub([0, 0, CAM], v.c)) > 1e-4)
    .sort((a, b) => a.c[2] - b.c[2]);
  // shadow
  ctx.save();
  ctx.globalAlpha = o.shadowAlpha ?? 0.18;
  ctx.fillStyle = ink;
  ctx.beginPath();
  if (o.flatShadow) ctx.ellipse(o.shadowX ?? x, o.shadowY ?? y, size * 0.8, size * 0.18, 0, 0, Math.PI * 2);
  else ctx.arc(o.shadowX ?? x, o.shadowY ?? y, size * 0.95, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  for (const { f, fi, n, c, u } of faces) {
    const shade = 0.55 + 0.45 * Math.max(0, dot(n, light));
    ctx.beginPath();
    f.idx.forEach((vi, k) => {
      const [px, py] = proj(rv[vi]!);
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.fillStyle = shadeColor(d.color, shade);
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.5, size * 0.045);
    ctx.strokeStyle = ink;
    ctx.stroke();
    if (n[2] > 0.3) {
      const label = labelFor(d.kind, fi);
      const w = cross(n, u);
      const s = 0.32 * (shape.faces.length > 12 ? 0.75 : shape.faces.length >= 10 ? 0.85 : 1);
      const p0 = proj(c);
      const pu = proj(add(c, mul(u, s)));
      const pw = proj(add(c, mul(w, s)));
      ctx.save();
      ctx.transform(pw[0] - p0[0], pw[1] - p0[1], -(pu[0] - p0[0]), -(pu[1] - p0[1]), p0[0], p0[1]);
      ctx.fillStyle = ink;
      ctx.globalAlpha = Math.min(1, (n[2] - 0.3) * 3);
      ctx.font = `bold ${label.length > 1 ? 0.75 : 1}px Georgia, serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 0, 0.05);
      if (label === '6' || label === '9') ctx.fillRect(-0.25, 0.42, 0.5, 0.06);
      ctx.restore();
    }
  }
  if (d.done && d.highlight) {
    ctx.save();
    ctx.lineWidth = size * 0.08;
    ctx.strokeStyle = d.highlight === 'crit' ? '#d4a017' : d.highlight === 'fumble' ? '#a93226' : d.highlight === 'dropped' ? 'rgba(80,60,40,0.35)' : '#2e7d32';
    ctx.beginPath();
    ctx.arc(x, y, size * RING, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/** The orientation that shows value v to the camera, label upright. */
export function restingQuat(kind: DieKind, v: number): Q {
  const shape = SHAPES[kind === 1000 || kind === 100 ? 10 : kind]!;
  const face = shape.faces[faceForValue(kind, v) % shape.faces.length]!;
  const q1 = qfromTo(face.normal, [0, 0, 1]);
  const up1 = qrot(q1, face.up);
  const ang = Math.atan2(up1[0], -up1[1]);
  return qmul(qaxis([0, 0, 1], -ang), q1);
}

/** The die's own-frame normal of the face showing value v. */
export function faceNormalFor(kind: DieKind, v: number): V3 {
  const shape = SHAPES[kind === 1000 || kind === 100 ? 10 : kind]!;
  return shape.faces[faceForValue(kind, v) % shape.faces.length]!.normal;
}

/** d100 is drawn as a tens die and a units die. */
export function expandFaces(faces: number[]): DieKind[] {
  const out: DieKind[] = [];
  for (const f of faces) {
    if (f === 100) out.push(1000, 100);
    else out.push(f as DieKind);
  }
  return out;
}

/** Values per drawn die, matching expandFaces (both halves of a d100 carry the d100's value). */
export function expandValues(faces: number[], values: number[]): number[] {
  const out: number[] = [];
  faces.forEach((f, i) => {
    out.push(values[i] ?? 1);
    if (f === 100) out.push(values[i] ?? 1);
  });
  return out;
}

export { qaxis, qfromTo, qmul, qnorm, qslerp, qrot, DIE_EXTENT };
export type { Q, V3 };

function shadeColor(hex: string, f: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const c = [1, 2, 3].map((i) => Math.max(0, Math.min(255, Math.round(parseInt(m[i]!, 16) * f))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function dieName(f: number) {
  return f === 100 ? 'd%' : `d${f}`;
}

// ------------------------------------------------------------------ styled dice (a hero's own set)

const rnd = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
function noise2(seed: number) {
  const r = rnd(seed);
  const N = 64;
  const g = Array.from({ length: N * N }, () => r());
  const at = (x: number, y: number) => g[(((y % N) + N) % N) * N + (((x % N) + N) % N)]!;
  const sm = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = sm(x - xi);
    const yf = sm(y - yi);
    const a = at(xi, yi);
    const b = at(xi + 1, yi);
    const c = at(xi, yi + 1);
    const d = at(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
}
const fbm = (n: (x: number, y: number) => number, x: number, y: number) => n(x, y) * 0.5 + n(x * 2, y * 2) * 0.25 + n(x * 4, y * 4) * 0.125 + n(x * 8, y * 8) * 0.0625;

/** Galaxy and metal are one big picture laid over each whole face (no repeats, so no seams);
 * glitter is fine enough to tile. */
const TEX: Partial<Record<DiceMaterial, { size: number; span: number; tile: boolean }>> = {
  galaxy: { size: 512, span: 2.6, tile: false },
  metal: { size: 512, span: 2.6, tile: false },
  glitter: { size: 256, span: 1.4, tile: true },
};
const texCache = new Map<string, HTMLCanvasElement>();
function texture(m: DiceMaterial, a: string, b: string): HTMLCanvasElement | null {
  const spec = TEX[m];
  if (!spec || typeof document === 'undefined') return null;
  const key = `${m}|${a}|${b}`;
  const hit = texCache.get(key);
  if (hit) return hit;
  const S = spec.size;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const c = cv.getContext('2d')!;
  const img = c.createImageData(S, S);
  const A = hexRgb(a);
  const B = hexRgb(b);
  const n = noise2(m.length * 97 + 7);
  const n2 = noise2(1234);
  const r = rnd(42);
  const put = (i: number, t: number, extra = 0) => {
    for (let k = 0; k < 3; k++) img.data[i * 4 + k] = Math.max(0, Math.min(255, A[k]! + (B[k]! - A[k]!) * t + extra));
    img.data[i * 4 + 3] = 255;
  };
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const u = (x / S) * 4;
      const v = (y / S) * 4;
      if (m === 'galaxy') {
        const cloud = Math.max(0, fbm(n, u * 0.9 + 3, v * 0.9) - 0.38) * 2.2;
        const wisp = Math.max(0, fbm(n2, u * 1.8, v * 1.8 + 5) - 0.5) * 2.5;
        const dust = Math.max(0, 0.55 - fbm(n2, u * 2.4 + 9, v * 2.4)) * 0.9;
        const core = Math.max(0, 1 - Math.hypot(x / S - 0.55, y / S - 0.45) * 2.2) * 0.35;
        put(i, Math.min(1, Math.max(0, cloud + wisp * 0.6 + core - dust)), wisp * 40);
      } else if (m === 'metal') put(i, 0.15 + (n(u * 0.15, v * 40) * 0.5 + n(u * 0.4, v * 90) * 0.3) * 0.45);
      else {
        const f = r();
        put(i, f > 0.93 ? 1 : f > 0.86 ? 0.55 : 0.04, f > 0.985 ? 90 : 0);
      }
    }
  c.putImageData(img, 0, 0);
  if (m === 'galaxy') {
    for (let k = 0; k < 420; k++) {
      const sx = r() * S;
      const sy = r() * S;
      if (r() > 0.94) {
        const g = c.createRadialGradient(sx, sy, 0, sx, sy, 6);
        g.addColorStop(0, 'rgba(255,255,255,0.95)');
        g.addColorStop(0.3, `rgba(${B.join(',')},0.5)`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g;
        c.fillRect(sx - 6, sy - 6, 12, 12);
      } else {
        c.fillStyle = `rgba(255,255,255,${0.35 + r() * 0.65})`;
        const d = r() > 0.7 ? 1.6 : 1;
        c.fillRect(sx, sy, d, d);
      }
    }
  }
  texCache.set(key, cv);
  return cv;
}

/** Canvas text never asks for a web font by itself: load each face the first time it is used. */
const fontsAsked = new Set<string>();
function wantFont(spec: string) {
  if (typeof document === 'undefined' || !document.fonts || fontsAsked.has(spec)) return;
  fontsAsked.add(spec);
  void document.fonts.load(spec, '0123456789');
}

const LIGHT = norm([-0.3, -0.2, 1]);
const HALF = norm([-0.15, -0.35, 1.6]);
const rgba = (hex: string, a: number) => `rgba(${hexRgb(hex).join(',')},${a})`;

function drawStyledDie(ctx: CanvasRenderingContext2D, d: DieLook, x: number, y: number, size: number, st: DiceStyle, o: { shadowX?: number; shadowY?: number; flatShadow?: boolean; shadowAlpha?: number }) {
  const kind = d.kind === 1000 || d.kind === 100 ? 10 : d.kind;
  const shape = SHAPES[kind]!;
  const col = diceColours(st);
  const font = diceFont(st);
  const glass = st.material === 'glass';
  const proj = (v: V3): [number, number] => {
    const p = CAM / (CAM - v[2]);
    return [x + v[0] * size * p, y + v[1] * size * p];
  };
  const rv = shape.verts.map((v) => qrot(d.q, v));
  // glass shows the far side through the near one, so it draws every face, back to front
  const faces = shape.faces
    .map((f, fi) => {
      const n = qrot(d.q, f.normal);
      const c = qrot(d.q, f.center);
      return { f, fi, n, c, u: qrot(d.q, f.up), front: dot(n, sub([0, 0, CAM], c)) > 1e-4 };
    })
    .filter((v) => glass || v.front)
    .sort((a, b) => Number(a.front) - Number(b.front) || a.c[2] - b.c[2]);

  // shadow; glass casts a tinted one with a bright caustic in it
  ctx.save();
  const sa = o.shadowAlpha ?? 0.22;
  ctx.fillStyle = glass ? rgba(col.body, sa * 1.6) : `rgba(0,0,0,${sa * 1.4})`;
  ctx.beginPath();
  if (o.flatShadow) ctx.ellipse(o.shadowX ?? x, o.shadowY ?? y, size * 0.8, size * 0.18, 0, 0, Math.PI * 2);
  else ctx.arc(o.shadowX ?? x, o.shadowY ?? y, size * 0.95, 0, Math.PI * 2);
  ctx.fill();
  if (glass) {
    // light focused through the glass: a small bright smear inside the shadow
    ctx.fillStyle = rgba(mixHex(col.accent, '#ffffff', 0.3), sa * 1.2);
    ctx.beginPath();
    if (o.flatShadow) ctx.ellipse(o.shadowX ?? x, o.shadowY ?? y, size * 0.3, size * 0.06, 0, 0, Math.PI * 2);
    else ctx.ellipse(o.shadowX ?? x, o.shadowY ?? y, size * 0.32, size * 0.22, -0.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  const tex = texture(st.material, col.body, col.accent);
  const tspec = TEX[st.material];
  const weight = st.bold && font.bold ? 700 : 400;
  for (const { f, fi, n, c, u, front } of faces) {
    const w = cross(n, u);
    const p0 = proj(c);
    const pu = proj(add(c, u));
    const pw = proj(add(c, w));
    // face space -> screen: (1,0) = w, (0,1) = -u
    const M = new DOMMatrix([pw[0] - p0[0], pw[1] - p0[1], -(pu[0] - p0[0]), -(pu[1] - p0[1]), p0[0], p0[1]]);
    const path = new Path2D();
    f.idx.forEach((vi, k) => {
      const [px, py] = proj(rv[vi]!);
      if (k === 0) path.moveTo(px, py);
      else path.lineTo(px, py);
    });
    path.closePath();
    const diffuse = Math.max(0, dot(n, LIGHT));
    const spec = Math.pow(Math.max(0, dot(n, HALF)), st.material === 'metal' ? 18 : glass ? 26 : 60);

    ctx.save();
    ctx.clip(path);
    if (glass) {
      if (!front) {
        ctx.fillStyle = rgba(col.body, 0.3);
        ctx.fill(path);
      } else {
        const g = ctx.createLinearGradient(M.e - M.c * 0.9, M.f - M.d * 0.9, M.e + M.c * 0.9, M.f + M.d * 0.9);
        g.addColorStop(0, rgba(mixHex(col.body, '#ffffff', 0.35), 0.42));
        g.addColorStop(1, rgba(col.body, 0.28));
        ctx.fillStyle = g;
        ctx.fill(path);
        ctx.fillStyle = `rgba(255,255,255,${0.05 + spec * 0.85})`;
        ctx.fill(path);
        ctx.lineWidth = Math.max(2, size * 0.07);
        ctx.strokeStyle = rgba(mixHex(col.accent, '#ffffff', 0.5), 0.22 + diffuse * 0.25);
        ctx.stroke(path);
      }
    } else {
      if (tex && tspec) {
        const pat = ctx.createPattern(tex, 'repeat')!;
        const k = tspec.span / tspec.size;
        const spread = tspec.tile ? tspec.size : 0.3 * tspec.size;
        const jx = (((fi * 37) % 17) / 16 - 0.5) * spread;
        const jy = (((fi * 53) % 13) / 12 - 0.5) * spread;
        pat.setTransform(M.scale(k, k).translate(-tspec.size / 2 + jx, -tspec.size / 2 + jy));
        ctx.fillStyle = pat;
      } else if (st.material === 'resin') {
        const g = ctx.createLinearGradient(M.e - M.c * 0.9, M.f - M.d * 0.9, M.e + M.c * 0.9, M.f + M.d * 0.9);
        g.addColorStop(0, col.body);
        g.addColorStop(0.55, mixHex(col.body, col.accent, 0.5));
        g.addColorStop(1, col.accent);
        ctx.fillStyle = g;
      } else ctx.fillStyle = col.body;
      ctx.fill(path);
      ctx.fillStyle = `rgba(0,0,0,${(1 - (0.5 + 0.5 * diffuse)) * (st.material === 'metal' ? 1.1 : 0.85)})`;
      ctx.fill(path);
      if (st.material !== 'solid' && st.material !== 'glitter') {
        ctx.fillStyle = `rgba(255,255,255,${spec * (st.material === 'metal' ? 0.75 : 0.5)})`;
        ctx.fill(path);
      }
    }
    ctx.restore();
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(glass ? 1 : 1.5, size * (glass ? 0.03 : 0.045));
    ctx.strokeStyle = glass ? rgba(col.edge, front ? 0.75 : 0.3) : col.edge;
    ctx.stroke(path);

    // number (glass also shows the far side's, faint and mirrored)
    const vis = front ? Math.min(1, (n[2] - 0.3) * 3) : glass && n[2] < -0.3 ? 0.16 : 0;
    if (vis > 0 && (!front || n[2] > 0.3)) {
      const label = labelFor(d.kind, fi);
      const s = 0.32 * (shape.faces.length > 12 ? 0.75 : shape.faces.length >= 10 ? 0.85 : 1);
      const fs = (label.length > 1 ? 0.75 : 1) * font.scale * st.size;
      wantFont(`${weight} 20px "${font.css}"`);
      ctx.save();
      ctx.transform(M.a * s, M.b * s, M.c * s, M.d * s, M.e, M.f);
      ctx.globalAlpha *= vis;
      ctx.font = `${weight} ${fs}px "${font.css}", Georgia, serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (col.glow && front) {
        ctx.shadowColor = col.ink;
        ctx.shadowBlur = size * 0.35;
      }
      ctx.fillStyle = col.ink;
      ctx.fillText(label, 0, 0.05);
      if (col.glow && front) ctx.fillText(label, 0, 0.05);
      ctx.shadowBlur = 0;
      if (label === '6' || label === '9') ctx.fillRect(-0.25, 0.42, 0.5, 0.06);
      ctx.restore();
    }
  }
  if (d.done && d.highlight) {
    ctx.save();
    ctx.lineWidth = size * 0.08;
    ctx.strokeStyle = d.highlight === 'crit' ? '#d4a017' : d.highlight === 'fumble' ? '#a93226' : d.highlight === 'dropped' ? 'rgba(80,60,40,0.35)' : '#2e7d32';
    if (d.highlight === 'crit') {
      ctx.shadowColor = '#ffd36a';
      ctx.shadowBlur = size * 0.5;
    }
    ctx.beginPath();
    ctx.arc(x, y, size * RING, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}
