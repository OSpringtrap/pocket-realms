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

function buildShapes(): Record<string, Shape> {
  const s: Record<string, Shape> = {};
  // d4
  {
    const v: V3[] = [
      [1, 1, 1],
      [1, -1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
    ];
    const verts = v.map((x) => mul(x, 0.95));
    s[4] = { verts, faces: facesByNormals(verts, v.map((x) => mul(x, -1)), 3) };
  }
  // d6
  {
    const verts: V3[] = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) verts.push([x * 0.72, y * 0.72, z * 0.72]);
    s[6] = { verts, faces: facesByNormals(verts, [[0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0]], 4) };
  }
  // d8
  {
    const verts: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const normals: V3[] = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) normals.push([x, y, z]);
    s[8] = { verts, faces: facesByNormals(verts, normals, 3) };
  }
  // d10 (pentagonal trapezohedron)
  {
    const verts: V3[] = [[0, 0, 1.05], [0, 0, -1.05]];
    const z0 = 0.11;
    for (let k = 0; k < 10; k++) {
      const a = (k * Math.PI) / 5;
      verts.push([Math.cos(a) * 0.95, Math.sin(a) * 0.95, k % 2 === 0 ? z0 : -z0]);
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
    s[10] = { verts, faces };
  }
  // d12
  {
    const verts: V3[] = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) verts.push([x, y, z]);
    for (const a of [-1, 1])
      for (const b of [-1, 1]) {
        verts.push([0, a / PHI, b * PHI]);
        verts.push([a / PHI, b * PHI, 0]);
        verts.push([a * PHI, 0, b / PHI]);
      }
    const sc = verts.map((v) => mul(v, 0.6));
    const normals: V3[] = [];
    for (const a of [-1, 1]) for (const b of [-1, 1]) normals.push([0, a, b * PHI], [a, b * PHI, 0], [a * PHI, 0, b]);
    s[12] = { verts: sc, faces: facesByNormals(sc, normals, 5) };
  }
  // d20
  {
    const verts: V3[] = [];
    for (const a of [-1, 1]) for (const b of [-1, 1]) verts.push([0, a, b * PHI], [a, b * PHI, 0], [a * PHI, 0, b]);
    const sc = verts.map((v) => mul(v, 0.58));
    const normals: V3[] = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) normals.push([x, y, z]);
    for (const a of [-1, 1])
      for (const b of [-1, 1]) {
        normals.push([0, a / PHI, b * PHI]);
        normals.push([a / PHI, b * PHI, 0]);
        normals.push([a * PHI, 0, b / PHI]);
      }
    s[20] = { verts: sc, faces: facesByNormals(sc, normals, 3) };
  }
  return s;
}

