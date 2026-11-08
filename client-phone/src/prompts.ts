import { monsterArt } from '../../shared/src/browser/glyphs.js';
import { sfx } from '../../shared/src/browser/audio.js';
import { dieName, expandFaces } from '../../shared/src/browser/dice3d.js';
import { DiceWorld } from '../../shared/src/browser/dicephys.js';
import { h, clear } from '../../shared/src/browser/dom.js';
import { renderHexMap } from '../../shared/src/browser/hexmap.js';
import { content } from '../../shared/src/content/index.js';
import type { ChoiceOption, Fx, Prompt, ThrowInfo } from '../../shared/src/protocol.js';
import { drawPad } from './creation.js';
import type { App } from './main.js';
import { playMinigame } from './minigames.js';
import { S, haptic, requestMotion, screenGravity, toScreen } from './sensors.js';

const C = content();

// ------------------------------------------------------------ dice

/**
 * The phone is a box with the dice inside. Tilt it and they slide downhill, shake it and they lag
 * behind and rattle off the walls, twist it and they swing round, jerk it and they hop and tumble.
 * Throw them: flick the phone (or swipe) and they fly out through an edge; the main screen picks
 * them up at the matching edge. The server still decides every value.
 */

interface ThrowState {
  id: string;
  sentAt: number;
}
let lastThrow: ThrowState | undefined;
let resultCard: HTMLElement | undefined;

function showResult(f: Extract<Fx, { kind: 'roll' }>) {
  resultCard?.remove();
  const base = f.kept ?? f.values.reduce((a, b) => a + b, 0);
  const text = `${f.crit ? '🌟 NAT 20! ' : f.fumble ? '💀 Nat 1… ' : ''}${base}${f.bonus ? ` ${f.bonus > 0 ? '+' : '−'} ${Math.abs(f.bonus)}` : ''} = ${f.total}${f.dc !== undefined ? (f.success ? ' ✔' : ' ✖') : ''}`;
  const card = h('div', { class: 'rollresult' }, h('div', { class: 'small muted' }, f.label), h('div', { class: `res ${f.crit ? 'crit' : f.fumble ? 'fumble' : ''}` }, text), h('div', { class: 'small muted' }, `🎲 ${f.values.join(' · ')}`));
  document.body.appendChild(card);
  resultCard = card;
  setTimeout(() => {
    card.classList.add('out');
    setTimeout(() => card.remove(), 400);
  }, 2600);
}

export function onRollFx(f: Extract<Fx, { kind: 'roll' }>) {
  const mine = lastThrow?.id === f.id;
  // the dice are on the main screen now; the phone answers with the number and a buzz
  setTimeout(() => {
    sfx.play('diceLand');
    haptic(f.crit ? [80, 40, 80, 40, 200] : f.fumble ? [200] : 50);
    if (f.crit) sfx.play('crit');
    showResult(f);
  }, mine ? 1700 : 300);
}

function diceText(faces: number[], bonus: number) {
  const counts = new Map<number, number>();
  for (const f of faces) counts.set(f, (counts.get(f) ?? 0) + 1);
  const parts = [...counts.entries()].map(([f, n]) => `${n}${dieName(f)}`);
  return `${parts.join(' + ')}${bonus ? ` ${bonus > 0 ? '+' : '−'} ${Math.abs(bonus)}` : ''}`;
}

/** Box scale: as if the screen were a 30 cm wide tray (a real 7 cm one would fling the dice out on
 * every shake). */
const BOX_M = 0.3;

