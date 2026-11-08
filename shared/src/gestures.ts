/**
 * $1 Unistroke Recognizer (Wobbrock, Wilson & Li 2007), trimmed down.
 * Templates are generated from parametric shapes. Scores are 0..1.
 */
export type Pt = [number, number];

const N = 48;
const SIZE = 250;
const HALF_DIAG = 0.5 * Math.sqrt(SIZE * SIZE * 2);
const ANGLE = (45 * Math.PI) / 180;
const PRECISION = (2 * Math.PI) / 180;
const PHI = 0.5 * (-1 + Math.sqrt(5));

function pathLength(pts: Pt[]) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  return d;
}

export function resample(points: Pt[], n = N): Pt[] {
  const pts = points.map((p) => [p[0], p[1]] as Pt);
  const I = pathLength(pts) / (n - 1);
  if (!(I > 0)) return Array(n).fill(pts[0] ?? [0, 0]);
  let D = 0;
  const out: Pt[] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (D + d >= I) {
      const t = (I - D) / d;
      const q: Pt = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      out.push(q);
      pts.splice(i, 0, q);
      D = 0;
    } else D += d;
  }
  while (out.length < n) out.push(pts[pts.length - 1]!);
  return out.slice(0, n);
}

function centroid(pts: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
}

function rotateBy(pts: Pt[], rad: number): Pt[] {
  const c = centroid(pts);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return pts.map(([x, y]) => [(x - c[0]) * cos - (y - c[1]) * sin + c[0], (x - c[0]) * sin + (y - c[1]) * cos + c[1]]);
}

function scaleTo(pts: Pt[]): Pt[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  // uniform scaling keeps lines/zigzags distinguishable from boxes
  const s = Math.max(maxX - minX, maxY - minY) || 1;
  return pts.map(([x, y]) => [((x - minX) * SIZE) / s, ((y - minY) * SIZE) / s]);
}

function translateToOrigin(pts: Pt[]): Pt[] {
  const c = centroid(pts);
  return pts.map(([x, y]) => [x - c[0], y - c[1]]);
}

function pathDistance(a: Pt[], b: Pt[]) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.hypot(a[i]![0] - b[i]![0], a[i]![1] - b[i]![1]);
  return d / a.length;
}

function distanceAtAngle(pts: Pt[], tpl: Pt[], rad: number) {
  return pathDistance(rotateBy(pts, rad), tpl);
}

function distanceAtBestAngle(pts: Pt[], tpl: Pt[]) {
  let a = -ANGLE;
  let b = ANGLE;
  let x1 = PHI * a + (1 - PHI) * b;
  let f1 = distanceAtAngle(pts, tpl, x1);
  let x2 = (1 - PHI) * a + PHI * b;
  let f2 = distanceAtAngle(pts, tpl, x2);
  while (Math.abs(b - a) > PRECISION) {
    if (f1 < f2) {
      b = x2;
      x2 = x1;
      f2 = f1;
      x1 = PHI * a + (1 - PHI) * b;
      f1 = distanceAtAngle(pts, tpl, x1);
    } else {
      a = x1;
      x1 = x2;
      f1 = f2;
      x2 = (1 - PHI) * a + PHI * b;
      f2 = distanceAtAngle(pts, tpl, x2);
    }
  }
  return Math.min(f1, f2);
}

export function normalize(points: Pt[]): Pt[] {
  return translateToOrigin(scaleTo(resample(points)));
}

// ---------------------------------------------------------------- templates

function poly(vertices: Pt[], closed = true, steps = 12): Pt[] {
  const vs = closed ? [...vertices, vertices[0]!] : vertices;
  const out: Pt[] = [];
  for (let i = 0; i < vs.length - 1; i++)
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push([vs[i]![0] + (vs[i + 1]![0] - vs[i]![0]) * t, vs[i]![1] + (vs[i + 1]![1] - vs[i]![1]) * t]);
    }
  out.push(vs[vs.length - 1]!);
  return out;
}

function param(fn: (t: number) => Pt, steps = 64): Pt[] {
  return Array.from({ length: steps + 1 }, (_, i) => fn(i / steps));
}

