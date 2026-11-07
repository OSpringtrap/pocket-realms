import '../../shared/src/browser/theme.css';
import './host.css';
import { sfx } from '../../shared/src/browser/audio.js';
import { DiceTray } from '../../shared/src/browser/dice3d.js';
import { Slot, clear, h, hash, toast } from '../../shared/src/browser/dom.js';
import { renderHexMap } from '../../shared/src/browser/hexmap.js';
import { Net } from '../../shared/src/browser/net.js';
import { content } from '../../shared/src/content/index.js';
import type { Fx, HostCommand, PublicView, SceneView, Settings } from '../../shared/src/protocol.js';
import type { Character, Monster } from '../../shared/src/types.js';

const params = new URLSearchParams(location.search);
const hostKey = params.get('key') ?? undefined;
const C = content();

let view: PublicView | undefined;
let role: 'host' | 'spectator' | 'phone' = 'spectator';
let modal: 'settings' | 'journal' | null = null;

const app = document.getElementById('app')!;
const top = h('div', { class: 'topbar' });
const main = h('div', { class: 'main' });
const narr = h('div', { class: 'narration' });
app.append(top, main, narr);
const topSlot = new Slot(top);
const stage = h('div', { class: 'stage' });
const side = h('div', { class: 'side' });
main.append(stage, side);
const stageSlot = new Slot(stage);
const sideSlot = new Slot(side);
const narrSlot = new Slot(narr);
const overlay = h('div');
main.appendChild(overlay);
const modalRoot = h('div');
document.body.appendChild(modalRoot);
const modalSlot = new Slot(modalRoot);

// sound unlock (browsers need a gesture)
const unlock = h('div', { class: 'unlock' }, h('div', { style: 'font-size:3em' }, '🏰'), 'Pocket Realms', h('div', { class: 'small muted' }, 'Click anywhere to begin (enables sound)'));
document.body.appendChild(unlock);
unlock.addEventListener('click', () => {
  sfx.unlock();
  unlock.remove();
  void document.documentElement.requestFullscreen?.().catch(() => {});
});

const net = new Net<PublicView>({
  onOpen: (n) => n.hello('host', hostKey),
  onWelcome: (m) => {
    role = m.role;
    if (role !== 'host') toast('Spectator mode (no host key in the URL). Use the link printed in the terminal to control the game.', 'info', 6000);
  },
  onState: (v) => {
    view = v;
    render();
  },
  onFx: (fx) => fx.forEach(handleFx),
  onError: (msg) => toast(msg, 'error'),
  onStatus: () => renderTop(true),
});

function cmd(command: HostCommand) {
  net.send({ t: 'host', key: hostKey, command });
}

// ------------------------------------------------------------ helpers

function avatar(c: Character | undefined, fallback = '🙂'): HTMLElement {
  if (c?.portrait) return h('img', { src: c.portrait, alt: c.name });
  if (!c) return h('span', null, fallback);
  return h('span', null, C.classes[c.cls].emoji);
}
function bar(cls: string, cur: number, max: number, label?: string) {
  return h('div', { class: `bar ${cls}`, title: label ?? `${cur}/${max}` }, h('i', { style: `width:${Math.max(0, Math.min(100, (cur / Math.max(1, max)) * 100))}%` }));
}
const COND_EMOJI: Record<string, string> = { poisoned: '🤢', stunned: '💫', frightened: '😱', prone: '🛌', blinded: '🙈', charmed: '😍', burning: '🔥', slowed: '🐌', blessed: '🙏', inspired: '✨' };
function conds(list: { id: string }[]) {
  return h('span', { class: 'conds' }, ...list.map((c) => h('span', { title: c.id }, COND_EMOJI[c.id] ?? '•')));
}
function playerColor(id: string) {
  return view?.players.find((p) => p.id === id)?.color ?? '#5a4326';
}

// ------------------------------------------------------------ render

function applySettings(s: Settings) {
  document.documentElement.style.setProperty('--scale', String(s.textSize));
  document.body.classList.toggle('cb', s.colorblind);
  document.body.classList.toggle('reduce-motion', s.reduceMotion);
  sfx.setVolume(s.volume);
  sfx.music = s.music;
  tray.reduceMotion = s.reduceMotion;
}