function diceBox(app: App, p: Extract<Prompt, { kind: 'roll' }>, wrap: HTMLElement) {
  const canvas = h('canvas') as HTMLCanvasElement;
  const head = h('div', { class: 'boxhead' }, h('div', { class: 'prompt-head' }, `🎲 ${p.title}`), h('div', null, diceText(p.faces, p.bonus), p.dc !== undefined ? h('span', { class: 'muted' }, `  (need ${p.dc})`) : null, p.adv === 1 ? h('span', { class: 'badge' }, 'advantage') : p.adv === -1 ? h('span', { class: 'badge' }, 'disadvantage') : null));
  const hint = h('div', { class: 'boxhint' }, 'Shake to rattle them. Flick the phone (or swipe) toward the screen to throw!');
  const auto = h('button', { class: 'ghost small' }, 'Throw for me');
  const real = h('button', { class: 'ghost small', onclick: () => app.send({ t: 'intent', intent: { kind: 'physicalDice', on: true } }) }, '🎲 Real dice');
  const box = h('div', { class: 'phonebox' }, canvas, head, h('div', { class: 'boxfoot' }, hint, h('div', { class: 'row' }, auto, h('span', { class: 'grow' }), real)));
  document.body.appendChild(box);

  const world = new DiceWorld(canvas);
  world.fit();
  const W = world.width;
  const H = world.height;
  const short = Math.min(W, H);
  const pxPerM = short / BOX_M;
  world.dieSize = Math.max(16, Math.min(46, short * 0.085));
  world.tableG = 9.81 * pxPerM;
  const kinds = expandFaces(p.faces);
  const color = '#f4ead2';
  kinds.forEach((k, i) => world.add(k, { group: p.id, x: W / 2 + (i - (kinds.length - 1) / 2) * world.dieSize * 2.4, y: H * 0.55, vx: (Math.random() - 0.5) * 200, vy: (Math.random() - 0.5) * 200, z: world.dieSize, vz: 0, color, spin: 6 }));

  const opened = performance.now();
  let exit: ThrowInfo | undefined;
  let sent = false;
  let lastBuzz = 0;
  world.onHit = (_b, v) => {
    sfx.clack(v);
    const now = performance.now();
    if (v > 0.25 && now - lastBuzz > 70) {
      lastBuzz = now;
      haptic(Math.round(6 + v * 18));
    }
  };
  const send = () => {
    if (sent) return;
    sent = true;
    lastThrow = { id: p.id, sentAt: performance.now() };
    app.send({ t: 'roll:throw', id: p.id, intensity: Math.min(2, (exit?.speed ?? 4) / 4), throw: exit });
    setTimeout(close, 250);
  };
  world.onExit = (b, e) => {
    if (!exit) {
      exit = { edge: e.edge, pos: e.pos, angle: Math.atan2(e.vy, e.vx), speed: Math.hypot(e.vx, e.vy) / short, spin: Math.hypot(...b.w) };
      sfx.play('dice');
      haptic(30);
      // the others follow the first out of the box
      world.escapeSpeed = 0;
      for (const o of world.bodies) if (!o.exited) (o.vx = e.vx * (0.85 + Math.random() * 0.3)), (o.vy = e.vy * (0.85 + Math.random() * 0.3));
      setTimeout(send, 450);
    }
    if (world.bodies.every((o) => o.exited || o === b)) send();
  };
  const fling = (vx: number, vy: number) => {
    for (const o of world.bodies) {
      o.vx = vx * (0.85 + Math.random() * 0.3);
      o.vy = vy * (0.85 + Math.random() * 0.3);
      o.vz = world.dieSize * 25;
    }
    world.escapeSpeed = short * 1.2;
  };
  auto.addEventListener('click', () => {
    sfx.unlock();
    fling((Math.random() - 0.5) * short * 2, -short * 6);
  });

  // swipe: drag across the box and let go; the dice take the finger's speed and direction
  let trail: { x: number; y: number; t: number }[] = [];
  canvas.addEventListener('pointerdown', (e) => {
    sfx.unlock();
    void requestMotion();
    trail = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!trail.length) return;
    trail.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (trail.length > 12) trail.shift();
  });
  canvas.addEventListener('pointerup', (e) => {
    const now = performance.now();
    const pts = [...trail, { x: e.clientX, y: e.clientY, t: now }].filter((q) => now - q.t < 120);
    trail = [];
    if (pts.length < 2) {
      // a tap: rattle the dice up off the table
      for (const o of world.bodies) (o.vz = world.dieSize * (14 + Math.random() * 8)), (o.vx += (Math.random() - 0.5) * 300), (o.vy += (Math.random() - 0.5) * 300);
      return;
    }
    const a = pts[0]!;
    const b = pts[pts.length - 1]!;
    const dt = Math.max(0.016, (b.t - a.t) / 1000);
    const vx = (b.x - a.x) / dt;
    const vy = (b.y - a.y) / dt;
    if (Math.hypot(vx, vy) > short * 1.5) fling(vx * 1.4, vy * 1.4);
  });

  // sensors -> forces, every frame.
  // Nobody holds a phone flat: whatever angle it is held at counts as level (re-learned over a few
  // seconds), and tilting away from that rolls the dice. Absolute gravity pinned them to one edge.
  let level: [number, number] | undefined;
  let lastTick = performance.now();
  const dead = (v: number, d: number) => (Math.abs(v) <= d ? 0 : v - Math.sign(v) * d);
  const tick = () => {
    if (sent) return;
    if (!wrap.isConnected) return close();
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastTick) / 1000);
    lastTick = now;
    const [gx, gy] = screenGravity();
    if (!level) level = [gx, gy];
    const k = 1 - Math.exp(-dt / 2.5);
    level = [level[0] + (gx - level[0]) * k, level[1] + (gy - level[1]) * k];
    const TILT_GAIN = 1.6;
    world.gravity = [(gx - level[0]) * TILT_GAIN * pxPerM, (gy - level[1]) * TILT_GAIN * pxPerM];
    // the phone accelerating one way pushes the dice the other way (capped: sensors spike; a dead
    // zone: a steady hand is not a shake)
    const [lx, ly] = toScreen(S.accelX, S.accelY);
    const cap = (v: number) => Math.max(-45, Math.min(45, v));
    world.push = [-cap(dead(lx, 1.2)) * pxPerM, -cap(dead(ly, 1.2)) * pxPerM];
    // dropping the phone fast lifts the dice off the table; tipping it sharply tosses them
    const tip = (dead(Math.abs(S.rotB), 40) + dead(Math.abs(S.rotG), 40)) * (Math.PI / 180);
    world.lift = Math.max(0, -cap(dead(S.accelZ, 1.5))) * pxPerM + tip * world.dieSize * 60;
    world.frameSpin = (dead(S.rotA, 25) * Math.PI) / 180;
    // a throw needs a deliberate flick, and not in the first instant
    if (!exit && world.escapeSpeed !== short * 1.2) world.escapeSpeed = performance.now() - opened < 500 ? Infinity : 2.2 * pxPerM;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  function close() {
    world.stop();
    box.remove();
  }
  return box;
}

