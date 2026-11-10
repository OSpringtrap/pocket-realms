/**
 * Hero creation: pick your dice. One screen, no scrolling: the dice sit in the middle (tap them to
 * roll), four pills switch the tray of options below them, and Back / Next stay at the bottom.
 * The element is built once and kept, so the roll animation survives the phone's re-renders.
 */
import { sfx } from '../../shared/src/browser/audio.js';
import { restingQuat, qaxis, qmul, qnorm, qslerp, drawDie, type DieKind, type Q } from '../../shared/src/browser/dice3d.js';
import { h } from '../../shared/src/browser/dom.js';
import { DICE_FONTS, DICE_MATERIALS, DICE_MATERIAL_NAMES, DICE_PALETTES, NAT20_SOUNDS, diceColours, randomDiceStyle, type DiceStyle } from '../../shared/src/dicestyle.js';
import { haptic } from './sensors.js';

type Tab = 'material' | 'colours' | 'type' | 'sound';
const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: 'material', icon: '💎', label: 'Material' },
  { id: 'colours', icon: '🎨', label: 'Colours' },
  { id: 'type', icon: '🔢', label: 'Numbers' },
  { id: 'sound', icon: '🔔', label: 'Nat 20' },
];

interface Spin {
  kind: DieKind;
  from: Q;
  to: Q;
  axis: [number, number, number];
  start: number;
  dur: number;
  value: number;
}

let root: HTMLElement | undefined;
let api: { get: () => DiceStyle; set: (s: DiceStyle) => void; back: () => void; next: () => void } | undefined;

export function diceForge(o: NonNullable<typeof api>): HTMLElement {
  api = o;
  if (root) {
    refresh();
    start();
    return root;
  }
  root = build();
  refresh();
  start();
  return root;
}

// ------------------------------------------------------------------ building

let tab: Tab = 'material';
let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let result: HTMLElement;
const panels = new Map<Tab, HTMLElement>();
const thumbs = new Map<string, HTMLCanvasElement>();