function render() {
  if (!view) return;
  applySettings(view.settings);
  renderTop();
  const sc = view.scene;
  stage.dataset.scene = sc.kind;
  const fullScenes = ['title', 'lobby', 'ending', 'jackbox'];
  main.classList.toggle('full', fullScenes.includes(sc.kind));
  stageSlot.render(hash([sc, view.world && sc.kind === 'overworld' ? [view.world.tiles.length, view.world.party, view.world.tiles.map((t) => t.reachable ?? '-').join(''), view.world.fogReach?.length, view.world.doom, view.world.objective.keys] : 0, sc.kind === 'lobby' || sc.kind === 'title' ? [view.players, Object.keys(view.chars)] : 0, sc.kind === 'combat' ? view.chars : 0, sc.kind === 'event' ? view.waiting.length : 0]), () => renderStage(sc));
  if (!fullScenes.includes(sc.kind)) sideSlot.render(hash([view.chars, view.players, view.world?.doom, view.world?.objective, view.world?.quests, view.party.gold, view.world?.time, view.world?.weather, (sc as { combat?: { current?: string } }).combat?.current]), renderSide);
  else sideSlot.render('none', () => null);
  renderNarration();
  renderModal();
  // ambience
  if (sc.kind === 'combat') sfx.ambient('combat');
  else if (sc.kind === 'dungeon') sfx.ambient('dungeon');
  else if (sc.kind === 'town') sfx.ambient('town');
  else if (view.world && (sc.kind === 'overworld' || sc.kind === 'event' || sc.kind === 'camp')) {
    const w = view.world;
    const t = w.tiles.find((x) => x.q === w.party.q && x.r === w.party.r);
    sfx.ambient((t?.biome as never) ?? 'plains');
  } else sfx.ambient('none');
}

function renderTop(force = false) {
  if (!view) return;
  if (force) topSlot.invalidate();
  topSlot.render(hash([view.code, view.campaign?.name, view.world?.kingdomName, view.party.name, net.status, role, view.paused, view.scene.kind]), () => [
    h('div', { class: 'logo' }, '🏰 Pocket Realms'),
    view!.campaign && view!.scene.kind !== 'title' ? h('div', { class: 'small muted' }, `${view!.party.name ? `${view!.party.name} · ` : ''}${view!.world?.kingdomName ?? ''} · seed ${view!.campaign.seed}`) : null,
    h('div', { class: 'spacer' }),
    h('div', { class: 'code' }, 'Room ', h('b', null, view!.code), h('span', { class: 'small muted' }, ` · ${view!.lanUrl.replace('https://', '')}`)),
    h('span', { class: `status-dot${net.status === 'open' ? '' : ' off'}`, title: net.status }),
    role === 'host' && view!.scene.kind !== 'title' ? h('button', { onclick: () => cmd({ cmd: 'skip' }), title: 'Auto-resolve everything we are waiting on' }, '⏩ Skip') : null,
    h('button', { onclick: () => ((modal = 'journal'), renderModal()) }, '📖 Journal'),
    h('button', { onclick: () => ((modal = 'settings'), renderModal()) }, '⚙️ Settings'),
  ]);
}

function renderStage(sc: SceneView) {
  switch (sc.kind) {
    case 'title':
      return renderTitle(sc.saves);
    case 'lobby':
    case 'creation':
      return renderLobby();
    case 'overworld':
      return renderOverworld();
    case 'event':
      return renderEvent(sc.event);
    case 'combat':
      return renderCombat(sc.combat as never);
    case 'town':
      return h('div', { class: 'col' }, h('div', { class: 'card center' }, h('h1', null, `🏘️ ${sc.name}`), h('div', { class: 'txt' }, sc.text), h('div', { class: 'muted' }, 'Shop, visit the shrine and take quests on your phones.')), sc.shop ? h('div', { class: 'shopgrid' }, ...sc.shop.items.slice(0, 12).map((s) => h('div', { class: 'card small' }, h('b', { class: `rarity-${s.item.rarity}` }, `${s.item.emoji} ${s.item.name}`), h('div', { class: 'muted' }, `${s.price}g · ${s.item.rarity}`)))) : null);
    case 'camp':
      return h('div', { class: 'col center', style: 'margin-top:4vh' }, h('div', { style: 'font-size:7em' }, '🔥'), h('h1', null, sc.text), sc.prompt ? h('div', { class: 'card', style: 'max-width:900px;margin:0 auto;font-size:1.5em' }, h('div', { class: 'muted small' }, `Campfire moment — ${sc.prompt.a} & ${sc.prompt.b}`), sc.prompt.text) : null);
    case 'dungeon':
      return h(
        'div',
        { class: 'col' },
        h('div', { class: 'card center' }, h('h1', null, `🕳️ ${sc.name}`), h('div', { class: 'txt' }, sc.text)),
        h('div', { class: 'rooms' }, ...sc.rooms.map((r) => h('div', { class: `card room${r.id === sc.current ? ' cur' : ''}${r.revealed ? '' : ' hidden'}` }, h('div', { style: 'font-size:2.2em' }, r.revealed ? r.emoji : '❔'), h('div', { class: 'small' }, r.revealed ? r.name : '???'), r.cleared ? h('div', { class: 'small' }, '✔️') : null))),
      );
    case 'social':
      return h('div', { class: 'card center' }, h('div', { style: 'font-size:5em' }, sc.npc.emoji), h('h1', null, `${sc.npc.name} the ${sc.npc.title}`), h('div', { class: 'txt' }, sc.text), sc.line ? h('div', { class: 'outcome' }, sc.line) : null);
    case 'jackbox':
      return renderJackbox(sc);
    case 'levelup':
      return h('div', { class: 'col center', style: 'margin-top:8vh' }, h('div', { style: 'font-size:7em' }, '⭐'), h('h1', null, `Level up! ${sc.names.join(', ')}`), h('div', { class: 'muted' }, 'Choose your upgrade on your phone.'));
    case 'ending':
      return renderEnding(sc);
    case 'loading':
      return h('div', { class: 'center' }, sc.text);
  }
}