function renderRoll(app: App, p: Extract<Prompt, { kind: 'roll' }>) {
  const physical = app.view!.me.physicalDice;
  const wrap = h('div', { class: 'card col dicebox urgent' });
  wrap.append(h('div', { class: 'prompt-head' }, `🎲 ${p.title}`), h('div', { class: 'center', style: 'font-size:1.4em' }, diceText(p.faces, p.bonus), p.dc !== undefined ? h('span', { class: 'muted' }, `  (need ${p.dc})`) : null, p.adv === 1 ? h('span', { class: 'badge' }, 'advantage') : p.adv === -1 ? h('span', { class: 'badge' }, 'disadvantage') : null));
  if (physical) {
    const inputs = p.faces.map((f) => h('input', { type: 'number', inputmode: 'numeric', min: 1, max: f, placeholder: dieName(f) }) as HTMLInputElement);
    const send = h('button', { class: 'primary' }, '✅ Submit my real dice');
    send.addEventListener('click', () => {
      const vals = inputs.map((i) => Number(i.value));
      const bad = vals.findIndex((v, i) => !Number.isInteger(v) || v < 1 || v > p.faces[i]!);
      if (bad >= 0) {
        inputs[bad]!.style.borderColor = 'var(--red)';
        inputs[bad]!.focus();
        return;
      }
      app.send({ t: 'roll:physical', id: p.id, values: vals });
    });
    wrap.append(
      h('div', null, `Roll your real ${p.faces.map((f) => dieName(f)).join(', ')} and enter the result${p.faces.includes(100) ? ' (d%: 1–100, 00 = 100)' : ''}:`),
      h('div', { class: 'numpad' }, ...inputs.map((inp, i) => h('label', { class: 'col center' }, h('span', { class: 'small' }, dieName(p.faces[i]!)), inp))),
      send,
      h('button', { class: 'ghost small', onclick: () => app.send({ t: 'roll:throw', id: p.id }) }, 'Let the app roll this one'),
      h('button', { class: 'ghost small', onclick: () => app.send({ t: 'intent', intent: { kind: 'physicalDice', on: false } }) }, 'Switch back to digital dice'),
    );
    return wrap;
  }
  wrap.append(h('div', { class: 'small muted center' }, 'Your dice are in your hands. Throw them at the screen!'));
  // the box goes on top of everything (fixed, full screen) once this card is on the page
  requestAnimationFrame(() => {
    if (wrap.isConnected) diceBox(app, p, wrap);
  });
  return wrap;
}

