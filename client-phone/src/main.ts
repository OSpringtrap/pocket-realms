import '../../shared/src/browser/theme.css';
import './phone.css';
import { sfx } from '../../shared/src/browser/audio.js';
import { Slot, h, hash, toast } from '../../shared/src/browser/dom.js';
import { heartIcon, sparkIcon } from '../../shared/src/browser/glyphs.js';
import { Net } from '../../shared/src/browser/net.js';
import { content } from '../../shared/src/content/index.js';
import { PROTOCOL_VERSION, type C2S, type Fx, type PhoneView } from '../../shared/src/protocol.js';
import { creationFlags, renderCreation, renderClaim } from './creation.js';
import { onRollFx, renderPrompt, renderContext } from './prompts.js';
import { DEBUG, haptic, keepAwake, mountDebugPanel, requestMotion } from './sensors.js';
import { renderTab, type TabId } from './tabs.js';

const C = content();
const params = new URLSearchParams(location.search);
const LS = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
  del: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

function hudLine(icon: Node, cls: string, cur: number, max: number) {
  const pct = Math.max(0, Math.min(100, (cur / Math.max(1, max)) * 100));
  return h('div', { class: 'stat-line' }, h('span', { class: 'ic' }, icon), h('span', { class: 'v' }, `${Math.max(0, cur)} / ${max}`), h('div', { class: `bar ${cls}` }, h('i', { style: `width:${pct}%` })));
}

export interface App {
  view?: PhoneView;
  send(msg: C2S): void;
  rerender(): void;
  tab: TabId;
}

const app: App = {
  view: undefined,
  tab: 'now',
  send: (m) => net.send(m),
  rerender: () => {
    mainSlot.invalidate();
    render();
  },
};

const root = document.getElementById('app')!;
const connBar = h('div', { class: 'conn', style: 'display:none' }, 'Reconnecting…');
const hudEl = h('div');
const mainEl = h('div', { class: 'screen' });
const tabsEl = h('div');
root.append(connBar, hudEl, mainEl, tabsEl);
const hudSlot = new Slot(hudEl);
const mainSlot = new Slot(mainEl);
const tabsSlot = new Slot(tabsEl);
mountDebugPanel();

let joined = false;
let lastPromptId: string | undefined;

const net = new Net<PhoneView>({
  onOpen: (n) => {
    const token = LS.get('pr_token');
    if (token) n.send({ t: 'resume', v: PROTOCOL_VERSION, token });
  },
  onWelcome: (m) => {
    joined = true;
    if (m.token) LS.set('pr_token', m.token);
    LS.set('pr_code', m.code);
  },
  onState: (v) => {
    app.view = v;
    render();
  },
  onFx: (fx) => fx.forEach(handleFx),
  onError: (msg, fatal) => {
    if (msg === 'unknown-token') {
      LS.del('pr_token');
      joined = false;
      app.view = undefined;
      render(true);
      return;
    }
    toast(msg, 'error');
    if (fatal) setTimeout(() => location.reload(), 2500);
  },
  onStatus: (s) => {
    connBar.style.display = s === 'open' || !joined ? 'none' : 'block';
  },
});

// ------------------------------------------------------------ join