// ------------------------------------------------------------ title

let newSettings: Partial<Settings> = {};
function renderTitle(saves: { id: string; name: string; updated: number; day: number; heroes: string[]; mode: string }[]) {
  const s = { ...view!.settings, ...newSettings };
  const segBtn = <K extends keyof Settings>(k: K, v: Settings[K], label: string) =>
    h('button', { class: s[k] === v ? 'on' : '', onclick: () => ((newSettings = { ...newSettings, [k]: v }), stageSlot.invalidate(), render()) }, label);
  let seedInput: HTMLInputElement;
  return h(
    'div',
    { class: 'col' },
    h('div', { class: 'hero-title' }, '🏰 Pocket Realms'),
    h('div', { class: 'subtitle' }, 'A pocket-sized fantasy RPG for 1–6 heroes. Phones are your character sheets, wands and dice.'),
    h(
      'div',
      { class: 'title-grid' },
      h(
        'div',
        { class: 'card col' },
        h('h2', null, '✨ New campaign'),
        h('div', null, 'Length'),
        h('div', { class: 'seg' }, segBtn('length', 'oneshot', '⚡ One-shot (~45 min)'), segBtn('length', 'campaign', '📜 Campaign (2–4 h)')),
        h('div', null, 'Difficulty'),
        h('div', { class: 'seg' }, segBtn('difficulty', 'story', '🌸 Story'), segBtn('difficulty', 'normal', '⚔️ Normal'), segBtn('difficulty', 'heroic', '💀 Heroic')),
        h('div', null, 'Seed (optional — same seed, same world)'),
        (seedInput = h('input', { placeholder: 'random', maxlength: 32 })),
        h('button', { class: 'primary', disabled: role !== 'host', onclick: () => cmd({ cmd: 'newCampaign', settings: newSettings, seed: seedInput.value.trim() || undefined }) }, '🗺️ Begin a new adventure'),
      ),
      h(
        'div',
        { class: 'card col' },
        h('h2', null, '📖 Continue campaign'),
        saves.length
          ? h('div', { class: 'col' }, ...saves.map((sv) => h('button', { disabled: role !== 'host', onclick: () => cmd({ cmd: 'continue', saveId: sv.id }), style: 'text-align:left' }, h('b', null, sv.name), h('div', { class: 'small muted' }, `Day ${sv.day} · ${sv.mode} · ${new Date(sv.updated).toLocaleString()}`), h('div', { class: 'small' }, sv.heroes.join(', ')))))
          : h('div', { class: 'muted' }, 'No saved campaigns yet. Campaigns autosave at the end of every scene.'),
      ),
    ),
    role !== 'host' ? h('div', { class: 'center muted' }, 'This screen is a spectator. Open the host link from the terminal to control the game.') : null,
  );
}

// ------------------------------------------------------------ lobby

function renderLobby() {
  const v = view!;
  const players = v.players;
  const allReady = players.length > 0 && players.filter((p) => p.connected).every((p) => p.ready && p.hasCharacter);
  return h(
    'div',
    { class: 'lobby' },
    h(
      'div',
      { class: 'card joinbox' },
      h('h2', null, '📱 Join on your phone'),
      h('img', { src: '/api/qr.svg', alt: 'QR code to join' }),
      h('div', { class: 'url' }, v.lanUrl.replace('https://', 'https://')),
      h('div', null, 'Room code'),
      h('div', { class: 'bigcode' }, v.code),
      h('div', { class: 'tip' }, '🔒 First time? Your phone will warn about the certificate. Tap Advanced → Proceed (Chrome) or Show Details → visit this website (Safari). It is your own computer. Same Wi-Fi required.'),
    ),
    h(
      'div',
      { class: 'col' },
      h('h1', null, players.length ? `${players.length} hero${players.length > 1 ? 'es' : ''} gathering...` : 'Waiting for heroes...'),
      h(
        'div',
        { class: 'players' },
        ...players.map((p) => {
          const c = v.chars[p.id];
          const sp = c ? C.species[c.species] : p.creating?.species ? C.species[p.creating.species as never] : undefined;
          const cl = c ? C.classes[c.cls] : p.creating?.cls ? C.classes[p.creating.cls as never] : undefined;
          return h(
            'div',
            { class: `card pcard${p.connected ? '' : ' offline'}`, style: `--c:${p.color}` },
            h('div', { class: 'avatar' }, c?.portrait ? h('img', { src: c.portrait }) : cl?.emoji ?? sp?.emoji ?? '🙂'),
            h('h3', null, c?.name ?? p.name),
            h('div', { class: 'small' }, c ? `${sp?.name} ${cl?.name}` : sp || cl ? `${sp?.name ?? '?'} ${cl?.name ?? '?'}...` : 'Creating a hero...'),
            h('div', null, !p.connected ? '📴 reconnecting' : p.ready && c ? '✅ Ready!' : '✍️ creating'),
            c?.personality ? h('div', { class: 'small muted' }, `“${c.personality}”`) : null,
            role === 'host' ? h('button', { class: 'ghost small', onclick: () => cmd({ cmd: 'kick', playerId: p.id }) }, 'remove') : null,
          );
        }),
      ),
      h(
        'div',
        { class: 'row center', style: 'margin-top:auto' },
        h('button', { class: 'primary', style: 'font-size:1.4em;padding:14px 30px', disabled: !allReady || role !== 'host', onclick: () => cmd({ cmd: 'start' }) }, allReady ? '⚔️ Start the adventure!' : 'Waiting for everyone to be ready...'),
        role === 'host' && (params.has('debug') || players.length < 6) ? h('button', { class: 'ghost', onclick: () => cmd({ cmd: 'addBot' }), title: 'Add a computer-controlled hero' }, '🤖 Add bot') : null,
        role === 'host' ? h('button', { class: 'ghost', onclick: () => cmd({ cmd: 'title' }) }, '↩ Title') : null,
      ),
    ),
  );
}

