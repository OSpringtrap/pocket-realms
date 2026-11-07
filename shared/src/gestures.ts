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

/**
 * Score a drawn stroke against a target rune. Returns 0..1 where ~0.8+ is a clean drawing.
 * `tolerance` (0.5 strict .. 1.5 lenient) adjusts how forgiving the curve is.
 */
export function scoreRune(points: unknown, target: string, tolerance = 1): { score: number; best: string } {
  if (!Array.isArray(points) || points.length < 6 || points.length > 2000) return { score: 0, best: '' };
  const pts: Pt[] = [];
  for (const p of points) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 1e5 && Math.abs(y) < 1e5) pts.push([x, y]);
  }
  if (pts.length < 6 || pathLength(pts) < 20) return { score: 0, best: '' };
  const cand = normalize(pts);
  let best = '';
  let bestD = Infinity;
  let targetD = Infinity;
  for (const name of RUNE_NAMES) {
    const d = Math.min(distanceAtBestAngle(cand, NORMALIZED[name]!), distanceAtBestAngle(cand, NORMALIZED_REV[name]!));
    if (d < bestD) {
      bestD = d;
      best = name;
    }
    if (name === target) targetD = d;
  }
  if (!NORMALIZED[target]) return { score: 0, best };
  const raw = 1 - targetD / HALF_DIAG;
  // map raw similarity (typically 0.6 .. 0.95) onto 0..1 with tolerance
  const lo = 0.62 - 0.08 * (tolerance - 1);
  const hi = 0.9 - 0.05 * (tolerance - 1);
  let score = Math.max(0, Math.min(1, (raw - lo) / (hi - lo)));
  if (best !== target) score *= 0.75;
  return { score: Math.round(score * 100) / 100, best };
}