function renderJoin() {
  const code = h('input', { placeholder: 'ABCD', maxlength: 4, value: (params.get('room') ?? LS.get('pr_code') ?? '').toUpperCase(), style: 'text-transform:uppercase;font-size:2em;text-align:center;letter-spacing:0.3em', autocapitalize: 'characters', autocomplete: 'off' });
  const name = h('input', { placeholder: 'Your name', maxlength: 20, value: LS.get('pr_name') ?? '' });
  const go = h('button', { class: 'primary', style: 'font-size:1.3em;padding:16px' }, '🎲 Join the adventure');
  go.addEventListener('click', async () => {
    const c = code.value.trim().toUpperCase();
    if (c.length !== 4) return toast('Enter the 4-letter room code from the TV.', 'error');
    if (!name.value.trim()) return toast('Enter your name.', 'error');
    LS.set('pr_name', name.value.trim());
    sfx.unlock();
    void keepAwake();
    void requestMotion(); // iOS needs this inside the tap
    net.send({ t: 'join', v: PROTOCOL_VERSION, code: c, name: name.value.trim(), token: LS.get('pr_token') ?? undefined });
  });
  return [
    h('div', { class: 'logo' }, '🏰 Pocket Realms'),
    h('div', { class: 'center muted' }, 'Your phone is your hero: sheet, wand, sword and dice.'),
    h('div', { class: 'card col' }, h('b', null, 'Room code (on the TV)'), code, h('b', null, 'Your name'), name, go),
    h(
      'div',
      { class: 'card tip' },
      h('b', null, '🔒 Saw a certificate warning?'),
      h('div', null, 'That is expected: the game runs on your friend\'s computer, not the internet. On Chrome tap "Advanced" → "Proceed". On Safari tap "Show Details" → "visit this website". You only do this once.'),
      h('div', { style: 'margin-top:6px' }, '📶 Make sure you are on the same Wi-Fi as the main screen.'),
    ),
    DEBUG ? h('div', { class: 'tip center' }, '🧪 Debug mode: simulated sensors (button bottom-right).') : null,
  ];
}

// ------------------------------------------------------------ render

function me() {
  return app.view?.chars[app.view.me.id];
}

function render(force = false) {
  const v = app.view;
  if (force) {
    mainSlot.invalidate();
    hudSlot.invalidate();
    tabsSlot.invalidate();
  }
  if (!v || !joined) {
    hudSlot.render('none', () => null);
    tabsSlot.render('none', () => null);
    mainSlot.render('join', renderJoin);
    return;
  }
  document.documentElement.style.setProperty('--scale', String(v.settings.textSize));
  document.body.classList.toggle('cb', v.settings.colorblind);
  document.body.classList.toggle('reduce-motion', v.settings.reduceMotion);
  const c = me();
  const player = v.players.find((p) => p.id === v.me.id);
  if (!c) {
    hudSlot.render('none', () => null);
    tabsSlot.render('none', () => null);
    const claimable = v.me.creation?.claimable ?? [];
    const rollPrompt = v.me.prompts.find((p) => p.kind === 'roll');
    if (rollPrompt) {
      mainSlot.render(hash(['croll', rollPrompt.id]), () => renderPrompt(app, rollPrompt));
      return;
    }
    if (claimable.length && !creationFlags.skipClaim && v.scene.kind !== 'title') mainSlot.render(hash(['claim', claimable]), () => renderClaim(app, claimable));
    else mainSlot.render(hash(['create', v.me.creation, v.scene.kind === 'title']), () => (v.scene.kind === 'title' ? waiting('🏰', 'The host is on the title screen', 'Waiting for a campaign to begin...') : renderCreation(app)));
    return;
  }
  // HUD
  hudSlot.render(hash([c.name, c.hp, c.maxHp, c.sp, c.maxSp, c.level, c.portrait, v.party.gold, player?.color, c.down, c.dead, c.inspiration, c.conditions]), () =>
    h(
      'div',
      { class: 'hud panel', style: `--c:${player?.color ?? '#5a4326'}` },
      h('div', { class: 'av' }, c.portrait ? h('img', { src: c.portrait }) : C.classes[c.cls].emoji),
      h(
        'div',
        { class: 'bars' },
        h('div', { class: 'row', style: 'gap:6px' }, h('span', { class: 'nm' }, c.name), c.dead ? h('span', null, '💀') : c.down ? h('span', null, '☠️') : null, c.inspiration ? h('span', { class: 'badge' }, `✨${c.inspiration}`) : null),
        hudLine(heartIcon(), 'hp', c.hp, c.maxHp),
        c.maxSp ? hudLine(sparkIcon(), 'sp', c.sp, c.maxSp) : null,
      ),
      h('div', { class: 'lv' }, h('small', null, 'LV.'), h('b', null, String(c.level).padStart(2, '0')), h('span', { class: 'gold' }, `💰 ${v.party.gold}`)),
    ),
  );
  // Tabs
  const pending = v.me.prompts.length;
  tabsSlot.render(hash([app.tab, pending > 0, v.me.secrets.length]), () =>
    h(
      'div',
      { class: 'tabs panel' },
      ...(
        [
          ['now', '⚔️', 'Now'],
          ['sheet', '📜', 'Hero'],
          ['bag', '🎒', 'Bag'],
          ['spells', '✨', 'Powers'],
          ['journal', '📖', 'Journal'],
        ] as [TabId, string, string][]
      ).map(([id, ic, label]) =>
        h(
          'button',
          {
            class: app.tab === id ? 'on' : '',
            onclick: () => {
              app.tab = id;
              render(true);
            },
          },
          h('span', { class: 'ic' }, ic),
          label,
          id === 'now' && pending > 0 && app.tab !== 'now' ? h('span', { class: 'dot' }) : null,
        ),
      ),
    ),
  );
  // Main
  const prompt = v.me.prompts[0];
  if (prompt && prompt.id !== lastPromptId) {
    lastPromptId = prompt.id;
    // a new question jumps you back to the action tab
    if (app.tab !== 'now') {
      app.tab = 'now';
      tabsSlot.invalidate();
      render();
      return;
    }
    haptic(prompt.urgent ? [60, 40, 60] : 30);
    sfx.play(prompt.urgent ? 'turn' : 'tick');
  }
  if (!prompt) lastPromptId = undefined;
  if (app.tab === 'now') {
    if (prompt) mainSlot.render(hash(['p', prompt.id, prompt.kind === 'choice' ? prompt.options : 0, v.me.physicalDice]), () => renderPrompt(app, prompt));
    else mainSlot.render(hash(['ctx', v.scene.kind === 'combat' ? [v.scene, c] : v.scene, v.world?.party, v.world?.leaderId, player?.ready, c.level, v.waiting]), () => renderContext(app));
  } else mainSlot.render(hash(['tab', app.tab, c, v.party.stash, v.me.secrets, v.journal.length, v.world?.quests, v.me.physicalDice, v.scene.kind]), () => renderTab(app, app.tab));
}

