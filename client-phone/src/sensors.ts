/**
 * Device sensors with feature detection and graceful fallbacks.
 * In ?debug=1 mode a slider panel simulates every sensor on desktop.
 */
import { h } from '../../shared/src/browser/dom.js';

export const DEBUG = new URLSearchParams(location.search).has('debug');

interface SensorState {
  accel: number; // |acceleration| without gravity, m/s²
  accelX: number;
  accelY: number;
  accelZ: number;
  beta: number; // front/back tilt (-180..180)
  gamma: number; // left/right tilt (-90..90)
  alpha: number; // compass heading 0..360
  vol: number; // mic RMS 0..1
  pitch: number; // Hz, 0 = none
}

export const S: SensorState = { accel: 0, accelX: 0, accelY: 0, accelZ: 0, beta: 0, gamma: 0, alpha: 0, vol: 0, pitch: 0 };
export const caps = { motion: false, orientation: false, mic: false, vibrate: 'vibrate' in navigator, multitouch: navigator.maxTouchPoints >= 2 };
const debugVals = { accel: 0, beta: 0, gamma: 0, alpha: 0, vol: 0, pitch: 0, burst: 0 };

let motionListening = false;
let lastMotion = 0;

function onMotion(e: DeviceMotionEvent) {
  if (DEBUG) return;
  const a = e.acceleration;
  const g = e.accelerationIncludingGravity;
  let x = a?.x ?? null;
  let y = a?.y ?? null;
  let z = a?.z ?? null;
  if (x === null && g) {
    // devices without linear acceleration: subtract gravity estimate
    x = (g.x ?? 0) * 0.3;
    y = (g.y ?? 0) * 0.3;
    z = ((g.z ?? 0) - 9.81) * 0.3;
  }
  if (x === null) return;
  S.accelX = x;
  S.accelY = y ?? 0;
  S.accelZ = z ?? 0;
  S.accel = Math.hypot(x, y ?? 0, z ?? 0);
  caps.motion = true;
  lastMotion = performance.now();
}

function onOrient(e: DeviceOrientationEvent) {
  if (DEBUG) return;
  if (e.beta === null && e.gamma === null) return;
  S.beta = e.beta ?? 0;
  S.gamma = e.gamma ?? 0;
  const webkit = (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading;
  S.alpha = webkit !== undefined ? webkit : 360 - (e.alpha ?? 0);
  caps.orientation = true;
}

/** Must be called from a user gesture (iOS permission prompts). */
export async function requestMotion(): Promise<boolean> {
  if (DEBUG) {
    caps.motion = caps.orientation = true;
    return true;
  }
  try {
    const DM = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> };
    if (typeof DM.requestPermission === 'function') {
      const r = await DM.requestPermission();
      if (r !== 'granted') return false;
    }
    const DO = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    if (typeof DO?.requestPermission === 'function') await DO.requestPermission().catch(() => 'denied');
  } catch {
    /* not supported */
  }
  if (!motionListening) {
    motionListening = true;
    window.addEventListener('devicemotion', onMotion);
    window.addEventListener('deviceorientation', onOrient);
  }
  // wait briefly for the first event to know whether the sensor really exists
  await new Promise((r) => setTimeout(r, 250));
  return caps.motion || performance.now() - lastMotion < 1000;
}

// ---------------------------------------------------------------- microphone

let micStream: MediaStream | undefined;
let micCtx: AudioContext | undefined;
let analyser: AnalyserNode | undefined;
let micLoop = 0;
const buf = new Float32Array(2048);

export async function startMic(): Promise<boolean> {
  if (DEBUG) {
    caps.mic = true;
    return true;
  }
  if (analyser) return true;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    micCtx = new AC();
    const src = micCtx.createMediaStreamSource(micStream);
    analyser = micCtx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    caps.mic = true;
    const tick = () => {
      if (!analyser || !micCtx) return;
      analyser.getFloatTimeDomainData(buf);
      let rms = 0;
      for (let i = 0; i < buf.length; i++) rms += buf[i]! * buf[i]!;
      rms = Math.sqrt(rms / buf.length);
      S.vol = Math.min(1, rms * 6);
      S.pitch = rms > 0.01 ? detectPitch(buf, micCtx.sampleRate) : 0;
      micLoop = requestAnimationFrame(tick);
    };
    tick();
    return true;
  } catch {
    return false;
  }
}

