/**
 * Phone minigames. Each returns a score in 0..1 (the server re-scores runes and
 * clamps everything). Every sensor game has a touch-only fallback.
 */
import { h, clear } from '../../shared/src/browser/dom.js';
import { sfx } from '../../shared/src/browser/audio.js';
import { RUNE_SHAPES, runeBox, runeInkDistance, scoreRune, type Pt } from '../../shared/src/gestures.js';
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
  rune: { title: '✍️ Draw the rune', how: 'Trace the glowing shape in one stroke, start at the green dot and stay on the line!', fallback: '' },
  swing: { title: '🏏 Swing!', how: 'Hold your phone tight and swing it like a sword!', fallback: 'Tap when the marker is in the gold zone.', sensor: 'motion' },
  shout: { title: '📣 Battle cry!', how: 'SHOUT into your phone as loud as you can!', fallback: 'Tap as fast as you can!', sensor: 'mic' },
  tilt: { title: '🎯 Aim!', how: 'Tilt your phone to keep the crosshair on the target.', fallback: 'Drag the crosshair to stay on the target.', sensor: 'orientation' },
  shake: { title: '🫨 Shake it!', how: 'Shake your phone hard!', fallback: 'Tap as fast as you can!', sensor: 'motion' },
  hold: { title: '✊ Charge it!', how: 'Press and hold, release when the bar is in the gold zone.', fallback: '' },
  rhythm: { title: '🥁 Keep the beat!', how: 'Tap on every flashing beat.', fallback: '' },
  steady: { title: '🧘 Hold steady...', how: 'Keep your phone perfectly still!', fallback: 'Keep your finger on the drifting dot.', sensor: 'motion' },
  blow: { title: '🌬️ Blow!', how: 'Blow into the microphone — long and hard!', fallback: 'Tap as fast as you can!', sensor: 'mic' },
  hum: { title: '🎵 Hum the note', how: 'Hum and slide your voice into the golden band.', fallback: 'Slide to match the tone you hear.', sensor: 'mic' },
  scan: { title: '🧭 Search around', how: 'Turn slowly around the room. The beeps (and buzzes) speed up and rise as you get closer. Sound on!', fallback: 'Spin the dial: it beeps faster and glows warmer when you are close.', sensor: 'orientation' },
  sequence: { title: '🧩 Remember the pattern', how: 'Watch the pads light up, then repeat the sequence.', fallback: '' },
  twofinger: { title: '✌️ Two-finger trick', how: 'Hold BOTH circles at once with two fingers!', fallback: 'Tap the two circles back and forth, fast!' },
  quiet: { title: '🤫 Stay silent...', how: 'Be completely quiet. Shhh!', fallback: 'Keep your finger perfectly still on the button.', sensor: 'mic' },
  tap: { title: '👆 Tap frenzy!', how: 'Tap as fast as you can!', fallback: '' },
  search: { title: '🔍 Search by touch', how: 'Rub away the dust to find what is hidden. Be quick — and tidy!', fallback: '' },
  listen: { title: '👂 Listen closely', how: 'Something faint will sound (and shimmer). Tap the ear the moment you notice it — three times.', fallback: '' },
  plates: { title: '🦶 Pressure plate', how: 'Everyone together: HOLD your plate only while the bar glows gold!', fallback: '' },
  lockpick: { title: '🔓 Pick the lock', how: 'Tilt your phone left/right to turn the dial. Ticks get louder near a tumbler; hold still on it until it CLICKS. Sound on!', fallback: 'Drag around the dial to turn it. Ticks get louder near a tumbler; hold still on it until it CLICKS.', sensor: 'orientation' },
  parry: { title: '🛡️ Parry!', how: 'Blows close in on your shield. Tap the moment each ring touches it. Not too early!', fallback: '' },
  balance: { title: '🪢 Keep your balance', how: 'Tilt your phone against the lean to stay upright. Gusts are coming!', fallback: 'Hold the LEFT or RIGHT side of the rope area to lean against the sway.', sensor: 'orientation' },
};

/** Unlock audio inside the Start tap (iOS only allows it in a user gesture). */
function unlockAudio(): void {
  sfx.unlock();
  // iOS mutes WebAudio with the ring/silent switch unless the page asks for a playback session
  // (Safari 16.4+). On iPhone the sound cues replace vibration, so ask for it during minigames.
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  try {
    if (nav.audioSession) nav.audioSession.type = 'playback';
  } catch {
    /* older Safari */
  }
}

function releaseAudioSession(): void {
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  try {
    if (nav.audioSession) nav.audioSession.type = 'auto';
  } catch {
    /* older Safari */
  }
}

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