export function waiting(icon: string, title: string, sub?: string) {
  return h('div', { class: 'card waitcard' }, h('div', { class: 'big' }, icon), h('h2', null, title), sub ? h('div', { class: 'muted' }, sub) : null);
}

function handleFx(f: Fx) {
  const v = app.view;
  if (!v) return;
  switch (f.kind) {
    case 'roll':
      if (f.playerId === v.me.id) onRollFx(f);
      break;
    case 'haptic':
      if (!f.playerId || f.playerId === v.me.id) haptic(f.pattern);
      break;
    case 'damage':
      if (f.target === v.me.id) {
        haptic(f.crit ? [200, 60, 200] : 120);
        sfx.play('hit');
        document.body.animate([{ transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'none' }], { duration: 250 });
      }
      break;
    case 'heal':
      if (f.target === v.me.id) sfx.play('heal');
      break;
    case 'banner':
      toast(f.text, f.style === 'bad' ? 'error' : f.style === 'good' ? 'good' : 'info', Math.min(7000, Math.max(3000, 1200 + f.text.length * 55)));
      break;
    case 'sound':
      if (['levelup', 'victory', 'coin', 'loot'].includes(f.name)) sfx.play(f.name);
      break;
    default:
      break;
  }
}

// low-HP heartbeat
setInterval(() => {
  const c = me();
  if (c && !c.dead && !c.down && c.hp > 0 && c.hp / c.maxHp < 0.25 && app.view?.scene.kind === 'combat') haptic([50, 120, 50]);
}, 1600);

render();
