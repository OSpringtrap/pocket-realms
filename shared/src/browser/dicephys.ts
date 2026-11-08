/**
 * Dice as rigid bodies on a flat table seen from above: in-plane sliding and rolling, hops and
 * bounces off the table, wall and die-to-die collisions, and a tumble that follows the motion
 * (rolling without slipping on the table, free spin in the air).
 *
 * The phone uses it as a box held in the hand: tilt is gravity, the phone's own acceleration is an
 * inertial push (the dice lag behind a shake), turning the phone spins the box under them, and a
 * hard enough hit carries a die out through a wall: that is the throw. The main screen uses it as a
 * table the dice land on after crossing from the phone.
 *
 * The server always decides the values; bodies are told their value and tip onto that face as they
 * come to rest.
 */
import type { ThrowInfo } from '../protocol.js';
import { DIE_EXTENT, drawDie, faceNormalFor, qaxis, qfromTo, qmul, qnorm, qrot, qslerp, type DieKind, type DieLook, type Q, type V3 } from './dice3d.js';

export type Edge = 'top' | 'bottom' | 'left' | 'right';

export interface Body extends DieLook {
  group: string;
  w: V3; // angular velocity, rad/s (x right, y down, z toward the viewer)
  x: number;
  y: number;
  z: number; // height above the table, px
  vx: number;
  vy: number;
  vz: number;
  value?: number;
  settleFrom?: Q;
  settleTo?: Q;
  settleT0?: number;
  settleWanted?: boolean;
  entering?: boolean; // still crossing in from outside: walls ignore it until it is fully in
  exited?: boolean;
  born: number;
  restAt?: number;
  fade?: number; // 1 = opaque
}

export interface ExitInfo {
  edge: Edge;
  pos: number;
  vx: number;
  vy: number;
}

export class DiceWorld {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  bodies: Body[] = [];
  /** in-plane acceleration from tilt, px/s² */
  gravity: [number, number] = [0, 0];
  /** inertial (pseudo) acceleration from moving the box, px/s² */
  push: [number, number] = [0, 0];
  /** extra vertical acceleration (shaking the box up and down), px/s² */
  lift = 0;
  /** the box turning under the dice, rad/s about the view axis */
  frameSpin = 0;
  /** speed into a wall that carries a die through it (Infinity: closed box) */
  escapeSpeed = Infinity;
  /** walls on or off (the main screen keeps them; dice stay on the table) */
  walls = true;
  ink = '#2b1d0e';
  /** px per die radius */
  dieSize = 30;
  /** gravity pulling dice onto the table, px/s² (default: a die-sized scale) */
  tableG?: number;
  onHit?: (b: Body, speed: number) => void;
  onExit?: (b: Body, e: ExitInfo) => void;
  onRest?: (group: string) => void;
  private raf = 0;
  private lastT = 0;
  private W = 0;
  private H = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  get width() {
    return this.W;
  }
  get height() {
    return this.H;
  }