/** Shrinking time bar. With `dur` it also ticks (and turns red) over the last 1.5 s. */
function timerBar(root: HTMLElement, dur?: number) {
  const bar = h('div', { class: 'bar xp', style: 'margin-top:8px' }, h('i', { style: 'width:100%' }));
  root.appendChild(bar);
  let lastTick = -1;
  return (frac: number): void => {
    const fill = bar.firstChild as HTMLElement;
    fill.style.width = `${Math.max(0, 100 - frac * 100)}%`;
    if (!dur || frac >= 1) return;
    const left = (1 - frac) * dur;
    if (left < 1500) {
      const k = Math.floor(left / 500);
      if (k !== lastTick) {
        lastTick = k;
        sfx.play('countdown');
        fill.style.background = '#a93226';
      }
    }
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
  const tb = timerBar(root, dur);
  const goal = (dur / 1000) * 6.5;
  btn.style.transition = 'transform .06s';
  count.style.transition = 'transform .08s';
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    taps++;
    count.textContent = String(taps);
    // the knock climbs in pitch as you near the goal: a little escalation you can hear
    sfx.knock(clamp(taps / goal));
    btn.style.transform = 'scale(0.95)';
    count.style.transform = `scale(${1.15 + clamp(taps / goal) * 0.35})`;
    setTimeout(() => {
      btn.style.transform = '';
      count.style.transform = '';
    }, 60);
    if (taps >= goal) count.style.color = '#b8860b';
    if (taps % 5 === 0) haptic(15);
  });
  await loop(dur, (_t, f) => tb(f));
  btn.disabled = true;
  return clamp(taps / goal);
}

async function timingBar(root: HTMLElement, dur: number): Promise<number> {
  const { ctx, W, H } = makeCanvas(root, 120);
  let pos = 0;
  let stopped = -1;
  const btn = h('button', { class: 'primary mgbig' }, 'STRIKE!');
  root.appendChild(btn);
  btn.addEventListener('pointerdown', () => {
    if (stopped >= 0) return;
    stopped = pos;
    sfx.swish(clamp(1 - Math.abs(stopped - 0.5) * 3.2));
  });
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
  const tb = timerBar(root, dur);
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
  const tb = timerBar(root, dur);
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
  const name = RUNE_SHAPES[p.param ?? ''] ? p.param! : 'circle';
  const shape = RUNE_SHAPES[name]!;
  root.appendChild(h('div', { class: 'center' }, `Rune: ${shape.label}`));
  const { c, ctx, W, H } = makeCanvas(root, 320);
  // screen pixels while drawing; sent to the server in the rune's own shape units (see below)
  const pts: Pt[] = [];
  const near: number[] = []; // per point: 0 on the line .. 1 far off (for the ink colour)
  let drawing = false;
  let done = false;
  // guide: the template's bounding box fills 70% of the short side, centred
  const box = runeBox(name);
  const sc = (Math.min(W, H) * 0.7) / box.size;
  const ox = W / 2 - ((box.minX + box.maxX) / 2) * sc;
  const oy = H / 2 - ((box.minY + box.maxY) / 2) * sc;
  const toShape = ([x, y]: Pt): Pt => [(x - ox) / sc, (y - oy) / sc];
  const inkColour = (d: number) => (d < 0.06 ? '#3b1f8a' : d < 0.16 ? '#b8860b' : '#a93226');
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
    // ink: violet on the line, gold when drifting, red when clearly off (that ink costs points)
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < pts.length; i++) {
      ctx.strokeStyle = inkColour(near[i]!);
      ctx.beginPath();
      ctx.moveTo(pts[i - 1]![0], pts[i - 1]![1]);
      ctx.lineTo(pts[i]![0], pts[i]![1]);
      ctx.stroke();
    }
  };
  drawGuide();
  const pos = (e: PointerEvent): Pt => {
    const r = c.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  let lastScratch = 0;
  const add = (q: Pt) => {
    pts.push(q);
    const d = runeInkDistance(toShape(q), name);
    near.push(d);
    // quill scratch: bright when on the line, dull and quiet when off it
    const now = performance.now();
    if (now - lastScratch > 55) {
      lastScratch = now;
      sfx.detent(clamp(1 - d / 0.16) * 0.6);
    }
  };
  c.addEventListener('pointerdown', (e) => {
    if (done) return;
    c.setPointerCapture(e.pointerId);
    drawing = true;
    pts.length = 0;
    near.length = 0;
    add(pos(e));
    drawGuide();
  });
  c.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    add(pos(e));
    drawGuide();
  });
  const finish = () => {
    if (!drawing) return;
    drawing = false;
    if (pts.length > 8) done = true;
  };
  c.addEventListener('pointerup', finish);
  c.addEventListener('pointercancel', finish);
  const tb = timerBar(root, p.duration);
  await loop(p.duration, (_t, f) => {
    tb(f);
    return done;
  });
  // Shape units keep the scoring independent of the canvas size, and let the server check the
  // trace against where the guide actually was (position and size count, not just the shape).
  const shapePts = pts.map((q) => toShape(q).map((v) => Math.round(v * 1000) / 1000) as Pt);
  const local = scoreRune(shapePts, name);
  if (local.best && local.best !== name && local.score < 0.45) {
    root.appendChild(h('div', { class: 'center muted' }, `That looked more like a ${RUNE_SHAPES[local.best]?.label ?? local.best}...`));
    await sleep(600);
  }
  return { score: local.score, points: shapePts };
}