// ------------------------------------------------------------ choices

function optButton(o: ChoiceOption, onPick: () => void) {
  return h(
    'button',
    { disabled: !!o.disabled, onclick: onPick, title: o.disabled ?? '' },
    h('span', { class: 'em' }, o.monster ? monsterArt(o.monster, o.emoji ?? '•') : o.emoji ?? '•'),
    h('span', null, h('div', { class: 'lbl' }, o.label, o.tag ? h('span', { class: 'badge' }, o.tag) : null), o.desc ? h('div', { class: 'ds' }, o.desc) : null, o.disabled ? h('div', { class: 'ds', style: 'color:var(--red)' }, o.disabled) : null),
    o.cost ? h('span', { class: 'cost' }, o.cost) : h('span'),
  );
}

let actionGroup = 'Actions';

function renderChoice(app: App, p: Extract<Prompt, { kind: 'choice' }>) {
  const answer = (id: string) => {
    haptic(20);
    app.send({ t: 'answer', id: p.id, value: id });
  };
  const head = [h('div', { class: 'prompt-head' }, p.title), p.text ? h('div', { class: 'prompt-text' }, p.text) : null, deadlineEl(p.deadline)];
  if (p.style === 'map') {
    const w = app.view!.world;
    const opts = new Map(p.options.map((o) => [o.id, o]));
    const mapEl = w
      ? h(
          'div',
          { class: 'mapbox' },
          renderHexMap(w, {
            colorblind: app.view!.settings.colorblind,
            showReach: true,
            compact: true,
            onTap: (q, r) => {
              const id = `${q},${r}`;
              if (opts.has(id)) answer(id);
            },
          }),
        )
      : null;
    const places = p.options.filter((o) => o.group === 'Places');
    return h('div', { class: 'col' }, ...head, mapEl, h('div', { class: 'muted small' }, 'Tap a glowing tile, or:'), h('div', { class: 'choice' }, ...places.map((o) => optButton(o, () => answer(o.id)))), h('details', null, h('summary', null, 'All destinations'), h('div', { class: 'choice' }, ...p.options.filter((o) => o.group !== 'Places').map((o) => optButton(o, () => answer(o.id))))));
  }
  if (p.style === 'action') {
    const groups = [...new Set(p.options.map((o) => o.group ?? 'Actions'))];
    if (!groups.includes(actionGroup)) actionGroup = groups[0] ?? 'Actions';
    const list = h('div', { class: 'choice' });
    const tabs = h('div', { class: 'grouptabs' });
    const fill = () => {
      clear(list);
      clear(tabs);
      for (const g of groups)
        tabs.appendChild(
          h(
            'button',
            {
              class: g === actionGroup ? 'on' : '',
              onclick: () => {
                actionGroup = g;
                fill();
              },
            },
            `${{ Actions: '⚔️', Abilities: '💪', Spells: '✨', Items: '🧪' }[g] ?? ''} ${g} (${p.options.filter((o) => (o.group ?? 'Actions') === g && !o.disabled).length})`,
          ),
        );
      for (const o of p.options.filter((x) => (x.group ?? 'Actions') === actionGroup)) list.appendChild(optButton(o, () => answer(o.id)));
    };
    fill();
    return h('div', { class: 'col card urgent' }, ...head, tabs, list);
  }
  return h('div', { class: `col${p.urgent ? ' card urgent' : ''}` }, ...head, h('div', { class: `choice ${p.style ?? ''}` }, ...p.options.map((o) => optButton(o, () => answer(o.id)))));
}

function deadlineEl(deadline?: number) {
  if (!deadline) return null;
  const el = h('div', { class: 'deadline', 'data-deadline': deadline });
  const upd = () => {
    if (!el.isConnected) return clearInterval(t);
    const s = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    el.textContent = `⏳ ${s}s`;
    el.classList.toggle('low', s <= 10);
  };
  const t = window.setInterval(upd, 1000);
  setTimeout(upd, 0);
  return el;
}

// ------------------------------------------------------------ entry