// ------------------------------------------------------------ overworld

function renderOverworld() {
  const w = view!.world!;
  const leader = w.leaderId ? view!.chars[w.leaderId] : undefined;
  const map = renderHexMap(w, {
    colorblind: view!.settings.colorblind,
    showReach: true,
    onTap: (q, r, t) => {
      if (role === 'host' && (t?.reachable !== undefined || w.fogReach?.some((f) => f.q === q && f.r === r))) cmd({ cmd: 'move', q, r });
    },
  });
  return h(
    'div',
    { class: 'mapwrap' },
    map,
    h('div', { class: 'card mapinfo' }, h('b', null, `🧭 ${leader?.name ?? 'The leader'} chooses the path`), h('div', { class: 'small muted' }, `${w.movesLeft} moves · glowing tiles are reachable · tap one to move for them`)),
  );
}

function renderSide() {
  const v = view!;
  const w = v.world;
  const current = (v.scene as { combat?: { current?: string } }).combat?.current;
  const els: HTMLElement[] = [];
  if (w) {
    const pips = Array.from({ length: w.doomMax }, (_, i) => h('div', { class: `pip${i < w.doom ? ' on' : ''}` }));
    els.push(
      h(
        'div',
        { class: 'card doom' },
        h('div', { class: 'row' }, h('b', null, `${w.antagonist.emoji} Doom Clock`), h('span', { class: 'grow' }), h('b', null, `${w.doom}/${w.doomMax}`)),
        h('div', { class: 'clock' }, ...pips),
        h('div', { class: 'small', style: 'margin-top:6px' }, `🔑 ${w.objective.keyName}: ${w.objective.keys}/${w.objective.keysNeeded}`),
        h('div', { class: 'small muted' }, `${{ morning: '🌅', afternoon: '☀️', evening: '🌇', night: '🌙' }[w.time]} Day ${w.day} ${w.time} · ${w.weather} · 💰 ${v.party.gold}g · 🎒 ${v.party.stash.length}`),
      ),
    );
  }
  const party = h('div', { class: 'party' });
  for (const p of v.players) {
    const c = v.chars[p.id];
    if (!c) continue;
    party.appendChild(
      h(
        'div',
        { class: `card member${c.dead ? ' dead' : c.down ? ' down' : ''}${current === c.id ? ' active' : ''}`, style: `--c:${p.color}`, 'data-uid': c.id },
        h('div', { class: 'av' }, avatar(c)),
        h(
          'div',
          null,
          h('div', { class: 'row' }, h('span', { class: 'nm' }, c.name), h('span', { class: 'small muted' }, `L${c.level} ${C.classes[c.cls].name}`), p.connected ? null : h('span', { title: 'reconnecting' }, '📴'), c.inspiration ? h('span', { class: 'tag', title: 'Inspiration' }, `✨${c.inspiration}`) : null),
          h('div', { class: 'bars' }, bar('hp', c.hp, c.maxHp), c.maxSp ? bar('sp', c.sp, c.maxSp) : null),
          h('div', { class: 'small' }, `${c.dead ? '💀 fallen' : c.down ? `☠️ dying (${c.death.successes}✔ ${c.death.failures}✖)` : `${c.hp}/${c.maxHp} HP${c.maxSp ? ` · ${c.sp} SP` : ''}`} `, conds(c.conditions)),
        ),
      ),
    );
  }
  els.push(party);
  if (w && w.quests.filter((q) => q.status === 'active').length)
    els.push(h('div', { class: 'card small' }, h('b', null, '📜 Quests'), ...w.quests.filter((q) => q.status === 'active').map((q) => h('div', null, `• ${q.title}`))));
  if (w?.banner) els.push(h('div', { class: 'card center' }, h('img', { src: w.banner, style: 'max-width:100%;max-height:120px' }), h('div', { class: 'small muted' }, `Banner of ${w.kingdomName}`)));
  return els;
}

