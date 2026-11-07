import { monsterArt } from '../../shared/src/browser/glyphs.js';
import { sfx } from '../../shared/src/browser/audio.js';
import { DiceTray, dieName } from '../../shared/src/browser/dice3d.js';
import { h, clear } from '../../shared/src/browser/dom.js';
import { renderHexMap } from '../../shared/src/browser/hexmap.js';
import { content } from '../../shared/src/content/index.js';
import type { ChoiceOption, Fx, Prompt } from '../../shared/src/protocol.js';
import { drawPad } from './creation.js';
import type { App } from './main.js';
import { playMinigame } from './minigames.js';
import { S, haptic, requestMotion } from './sensors.js';

const C = content();

// ------------------------------------------------------------ dice

interface ActiveRoll {
  id: string;
  tray: DiceTray;
  el: HTMLElement;
  res: HTMLElement;
  faces: number[];
  thrown: boolean;
}
let activeRoll: ActiveRoll | undefined;

function rollOverlay(id: string, faces: number[], title: string): ActiveRoll {
  activeRoll?.el.remove();
  const canvas = h('canvas');
  const res = h('div', { class: 'res' });
  const el = h('div', { class: 'modal', style: 'position:fixed;inset:0;background:rgba(43,29,14,0.35);display:flex;align-items:center;justify-content:center;z-index:500' }, h('div', { class: 'card dicebox', style: 'width:min(560px,94vw)' }, h('div', { class: 'center prompt-head' }, title), canvas, res));
  document.body.appendChild(el);
  const tray = new DiceTray(canvas);
  activeRoll = { id, tray, el, res, faces, thrown: false };
  return activeRoll;
}

export function onRollFx(f: Extract<Fx, { kind: 'roll' }>) {
  let ar = activeRoll && activeRoll.id === f.id ? activeRoll : undefined;
  if (!ar) {
    // auto-rolled (timeout) or physical: still show the result
    ar = rollOverlay(f.id, f.faces, f.label);
    ar.tray.throw(f.faces);
  }
  const roll = ar;
  const highlights = f.faces.length === 2 && f.faces.every((x) => x === 20) ? f.values.map((v) => (v === f.kept ? 'kept' : 'dropped')) : f.values.map((v, i) => (f.faces[i] === 20 && v === 20 ? 'crit' : f.faces[i] === 20 && v === 1 ? 'fumble' : undefined));
  void roll.tray.settle(f.values, highlights as never).then(() => {
    sfx.play('diceLand');
    const base = f.kept ?? f.values.reduce((a, b) => a + b, 0);
    roll.res.textContent = `${f.crit ? '🌟 NAT 20! ' : f.fumble ? '💀 Nat 1… ' : ''}${base}${f.bonus ? ` ${f.bonus > 0 ? '+' : '−'} ${Math.abs(f.bonus)}` : ''} = ${f.total}${f.dc !== undefined ? (f.success ? ' ✔' : ' ✖') : ''}`;
    roll.res.className = `res ${f.crit ? 'crit' : f.fumble ? 'fumble' : ''}`;
    haptic(f.crit ? [80, 40, 80, 40, 200] : 60);
    if (f.crit) sfx.play('crit');
    setTimeout(() => {
      roll.el.remove();
      if (activeRoll === roll) activeRoll = undefined;
    }, 2600);
  });
}

function diceText(faces: number[], bonus: number) {
  const counts = new Map<number, number>();
  for (const f of faces) counts.set(f, (counts.get(f) ?? 0) + 1);
  const parts = [...counts.entries()].map(([f, n]) => `${n}${dieName(f)}`);
  return `${parts.join(' + ')}${bonus ? ` ${bonus > 0 ? '+' : '−'} ${Math.abs(bonus)}` : ''}`;
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
  const canvas = h('canvas');
  const tray = new DiceTray(canvas);
  const btn = h('button', { class: 'primary mgbig' }, '🎲 Tap or shake to roll!');
  wrap.append(
    canvas,
    btn,
    h('div', { class: 'small muted center' }, 'Fair rolls: the game server rolls the dice.'),
    h('button', { class: 'ghost small', onclick: () => app.send({ t: 'intent', intent: { kind: 'physicalDice', on: true } }) }, '🎲 I want to roll my real dice'),
  );
  let thrown = false;
  const doThrow = (intensity: number) => {
    if (thrown) return;
    thrown = true;
    sfx.unlock();
    sfx.play('dice');
    haptic(40);
    const ar = rollOverlay(p.id, p.faces, p.title);
    ar.thrown = true;
    ar.tray.throw(p.faces, { intensity });
    app.send({ t: 'roll:throw', id: p.id, intensity });
  };
  btn.addEventListener('click', () => {
    void requestMotion();
    doThrow(1);
  });
  // idle wobble + shake detection
  setTimeout(() => tray.throw(p.faces, { intensity: 0.4 }), 30);
  let hot = 0;
  const watch = () => {
    if (thrown || !wrap.isConnected) return;
    if (S.accel > 17) hot++;
    else hot = Math.max(0, hot - 1);
    if (hot > 3) doThrow(Math.min(2, S.accel / 15));
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
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
  const lastLine = v.narration[v.narration.length - 1]?.text;
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