  /** Match the backing store to the element (simulation runs in CSS pixels). */
  fit() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = Math.max(10, r.width);
    this.H = Math.max(10, r.height);
    const w = Math.round(this.W * dpr);
    const h = Math.round(this.H * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  add(kind: DieKind, o: { group: string; x: number; y: number; vx?: number; vy?: number; z?: number; vz?: number; color: string; spin?: number; entering?: boolean }): Body {
    const axis: V3 = [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5];
    const l = Math.hypot(...axis) || 1;
    const spin = o.spin ?? 12;
    const b: Body = {
      kind,
      group: o.group,
      q: qnorm([Math.random(), Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]),
      w: [(axis[0] / l) * spin, (axis[1] / l) * spin, (axis[2] / l) * spin],
      x: o.x,
      y: o.y,
      z: o.z ?? 0,
      vx: o.vx ?? 0,
      vy: o.vy ?? 0,
      vz: o.vz ?? 0,
      color: o.color,
      done: false,
      entering: o.entering,
      born: performance.now(),
      fade: 1,
    };
    this.bodies.push(b);
    this.start();
    return b;
  }

  /** Tell a group its values; each die tips onto its face once it slows down (or after maxMs). */
  settle(group: string, values: number[], highlights: (Body['highlight'] | undefined)[] = []) {
    const list = this.bodies.filter((b) => b.group === group);
    list.forEach((b, i) => {
      b.value = values[i] ?? 1;
      b.highlight = highlights[i];
      b.settleWanted = true;
    });
  }

  removeGroup(group: string) {
    this.bodies = this.bodies.filter((b) => b.group !== group);
  }

  fadeGroup(group: string) {
    for (const b of this.bodies) if (b.group === group) b.fade = Math.min(b.fade ?? 1, 0.999);
  }

  groupDone(group: string) {
    const list = this.bodies.filter((b) => b.group === group && !b.exited);
    return list.length > 0 && list.every((b) => b.done);
  }

  start() {
    if (this.raf) return;
    this.lastT = 0;
    const loop = (t: number) => {
      this.raf = 0;
      this.frame(t);
      if (this.bodies.length) this.raf = requestAnimationFrame(loop);
      else this.ctx.clearRect(0, 0, this.W, this.H);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame(t: number) {
    this.fit();
    const dt = this.lastT ? Math.min(1 / 30, Math.max(1 / 240, (t - this.lastT) / 1000)) : 1 / 60;
    this.lastT = t;
    // two substeps keep fast dice from tunnelling through each other
    this.step(dt / 2, t);
    this.step(dt / 2, t);
    this.draw();
  }

  private step(dt: number, now: number) {
    const s = this.dieSize;
    const r = s * DIE_EXTENT * 0.82; // collision radius: a little inside the drawn silhouette
    const G = this.tableG ?? s * 90; // table gravity, px/s² (a die of ~1.5 cm falls at ~9.8 m/s²)
    const W = this.W;
    const H = this.H;
    const groups = new Set<string>();
    for (const b of this.bodies) {
      if (b.exited) continue;
      if (b.fade !== undefined && b.fade < 1) {
        b.fade -= dt * 2.2;
        continue;
      }
      // --- coming to rest on the server's value
      if (b.settleWanted && !b.settleTo) {
        const speed = Math.hypot(b.vx, b.vy);
        const age = now - b.born;
        if ((speed < s * 5 && b.z < 1 && age > 450) || age > 3200) {
          const n = qrot(b.q, faceNormalFor(b.kind, b.value ?? 1));
          b.settleFrom = b.q;
          b.settleTo = qnorm(qmul(qfromTo(n, [0, 0, 1]), b.q)); // the smallest tip onto that face
          b.settleT0 = now;
        }
      }
      if (b.settleTo && b.settleT0 !== undefined) {
        const k = Math.min(1, (now - b.settleT0) / 420);
        b.q = qslerp(b.settleFrom!, b.settleTo, 1 - (1 - k) ** 3);
        const damp = Math.exp(-9 * dt);
        b.vx *= damp;
        b.vy *= damp;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.z = Math.max(0, b.z - s * 20 * dt);
        if (k >= 1 && !b.done) {
          b.done = true;
          b.restAt = now;
          groups.add(b.group);
        }
        this.keepIn(b, r);
        continue;
      }
      // --- vertical: hops off the table
      b.vz += (this.lift - G) * dt;
      b.z += b.vz * dt;
      if (b.z <= 0) {
        b.z = 0;
        if (b.vz < -s * 6) {
          this.onHit?.(b, Math.min(1, -b.vz / (s * 60)));
          b.vz = -b.vz * 0.32;
          // a landing die kicks into a new tumble
          b.w = [b.w[0] + (Math.random() - 0.5) * 8, b.w[1] + (Math.random() - 0.5) * 8, b.w[2] + (Math.random() - 0.5) * 4];
        } else b.vz = 0;
      }
      const onTable = b.z < 1.5;
      // --- in-plane: tilt + inertial push, friction on the table
      const ax = this.gravity[0] + this.push[0];
      const ay = this.gravity[1] + this.push[1];
      if (onTable) {
        // static friction: a gentle tilt does not move a die at rest
        const resting = Math.hypot(b.vx, b.vy) < s * 0.8;
        const a = Math.hypot(ax, ay);
        if (!resting || a > G * 0.2) {
          b.vx += ax * dt;
          b.vy += ay * dt;
        }
        // kinetic friction (constant) + rolling drag (proportional)
        const sp = Math.hypot(b.vx, b.vy);
        if (sp > 0) {
          const dec = Math.min(sp, G * 0.35 * dt);
          b.vx -= (b.vx / sp) * dec;
          b.vy -= (b.vy / sp) * dec;
          const drag = Math.exp(-0.9 * dt);
          b.vx *= drag;
          b.vy *= drag;
        }
      } else {
        b.vx += ax * dt;
        b.vy += ay * dt;
      }
      // the box turning under the dice: in its frame they swing the other way (half-coupled by friction)
      if (this.frameSpin) {
        const a = -this.frameSpin * dt * (onTable ? 0.55 : 0.9);
        const cx = W / 2;
        const cy = H / 2;
        const c = Math.cos(a);
        const sn = Math.sin(a);
        const dx = b.x - cx;
        const dy = b.y - cy;
        b.x = cx + dx * c - dy * sn;
        b.y = cy + dx * sn + dy * c;
        const vx = b.vx * c - b.vy * sn;
        b.vy = b.vx * sn + b.vy * c;
        b.vx = vx;
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      // --- tumble: on the table it rolls with its motion (ω = ẑ × v / r), in the air it spins freely
      if (onTable) {
        const tx = -b.vy / s;
        const ty = b.vx / s;
        const k = 1 - Math.exp(-14 * dt);
        b.w = [b.w[0] + (tx - b.w[0]) * k, b.w[1] + (ty - b.w[1]) * k, b.w[2] * Math.exp(-2.5 * dt)];
      } else {
        const k = Math.exp(-0.25 * dt);
        b.w = [b.w[0] * k, b.w[1] * k, b.w[2] * k];
      }
      const wl = Math.hypot(...b.w);
      if (wl > 1e-4) b.q = qnorm(qmul(qaxis(b.w, wl * dt), b.q));
      // --- walls
      if (b.entering) {
        if (b.x > r && b.x < W - r && b.y > r && b.y < H - r) b.entering = false;
        else if (b.x < -4 * r || b.x > W + 4 * r || b.y < -4 * r || b.y > H + 4 * r) b.entering = false; // flew off: let walls catch it
      } else if (this.walls) this.collideWalls(b, r);
    }
    this.collideDice(r);
    for (const g of groups) if (this.groupDone(g)) this.onRest?.(g);
    this.bodies = this.bodies.filter((b) => (b.fade ?? 1) > 0 && !b.exited);
  }

  private keepIn(b: Body, r: number) {
    if (!this.walls || b.entering) return;
    b.x = Math.max(r, Math.min(this.W - r, b.x));
    b.y = Math.max(r, Math.min(this.H - r, b.y));
  }

  private collideWalls(b: Body, r: number) {
    const W = this.W;
    const H = this.H;
    const rest = 0.45;
    const hit = (edge: Edge, normalSpeed: number, pos: number) => {
      if (normalSpeed > this.escapeSpeed) {
        b.exited = true;
        this.onExit?.(b, { edge, pos: Math.max(0, Math.min(1, pos)), vx: b.vx, vy: b.vy });
        return true;
      }
      if (normalSpeed > this.dieSize * 2) this.onHit?.(b, Math.min(1, normalSpeed / (this.dieSize * 40)));
      // glancing off a wall sets the die spinning about the view axis
      b.w = [b.w[0], b.w[1], b.w[2] + (Math.random() - 0.5) * normalSpeed * 0.04];
      return false;
    };
    if (b.x < r && b.vx < 0) {
      if (hit('left', -b.vx, b.y / H)) return;
      b.x = r;
      b.vx = -b.vx * rest;
    } else if (b.x > W - r && b.vx > 0) {
      if (hit('right', b.vx, b.y / H)) return;
      b.x = W - r;
      b.vx = -b.vx * rest;
    }
    if (b.y < r && b.vy < 0) {
      if (hit('top', -b.vy, b.x / W)) return;
      b.y = r;
      b.vy = -b.vy * rest;
    } else if (b.y > H - r && b.vy > 0) {
      if (hit('bottom', b.vy, b.x / W)) return;
      b.y = H - r;
      b.vy = -b.vy * rest;
    }
  }

  private collideDice(r: number) {
    const live = this.bodies.filter((b) => !b.exited && (b.fade ?? 1) >= 1);
    for (let i = 0; i < live.length; i++)
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i]!;
        const b = live[j]!;
        if (Math.abs(a.z - b.z) > r * 1.5) continue; // one is hopping over the other
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        const min = 2 * r;
        if (d >= min || d === 0) continue;
        const nx = dx / d;
        const ny = dy / d;
        const push = (min - d) / 2;
        const am = a.settleTo ? 0 : 1;
        const bm = b.settleTo ? 0 : 1;
        if (!am && !bm) continue;
        a.x -= nx * push * (bm ? am : 2 * am);
        a.y -= ny * push * (bm ? am : 2 * am);
        b.x += nx * push * (am ? bm : 2 * bm);
        b.y += ny * push * (am ? bm : 2 * bm);
        const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rel >= 0) continue;
        const jimp = (-(1 + 0.5) * rel) / (am + bm);
        a.vx -= jimp * nx * am;
        a.vy -= jimp * ny * am;
        b.vx += jimp * nx * bm;
        b.vy += jimp * ny * bm;
        if (-rel > this.dieSize * 2) this.onHit?.(a, Math.min(1, -rel / (this.dieSize * 40)));
      }
  }

  private draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.W, this.H);
    const s = this.dieSize;
    // lower dice first, so a hopping die passes over the others
    for (const b of [...this.bodies].filter((x) => !x.exited).sort((a, c) => a.z - c.z)) {
      const lift = 1 + Math.min(0.6, b.z / (s * 8));
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, b.fade ?? 1));
      drawDie(ctx, b, b.x - b.z * 0.08, b.y - b.z * 0.25, s * lift, this.ink, { shadowX: b.x + s * 0.18 + b.z * 0.25, shadowY: b.y + s * 0.3 + b.z * 0.15, shadowAlpha: 0.22 / lift });
      ctx.restore();
    }
  }
}