export function renderPrompt(app: App, p: Prompt): HTMLElement | HTMLElement[] {
  switch (p.kind) {
    case 'choice':
      return renderChoice(app, p);
    case 'roll':
      return renderRoll(app, p);
    case 'minigame': {
      const box = h('div', { class: 'card col urgent' });
      void playMinigame(box, p).then((r) => app.send({ t: 'input:result', id: p.id, data: { score: r.score, points: r.points, fallback: r.fallback } }));
      return box;
    }
    case 'text': {
      const ta = h('textarea', { rows: 3, maxlength: p.maxLen, placeholder: p.placeholder ?? '' }) as HTMLTextAreaElement;
      const send = () => {
        const v = ta.value.trim();
        if (!v) return;
        app.send({ t: 'answer', id: p.id, value: v });
      };
      return h(
        'div',
        { class: 'card col' },
        h('div', { class: 'prompt-head' }, `✍️ ${p.title}`),
        p.text ? h('div', { class: 'prompt-text' }, p.text) : null,
        deadlineEl(p.deadline),
        ta,
        p.suggestions?.length ? h('div', { class: 'row wrap' }, ...p.suggestions.map((s) => h('button', { class: 'ghost small', onclick: () => (ta.value = s) }, s))) : null,
        h('button', { class: 'primary', onclick: send }, '📨 Send'),
      );
    }
    case 'draw': {
      let url: string | undefined;
      return h(
        'div',
        { class: 'card col' },
        h('div', { class: 'prompt-head' }, `🎨 ${p.title}`),
        p.text ? h('div', { class: 'prompt-text' }, p.text) : null,
        deadlineEl(p.deadline),
        drawPad(undefined, (u) => (url = u), 256),
        h('button', { class: 'primary', onclick: () => url && app.send({ t: 'answer', id: p.id, value: url }) }, '🏳️ Raise the banner!'),
      );
    }
    case 'notice':
      return h('div', { class: 'card col' }, h('div', { class: 'prompt-head' }, p.title), p.text ? h('div', { class: 'prompt-text', style: 'font-size:1.15em' }, p.text) : null, deadlineEl(p.deadline), h('button', { class: 'primary', onclick: () => app.send({ t: 'answer', id: p.id, value: true }) }, p.okLabel));
  }
}

// ------------------------------------------------------------ context (nothing asked right now)

function waitCard(icon: string, title: string, sub?: string) {
  return h('div', { class: 'card waitcard' }, h('div', { class: 'big' }, icon), h('h2', null, title), sub ? h('div', { class: 'muted' }, sub) : null);
}

