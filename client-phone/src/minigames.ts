/**
 * Phone minigames. Each returns a score in 0..1 (the server re-scores runes and
 * clamps everything). Every sensor game has a touch-only fallback.
 */
import { h, clear } from '../../shared/src/browser/dom.js';
import { RUNE_SHAPES, scoreRune, type Pt } from '../../shared/src/gestures.js';
import type { Prompt } from '../../shared/src/protocol.js';
import { S, caps, haptic, requestMotion, startMic, stopMic } from './sensors.js';

type MiniPrompt = Extract<Prompt, { kind: 'minigame' }>;
export interface MiniResult {
  score: number;
  points?: Pt[];
  fallback?: boolean;
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const INFO: Record<string, { title: string; how: string; fallback: string; sensor?: 'motion' | 'mic' | 'orientation' }> = {
  rune: { title: '✍️ Draw the rune', how: 'Trace the glowing shape in one smooth stroke.', fallback: '' },
  swing: { title: '🏏 Swing!', how: 'Hold your phone tight and swing it like a sword!', fallback: 'Tap when the marker is in the gold zone.', sensor: 'motion' },
  shout: { title: '📣 Battle cry!', how: 'SHOUT into your phone as loud as you can!', fallback: 'Tap as fast as you can!', sensor: 'mic' },
  tilt: { title: '🎯 Aim!', how: 'Tilt your phone to keep the crosshair on the target.', fallback: 'Drag the crosshair to stay on the target.', sensor: 'orientation' },
  shake: { title: '🫨 Shake it!', how: 'Shake your phone hard!', fallback: 'Tap as fast as you can!', sensor: 'motion' },
  hold: { title: '✊ Charge it!', how: 'Press and hold, release when the bar is in the gold zone.', fallback: '' },
  rhythm: { title: '🥁 Keep the beat!', how: 'Tap on every flashing beat.', fallback: '' },
  steady: { title: '🧘 Hold steady...', how: 'Keep your phone perfectly still!', fallback: 'Keep your finger on the drifting dot.', sensor: 'motion' },
  blow: { title: '🌬️ Blow!', how: 'Blow into the microphone — long and hard!', fallback: 'Tap as fast as you can!', sensor: 'mic' },
  hum: { title: '🎵 Hum the note', how: 'Hum and slide your voice into the golden band.', fallback: 'Slide to match the tone you hear.', sensor: 'mic' },
  scan: { title: '🧭 Search around', how: 'Turn slowly around the room. Your phone buzzes faster when you are close.', fallback: 'Spin the dial — it glows warmer when you are close.', sensor: 'orientation' },
  sequence: { title: '🧩 Remember the pattern', how: 'Watch the pads light up, then repeat the sequence.', fallback: '' },
  twofinger: { title: '✌️ Two-finger trick', how: 'Hold BOTH circles at once with two fingers!', fallback: 'Tap the two circles back and forth, fast!' },
  quiet: { title: '🤫 Stay silent...', how: 'Be completely quiet. Shhh!', fallback: 'Keep your finger perfectly still on the button.', sensor: 'mic' },
  tap: { title: '👆 Tap frenzy!', how: 'Tap as fast as you can!', fallback: '' },
  search: { title: '🔍 Search by touch', how: 'Rub away the dust to find what is hidden. Be quick — and tidy!', fallback: '' },
  listen: { title: '👂 Listen closely', how: 'Something faint will sound (and shimmer). Tap the ear the moment you notice it — three times.', fallback: '' },
  plates: { title: '🦶 Pressure plate', how: 'Everyone together: HOLD your plate only while the bar glows gold!', fallback: '' },
};

function makeCanvas(root: HTMLElement, height = 320) {
  const c = h('canvas', { class: 'mgcanvas', style: `height:${height}px` });
  root.appendChild(c);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = c.getBoundingClientRect();
  c.width = Math.max(100, r.width * dpr);
  c.height = height * dpr;
  const ctx = c.getContext('2d')!;
  ctx.scale(dpr, dpr);
  return { c, ctx, W: r.width, H: height };
}

function timerBar(root: HTMLElement) {
  const bar = h('div', { class: 'bar xp', style: 'margin-top:8px' }, h('i', { style: 'width:100%' }));
  root.appendChild(bar);
  return (frac: number): void => {
    (bar.firstChild as HTMLElement).style.width = `${Math.max(0, 100 - frac * 100)}%`;
  };
}

async function loop(dur: number, frame: (t: number, frac: number) => void | boolean) {
  const t0 = performance.now();
  return new Promise<void>((res) => {
    const step = () => {
      const t = performance.now() - t0;
      const stop = frame(t, Math.min(1, t / dur));
      if (t >= dur || stop === true) res();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function ink(ctx: CanvasRenderingContext2D, W: number, H: number) {
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = '#2b1d0e';
  ctx.fillStyle = '#2b1d0e';
  ctx.lineWidth = 3;
}

// ---------------------------------------------------------------- touch games (also fallbacks)

async function tapMash(root: HTMLElement, dur: number, label = 'TAP!'): Promise<number> {
  let taps = 0;
  const btn = h('button', { class: 'primary mgbig' }, label);
  const count = h('div', { class: 'mgcount' }, '0');
  root.append(count, btn);
  const tb = timerBar(root);
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    taps++;
    count.textContent = String(taps);
    if (taps % 5 === 0) haptic(15);
  });
  await loop(dur, (_t, f) => tb(f));
  btn.disabled = true;
  return clamp(taps / ((dur / 1000) * 6.5));
}

async function timingBar(root: HTMLElement, dur: number): Promise<number> {
  const { ctx, W, H } = makeCanvas(root, 120);
  let pos = 0;
  let stopped = -1;
  const btn = h('button', { class: 'primary mgbig' }, 'STRIKE!');
  root.appendChild(btn);
  btn.addEventListener('pointerdown', () => (stopped = pos));
  await loop(dur, (t) => {
    pos = (Math.sin(t / 260) + 1) / 2;
    ink(ctx, W, H);
    ctx.fillStyle = '#e8d28a';
    ctx.fillRect(W * 0.42, 30, W * 0.16, 60);
    ctx.strokeRect(10, 30, W - 20, 60);
    ctx.fillStyle = '#7a1f1f';
    ctx.fillRect(10 + (W - 20) * (stopped >= 0 ? stopped : pos) - 4, 22, 8, 76);
    return stopped >= 0;
  });
  if (stopped < 0) return 0.1;
  return clamp(1 - Math.abs(stopped - 0.5) * 3.2);
}

async function dragTarget(root: HTMLElement, dur: number, useTilt: boolean): Promise<number> {
  const { c, ctx, W, H } = makeCanvas(root, 300);
  let cx = W / 2;
  let cy = H / 2;
  let inside = 0;
  let frames = 0;
  const base = { beta: S.beta, gamma: S.gamma };
  c.addEventListener('pointermove', (e) => {
    if (useTilt) return;
    const r = c.getBoundingClientRect();
    cx = e.clientX - r.left;
    cy = e.clientY - r.top;
  });
  c.addEventListener('pointerdown', (e) => {
    const r = c.getBoundingClientRect();
    cx = e.clientX - r.left;
    cy = e.clientY - r.top;
  });
  const tb = timerBar(root);
  await loop(dur, (t, f) => {
    tb(f);
    const tx = W / 2 + Math.sin(t / 700) * W * 0.32;
    const ty = H / 2 + Math.sin(t / 530 + 1) * H * 0.3;
    if (useTilt) {
      cx = W / 2 + Math.max(-1, Math.min(1, (S.gamma - base.gamma) / 25)) * W * 0.45;
      cy = H / 2 + Math.max(-1, Math.min(1, (S.beta - base.beta) / 25)) * H * 0.45;
    }
    const d = Math.hypot(cx - tx, cy - ty);
    frames++;
    if (d < 34) inside++;
    ink(ctx, W, H);
    ctx.fillStyle = d < 34 ? '#e3b23c' : '#d9c7a0';
    ctx.beginPath();
    ctx.arc(tx, ty, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(tx, ty, 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#7a1f1f';
    ctx.beginPath();
    ctx.moveTo(cx - 16, cy);
    ctx.lineTo(cx + 16, cy);
    ctx.moveTo(cx, cy - 16);
    ctx.lineTo(cx, cy + 16);
    ctx.stroke();
  });
  return clamp((inside / Math.max(1, frames)) * 1.35);
}

async function holdStill(root: HTMLElement, dur: number): Promise<number> {
  // fallback for steady/quiet: keep finger down without lifting or sliding
  const { c, ctx, W, H } = makeCanvas(root, 260);
  let down = false;
  let px = 0;
  let py = 0;
  let good = 0;
  let frames = 0;
  c.addEventListener('pointerdown', (e) => {
    down = true;
    const r = c.getBoundingClientRect();
    px = e.clientX - r.left;
    py = e.clientY - r.top;
  });
  c.addEventListener('pointermove', (e) => {
    const r = c.getBoundingClientRect();
    px = e.clientX - r.left;
    py = e.clientY - r.top;
  });
  c.addEventListener('pointerup', () => (down = false));
  c.addEventListener('pointercancel', () => (down = false));
  const tb = timerBar(root);
  await loop(dur, (t, f) => {
    tb(f);
    const dx = W / 2 + Math.sin(t / 900) * W * 0.25;
    const dy = H / 2 + Math.cos(t / 1100) * H * 0.2;
    frames++;
    const on = down && Math.hypot(px - dx, py - dy) < 40;
    if (on) good++;
    ink(ctx, W, H);
    ctx.fillStyle = on ? '#2e6b2e' : '#b8a37a';
    ctx.beginPath();
    ctx.arc(dx, dy, 40, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
  return clamp((good / Math.max(1, frames)) * 1.15);
}

// ---------------------------------------------------------------- specific games

async function rune(root: HTMLElement, p: MiniPrompt): Promise<MiniResult> {
  const shape = RUNE_SHAPES[p.param ?? 'circle'] ?? RUNE_SHAPES.circle!;
  root.appendChild(h('div', { class: 'center' }, `Rune: ${shape.label}`));
  const { c, ctx, W, H } = makeCanvas(root, 320);
  const pts: Pt[] = [];
  let drawing = false;
  let done = false;
  // guide
  const xs = shape.points.map((q) => q[0]);
  const ys = shape.points.map((q) => q[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const sc = Math.min(W, H) * 0.7 / Math.max(maxX - minX, maxY - minY, 0.01);
  const ox = W / 2 - ((minX + maxX) / 2) * sc;
  const oy = H / 2 - ((minY + maxY) / 2) * sc;
  const drawGuide = () => {
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.setLineDash([8, 8]);
    ctx.strokeStyle = 'rgba(184,134,11,0.55)';
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.beginPath();
    shape.points.forEach(([x, y], i) => (i ? ctx.lineTo(ox + x * sc, oy + y * sc) : ctx.moveTo(ox + x * sc, oy + y * sc)));
    ctx.stroke();
    const [sx, sy] = shape.points[0]!;
    ctx.fillStyle = '#2e6b2e';
    ctx.beginPath();
    ctx.arc(ox + sx * sc, oy + sy * sc, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = '#3b1f8a';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  };
  drawGuide();
  const pos = (e: PointerEvent): Pt => {
    const r = c.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  c.addEventListener('pointerdown', (e) => {
    if (done) return;
    c.setPointerCapture(e.pointerId);
    drawing = true;
    pts.length = 0;
    pts.push(pos(e));
    drawGuide();
  });
  c.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    pts.push(pos(e));
    drawGuide();
  });
  const finish = () => {
    if (!drawing) return;
    drawing = false;
    if (pts.length > 8) done = true;
  };
  c.addEventListener('pointerup', finish);
  c.addEventListener('pointercancel', finish);
  const tb = timerBar(root);
  await loop(p.duration, (_t, f) => {
    tb(f);
    return done;
  });
  const local = scoreRune(pts, p.param ?? 'circle').score;
  return { score: local, points: pts.map(([x, y]) => [Math.round(x), Math.round(y)]) };
}

async function swing(root: HTMLElement, dur: number): Promise<number> {
  let peak = 0;
  const meter = h('div', { class: 'bar hp mgmeter' }, h('i', { style: 'width:0%' }));
  root.appendChild(meter);
  const tb = timerBar(root);
  await loop(dur, (_t, f) => {
    tb(f);
    peak = Math.max(peak, S.accel);
    (meter.firstChild as HTMLElement).style.width = `${clamp((peak - 6) / 24) * 100}%`;
    if (peak > 28) return true;
  });
  haptic([60, 40, 120]);
  return clamp((peak - 6) / 24);
}

async function shake(root: HTMLElement, dur: number): Promise<number> {
  let sum = 0;
  let last = performance.now();
  const meter = h('div', { class: 'bar hp mgmeter' }, h('i', { style: 'width:0%' }));
  root.appendChild(meter);
  const tb = timerBar(root);
  const target = (dur / 1000) * 14;
  await loop(dur, (_t, f) => {
    tb(f);
    const now = performance.now();
    sum += S.accel * ((now - last) / 1000);
    last = now;
    (meter.firstChild as HTMLElement).style.width = `${clamp(sum / target) * 100}%`;
  });
  return clamp(sum / target);
}

async function steady(root: HTMLElement, dur: number): Promise<number> {
  let total = 0;
  let frames = 0;
  const dot = h('div', { class: 'mgsteady' }, '🎯');
  root.appendChild(dot);
  const tb = timerBar(root);
  await loop(dur, (_t, f) => {
    tb(f);
    total += S.accel;
    frames++;
    dot.style.transform = `translate(${S.accelX * 6}px, ${S.accelY * 6}px)`;
  });
  return clamp(1 - total / Math.max(1, frames) / 2.2);
}

async function micGame(root: HTMLElement, dur: number, kind: 'shout' | 'blow' | 'quiet'): Promise<number> {
  const meter = h('div', { class: 'bar sp mgmeter' }, h('i', { style: 'width:0%' }));
  root.appendChild(meter);
  const tb = timerBar(root);
  const samples: number[] = [];
  await loop(dur, (_t, f) => {
    tb(f);
    samples.push(S.vol);
    (meter.firstChild as HTMLElement).style.width = `${S.vol * 100}%`;
  });
  stopMic();
  if (!samples.length) return 0;
  if (kind === 'quiet') {
    const loud = samples.filter((v) => v > 0.1).length / samples.length;
    const spike = Math.max(...samples);
    return clamp(1 - loud * 2 - Math.max(0, spike - 0.35));
  }
  const sorted = [...samples].sort((a, b) => b - a);
  if (kind === 'shout') {
    const top = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.3)));
    return clamp((top.reduce((a, b) => a + b, 0) / top.length) / 0.6);
  }
  return clamp((samples.filter((v) => v > 0.22).length / samples.length) * 1.4);
}

async function hum(root: HTMLElement, dur: number, useMic: boolean): Promise<number> {
  const target = 160 + Math.random() * 160;
  const { ctx, W, H } = makeCanvas(root, 220);
  let inBand = 0;
  let frames = 0;
  let slider: HTMLInputElement | undefined;
  let osc: OscillatorNode | undefined;
  let actx: AudioContext | undefined;
  if (!useMic) {
    slider = h('input', { type: 'range', min: 100, max: 400, value: 250, style: 'width:100%' });
    root.appendChild(slider);
    try {
      actx = new AudioContext();
      osc = actx.createOscillator();
      const g = actx.createGain();
      g.gain.value = 0.08;
      osc.connect(g).connect(actx.destination);
      osc.start();
    } catch {
      /* no audio */
    }
  }
  const tb = timerBar(root);
  await loop(dur, (t, f) => {
    tb(f);
    const pitch = useMic ? S.pitch : Number(slider!.value);
    // for the fallback the tone you hear is the target; the slider tone alternates
    if (osc && actx) osc.frequency.setValueAtTime(Math.floor(t / 700) % 2 === 0 ? target : pitch, actx.currentTime);
    frames++;
    const ok = pitch > 0 && Math.abs(Math.log2(pitch / target)) < 0.09;
    if (ok) inBand++;
    ink(ctx, W, H);
    const y = (hz: number) => H - ((Math.log2(Math.max(80, hz)) - Math.log2(80)) / (Math.log2(500) - Math.log2(80))) * H;
    ctx.fillStyle = 'rgba(212,160,23,0.45)';
    ctx.fillRect(0, y(target * 1.065), W, y(target / 1.065) - y(target * 1.065));
    if (pitch > 0) {
      ctx.fillStyle = ok ? '#2e6b2e' : '#7a1f1f';
      ctx.beginPath();
      ctx.arc(W / 2, y(pitch), 12, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  osc?.stop();
  void actx?.close();
  if (useMic) stopMic();
  return clamp((inBand / Math.max(1, frames)) * 1.6);
}

async function scan(root: HTMLElement, dur: number, useCompass: boolean): Promise<number> {
  const target = Math.random() * 360;
  const { c, ctx, W, H } = makeCanvas(root, 260);
  let heading = 0;
  let dragStart: number | null = null;
  let headStart = 0;
  if (!useCompass) {
    c.addEventListener('pointerdown', (e) => {
      dragStart = e.clientX;
      headStart = heading;
    });
    c.addEventListener('pointermove', (e) => {
      if (dragStart !== null) heading = (headStart + (e.clientX - dragStart) * 0.8 + 720) % 360;
    });
    c.addEventListener('pointerup', () => (dragStart = null));
  }
  let lockMs = 0;
  let foundAt = -1;
  let lastBuzz = 0;
  let lastT = 0;
  const tb = timerBar(root);
  await loop(dur, (t, f) => {
    tb(f);
    if (useCompass) heading = S.alpha;
    const diff = Math.abs(((heading - target + 540) % 360) - 180);
    const warmth = 1 - diff / 180;
    const interval = 120 + diff * 6;
    if (t - lastBuzz > interval) {
      lastBuzz = t;
      haptic(diff < 20 ? 60 : 20);
    }
    if (diff < 15) lockMs += t - lastT;
    else lockMs = 0;
    lastT = t;
    if (lockMs > 800 && foundAt < 0) foundAt = t;
    ink(ctx, W, H);
    const r = Math.min(W, H) * 0.38;
    ctx.fillStyle = `rgb(${Math.round(120 + warmth * 135)},${Math.round(90 + warmth * 60)},${Math.round(160 - warmth * 120)})`;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate((heading * Math.PI) / 180);
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(10, 0);
    ctx.lineTo(-10, 0);
    ctx.closePath();
    ctx.fillStyle = '#2b1d0e';
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#2b1d0e';
    ctx.font = '18px Georgia';
    ctx.textAlign = 'center';
    ctx.fillText(diff < 15 ? 'HOT! hold...' : diff < 45 ? 'warmer' : 'cold', W / 2, H - 10);
    return foundAt >= 0;
  });
  if (foundAt < 0) return 0.15;
  return clamp(1.1 - foundAt / dur);
}

async function holdCharge(root: HTMLElement, dur: number): Promise<number> {
  const { c, ctx, W, H } = makeCanvas(root, 200);
  let down = -1;
  let released = -1;
  let level = 0;
  c.addEventListener('pointerdown', () => (down = performance.now()));
  const up = () => {
    if (down >= 0 && released < 0) released = level;
  };
  c.addEventListener('pointerup', up);
  c.addEventListener('pointercancel', up);
  await loop(dur, () => {
    if (down >= 0 && released < 0) {
      const t = (performance.now() - down) / 1100;
      level = 1 - Math.abs((t % 2) - 1); // ping-pong 0..1..0
    }
    ink(ctx, W, H);
    ctx.fillStyle = '#e8d28a';
    ctx.fillRect(40, H * 0.06, W - 80, H * 0.88 * 0.2);
    ctx.strokeRect(40, 10, W - 80, H - 20);
    ctx.fillStyle = '#a23b2c';
    const v = released >= 0 ? released : level;
    ctx.fillRect(44, H - 14 - (H - 28) * v, W - 88, (H - 28) * v);
    ctx.fillStyle = '#2b1d0e';
    ctx.font = '18px Georgia';
    ctx.textAlign = 'center';
    ctx.fillText(down < 0 ? 'Press & hold' : released >= 0 ? 'Released!' : 'Release in the gold!', W / 2, H / 2);
    return released >= 0;
  });
  if (released < 0) return down >= 0 ? clamp(level) * 0.6 : 0;
  const target = 0.88;
  return clamp(1 - Math.abs(released - target) * 3.5);
}

async function rhythm(root: HTMLElement): Promise<number> {
  const beat = 600;
  const n = 6;
  const pad = h('button', { class: 'mgpad' }, '🥁');
  root.appendChild(pad);
  const t0 = performance.now() + beat * 2;
  const taps: number[] = [];
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    taps.push(performance.now());
    pad.classList.add('hit');
    setTimeout(() => pad.classList.remove('hit'), 90);
  });
  await loop(beat * (n + 2.5), (t) => {
    const k = Math.floor((t + 0) / beat);
    const phase = (t % beat) / beat;
    pad.style.boxShadow = phase < 0.18 ? '0 0 0 14px rgba(184,134,11,0.55)' : 'none';
    pad.textContent = k < 2 ? `${2 - k}…` : '🥁';
  });
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const bt = t0 + i * beat;
    const near = taps.reduce((m, x) => Math.min(m, Math.abs(x - bt)), Infinity);
    acc += clamp(1 - near / 220);
  }
  const spam = Math.max(0, taps.length - n * 1.5) * 0.05;
  return clamp(acc / n - spam);
}

async function sequence(root: HTMLElement, len = 4): Promise<number> {
  const colors = ['#a93226', '#2471a3', '#229954', '#d4a017'];
  const seq = Array.from({ length: len }, () => Math.floor(Math.random() * 4));
  const grid = h('div', { class: 'mgseq' });
  const pads = colors.map((c, i) => h('button', { class: 'mgseqpad', style: `background:${c}`, 'data-i': i }));
  grid.append(...pads);
  const msg = h('div', { class: 'center' }, 'Watch...');
  root.append(msg, grid);
  pads.forEach((p) => (p.disabled = true));
  await sleep(500);
  for (const i of seq) {
    pads[i]!.classList.add('lit');
    haptic(30);
    await sleep(450);
    pads[i]!.classList.remove('lit');
    await sleep(160);
  }
  msg.textContent = 'Your turn!';
  pads.forEach((p) => (p.disabled = false));
  let idx = 0;
  let wrong = false;
  await new Promise<void>((res) => {
    const timeout = setTimeout(res, 9000);
    pads.forEach((p, i) =>
      p.addEventListener('pointerdown', () => {
        if (wrong || idx >= seq.length) return;
        p.classList.add('lit');
        setTimeout(() => p.classList.remove('lit'), 150);
        if (seq[idx] === i) idx++;
        else wrong = true;
        if (wrong || idx >= seq.length) {
          clearTimeout(timeout);
          setTimeout(res, 200);
        }
      }),
    );
  });
  return clamp(idx / seq.length);
}

async function twoFinger(root: HTMLElement, dur: number, multi: boolean): Promise<number> {
  const { c, ctx, W, H } = makeCanvas(root, 300);
  const touches = new Map<number, [number, number]>();
  let alternations = 0;
  let lastHit = -1;
  const pos = (e: PointerEvent): [number, number] => {
    const r = c.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  let A: [number, number] = [W * 0.28, H * 0.5];
  let B: [number, number] = [W * 0.72, H * 0.5];
  c.addEventListener('pointerdown', (e) => {
    touches.set(e.pointerId, pos(e));
    if (!multi) {
      const p = pos(e);
      const hit = Math.hypot(p[0] - A[0], p[1] - A[1]) < 46 ? 0 : Math.hypot(p[0] - B[0], p[1] - B[1]) < 46 ? 1 : -1;
      if (hit >= 0 && hit !== lastHit) {
        alternations++;
        lastHit = hit;
      }
    }
  });
  c.addEventListener('pointermove', (e) => touches.has(e.pointerId) && touches.set(e.pointerId, pos(e)));
  const up = (e: PointerEvent) => touches.delete(e.pointerId);
  c.addEventListener('pointerup', up);
  c.addEventListener('pointercancel', up);
  let held = 0;
  let last = performance.now();
  const tb = timerBar(root);
  await loop(dur, (t, f) => {
    tb(f);
    A = [W * 0.28 + Math.sin(t / 800) * 20, H * 0.5 + Math.cos(t / 700) * 40];
    B = [W * 0.72 + Math.cos(t / 900) * 20, H * 0.5 + Math.sin(t / 650) * 40];
    const pts = [...touches.values()];
    const onA = pts.some((p) => Math.hypot(p[0] - A[0], p[1] - A[1]) < 46);
    const onB = pts.some((p) => Math.hypot(p[0] - B[0], p[1] - B[1]) < 46);
    const now = performance.now();
    if (onA && onB) held += now - last;
    last = now;
    ink(ctx, W, H);
    for (const [p, on] of [[A, onA], [B, onB]] as const) {
      ctx.fillStyle = on ? '#2e6b2e' : '#c9b48a';
      ctx.beginPath();
      ctx.arc(p[0], p[1], 46, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  });
  return multi ? clamp(held / (dur * 0.6)) : clamp(alternations / ((dur / 1000) * 4));
}


async function search(root: HTMLElement, dur: number): Promise<number> {
  const { c, ctx, W, H } = makeCanvas(root, 320);
  const gx = 40 + Math.random() * (W - 80);
  const gy = 40 + Math.random() * (H - 80);
  const dust = document.createElement('canvas');
  dust.width = Math.ceil(W);
  dust.height = H;
  const dctx = dust.getContext('2d')!;
  dctx.fillStyle = '#b89c6c';
  dctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 400; i++) {
    dctx.fillStyle = `rgba(${90 + Math.random() * 60},${70 + Math.random() * 40},40,0.35)`;
    dctx.fillRect(Math.random() * W, Math.random() * H, 3, 3);
  }
  let rubbing = false;
  let erased = 0;
  let foundAt = -1;
  const t0 = performance.now();
  const rub = (e: PointerEvent) => {
    const r = c.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    dctx.globalCompositeOperation = 'destination-out';
    dctx.beginPath();
    dctx.arc(x, y, 18, 0, Math.PI * 2);
    dctx.fill();
    erased += 1;
    if (foundAt < 0 && Math.hypot(x - gx, y - gy) < 20) {
      // check how uncovered the gem is
      const px = dctx.getImageData(Math.max(0, gx - 12), Math.max(0, gy - 12), 24, 24).data;
      let clear = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i]! < 40) clear++;
      if (clear / (px.length / 4) > 0.5) {
        foundAt = performance.now() - t0;
        haptic([30, 30, 90]);
      }
    }
  };
  c.addEventListener('pointerdown', (e) => {
    rubbing = true;
    c.setPointerCapture(e.pointerId);
    rub(e);
  });
  c.addEventListener('pointermove', (e) => rubbing && rub(e));
  c.addEventListener('pointerup', () => (rubbing = false));
  const tb = timerBar(root);
  await loop(dur, (_t, f) => {
    tb(f);
    ctx.clearRect(0, 0, W, H);
    ctx.font = '34px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('💎', gx, gy);
    ctx.drawImage(dust, 0, 0, W, H);
    return foundAt >= 0 && performance.now() - t0 > foundAt + 400;
  });
  if (foundAt < 0) return 0.1;
  const messy = Math.min(0.35, erased / 1200);
  return clamp(1.15 - foundAt / dur - messy);
}

async function listen(root: HTMLElement, dur: number): Promise<number> {
  const ear = h('button', { class: 'mgpad', style: 'transition: box-shadow .4s' }, '👂');
  root.appendChild(ear);
  const tb = timerBar(root);
  const cues = [0.2, 0.5, 0.78].map((f) => (f + (Math.random() - 0.5) * 0.12) * dur);
  const taps: number[] = [];
  let actx: AudioContext | undefined;
  try {
    actx = new AudioContext();
  } catch {
    /* silent fallback: shimmer only */
  }
  const played = new Set<number>();
  const t0 = performance.now();
  ear.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    taps.push(performance.now() - t0);
  });
  await loop(dur, (t, f) => {
    tb(f);
    cues.forEach((ct, i) => {
      if (!played.has(i) && t >= ct) {
        played.add(i);
        if (actx) {
          const o = actx.createOscillator();
          const g = actx.createGain();
          o.frequency.value = 900 + Math.random() * 900;
          g.gain.setValueAtTime(0.0001, actx.currentTime);
          g.gain.exponentialRampToValueAtTime(0.05, actx.currentTime + 0.05);
          g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.35);
          o.connect(g).connect(actx.destination);
          o.start();
          o.stop(actx.currentTime + 0.4);
        }
        ear.style.boxShadow = '0 0 0 6px rgba(184,134,11,0.25)';
        setTimeout(() => (ear.style.boxShadow = 'none'), 350);
      }
    });
  });
  void actx?.close();
  let score = 0;
  for (const ct of cues) {
    const hit = taps.find((x) => x >= ct && x - ct < 1300);
    if (hit !== undefined) score += clamp(1 - (hit - ct) / 1300);
  }
  const falseTaps = taps.filter((x) => !cues.some((ct) => x >= ct && x - ct < 1300)).length;
  return clamp(score / cues.length - falseTaps * 0.15);
}

async function plates(root: HTMLElement, dur: number): Promise<number> {
  const plate = h('button', { class: 'mgpad', style: 'border-radius:18px' }, '🦶');
  const tl = h('div', { class: 'bar', style: 'height:26px;position:relative' }, h('i', { style: 'width:0%;background:#7a1f1f' }));
  const win = h('div', { style: 'position:absolute;top:0;bottom:0;left:35%;width:40%;background:rgba(212,160,23,0.35)' });
  tl.appendChild(win);
  root.append(tl, plate);
  let down = false;
  plate.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    down = true;
    plate.classList.add('hit');
  });
  const up = () => {
    down = false;
    plate.classList.remove('hit');
  };
  plate.addEventListener('pointerup', up);
  plate.addEventListener('pointercancel', up);
  plate.addEventListener('pointerleave', up);
  let inWin = 0;
  let winFrames = 0;
  let outside = 0;
  let outFrames = 0;
  await loop(dur, (_t, f) => {
    (tl.firstChild as HTMLElement).style.width = `${f * 100}%`;
    const inside = f >= 0.35 && f <= 0.75;
    win.style.background = inside ? 'rgba(212,160,23,0.85)' : 'rgba(212,160,23,0.35)';
    if (inside) {
      winFrames++;
      if (down) inWin++;
    } else {
      outFrames++;
      if (down) outside++;
    }
  });
  return clamp(inWin / Math.max(1, winFrames) - (outside / Math.max(1, outFrames)) * 0.6);
}

// ---------------------------------------------------------------- entry

export async function playMinigame(root: HTMLElement, p: MiniPrompt): Promise<MiniResult> {
  const info = INFO[p.game] ?? INFO.tap!;
  clear(root);
  let forceTouch = false;
  const startBtn = h('button', { class: 'primary mgbig' }, '▶ START');
  const touchToggle = info.sensor ? h('button', { class: 'ghost small' }, `Use touch instead (${info.fallback})`) : null;
  root.append(h('h2', { class: 'center' }, info.title), h('div', { class: 'center mghow' }, info.how), h('div', { class: 'center small muted' }, p.title), startBtn);
  if (touchToggle) root.append(touchToggle);
  await new Promise<void>((res) => {
    startBtn.addEventListener('click', () => res(), { once: true });
    touchToggle?.addEventListener('click', () => {
      forceTouch = true;
      res();
    });
  });
  // permissions (needs the tap above)
  let sensorOk = false;
  if (!forceTouch && info.sensor === 'motion') sensorOk = await requestMotion();
  if (!forceTouch && info.sensor === 'orientation') sensorOk = (await requestMotion()) && caps.orientation;
  if (!forceTouch && info.sensor === 'mic') sensorOk = await startMic();
  const fallback = !!info.sensor && !sensorOk;
  clear(root);
  root.appendChild(h('h2', { class: 'center' }, info.title));
  root.appendChild(h('div', { class: 'center mghow' }, fallback ? `${info.fallback}` : info.how));
  const arena = h('div', { class: 'mgarena' });
  root.appendChild(arena);
  const dur = p.duration;
  let score = 0;
  let points: Pt[] | undefined;
  switch (p.game) {
    case 'rune': {
      const r = await rune(arena, p);
      score = r.score;
      points = r.points;
      break;
    }
    case 'swing':
      score = fallback ? await timingBar(arena, dur + 1500) : await swing(arena, dur);
      break;
    case 'shake':
      score = fallback ? await tapMash(arena, dur) : await shake(arena, dur);
      break;
    case 'steady':
      score = fallback ? await holdStill(arena, dur) : await steady(arena, dur);
      break;
    case 'tilt':
      score = await dragTarget(arena, dur, !fallback);
      break;
    case 'shout':
    case 'blow':
      score = fallback ? await tapMash(arena, dur) : await micGame(arena, dur, p.game);
      break;
    case 'quiet':
      score = fallback ? await holdStill(arena, dur) : await micGame(arena, dur, 'quiet');
      break;
    case 'hum':
      score = await hum(arena, dur, !fallback);
      break;
    case 'scan':
      score = await scan(arena, dur, !fallback);
      break;
    case 'hold':
      score = await holdCharge(arena, dur + 2000);
      break;
    case 'rhythm':
      score = await rhythm(arena);
      break;
    case 'sequence':
      score = await sequence(arena, 4 + (p.difficulty ?? 0));
      break;
    case 'twofinger':
      score = await twoFinger(arena, dur, caps.multitouch);
      break;
    case 'search':
      score = await search(arena, dur);
      break;
    case 'listen':
      score = await listen(arena, dur);
      break;
    case 'plates':
      score = await plates(arena, dur);
      break;
    default:
      score = await tapMash(arena, dur);
  }
  const pct = Math.round(score * 100);
  clear(root);
  root.appendChild(h('div', { class: 'center mgresult' }, h('div', { style: 'font-size:4em' }, pct >= 80 ? '🌟' : pct >= 45 ? '👍' : '😅'), h('h2', null, pct >= 80 ? 'PERFECT!' : pct >= 45 ? 'Nice!' : 'Oof.'), h('div', null, `${pct}%`)));
  haptic(pct >= 80 ? [40, 30, 40, 30, 120] : 50);
  await sleep(700);
  return { score, points, fallback };
}