// ------------------------------------------------------------ event

function renderEvent(ev: Extract<SceneView, { kind: 'event' }>['event']) {
  return h(
    'div',
    { class: 'card eventcard' },
    h('div', { class: 'em' }, ev.emoji),
    h('h1', null, ev.title),
    h('div', { class: 'txt' }, ev.text),
    ev.options.length
      ? h(
          'div',
          { class: 'options' },
          ...ev.options.map((o, i) =>
            h(
              'div',
              { class: `card opt${ev.chosen === i ? ' chosen' : ''}` },
              ev.votes?.[i] ? h('span', { class: 'votes' }, '🗳️'.repeat(ev.votes[i]!)) : null,
              h('b', null, `${o.emoji} ${o.label}`),
              h('div', { class: 'small muted' }, [o.skill ? `${o.skill} DC ${o.dc}` : '', o.group ? 'everyone rolls' : '', o.best ? `best: ${o.best}` : '', o.cost ?? ''].filter(Boolean).join(' · ')),
            ),
          ),
        )
      : null,
    ev.actorId ? h('div', { class: 'muted', style: 'margin-top:8px' }, `🎲 ${view!.chars[ev.actorId]?.name ?? 'A hero'} attempts it...`) : ev.chosen === undefined && ev.options.length ? h('div', { class: 'muted', style: 'margin-top:8px' }, '🗳️ Vote on your phones!') : null,
    ev.outcome ? h('div', { class: 'outcome' }, h('b', null, { crit: '🌟 Critical success! ', success: '✅ Success! ', partial: '➗ Partial: ', fail: '❌ Failure: ', fumble: '💥 Fumble! ' }[ev.outcome.degree] ?? ''), ev.outcome.text) : null,
  );
}

// ------------------------------------------------------------ combat

function renderCombat(cb: { title: string; round: number; order: string[]; current?: string; monsters: Monster[]; log: { text: string; tone?: string }[]; bossFight?: boolean }) {
  const v = view!;
  const unitName = (id: string) => v.chars[id]?.name ?? cb.monsters.find((m) => m.id === id)?.name ?? '?';
  const isGone = (id: string) => {
    const m = cb.monsters.find((x) => x.id === id);
    return m ? m.dead || m.fled : v.chars[id]?.dead;
  };
  const initbar = h(
    'div',
    { class: 'initbar' },
    h('b', null, cb.round ? `Round ${cb.round}` : 'Initiative!'),
    ...cb.order.map((id) => {
      const m = cb.monsters.find((x) => x.id === id);
      return h('span', { class: `ini${id === cb.current ? ' cur' : ''}${m && m.side === 'enemy' ? ' foe' : ''}${isGone(id) ? ' gone' : ''}` }, `${m ? m.emoji : v.chars[id] ? C.classes[v.chars[id]!.cls].emoji : ''} ${unitName(id)}`);
    }),
  );
  const unit = (m: Monster) =>
    h(
      'div',
      { class: `card unit${m.boss ? ' boss' : ''}${m.dead || m.fled ? ' dead' : ''}${m.id === cb.current ? ' cur' : ''}`, 'data-uid': m.id },
      m.telegraph ? h('div', { class: 'tele' }, `⚠️ ${m.attacks[m.telegraph.attackIndex]?.name} → ${m.telegraph.targetId === 'all' ? 'EVERYONE' : unitName(m.telegraph.targetId)}`) : null,
      h('div', { class: 'big' }, m.emoji),
      h('div', { class: 'uname' }, m.name, m.elite ? ' ⭐' : ''),
      bar('hp', m.hp, m.maxHp),
      h('div', { class: 'small' }, `${m.hp}/${m.maxHp} · AC ${m.ac} `, conds(m.conditions)),
      m.weakness && !m.dead ? h('div', { class: 'small muted' }, `weak: ${m.weakness}`) : null,
    );
  const foes = cb.monsters.filter((m) => m.side === 'enemy');
  const friends = cb.monsters.filter((m) => m.side === 'party');
  const heroes = v.players
    .map((p) => v.chars[p.id])
    .filter((c): c is Character => !!c)
    .map((c) =>
      h(
        'div',
        { class: `card unit${c.dead ? ' dead' : ''}${c.id === cb.current ? ' cur' : ''}`, 'data-uid': c.id, style: `border-color:${playerColor(c.id)}` },
        h('div', { class: 'big', style: 'font-size:2.6em' }, c.portrait ? h('img', { src: c.portrait, style: 'width:64px;height:64px;border-radius:50%;object-fit:cover' }) : C.classes[c.cls].emoji),
        h('div', { class: 'uname' }, c.name),
        bar('hp', c.hp, c.maxHp),
        h('div', { class: 'small' }, c.down && !c.dead ? `☠️ ${c.death.successes}✔ ${c.death.failures}✖` : `${c.hp}/${c.maxHp}`, ' ', conds(c.conditions)),
      ),
    );
  return h(
    'div',
    { class: 'combat' },
    initbar,
    h('div', { class: 'col', style: 'justify-content:space-around;min-height:0' }, h('div', { class: 'foes' }, ...foes.map(unit)), h('div', { class: 'friends' }, ...heroes, ...friends.map(unit))),
    h('div', { class: 'card clog', style: 'max-height:18vh' }, ...cb.log.slice(-6).map((l) => h('div', { class: `l ${l.tone ?? ''}` }, l.text))),
  );
}