const SHAPES = buildShapes();

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
    const size = this.dieSize(n);
    const cols = Math.min(n, Math.max(1, Math.floor(W / (size * 2.4))));
    const rows = Math.ceil(n / cols);
    const intensity = Math.max(0.4, Math.min(2, opts.intensity ?? 1));
    this.dice = expanded.map((kind, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const targetX = (W / (cols + 1)) * (col + 1);
      const targetY = (H / (rows + 1)) * (row + 1);
      return {
        kind,
        shape: SHAPES[kind === 1000 || kind === 100 ? 10 : kind]!,
        q: qnorm([Math.random(), Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]),
        axis: norm([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]),
        spin: (10 + Math.random() * 8) * intensity,
        x: targetX + (Math.random() - 0.5) * W * 0.6,
        y: -size * 2 - Math.random() * size * 2,
        vx: (Math.random() - 0.5) * 400,
        vy: 300 + Math.random() * 300,
        targetX,
        targetY,
        done: false,
        color: opts.color ?? this.opts.color ?? '#f4ead2',
      };
    });
    this.t0 = performance.now();
    cancelAnimationFrame(this.raf);
    const loop = (t: number) => {
      this.step(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private dieSize(n: number) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const base = this.opts.size ?? Math.min(W, H) * 0.3;
    return Math.max(18, Math.min(base, (W / Math.max(1, n)) * 0.38));
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
    const dt = 1 / 60;
    let allDone = this.dice.length > 0;
    const size = this.dieSize(this.dice.length);
    for (const d of this.dice) {
      if (d.settleTo && d.settleStart !== undefined && t >= d.settleStart) {
        const dur = this.reduceMotion ? 120 : 520;
        if (!d.settleFrom) d.settleFrom = d.q;
        const k = Math.min(1, (t - d.settleStart) / dur);
        const e = 1 - (1 - k) ** 3;
        d.q = qslerp(d.settleFrom, d.settleTo, e);
        d.x += (d.targetX - d.x) * 0.2;
        d.y += (d.targetY - d.y) * 0.2;
        if (k >= 1) d.done = true;
      } else {
        // free tumble with bounces inside the tray
        d.q = qnorm(qmul(qaxis(d.axis, d.spin * dt), d.q));
        d.spin = Math.max(6, d.spin * 0.992);
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
        if (d.x < size) (d.x = size), (d.vx = Math.abs(d.vx));
        if (d.x > W - size) (d.x = W - size), (d.vx = -Math.abs(d.vx));
        d.x += (d.targetX - d.x) * 0.02;
      }
      if (!d.done) allDone = false;
      this.drawDie(d, size);
    }
    if (allDone && this.settleResolve) {
      const r = this.settleResolve;
      this.settleResolve = undefined;
      r();
    }
  }

  private drawDie(d: DieAnim, size: number) {
    const ctx = this.ctx;
    const light = norm([-0.4, -0.6, 1]);
    const proj = (v: V3): [number, number] => {
      const persp = 4 / (4 - v[2]);
      return [d.x + v[0] * size * persp, d.y + v[1] * size * persp];
    };
    const rv = d.shape.verts.map((v) => qrot(d.q, v));
    const faces = d.shape.faces
      .map((f, fi) => ({ f, fi, n: qrot(d.q, f.normal), c: qrot(d.q, f.center), u: qrot(d.q, f.up) }))
      .filter((x) => x.n[2] > 0.01)
      .sort((a, b) => a.c[2] - b.c[2]);
    // shadow
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = this.ink;
    ctx.beginPath();
    ctx.ellipse(d.x + size * 0.15, d.targetY + size * 1.05, size * 0.85, size * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    for (const { f, fi, n, c, u } of faces) {
      const shade = 0.55 + 0.45 * Math.max(0, dot(n, light));
      ctx.beginPath();
      f.idx.forEach((vi, k) => {
        const [x, y] = proj(rv[vi]!);
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = shadeColor(d.color, shade);
      ctx.fill();
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(1.5, size * 0.045);
      ctx.strokeStyle = this.ink;
      ctx.stroke();
      if (n[2] > 0.3) {
        const label = labelFor(d.kind, fi);
        const w = cross(n, u);
        const s = 0.32 * (d.shape.faces.length > 12 ? 0.75 : d.shape.faces.length >= 10 ? 0.85 : 1);
        const p0 = proj(c);
        const pu = proj(add(c, mul(u, s)));
        const pw = proj(add(c, mul(w, s)));
        ctx.save();
        ctx.setTransform(pw[0] - p0[0], pw[1] - p0[1], -(pu[0] - p0[0]), -(pu[1] - p0[1]), p0[0], p0[1]);
        ctx.fillStyle = this.ink;
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
      ctx.arc(d.x, d.y, size * 1.25, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
}

function shadeColor(hex: string, f: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const c = [1, 2, 3].map((i) => Math.max(0, Math.min(255, Math.round(parseInt(m[i]!, 16) * f))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function dieName(f: number) {
  return f === 100 ? 'd%' : `d${f}`;
}