export function renderContext(app: App) {
  const v = app.view!;
  const c = v.chars[v.me.id]!;
  const player = v.players.find((p) => p.id === v.me.id)!;
  const sc = v.scene;
  const last = v.narration[v.narration.length - 1];
  const lastLine = last && (last.style === 'say' && last.who ? `${last.who}: “${last.text}”` : last.text);
  const waitingOthers = v.waiting.filter((w) => w.playerId !== v.me.id).map((w) => w.label);
  const footer = h('div', { class: 'col' }, lastLine ? h('div', { class: 'card small' }, `📜 ${lastLine}`) : null, waitingOthers.length ? h('div', { class: 'small muted center' }, `⏳ Waiting for ${waitingOthers.join(', ')}`) : null);
  switch (sc.kind) {
    case 'lobby':
      return [
        h('div', { class: 'card col center' }, h('div', { style: 'font-size:3em' }, C.classes[c.cls].emoji), h('h2', null, `${c.name}`), h('div', null, `${C.species[c.species].name} ${C.classes[c.cls].name}`), h('div', { class: 'muted' }, `“${c.personality}”`)),
        h('button', { class: player.ready ? 'good' : 'primary', style: 'font-size:1.4em;padding:18px', onclick: () => app.send({ t: 'ready', ready: !player.ready }) }, player.ready ? '✅ Ready! (tap to unready)' : '⚔️ I\'m ready!'),
        h('div', { class: 'muted center' }, 'When everyone is ready, the host starts the adventure.'),
        h('div', { class: 'card small' }, h('b', null, 'Tip: '), 'Check the 📜 Hero, 🎒 Bag and ✨ Powers tabs while you wait. You can switch to rolling real dice in 📖 Journal → Settings.'),
      ];
    case 'overworld': {
      const w = v.world!;
      const leader = w.leaderId ? v.chars[w.leaderId] : undefined;
      return [
        h('div', { class: 'card' }, h('b', null, `🧭 ${leader?.id === c.id ? 'You lead!' : `${leader?.name ?? 'The leader'} is choosing the path`}`), h('div', { class: 'small muted' }, 'Tap a tile to ping a suggestion on the TV.')),
        h('div', { class: 'mapbox' }, renderHexMap(w, { colorblind: v.settings.colorblind, compact: true, onTap: (q, r) => app.send({ t: 'intent', intent: { kind: 'ping', q, r } }) })),
        h('div', { class: 'card small' }, `🎯 ${w.objective.text} (🔑 ${w.objective.keys}/${w.objective.keysNeeded})`),
        footer,
      ];
    }
    case 'combat': {
      const cb = sc.combat;
      const foes = cb.monsters.filter((m) => m.side === 'enemy' && !m.dead && !m.fled);
      const mine = cb.current === c.id;
      return [
        c.dead ? waitCard('👻', 'Your spirit lingers', 'You will get to nudge the battle on your turn.') : c.down ? waitCard('☠️', 'You are dying!', `Death saves: ${c.death.successes}✔ ${c.death.failures}✖ — roll on your turn.`) : waitCard(mine ? '⚔️' : '⏳', mine ? 'Your turn!' : cb.round === 0 ? 'Rolling initiative...' : `Round ${cb.round} — wait for your turn`, cb.current ? `Now acting: ${v.chars[cb.current]?.name ?? cb.monsters.find((m) => m.id === cb.current)?.name ?? ''}` : undefined),
        h('div', { class: 'card col small' }, h('b', null, 'Enemies'), ...foes.map((m) => h('div', { class: 'row' }, monsterArt(m.defId, m.emoji, 'foe-ic'), h('span', { class: 'grow' }, `${m.name}${m.telegraph ? ' ⚠️' : ''}`), h('span', null, `${m.hp} / ${m.maxHp}`)))),
        c.conditions.length ? h('div', { class: 'card small' }, `Conditions: ${c.conditions.map((x) => x.id).join(', ')}`) : null,
        footer,
      ];
    }
    case 'event':
      return [h('div', { class: 'card col' }, h('h2', null, `${sc.event.emoji} ${sc.event.title}`), h('div', null, sc.event.text), sc.event.outcome ? h('div', { class: 'card' }, sc.event.outcome.text) : null), footer];
    case 'town':
      return [waitCard('🏘️', sc.name, 'Waiting for the others to finish in town...'), footer];
    case 'jackbox':
      return [waitCard('✍️', sc.prompt, sc.stage === 'result' ? 'Results are on the TV!' : 'Waiting for the others...'), footer];
    case 'ending':
      return [h('div', { class: 'card col center' }, h('div', { style: 'font-size:4em' }, sc.victory ? '🏆' : '💀'), h('h1', null, sc.title), h('div', null, sc.text), h('div', { class: 'muted' }, 'Thanks for playing Pocket Realms!'))];
    case 'levelup':
      return [waitCard('⭐', 'Level up!', 'Waiting for the others to choose...'), footer];
    case 'social':
      return [h('div', { class: 'card col center' }, h('div', { style: 'font-size:3.5em' }, sc.npc.emoji), h('h2', null, `${sc.npc.name}`), h('div', { class: 'muted' }, `the ${sc.npc.title} — wants to ${sc.npc.motivation}`), sc.line ? h('div', { class: 'card', style: 'font-style:italic' }, sc.line) : null), footer];
    case 'dungeon':
      return [
        h('div', { class: 'card col' }, h('h2', null, `🕳️ ${sc.name}`), h('div', { class: 'row wrap' }, ...sc.rooms.filter((r) => r.revealed).map((r) => h('span', { class: 'tag', style: r.id === sc.current ? 'border-width:2px;font-weight:bold' : '' }, `${r.emoji} ${r.name}${r.cleared ? ' ✔' : ''}`)))),
        footer,
      ];
    case 'camp':
      return [waitCard('🔥', 'Around the campfire', sc.prompt ? sc.prompt.text : sc.text), footer];
    default:
      return [waitCard('📜', 'Look at the TV!', ''), footer];
  }
}