/** Shapes in screen coordinates (y down). */
export const RUNE_SHAPES: Record<string, { label: string; points: Pt[] }> = {
  circle: { label: 'Circle', points: param((t) => [Math.cos(t * 2 * Math.PI - Math.PI / 2), Math.sin(t * 2 * Math.PI - Math.PI / 2)]) },
  triangle: { label: 'Triangle', points: poly([[0, -1], [0.95, 0.75], [-0.95, 0.75]]) },
  square: { label: 'Square', points: poly([[-1, -1], [1, -1], [1, 1], [-1, 1]]) },
  zigzag: { label: 'Lightning Zigzag', points: poly([[-1, -1], [0.6, -0.35], [-0.6, 0.35], [1, 1]], false) },
  vee: { label: 'Check-mark V', points: poly([[-1, -1], [0, 1], [1, -1]], false) },
  caret: { label: 'Mountain ^', points: poly([[-1, 1], [0, -1], [1, 1]], false) },
  spiral: { label: 'Spiral', points: param((t) => [Math.cos(t * 5 * Math.PI) * (0.15 + t), Math.sin(t * 5 * Math.PI) * (0.15 + t)], 90) },
  star: {
    label: 'Star',
    points: poly(
      [0, 2, 4, 1, 3].map((i) => [Math.cos((i * 2 * Math.PI) / 5 - Math.PI / 2), Math.sin((i * 2 * Math.PI) / 5 - Math.PI / 2)] as Pt),
      true,
      10,
    ),
  },
  wave: { label: 'Wave', points: param((t) => [t * 4 - 2, Math.sin(t * 4 * Math.PI) * 0.6]) },
  heart: {
    label: 'Heart',
    points: param((t) => {
      const a = t * 2 * Math.PI + Math.PI;
      return [16 * Math.sin(a) ** 3 / 16, -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a)) / 16];
    }, 80),
  },
};

const NORMALIZED: Record<string, Pt[]> = Object.fromEntries(Object.entries(RUNE_SHAPES).map(([k, v]) => [k, normalize(v.points)]));
// Also accept reversed-direction strokes
const NORMALIZED_REV: Record<string, Pt[]> = Object.fromEntries(Object.entries(RUNE_SHAPES).map(([k, v]) => [k, normalize([...v.points].reverse())]));

export const RUNE_NAMES = Object.keys(RUNE_SHAPES);

// ---------------------------------------------------------------- strict trace scoring

/** Bounding box of a template in its own (shape) units: the phone draws the guide from this box. */
export function runeBox(name: string): { minX: number; minY: number; maxX: number; maxY: number; size: number } {
  const pts = (RUNE_SHAPES[name] ?? RUNE_SHAPES.circle!).points;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY, size: Math.max(maxX - minX, maxY - minY, 0.01) };
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Distance from a point to a polyline. */
export function polyDist(p: Pt, line: Pt[]): number {
  if (line.length === 1) return Math.hypot(p[0] - line[0]![0], p[1] - line[0]![1]);
  let d = Infinity;
  for (let i = 1; i < line.length; i++) d = Math.min(d, segDist(p, line[i - 1]!, line[i]!));
  return d;
}

/** Distance (in units of the rune's size) from a shape-space point to the target rune; the phone
 * uses it to colour the ink live. */
export function runeInkDistance(p: Pt, target: string): number {
  const shape = RUNE_SHAPES[target] ?? RUNE_SHAPES.circle!;
  return polyDist(p, shape.points) / runeBox(target).size;
}

const ramp = (d: number, ok: number, zero: number) => (d <= ok ? 1 : d >= zero ? 0 : 1 - (d - ok) / (zero - ok));

export interface TraceScore {
  score: number;
  /** mean closeness of the ink to the rune (0..1): penalises ink far from the rune */
  precision: number;
  /** share of the rune that has ink on it (0..1) */
  coverage: number;
  /** stroke order/direction agreement (0..1), either direction, any start point on closed runes */
  order: number;
  /** share of the ink that is clearly off the rune */
  stray: number;
}

const TRACE_N = 64;

/**
 * Strict scoring of a trace drawn over the guide. `pts` are in the rune's own shape units (the
 * phone converts screen pixels with the same transform it used to draw the guide), so position
 * and size matter: a tiny or shifted copy of the right shape is not an honest trace.
 *
 * The old $1-only scoring was translation/scale/rotation invariant and only rewarded similarity
 * to the closest template, so a lopsided blob drawn anywhere passed as a circle. Here three
 * things must all hold (they are multiplied, so one bad metric sinks the score):
 * - precision: every bit of ink must lie near the rune (ink far away is penalised, not ignored);
 * - coverage: the whole rune must be inked (half a star is half a star);
 * - order: the stroke must follow the rune's path (scribbling over it back and forth fails).
 * Distances are in units of the rune's bounding-box size; `tolerance` scales them.
 */