// ------------------------------------------------------------ jackbox, ending

function renderJackbox(sc: Extract<SceneView, { kind: 'jackbox' }>) {
  return h(
    'div',
    { class: 'jack' },
    h('div', { class: 'prompt' }, `✍️ ${sc.prompt}`),
    sc.stage === 'writing' ? h('div', { class: 'col center' }, h('div', { style: 'font-size:5em' }, '📝'), h('h2', null, 'Write your answer on your phone!'), h('div', { class: 'waiting center' }, ...view!.waiting.map((wt) => h('span', { class: 'chip' }, wt.label)))) : null,
    sc.answers
      ? h(
          'div',
          { class: 'answers' },
          ...sc.answers.map((a) =>
            h('div', { class: `card${sc.winner === a.id && sc.stage === 'result' ? ' win' : ''}` }, h('div', null, `“${a.text}”`), sc.stage === 'result' ? h('div', { class: 'small muted' }, `${a.author ?? ''}${a.votes !== undefined ? ` · ${'⭐'.repeat(a.votes)}` : ''}`) : null),
          ),
        )
      : null,
    sc.stage === 'voting' ? h('h2', null, '🗳️ Vote for your favorite on your phone!') : null,
  );
}

function renderEnding(sc: Extract<SceneView, { kind: 'ending' }>) {
  return h(
    'div',
    { class: 'ending col' },
    h('div', { style: 'font-size:6em' }, sc.victory ? '🏆' : '💀'),
    h('h1', { style: 'font-size:3.2em' }, sc.title),
    h('div', { class: 'card', style: 'font-size:1.35em;line-height:1.5' }, sc.text),
    h(
      'table',
      null,
      h('tr', null, ...['Hero', 'Level', 'Defeated', 'Crits', 'Damage', 'Healed', ''].map((t) => h('th', null, t))),
      ...sc.stats.heroes.map((x) => h('tr', null, h('td', null, `${x.name} ${x.title}`), h('td', null, x.level), h('td', null, x.kills), h('td', null, x.crits), h('td', null, x.damage), h('td', null, x.healed), h('td', null, x.dead ? '💀' : ''))),
    ),
    h('div', { class: 'muted' }, `${sc.stats.days} days · ${sc.stats.turns} turns · Doom ${sc.stats.doom}`),
    role === 'host' ? h('div', { class: 'row center' }, h('button', { class: 'primary', onclick: () => cmd({ cmd: 'title' }) }, '🏰 Back to the title screen')) : null,
  );
}

// ------------------------------------------------------------ narration (typewriter)

let typedId = -1;
let typeTimer = 0;
const narrOld = h('div', { class: 'old' });
const narrLine = h('div', { class: 'line' });
const narrWait = h('div', { class: 'waiting' });
narr.append(narrOld, narrLine, narrWait);
void narrSlot;
function renderNarration() {
  const v = view!;
  const lines = v.narration;
  const last = lines[lines.length - 1];
  clear(narrWait);
  for (const w of v.waiting) narrWait.appendChild(h('span', { class: 'chip' }, `⏳ ${w.label}${w.deadline ? ` (${Math.max(0, Math.round((w.deadline - Date.now()) / 1000))}s)` : ''}`));
  if (!last || last.id === typedId) return;
  typedId = last.id;
  clear(narrOld);
  for (const l of lines.slice(-3, -1)) narrOld.appendChild(h('div', null, l.text));
  narrLine.className = `line ${last.style ?? ''}`;
  clearInterval(typeTimer);
  const text = last.text;
  if (v.settings.reduceMotion) {
    narrLine.textContent = text;
    return;
  }
  let i = 0;
  const speed = Math.max(8, 26 / (v.settings.textSpeed || 1));
  narrLine.textContent = '';
  typeTimer = window.setInterval(() => {
    i += 2;
    narrLine.textContent = text.slice(0, i);
    if (i >= text.length) clearInterval(typeTimer);
  }, speed);
}

// ------------------------------------------------------------ modals