function build(): HTMLElement {
  canvas = h('canvas', { class: 'df-canvas', 'aria-label': 'Your dice. Tap to roll.' }) as HTMLCanvasElement;
  ctx = canvas.getContext('2d')!;
  result = h('div', { class: 'df-result', 'aria-live': 'polite' });
  const stage = h('div', { class: 'df-stage' }, canvas, result, h('div', { class: 'df-hint' }, 'Tap the dice to roll'));
  stage.addEventListener('pointerdown', () => {
    sfx.unlock();
    roll();
  });

  // Material: the six materials, each shown on a little d20 in the current colours
  const mat = h('div', { class: 'df-grid df-mats' }, ...DICE_MATERIALS.map((m) => {
    const cv = h('canvas', { width: 96, height: 96, 'aria-hidden': 'true' }) as HTMLCanvasElement;
    thumbs.set(m, cv);
    return h('button', { type: 'button', class: 'df-opt', 'data-v': m, onclick: () => pick({ material: m }) }, cv, h('span', null, DICE_MATERIAL_NAMES[m]));
  }));
  // Colours: the sets as split swatches
  const pal = h('div', { class: 'df-grid df-pals' }, ...DICE_PALETTES.map((p) =>
    h('button', { type: 'button', class: 'df-pal', 'data-v': p.id, 'aria-label': p.name, title: p.name, style: `--a:${p.body};--b:${p.accent};--e:${p.edge}`, onclick: () => pick({ palette: p.id }) }),
  ));
  // Numbers: bold, light/dark, size, then the typefaces
  const boldBtn = h('button', { type: 'button', class: 'df-switch', id: 'df-bold', role: 'switch', onclick: () => {
    const f = DICE_FONTS.find((x) => x.id === api!.get().font);
    if (f?.bold) pick({ bold: !api!.get().bold });
  } }, h('b', null, 'B'), 'Bold');
  const lightBtn = h('button', { type: 'button', class: 'df-switch', id: 'df-light', role: 'switch', 'aria-label': 'Light glowing numbers or dark numbers', onclick: () => pick({ light: !api!.get().light }) }, h('span', { class: 'df-sun' }, '☀'), h('span', { class: 'df-moon' }, '☾'));
  const size = h('input', { type: 'range', id: 'df-size', min: '0.8', max: '1.3', step: '0.01', 'aria-label': 'Number size' }) as HTMLInputElement;
  size.addEventListener('input', () => pick({ size: Number(size.value) }, false));
  const fonts = h('div', { class: 'df-grid df-fonts' }, ...DICE_FONTS.map((f) =>
    h('button', { type: 'button', class: 'df-font', 'data-v': f.id, onclick: () => pick({ font: f.id, bold: f.bold && api!.get().bold }) }, h('span', { class: 'df-num', style: `font-family:"${f.css}",Georgia,serif;font-size:${1.35 * f.scale}em` }, '20'), h('span', { class: 'df-fname' }, f.name)),
  ));
  const typ = h('div', { class: 'df-type' }, h('div', { class: 'df-row' }, boldBtn, lightBtn, h('label', { class: 'df-sizer' }, h('span', { class: 'df-aa', 'aria-hidden': 'true' }, h('i', null, 'A'), h('b', null, 'A')), size)), fonts);
  // Nat 20: tap to hear it and pick it
  const snd = h('div', { class: 'df-grid df-snds' }, ...NAT20_SOUNDS.map((s) =>
    h('button', { type: 'button', class: 'df-snd', 'data-v': s.id, onclick: () => {
      sfx.unlock();
      pick({ nat20: s.id });
      sfx.nat20(s.id);
    } }, s.name),
  ));
  panels.set('material', mat).set('colours', pal).set('type', typ).set('sound', snd);

  const tray = h('div', { class: 'df-tray' }, ...panels.values());
  const pills = h('div', { class: 'df-pills', role: 'tablist' }, ...TABS.map((t) =>
    h('button', { type: 'button', role: 'tab', class: 'df-pill', 'data-t': t.id, onclick: () => ((tab = t.id), refresh()) }, h('span', { class: 'df-ic' }, t.icon), t.label),
  ));
  const shuffle = h('button', { type: 'button', class: 'df-shuffle', title: 'Surprise me', 'aria-label': 'Random dice', onclick: () => {
    sfx.unlock();
    api!.set(randomDiceStyle());
    refresh();
    roll();
  } }, '🎲');
  const top = h('div', { class: 'df-top' }, h('h2', null, 'Your dice'), shuffle);
  const nav = h('div', { class: 'df-nav' }, h('button', { type: 'button', onclick: () => api!.back() }, '← Back'), h('button', { type: 'button', class: 'primary', onclick: () => api!.next() }, 'Next →'));
  return h('div', { class: 'diceforge' }, top, stage, pills, tray, nav);
}

function pick(change: Partial<DiceStyle>, bump = true) {
  api!.set({ ...api!.get(), ...change });
  if (bump) haptic(8);
  refresh();
}

function refresh() {
  if (!root || !api) return;
  const st = api.get();
  const on = (sel: string, v: string) => root!.querySelectorAll<HTMLElement>(sel).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  on('.df-opt', st.material);
  on('.df-pal', st.palette);
  on('.df-font', st.font);
  on('.df-snd', st.nat20);
  root.querySelectorAll<HTMLElement>('.df-pill').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.t === tab)));
  for (const [t, el] of panels) el.hidden = t !== tab;
  const font = DICE_FONTS.find((f) => f.id === st.font)!;
  const bold = root.querySelector<HTMLButtonElement>('#df-bold')!;
  bold.disabled = !font.bold;
  bold.setAttribute('aria-checked', String(font.bold && st.bold));
  root.querySelector('#df-light')!.setAttribute('aria-checked', String(st.light));
  root.querySelector<HTMLInputElement>('#df-size')!.value = String(st.size);
  root.querySelectorAll<HTMLElement>('.df-font .df-num').forEach((e) => (e.style.fontWeight = st.bold && DICE_FONTS.find((f) => f.id === (e.parentElement as HTMLElement).dataset.v)?.bold ? '700' : '400'));
  // the tray's own swatches take the dice's ink so the light/dark choice reads at a glance
  root.style.setProperty('--df-ink', diceColours(st).ink);
  drawThumbs(st);
}