export function scoreTrace(pts: Pt[], target: string, tolerance = 1): TraceScore {
  const zero: TraceScore = { score: 0, precision: 0, coverage: 0, order: 0, stray: 1 };
  const shape = RUNE_SHAPES[target];
  if (!shape || pts.length < 2) return zero;
  const L = runeBox(target).size;
  const tol = Math.max(0.3, tolerance);
  const tpl = shape.points;
  if (pathLength(pts) < L * 0.2) return zero;
  const P = resample(pts, TRACE_N);
  const T = resample(tpl, TRACE_N);

  // precision: ink within ~5% of the rune size is perfect, beyond ~16% earns nothing
  let prec = 0;
  let stray = 0;
  for (const p of P) {
    const d = polyDist(p, tpl) / L;
    prec += ramp(d, 0.05 * tol, 0.16 * tol);
    if (d > 0.22 * tol) stray++;
  }
  prec /= P.length;
  stray /= P.length;

  // coverage: every part of the rune needs ink close by
  let cov = 0;
  for (const q of T) cov += ramp(polyDist(q, pts) / L, 0.06 * tol, 0.15 * tol);
  cov /= T.length;

  // order: point-by-point along the path (forward or reversed; cyclic shifts for closed runes)
  const closed = Math.hypot(tpl[0]![0] - tpl[tpl.length - 1]![0], tpl[0]![1] - tpl[tpl.length - 1]![1]) < L * 0.05;
  let best = Infinity;
  for (const cand of [T, [...T].reverse()]) {
    const base = closed ? cand.slice(0, -1) : cand; // drop the duplicated closing point for shifting
    const shifts = closed ? base.length : 1;
    for (let s = 0; s < shifts; s += closed ? 2 : 1) {
      const seq = closed ? [...base.slice(s), ...base.slice(0, s)] : base;
      const tgt = closed ? resample([...seq, seq[0]!], TRACE_N) : seq;
      best = Math.min(best, pathDistance(P, tgt));
    }
  }
  const order = ramp(best / L, 0.06 * tol, 0.2 * tol);

  // strays are punished twice on purpose: a scribble that also crosses the rune must not pass
  const raw = prec ** 1.5 * cov ** 2 * (0.35 + 0.65 * order) * (1 - Math.min(1, stray * 1.5));
  const score = Math.max(0, Math.min(1, raw * 1.15)); // small headroom so a careful honest trace can reach 1
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { score: r2(score), precision: r2(prec), coverage: r2(cov), order: r2(order), stray: r2(stray) };
}

function cleanPoints(points: unknown): Pt[] | null {
  if (!Array.isArray(points) || points.length < 6 || points.length > 2000) return null;
  const pts: Pt[] = [];
  for (const p of points) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 1e5 && Math.abs(y) < 1e5) pts.push([x, y]);
  }
  return pts.length < 6 ? null : pts;
}

/** Which template a stroke most resembles ($1 recognizer: position/size/rotation invariant). */
export function recognizeRune(pts: Pt[]): string {
  if (pts.length < 6 || pathLength(pts) <= 0) return '';
  const cand = normalize(pts);
  let best = '';
  let bestD = Infinity;
  for (const name of RUNE_NAMES) {
    const d = Math.min(distanceAtBestAngle(cand, NORMALIZED[name]!), distanceAtBestAngle(cand, NORMALIZED_REV[name]!));
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

/**
 * Score a drawn stroke against a target rune. `points` are in the rune's shape units (see
 * `scoreTrace`); untrusted input is sanitised here. Returns 0..1 where 0.8+ is a clean trace,
 * plus the template the stroke looks most like (for feedback).
 * `tolerance` (0.5 strict .. 1.5 lenient) scales the distance thresholds.
 */
export function scoreRune(points: unknown, target: string, tolerance = 1): { score: number; best: string } {
  const pts = cleanPoints(points);
  if (!pts || !RUNE_SHAPES[target]) return { score: 0, best: '' };
  return { score: scoreTrace(pts, target, tolerance).score, best: recognizeRune(pts) };
}