function renderModal() {
  if (!view) return;
  modalSlot.render(hash([modal, modal === 'settings' ? view.settings : modal === 'journal' ? view.journal.length : 0]), () => {
    if (!modal) return null;
    const close = () => {
      modal = null;
      renderModal();
    };
    if (modal === 'journal') {
      const w = view!.world;
      return h(
        'div',
        { class: 'modal', onclick: (e: Event) => e.target === e.currentTarget && close() },
        h(
          'div',
          { class: 'card journal' },
          h('div', { class: 'row' }, h('h2', null, `📖 The Chronicle of ${w?.kingdomName ?? 'the Realm'}`), h('span', { class: 'grow' }), h('button', { onclick: close }, '✖')),
          w ? h('div', { class: 'small' }, `${w.antagonist.emoji} ${w.antagonist.name} ${w.antagonist.title} — ${w.antagonist.desc}`) : null,
          w?.mascot ? h('div', { class: 'small' }, `Mascot: ${w.mascot}`) : null,
          view!.party.motto ? h('div', { class: 'small' }, `Motto: “${view!.party.motto}”`) : null,
          w ? h('div', { class: 'small' }, ...w.factions.map((f) => h('span', { class: 'tag' }, `${f.emoji} ${f.name} ${f.rep >= 0 ? '+' : ''}${f.rep}`))) : null,
          h('hr'),
          ...[...view!.journal].reverse().map((e) => h('div', { class: 'e' }, h('span', { class: 'muted small' }, `Day ${e.day} · `), e.text, e.author ? h('span', { class: 'muted small' }, ` — ${e.author}`) : null)),
        ),
      );
    }
    const s = view!.settings;
    const set = (patch: Partial<Settings>) => cmd({ cmd: 'settings', settings: patch });
    const seg = <K extends keyof Settings>(k: K, opts: [Settings[K], string][]) => h('div', { class: 'seg' }, ...opts.map(([val, label]) => h('button', { class: s[k] === val ? 'on' : '', onclick: () => set({ [k]: val } as Partial<Settings>) }, label)));
    const slider = (k: 'textSpeed' | 'volume' | 'textSize' | 'turnTimer', min: number, max: number, step: number) =>
      h('input', { type: 'range', min, max, step, value: s[k], onchange: (e: Event) => set({ [k]: Number((e.target as HTMLInputElement).value) }) });
    return h(
      'div',
      { class: 'modal', onclick: (e: Event) => e.target === e.currentTarget && close() },
      h(
        'div',
        { class: 'card col' },
        h('div', { class: 'row' }, h('h2', null, '⚙️ Settings'), h('span', { class: 'grow' }), h('button', { onclick: close }, '✖')),
        role !== 'host' ? h('div', { class: 'muted' }, 'Only the host screen can change settings.') : null,
        h('div', null, 'Difficulty'),
        seg('difficulty', [['story', '🌸 Story'], ['normal', '⚔️ Normal'], ['heroic', '💀 Heroic']]),
        h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: s.adaptive, style: 'width:auto', onchange: (e: Event) => set({ adaptive: (e.target as HTMLInputElement).checked }) }), 'Adaptive difficulty (the director adjusts to how you are doing)'),
        h('div', null, `Text speed (${s.textSpeed}×)`),
        slider('textSpeed', 0.5, 2.5, 0.25),
        h('div', null, `Text size (${s.textSize}×)`),
        slider('textSize', 0.8, 1.8, 0.1),
        h('div', null, `Volume (${Math.round(s.volume * 100)}%)`),
        slider('volume', 0, 1, 0.05),
        h('div', null, `Turn timer (${s.turnTimer ? `${s.turnTimer}s, then auto-play` : 'off'})`),
        slider('turnTimer', 0, 180, 15),
        h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: s.music, style: 'width:auto', onchange: (e: Event) => set({ music: (e.target as HTMLInputElement).checked }) }), 'Ambient music'),
        h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: s.colorblind, style: 'width:auto', onchange: (e: Event) => set({ colorblind: (e.target as HTMLInputElement).checked }) }), 'Color-blind-safe palette'),
        h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: s.reduceMotion, style: 'width:auto', onchange: (e: Event) => set({ reduceMotion: (e.target as HTMLInputElement).checked }) }), 'Reduce motion'),
        role === 'host' && view!.scene.kind !== 'title' ? h('button', { class: 'ghost', onclick: () => confirm('Return to the title screen? Progress is autosaved at the end of each scene.') && (cmd({ cmd: 'title' }), close()) }, '🏰 Quit to title') : null,
      ),
    );
  });
}

// ------------------------------------------------------------ fx

const diceCanvas = h('canvas');
const tray = new DiceTray(diceCanvas);
const diceBox = h('div', { class: 'card diceov' }, h('div', { class: 'who' }), diceCanvas, h('div', { class: 'res' }));
let diceQueue: Extract<Fx, { kind: 'roll' }>[] = [];
let diceBusy = false;
let diceHideTimer = 0;