const thumbQ = qmul(qaxis([1, 0.3, 0], 0.5), restingQuat(20, 20));
function drawThumbs(st: DiceStyle) {
  for (const [m, cv] of thumbs) {
    const c = cv.getContext('2d')!;
    c.clearRect(0, 0, cv.width, cv.height);
    drawDie(c, { kind: 20, q: thumbQ, color: '', style: { ...st, material: m as DiceStyle['material'] } }, 48, 44, 30, '#000', { shadowX: 50, shadowY: 84, flatShadow: true, shadowAlpha: 0.25 });
  }
}

// ------------------------------------------------------------------ the dice and their roll

const SET: DieKind[] = [4, 6, 8, 12];
const spins: Spin[] = [20, ...SET].map((k) => ({ kind: k as DieKind, from: restingQuat(k as DieKind, k), to: restingQuat(k as DieKind, k), axis: [1, 0, 0], start: 0, dur: 1, value: k }));
let critAt = 0;
let rolled = false; // no crit ring on the dice as first shown, only after a real roll
let raf = 0;
const sparks: { x: number; y: number; vx: number; vy: number; life: number }[] = [];

function roll() {
  const now = performance.now();
  rolled = true;
  for (const s of spins) {
    s.value = 1 + Math.floor(Math.random() * s.kind);
    s.from = qnorm([Math.random(), Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]);
    s.to = restingQuat(s.kind, s.value);
    const a: [number, number, number] = [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5];
    const l = Math.hypot(...a) || 1;
    s.axis = [a[0] / l, a[1] / l, a[2] / l];
    s.start = now + (s.kind === 20 ? 0 : 60 + Math.random() * 120);
    s.dur = 950 + Math.random() * 250;
  }
  sfx.play('dice');
  haptic(20);
  result.textContent = '';
  result.className = 'df-result';
  const d20 = spins[0]!;
  setTimeout(() => {
    if (d20.value === 20) {
      critAt = performance.now();
      result.textContent = 'Natural 20!';
      result.className = 'df-result crit';
      sfx.nat20(api!.get().nat20);
      haptic([40, 40, 120]);
      const { x, y } = layout();
      for (let i = 0; i < 60; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = 1.5 + Math.random() * 4;
        sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1.2, life: 1 });
      }
    } else result.textContent = d20.value === 1 ? 'Natural 1…' : String(d20.value);
  }, d20.dur);
}

function layout() {
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  const big = Math.max(30, Math.min(W * 0.24, H * 0.27));
  return { W, H, big, small: Math.max(14, Math.min(W / 11, big * 0.42)), x: W / 2, y: H * 0.42 };
}

function start() {
  if (raf) return;
  const loop = (now: number) => {
    raf = 0;
    if (!root?.isConnected || !api) return; // the step was left: stop until it comes back
    frame(now);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
}

const ease = (t: number) => 1 - Math.pow(1 - t, 3);
function frame(now: number) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const { W, H, big, small, x, y } = layout();
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const st = api!.get();
  spins.forEach((s, i) => {
    const t = Math.max(0, Math.min(1, (now - s.start) / s.dur));
    const k = ease(t);
    const q = t >= 1 ? s.to : qslerp(qmul(qaxis(s.axis, (1 - k) * 14), s.from), s.to, k);
    const size = i === 0 ? big : small;
    const hop = t > 0 && t < 1 ? Math.abs(Math.sin(t * Math.PI * 2.5)) * (1 - t) * size * 0.7 : 0;
    const cx = i === 0 ? x : (W / (SET.length + 1)) * i;
    const cy = i === 0 ? y : H - small * 1.9;
    const crit = rolled && i === 0 && s.value === 20 && t >= 1;
    drawDie(ctx, { kind: s.kind, q, color: '', style: st, done: crit, highlight: crit ? 'crit' : undefined }, cx, cy - hop, size, '#000', { shadowX: cx + size * 0.1, shadowY: cy + size * 1.05, flatShadow: true, shadowAlpha: 0.28 });
  });
  for (const p of sparks) {
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.08;
    p.life -= 0.014;
    ctx.fillStyle = `hsla(${40 + p.life * 15},90%,65%,${Math.max(0, p.life)})`;
    ctx.fillRect(p.x, p.y, 3, 3);
  }
  for (let i = sparks.length - 1; i >= 0; i--) if (sparks[i]!.life <= 0) sparks.splice(i, 1);
  if (critAt && now - critAt > 4000) critAt = 0;
}