async function swing(root: HTMLElement, dur: number): Promise<number> {
  let peak = 0;
  const meter = h('div', { class: 'bar hp mgmeter' }, h('i', { style: 'width:0%' }));
  root.appendChild(meter);
  const tb = timerBar(root, dur);
  let swished = false;
  const whoosh = () => {
    if (swished) return;
    swished = true;
    sfx.swish(clamp((peak - 6) / 24));
  };
  await loop(dur, (_t, f) => {
    tb(f);
    peak = Math.max(peak, S.accel);
    (meter.firstChild as HTMLElement).style.width = `${clamp((peak - 6) / 24) * 100}%`;
    // the whoosh plays as the swing ends (acceleration falling off its peak), scaled by its force
    if (peak > 10 && S.accel < peak * 0.55) whoosh();
    if (peak > 28) return true;
  });
  if (peak > 8) whoosh();
  haptic([60, 40, 120]);
  return clamp((peak - 6) / 24);
}

async function shake(root: HTMLElement, dur: number): Promise<number> {
  let sum = 0;
  let last = performance.now();
  const meter = h('div', { class: 'bar hp mgmeter' }, h('i', { style: 'width:0%' }));
  root.appendChild(meter);
  const tb = timerBar(root, dur);
  const target = (dur / 1000) * 14;
  await loop(dur, (_t, f) => {
    tb(f);
    if (S.accel > 6) sfx.rattle(clamp(S.accel / 30));
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
  const tb = timerBar(root, dur);
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
  // the shared synth was unlocked by the Start tap, so this also plays on iOS
  const tone = useMic ? undefined : sfx.drone('sine');
  if (!useMic) {
    slider = h('input', { type: 'range', min: 100, max: 400, value: 250, style: 'width:100%' });
    root.appendChild(slider);
  }
  const tb = timerBar(root, useMic ? undefined : dur); // no ticks into the pitch detector
  await loop(dur, (t, f) => {
    tb(f);
    const pitch = useMic ? S.pitch : Number(slider!.value);
    // for the fallback the tone you hear is the target; the slider tone alternates
    tone?.set(Math.floor(t / 700) % 2 === 0 ? target : pitch, 0.08);
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
  tone?.stop();
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
  const tb = timerBar(root, dur);
  await loop(dur, (t, f) => {
    tb(f);
    if (useCompass) heading = S.alpha;
    const diff = Math.abs(((heading - target + 540) % 360) - 180);
    const warmth = 1 - diff / 180;
    // geiger-style: ~1.2 s between blips when cold, ~90 ms when hot, and the pitch rises too
    // (iPhone has no vibration, so the sound is the main cue there)
    const interval = 90 + diff * 6;
    if (t - lastBuzz > interval) {
      lastBuzz = t;
      sfx.sonar(diff < 15 ? 1 : warmth ** 1.5 * 0.88);
      haptic(diff < 20 ? 60 : 20);
    }
    if (diff < 15) lockMs += t - lastT;
    else lockMs = 0;
    lastT = t;
    if (lockMs > 800 && foundAt < 0) {
      foundAt = t;
      sfx.play('discover');
    }
    ink(ctx, W, H);
    const r = Math.min(W, H) * 0.38;
    if (lockMs > 0) {
      // lock-on ring fills while you hold on target
      ctx.save();
      ctx.strokeStyle = '#b8860b';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, r + 9, -Math.PI / 2, -Math.PI / 2 + Math.min(1, lockMs / 800) * Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
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
  const charge = sfx.drone('triangle');
  c.addEventListener('pointerdown', () => {
    if (down < 0) down = performance.now();
  });
  const up = () => {
    if (down >= 0 && released < 0) {
      released = level;
      charge.stop();
      sfx.swish(clamp(1 - Math.abs(released - 0.88) * 3.5));
    }
  };
  c.addEventListener('pointerup', up);
  c.addEventListener('pointercancel', up);
  await loop(dur, () => {
    if (down >= 0 && released < 0) {
      const t = (performance.now() - down) / 1100;
      level = 1 - Math.abs((t % 2) - 1); // ping-pong 0..1..0
      charge.set(180 + level * 520, 0.05); // pitch follows the bar so you can release by ear
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
  charge.stop();
  if (released < 0) return down >= 0 ? clamp(level) * 0.6 : 0;
  const target = 0.88;
  return clamp(1 - Math.abs(released - target) * 3.5);
}

async function rhythm(root: HTMLElement): Promise<number> {
  const beat = 600;
  const n = 6;
  const pad = h('button', { class: 'mgpad' }, '🥁');
  root.appendChild(pad);
  const feedback = h('div', { class: 'center mgcount', style: 'font-size:1.6em;min-height:1.4em' }, '');
  root.appendChild(feedback);
  const t0 = performance.now() + beat * 2;
  const taps: number[] = [];
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const now = performance.now();
    taps.push(now);
    sfx.knock(0.6);
    // judge the tap against the nearest beat right away, for feedback only (scoring is below)
    const i = Math.round((now - t0) / beat);
    const off = i >= 0 && i < n ? Math.abs(now - (t0 + i * beat)) : Infinity;
    feedback.textContent = off < 70 ? 'PERFECT!' : off < 150 ? 'Good' : off < 220 ? 'Close' : 'Miss';
    feedback.style.color = off < 70 ? '#b8860b' : off < 150 ? '#2e6b2e' : '#7a1f1f';
    pad.classList.add('hit');
    setTimeout(() => pad.classList.remove('hit'), 90);
  });
  let lastBeat = -1;
  await loop(beat * (n + 2.5), (t) => {
    const k = Math.floor((t + 0) / beat);
    const phase = (t % beat) / beat;
    if (k !== lastBeat && k < n + 2) {
      lastBeat = k;
      if (k < 2) sfx.play('tick'); // count-in
      else sfx.pad(-1); // drum on every beat
    }
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
    sfx.pad(i);
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
        if (seq[idx] === i) {
          idx++;
          sfx.pad(i);
        } else {
          wrong = true;
          sfx.play('bad');
        }
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
        sfx.knock(hit ? 0.7 : 0.4);
      }
    }
  });
  c.addEventListener('pointermove', (e) => touches.has(e.pointerId) && touches.set(e.pointerId, pos(e)));
  const up = (e: PointerEvent) => touches.delete(e.pointerId);
  c.addEventListener('pointerup', up);
  c.addEventListener('pointercancel', up);
  let held = 0;
  let last = performance.now();
  let wasBoth = false;
  const tb = timerBar(root, dur);
  await loop(dur, (t, f) => {
    tb(f);
    A = [W * 0.28 + Math.sin(t / 800) * 20, H * 0.5 + Math.cos(t / 700) * 40];
    B = [W * 0.72 + Math.cos(t / 900) * 20, H * 0.5 + Math.sin(t / 650) * 40];
    const pts = [...touches.values()];
    const onA = pts.some((p) => Math.hypot(p[0] - A[0], p[1] - A[1]) < 46);
    const onB = pts.some((p) => Math.hypot(p[0] - B[0], p[1] - B[1]) < 46);
    const now = performance.now();
    if (onA && onB) held += now - last;
    if (onA && onB && !wasBoth) sfx.play('pin'); // both pins engaged
    wasBoth = onA && onB;
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
    sfx.rattle(0.12); // grit scraping off (throttled inside)
    if (foundAt < 0 && Math.hypot(x - gx, y - gy) < 20) {
      // check how uncovered the gem is
      const px = dctx.getImageData(Math.max(0, gx - 12), Math.max(0, gy - 12), 24, 24).data;
      let clear = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i]! < 40) clear++;
      if (clear / (px.length / 4) > 0.5) {
        foundAt = performance.now() - t0;
        sfx.play('discover');
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
  const tb = timerBar(root, dur);
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
        // via the shared synth, which the Start tap unlocked (a fresh AudioContext created after
        // the permission awaits stayed suspended on iOS)
        sfx.shimmer(900 + Math.random() * 900);
        ear.style.boxShadow = '0 0 0 6px rgba(184,134,11,0.25)';
        setTimeout(() => (ear.style.boxShadow = 'none'), 350);
      }
    });
  });
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
  let wasInside = false;
  await loop(dur, (_t, f) => {
    (tl.firstChild as HTMLElement).style.width = `${f * 100}%`;
    const inside = f >= 0.35 && f <= 0.75;
    if (inside !== wasInside) sfx.play(inside ? 'ping' : 'tick'); // window opens / closes
    wasInside = inside;
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

// ---------------------------------------------------------------- new games

/**
 * Lockpick: a dial with three hidden tumblers. Turn it (tilt = turning speed, or drag around the
 * dial) and feel for each one: the detent ticks get louder and brighter, and the pick trembles,
 * as you approach. Rest on the sweet spot until it clicks. Each tumbler is narrower than the
 * last. Score: share of tumblers set, minus a little for time taken.
 */
async function lockpick(root: HTMLElement, dur: number, useTilt: boolean): Promise<number> {
  const { c, ctx, W, H } = makeCanvas(root, 300);
  const status = h('div', { class: 'center mgcount', style: 'font-size:1.4em' }, '🔒 🔒 🔒');
  root.appendChild(status);
  const PINS = 3;
  const wrap = (x: number) => ((x % 100) + 100) % 100;
  const circDist = (a: number, b: number) => Math.abs(((a - b + 150) % 100) - 50);
  // tumblers well apart from each other and from the starting position
  const spots: number[] = [];
  while (spots.length < PINS) {
    const v = Math.random() * 100;
    if (circDist(v, 0) > 12 && spots.every((s) => circDist(s, v) > 20)) spots.push(v);
  }
  // half-widths in dial units (100 per turn); tilt control is coarser, so it gets a little more
  const widths = [3.2, 2.6, 2.1].map((w) => (useTilt ? w * 1.25 : w));
  const HOLD_MS = 450;
  let dial = 0;
  let set = 0;
  let holdMs = 0;
  let doneAt = -1;
  let lastDetent = 0;
  let lastFrame = performance.now();
  let prevDial = 0;
  let speed = 0; // smoothed dial units per second
  const base = S.gamma;
  const cx = W / 2;
  const cy = H / 2 + 6;
  const R = Math.min(W, H) * 0.36;
  let dragAng: number | null = null;
  const angAt = (e: PointerEvent) => {
    const r = c.getBoundingClientRect();
    return Math.atan2(e.clientY - r.top - cy, e.clientX - r.left - cx);
  };
  c.addEventListener('pointerdown', (e) => {
    c.setPointerCapture(e.pointerId);
    dragAng = angAt(e);
  });
  c.addEventListener('pointermove', (e) => {
    if (dragAng === null) return;
    const a = angAt(e);
    let d = a - dragAng;
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    dragAng = a;
    dial = wrap(dial + (d / (Math.PI * 2)) * 100);
  });
  const up = () => (dragAng = null);
  c.addEventListener('pointerup', up);
  c.addEventListener('pointercancel', up);
  const tb = timerBar(root, dur);
  await loop(dur, (t, f) => {
    tb(f);
    const now = performance.now();
    const realDt = (now - lastFrame) / 1000;
    const dt = Math.min(0.05, realDt);
    lastFrame = now;
    if (useTilt && dragAng === null && set < PINS) {
      // tilt sets the turning speed (with a dead zone), so a tiny lean gives fine control
      const g = S.gamma - base;
      const v = Math.abs(g) < 3 ? 0 : Math.sign(g) * Math.min(1, (Math.abs(g) - 3) / 30) ** 1.6 * 45;
      dial = wrap(dial + v * dt);
    }
    if (realDt > 0) {
      const k = 1 - Math.exp(-realDt / 0.1); // ~0.1 s smoothing, independent of frame rate
      speed += (circDist(dial, prevDial) / realDt - speed) * k;
    }
    prevDial = dial;
    const spot = spots[set];
    const d = spot === undefined ? 99 : circDist(dial, spot);
    const feel = spot === undefined ? 0 : clamp(1 - d / 12);
    // a detent tick each dial unit crossed
    const unit = Math.floor(dial);
    if (unit !== lastDetent && set < PINS) {
      lastDetent = unit;
      sfx.detent(feel);
      if (feel > 0.7) haptic(8);
    }
    // you must REST on the tumbler: sweeping slowly across it does not set it
    if (spot !== undefined && d <= widths[set]! && speed < 1.5) {
      holdMs += dt * 1000;
      if (holdMs >= HOLD_MS) {
        set++;
        holdMs = 0;
        sfx.play(set === PINS ? 'unlock' : 'pin');
        haptic(set === PINS ? [40, 40, 120] : 40);
        status.textContent = Array.from({ length: PINS }, (_, i) => (i < set ? '🔓' : '🔒')).join(' ');
        if (set === PINS) doneAt = t;
      }
    } else if (spot === undefined || d > widths[set]!) holdMs = Math.max(0, holdMs - dt * 2000);

    ink(ctx, W, H);
    // lock body
    ctx.fillStyle = '#d9c7a0';
    ctx.beginPath();
    ctx.arc(cx, cy, R + 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // the dial, rotating with its value, with 100 marks (every 10th long)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-(dial / 100) * Math.PI * 2);
    ctx.fillStyle = '#efe3c6';
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    for (let i = 0; i < 100; i += 2) {
      const a = (i / 100) * Math.PI * 2 - Math.PI / 2;
      const l = i % 10 === 0 ? 14 : 6;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * (R - 2), Math.sin(a) * (R - 2));
      ctx.lineTo(Math.cos(a) * (R - 2 - l), Math.sin(a) * (R - 2 - l));
      ctx.stroke();
    }
    ctx.fillStyle = '#2b1d0e';
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // the pick at the top trembles as you get close (a cue without sound)
    const jit = feel ** 2 * 3 * Math.sin(t / 18);
    ctx.save();
    ctx.translate(cx + jit, cy - R - 18);
    ctx.fillStyle = holdMs > 0 ? '#b8860b' : '#7a1f1f';
    ctx.beginPath();
    ctx.moveTo(0, 16);
    ctx.lineTo(-8, -4);
    ctx.lineTo(8, -4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    if (holdMs > 0) {
      // the click is coming: a ring fills while you rest on the tumbler
      ctx.save();
      ctx.strokeStyle = '#b8860b';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(cx, cy, R + 22, -Math.PI / 2, -Math.PI / 2 + (holdMs / HOLD_MS) * Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    return set >= PINS && t > doneAt + 350;
  });
  const tFrac = doneAt >= 0 ? doneAt / dur : 1;
  return clamp((set / PINS) * (1.15 - 0.4 * tFrac));
}

/**
 * Parry: five blows close in on your shield as shrinking rings, each a little faster. Tap as a
 * ring meets the shield. A tap long before impact is a flinch and wastes that parry, so mashing
 * does not work. Score: mean timing quality (perfect within 70 ms, nothing past 260 ms).
 */
async function parry(root: HTMLElement): Promise<number> {
  const { c, ctx, W, H } = makeCanvas(root, 300);
  const label = h('div', { class: 'center mgcount', style: 'font-size:1.6em;min-height:1.4em' }, 'Ready...');
  root.appendChild(label);
  const travel = [1150, 1000, 860, 740, 640];
  const GAP = 420;
  const PERFECT = 70;
  const WINDOW = 260;
  const cx = W / 2;
  const cy = H / 2;
  const shieldR = 40;
  const startR = Math.min(W, H) / 2 - 6;
  // impact times, after a short lead-in
  const impacts: number[] = [];
  let at = 700;
  for (const tr of travel) {
    at += tr;
    impacts.push(at);
    at += GAP;
  }
  const angles = travel.map(() => Math.random() * Math.PI * 2);
  const results: (number | undefined)[] = travel.map(() => undefined);
  const sparks: { x: number; y: number; vx: number; vy: number; life: number }[] = [];
  let shake = 0;
  let cur = 0;
  let whooshed = -1;
  const t0 = performance.now();
  const resolve = (i: number, v: number, text: string, colour: string) => {
    results[i] = v;
    label.textContent = text;
    label.style.color = colour;
    if (v > 0) {
      sfx.clang(v);
      haptic(v > 0.8 ? [20, 20, 40] : 25);
      const a = angles[i]!;
      for (let k = 0; k < 10 + v * 14; k++) {
        const s = 1.5 + Math.random() * 4;
        const d = a + (Math.random() - 0.5) * 1.6;
        sparks.push({ x: cx + Math.cos(a) * shieldR, y: cy + Math.sin(a) * shieldR, vx: Math.cos(d) * s, vy: Math.sin(d) * s, life: 1 });
      }
    } else {
      sfx.play('hit');
      haptic(80);
      shake = 1;
    }
  };
  c.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (cur >= travel.length || results[cur] !== undefined) return;
    const t = performance.now() - t0;
    const impact = impacts[cur]!;
    if (t < impact - travel[cur]!) return; // between blows: ignore
    const err = t - impact;
    if (err < -WINDOW) resolve(cur, 0, 'Flinched!', '#7a1f1f');
    else {
      const a = Math.abs(err);
      const v = a <= PERFECT ? 1 : clamp(1 - (a - PERFECT) / (WINDOW - PERFECT));
      resolve(cur, v, v >= 0.95 ? 'PARRY!' : v > 0.5 ? (err < 0 ? 'Good (early)' : 'Good (late)') : err < 0 ? 'Too early' : 'Too late', v >= 0.95 ? '#b8860b' : v > 0.5 ? '#2e6b2e' : '#7a1f1f');
    }
  });
  const total = impacts[impacts.length - 1]! + WINDOW + 400;
  await loop(total, (t) => {
    // advance to the next blow once this one is resolved and its impact has passed
    while (cur < travel.length && (results[cur] !== undefined ? t > impacts[cur]! + 80 : t > impacts[cur]! + WINDOW)) {
      if (results[cur] === undefined) resolve(cur, 0, 'Hit!', '#7a1f1f');
      cur++;
    }
    ink(ctx, W, H);
    ctx.save();
    if (shake > 0) {
      ctx.translate((Math.random() - 0.5) * 14 * shake, (Math.random() - 0.5) * 14 * shake);
      shake = Math.max(0, shake - 0.08);
    }
    // shield
    ctx.fillStyle = '#c9b48a';
    ctx.beginPath();
    ctx.arc(cx, cy, shieldR, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.font = '34px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🛡️', cx, cy + 2);
    // the incoming blow
    if (cur < travel.length && results[cur] === undefined) {
      const start = impacts[cur]! - travel[cur]!;
      if (t >= start) {
        if (whooshed !== cur) {
          whooshed = cur;
          sfx.swish(0.25 + cur * 0.08);
        }
        const k = clamp((t - start) / travel[cur]!);
        const r = startR + (shieldR - startR) * k ** 1.6; // accelerates in, like a real swing
        const close = Math.abs(r - shieldR) < 10;
        ctx.strokeStyle = close ? '#b8860b' : '#7a1f1f';
        ctx.lineWidth = close ? 7 : 4;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(shieldR, r), 0, Math.PI * 2);
        ctx.stroke();
        const a = angles[cur]!;
        ctx.fillText('🗡️', cx + Math.cos(a) * Math.max(shieldR + 14, r), cy + Math.sin(a) * Math.max(shieldR + 14, r));
      }
    }
    // sparks
    ctx.fillStyle = '#e3b23c';
    for (const s of sparks) {
      if (s.life <= 0) continue;
      s.x += s.vx;
      s.y += s.vy;
      s.vy += 0.12;
      s.life -= 0.04;
      ctx.globalAlpha = Math.max(0, s.life);
      ctx.fillRect(s.x - 2, s.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    // pips: how each parry went
    results.forEach((v, i) => {
      ctx.fillStyle = v === undefined ? '#d9c7a0' : v >= 0.95 ? '#b8860b' : v > 0.5 ? '#2e6b2e' : v > 0 ? '#c97a3a' : '#7a1f1f';
      ctx.beginPath();
      ctx.arc(W / 2 + (i - 2) * 22, H - 14, 7, 0, Math.PI * 2);
      ctx.fill();
    });
    return cur >= travel.length && t > impacts[impacts.length - 1]! + 400;
  });
  return clamp(results.reduce<number>((a, v) => a + (v ?? 0), 0) / travel.length);
}

/**
 * Tightrope: you lean further the more you lean (an unstable balance), and gusts shove you,
 * harder as you near the far side. Counter with tilt, or by holding the left/right side.
 * Falling ends the walk. Score: how far you got times how calm (near upright) you stayed.
 */
async function balance(root: HTMLElement, dur: number, useTilt: boolean): Promise<number> {
  const { c, ctx, W, H } = makeCanvas(root, 280);
  let lean = (Math.random() - 0.5) * 0.1;
  let vel = 0;
  let push = 0; // touch: -1 left, +1 right
  const base = S.gamma;
  const setPush = (e: PointerEvent) => {
    const r = c.getBoundingClientRect();
    push = e.clientX - r.left < W / 2 ? -1 : 1;
  };
  c.addEventListener('pointerdown', (e) => {
    c.setPointerCapture(e.pointerId);
    setPush(e);
  });
  c.addEventListener('pointermove', (e) => e.buttons && setPush(e));
  const up = () => (push = 0);
  c.addEventListener('pointerup', up);
  c.addEventListener('pointercancel', up);
  const creak = sfx.drone('triangle');
  let gust = 0;
  let gustUntil = 0;
  let nextGust = 900 + Math.random() * 600;
  let calm = 0;
  let frames = 0;
  let fellAt = -1;
  let last = performance.now();
  const tb = timerBar(root, dur);
  await loop(dur, (t, f) => {
    tb(f);
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (fellAt < 0) {
      if (t > nextGust) {
        // gusts get stronger and more frequent towards the far side
        gust = (Math.random() < 0.5 ? -1 : 1) * (0.9 + Math.random() * 0.6 + f * 0.9);
        gustUntil = t + 450;
        nextGust = t + 1300 - f * 500 + Math.random() * 500;
        sfx.play('gust');
      }
      const g = t < gustUntil ? gust : 0;
      const control = useTilt ? Math.max(-1, Math.min(1, (S.gamma - base) / 20)) : push;
      const acc = lean * 2.4 + g + control * 3.4; // control pushes the walker its way
      vel = (vel + acc * dt) * 0.985;
      lean += vel * dt;
      frames++;
      if (Math.abs(lean) < 0.3) calm++;
      if (Math.abs(lean) >= 1) {
        fellAt = t;
        lean = Math.sign(lean);
        sfx.play('down');
        haptic([80, 40, 160]);
      }
      // a rope creak that rises as you tip, silent while you are steady
      creak.set(110 + Math.abs(lean) * 260, Math.max(0, Math.abs(lean) - 0.35) * 0.12);
      if (Math.abs(lean) > 0.7 && frames % 10 === 0) haptic(15);
    } else creak.set(80, 0);

    const prog = fellAt >= 0 ? fellAt / dur : f;
    ink(ctx, W, H);
    const danger = clamp((Math.abs(lean) - 0.4) / 0.6);
    if (danger > 0) {
      ctx.fillStyle = `rgba(169,50,38,${danger * 0.18})`;
      ctx.fillRect(0, 0, W, H);
    }
    // touch zones
    if (!useTilt) {
      ctx.fillStyle = 'rgba(43,29,14,0.06)';
      ctx.fillRect(push < 0 ? 0 : W / 2, 0, push === 0 ? 0 : W / 2, H);
      ctx.fillStyle = '#2b1d0e';
      ctx.font = '22px Georgia';
      ctx.textAlign = 'center';
      ctx.fillText('◀', 22, H - 18);
      ctx.fillText('▶', W - 22, H - 18);
    }
    // the rope with a sag under the walker
    const x = 56 + prog * (W - 112); // keep the balance pole on screen
    const ropeY = H * 0.72;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(10, ropeY);
    ctx.quadraticCurveTo(x, ropeY + 22, W - 10, ropeY);
    ctx.stroke();
    const footY = ropeY + 22 * (1 - Math.abs((x - W / 2) / (W / 2 - 10)) ** 2) * 0.5;
    // the walker: body pivots on the foot, the pole stays perpendicular to it
    ctx.save();
    ctx.translate(x, fellAt >= 0 ? footY + Math.min(80, (t - fellAt) / 4) : footY);
    ctx.rotate(lean * 0.9);
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -52);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -62, 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-48, -36);
    ctx.lineTo(48, -36);
    ctx.stroke();
    ctx.restore();
    // wind streaks during a gust
    if (t < gustUntil && fellAt < 0) {
      ctx.strokeStyle = 'rgba(43,29,14,0.35)';
      ctx.lineWidth = 2;
      for (let i = 0; i < 4; i++) {
        const yy = 30 + i * 32 + Math.sin(t / 90 + i) * 6;
        const x0 = gust > 0 ? ((t / 2 + i * 70) % W) : W - ((t / 2 + i * 70) % W);
        ctx.beginPath();
        ctx.moveTo(x0, yy);
        ctx.lineTo(x0 + (gust > 0 ? 36 : -36), yy);
        ctx.stroke();
      }
    }
    return fellAt >= 0 && t > fellAt + 600;
  });
  creak.stop();
  const calmFrac = calm / Math.max(1, frames);
  if (fellAt < 0) sfx.play('good');
  const reached = fellAt < 0 ? 1 : (fellAt / dur) * 0.6;
  return clamp(reached * (0.45 + 0.65 * calmFrac));
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
    startBtn.addEventListener(
      'click',
      () => {
        unlockAudio();
        res();
      },
      { once: true },
    );
    touchToggle?.addEventListener('click', () => {
      unlockAudio();
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
    case 'lockpick':
      score = await lockpick(arena, dur, !fallback);
      break;
    case 'parry':
      score = await parry(arena);
      break;
    case 'balance':
      score = await balance(arena, dur, !fallback);
      break;
    default:
      score = await tapMash(arena, dur);
  }
  const pct = Math.round(score * 100);
  clear(root);
  root.appendChild(h('div', { class: 'center mgresult' }, h('div', { style: 'font-size:4em' }, pct >= 80 ? '🌟' : pct >= 45 ? '👍' : '😅'), h('h2', null, pct >= 80 ? 'PERFECT!' : pct >= 45 ? 'Nice!' : 'Oof.'), h('div', null, `${pct}%`)));
  sfx.play(pct >= 80 ? 'perfect' : pct >= 45 ? 'good' : 'bad');
  haptic(pct >= 80 ? [40, 30, 40, 30, 120] : 50);
  await sleep(700);
  releaseAudioSession();
  return { score, points, fallback };
}