async function runDice() {
  if (diceBusy) return;
  diceBusy = true;
  while (diceQueue.length) {
    const f = diceQueue.shift()!;
    clearTimeout(diceHideTimer);
    if (!diceBox.isConnected) overlay.appendChild(diceBox);
    const who = diceBox.querySelector('.who')!;
    const res = diceBox.querySelector('.res')!;
    who.textContent = `${f.name}: ${f.label}${f.physical ? ' 🎲 (real dice)' : ''}`;
    res.textContent = '';
    res.className = 'res';
    sfx.play('dice');
    const highlights = f.faces.length === 2 && f.faces.every((x) => x === 20) ? f.values.map((v) => (v === f.kept ? 'kept' : 'dropped')) : f.values.map((v, i) => (f.faces[i] === 20 && v === 20 ? 'crit' : f.faces[i] === 20 && v === 1 ? 'fumble' : undefined));
    tray.throw(f.faces, { color: tintFor(f.playerId) });
    await tray.settle(f.values, highlights as never);
    sfx.play('diceLand');
    const bonus = f.bonus ? ` ${f.bonus > 0 ? '+' : '−'} ${Math.abs(f.bonus)}` : '';
    const base = f.kept ?? f.values.reduce((a, b) => a + b, 0);
    res.textContent = `${f.crit ? 'NATURAL 20! ' : f.fumble ? 'Natural 1... ' : ''}${base}${bonus} = ${f.total}${f.dc !== undefined ? (f.success ? ' ✔' : ' ✖') : ''}`;
    res.className = `res ${f.crit ? 'crit' : f.dc !== undefined ? (f.success ? 'ok' : 'no') : ''}`;
    if (f.crit) sfx.play('crit');
    if (f.fumble) sfx.play('fumble');
    await new Promise((r) => setTimeout(r, diceQueue.length ? 600 : 1300));
  }
  diceHideTimer = window.setTimeout(() => diceBox.remove(), 400);
  diceBusy = false;
}

function tintFor(pid: string): string {
  const c = playerColor(pid);
  // blend player color with ivory for a dice body
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
  if (!m) return '#f4ead2';
  const mix = (i: number) => Math.round(parseInt(m[i]!, 16) * 0.35 + 244 * 0.65).toString(16).padStart(2, '0');
  return `#${mix(1)}${mix(2)}${mix(3)}`;
}

function unitEl(id: string): HTMLElement | null {
  return stage.querySelector(`[data-uid="${id}"]`) ?? side.querySelector(`[data-uid="${id}"]`);
}
/** Floating numbers live in a fixed layer so state re-renders don't cut them off. */
function atUnit(id: string, node: HTMLElement, ms: number) {
  const el = unitEl(id);
  if (!el) return;
  const r = el.getBoundingClientRect();
  node.style.position = 'fixed';
  node.style.left = `${r.left}px`;
  node.style.top = `${r.top}px`;
  node.style.width = `${r.width}px`;
  node.style.height = `${r.height}px`;
  node.style.zIndex = '70';
  node.style.pointerEvents = 'none';
  document.body.appendChild(node);
  setTimeout(() => node.remove(), ms);
}
function floaty(id: string, text: string, cls: string) {
  atUnit(id, h('div', null, h('div', { class: `floaty ${cls}` }, text)), 1500);
}

function banner(text: string, style = 'title') {
  const b = h('div', { class: `banner ${style}` }, text);
  overlay.appendChild(b);
  setTimeout(() => b.remove(), 2400);
}

function handleFx(f: Fx) {
  switch (f.kind) {
    case 'roll':
      diceQueue.push(f);
      void runDice();
      break;
    case 'damage': {
      floaty(f.target, `-${f.amount}${f.weak ? '!' : ''}`, f.crit ? 'crit' : 'dmg');
      const el = unitEl(f.target);
      el?.classList.add('hit');
      setTimeout(() => el?.classList.remove('hit'), 400);
      sfx.play(f.crit ? 'crit' : 'hit');
      break;
    }
    case 'heal':
      floaty(f.target, `+${f.amount}`, 'heal');
      break;
    case 'miss':
      floaty(f.target, 'miss', 'miss');
      sfx.play('whoosh');
      break;
    case 'anim':
      for (const t of f.targets) atUnit(t, h('div', null, h('div', { class: `anim ${f.anim}` })), 1000);
      break;
    case 'sound':
      sfx.play(f.name);
      break;
    case 'telegraph':
      banner('⚠️ Incoming!', 'bad');
      sfx.play('bad');
      break;
    case 'banner':
      banner(f.text, f.style);
      break;
    case 'minigame': {
      const pct = Math.round(f.score * 100);
      const t = h('div', { class: 'card minifx' }, `${pct >= 80 ? '🌟' : pct >= 45 ? '👍' : '😅'} ${f.name}'s ${f.game}: ${pct}%`);
      overlay.appendChild(t);
      setTimeout(() => t.remove(), 2200);
      if (pct >= 80) sfx.play('good');
      break;
    }
    case 'enemyRoll':
    case 'haptic':
      break;
  }
}

// refresh countdown chips
setInterval(() => {
  if (view?.waiting.some((w) => w.deadline)) renderNarration();
}, 1000);