const OPPOSITE: Record<Edge, Edge> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
const INWARD: Record<Edge, [number, number]> = { top: [0, 1], bottom: [0, -1], left: [1, 0], right: [-1, 0] };

/**
 * Where and how dice that left a phone come onto this screen: through the opposite edge (as if the
 * phone lay against that edge), at the same place along it, with the same heading and a speed
 * scaled to this screen. No throw info (a bot, a timeout, real dice): in from the bottom, upward.
 */
export function entryFromThrow(t: ThrowInfo | undefined, W: number, H: number, r: number) {
  const info: ThrowInfo = t ?? { edge: 'top', pos: 0.3 + Math.random() * 0.4, angle: -Math.PI / 2 + (Math.random() - 0.5) * 0.7, speed: 5 + Math.random() * 2, spin: 18 };
  const edge = OPPOSITE[info.edge];
  const [nx, ny] = INWARD[edge];
  let dx = Math.cos(info.angle);
  let dy = Math.sin(info.angle);
  // a heading that skims along (or out of) the edge is bent inward, so the dice always arrive
  let inward = dx * nx + dy * ny;
  if (inward < 0) {
    // pointing back out: mirror it in the edge
    dx -= 2 * inward * nx;
    dy -= 2 * inward * ny;
    inward = -inward;
  }
  if (inward < 0.35) {
    dx += nx * (0.35 - inward) * 1.5;
    dy += ny * (0.35 - inward) * 1.5;
  }
  const l = Math.hypot(dx, dy) || 1;
  dx /= l;
  dy /= l;
  const short = Math.min(W, H);
  const speed = Math.max(short * 1.5, Math.min(short * 4, info.speed * short * 0.5));
  const pos = Math.max(0.08, Math.min(0.92, info.pos));
  const x = edge === 'left' ? -r : edge === 'right' ? W + r : pos * W;
  const y = edge === 'top' ? -r : edge === 'bottom' ? H + r : pos * H;
  return { edge, x, y, vx: dx * speed, vy: dy * speed, spin: Math.max(8, Math.min(40, info.spin)), dir: [dx, dy] as [number, number] };
}