export function stopMic() {
  cancelAnimationFrame(micLoop);
  micStream?.getTracks().forEach((t) => t.stop());
  void micCtx?.close();
  micStream = undefined;
  micCtx = undefined;
  analyser = undefined;
  S.vol = 0;
  S.pitch = 0;
}

/** Autocorrelation pitch detector (good enough for humming 80–1000 Hz). */
function detectPitch(b: Float32Array, rate: number): number {
  const n = b.length;
  let best = -1;
  let bestCorr = 0;
  const minLag = Math.floor(rate / 1000);
  const maxLag = Math.floor(rate / 80);
  for (let lag = minLag; lag < maxLag; lag++) {
    let c = 0;
    for (let i = 0; i < n - lag; i += 2) c += b[i]! * b[i + lag]!;
    if (c > bestCorr) {
      bestCorr = c;
      best = lag;
    }
  }
  return best > 0 && bestCorr > 0.5 ? rate / best : 0;
}

// ---------------------------------------------------------------- haptics

let flashEl: HTMLElement | undefined;
export function haptic(pattern: number | number[]) {
  if (caps.vibrate) {
    try {
      navigator.vibrate(pattern);
      return;
    } catch {
      /* fall through */
    }
  }
  // iOS has no vibration: flash the screen edge instead
  if (!flashEl) {
    flashEl = h('div', { style: 'position:fixed;inset:0;pointer-events:none;border:10px solid rgba(184,134,11,0.85);opacity:0;transition:opacity .08s;z-index:9998' });
    document.body.appendChild(flashEl);
  }
  flashEl.style.opacity = '1';
  setTimeout(() => (flashEl!.style.opacity = '0'), Array.isArray(pattern) ? pattern[0] ?? 80 : pattern);
}

// ---------------------------------------------------------------- wake lock

let wakeLock: { release: () => Promise<void> } | undefined;
export async function keepAwake() {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    if (nav.wakeLock) wakeLock = await nav.wakeLock.request('screen');
  } catch {
    /* not allowed / not supported */
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLock) void keepAwake();
});

// ---------------------------------------------------------------- debug panel

export function mountDebugPanel() {
  if (!DEBUG) return;
  const slider = (label: string, key: keyof typeof debugVals, min: number, max: number, step = 1) => {
    const out = h('span', null, '0');
    const inp = h('input', { type: 'range', min, max, step, value: 0, style: 'width:100%' });
    inp.addEventListener('input', () => {
      debugVals[key] = Number(inp.value);
      out.textContent = inp.value;
    });
    return h('div', null, h('div', { class: 'small' }, `${label}: `, out), inp);
  };
  const panel = h(
    'div',
    { class: 'debugpanel' },
    h('b', null, '🧪 Sensor simulator'),
    slider('accel m/s²', 'accel', 0, 40, 0.5),
    slider('tilt β (fwd/back)', 'beta', -90, 90),
    slider('tilt γ (left/right)', 'gamma', -90, 90),
    slider('compass α', 'alpha', 0, 359),
    slider('mic volume', 'vol', 0, 1, 0.01),
    slider('mic pitch Hz', 'pitch', 0, 800, 5),
    h('div', { class: 'row' }, h('button', { onclick: () => (debugVals.burst = performance.now()) }, '🏏 Swing!'), h('button', { onclick: () => (debugVals.burst = performance.now() + 1) }, '🫨 Shake!')),
  );
  const toggle = h('button', { class: 'debugtoggle', onclick: () => panel.classList.toggle('open') }, '🧪');
  document.body.append(panel, toggle);
  const loop = () => {
    const burst = performance.now() - debugVals.burst < 600 ? 32 * Math.sin(((performance.now() - debugVals.burst) / 600) * Math.PI * 4) ** 2 : 0;
    S.accel = Math.max(debugVals.accel, burst);
    S.accelX = S.accel * 0.7;
    S.accelY = S.accel * 0.5;
    S.beta = debugVals.beta;
    S.gamma = debugVals.gamma;
    S.alpha = debugVals.alpha;
    S.vol = debugVals.vol;
    S.pitch = debugVals.pitch;
    requestAnimationFrame(loop);
  };
  loop();
  caps.motion = caps.orientation = caps.mic = true;
}
