import { sfx } from '../../shared/src/browser/audio.js';
import { h } from '../../shared/src/browser/dom.js';
import { content } from '../../shared/src/content/index.js';
import { itemStatLine } from '../../shared/src/rules/items.js';
import { getAc, initiativeBonus, mod, profBonus, saveBonus, signed, skillBonus, spellDC, stat, weaponProfile, XP_TABLE } from '../../shared/src/rules/stats.js';
import { ABILITIES, SKILLS, type Character, type ItemInstance } from '../../shared/src/types.js';
import type { App } from './main.js';
import { DEBUG, caps, haptic, requestMotion, startMic, stopMic } from './sensors.js';

const C = content();
export type TabId = 'now' | 'sheet' | 'bag' | 'spells' | 'journal';

export function renderTab(app: App, tab: TabId) {
  const v = app.view!;
  const c = v.chars[v.me.id]!;
  switch (tab) {
    case 'sheet':
      return sheet(c);
    case 'bag':
      return bag(app, c);
    case 'spells':
      return powers(app, c);
    case 'journal':
      return journal(app, c);
    default:
      return null;
  }
}

function sheet(c: Character) {
  const cls = C.classes[c.cls];
  const sp = C.species[c.species];
  const wp = weaponProfile(c);
  const nextXp = XP_TABLE[c.level] ?? XP_TABLE[XP_TABLE.length - 1]!;
  return [
    h(
      'div',
      { class: 'card col' },
      h('div', { class: 'row' }, c.portrait ? h('img', { src: c.portrait, style: 'width:64px;height:64px;border-radius:50%;border:2px solid var(--ink-2)' }) : h('span', { style: 'font-size:2.6em' }, cls.emoji), h('div', null, h('h2', null, `${c.name} ${c.titles.length ? c.titles[c.titles.length - 1] : ''}`), h('div', null, `Level ${c.level} ${sp.name} ${cls.name}${c.ancestry ? ` (${c.ancestry})` : ''}`))),
      h('div', { class: 'muted' }, `“${c.personality}”`),
      h('div', { class: 'bar xp', title: 'XP' }, h('i', { style: `width:${Math.min(100, ((c.xp - (XP_TABLE[c.level - 1] ?? 0)) / Math.max(1, nextXp - (XP_TABLE[c.level - 1] ?? 0))) * 100)}%` })),
      h('div', { class: 'small muted' }, `${c.xp} XP · next level at ${nextXp}`),
    ),
    h(
      'div',
      { class: 'sheet-grid' },
      h('div', { class: 'card stat' }, h('span', { class: 'small' }, 'AC'), h('b', null, getAc(c))),
      h('div', { class: 'card stat' }, h('span', { class: 'small' }, 'HP'), h('b', null, `${c.hp}/${c.maxHp}`)),
      h('div', { class: 'card stat' }, h('span', { class: 'small' }, 'Init'), h('b', null, signed(initiativeBonus(c)))),
      h('div', { class: 'card stat' }, h('span', { class: 'small' }, 'Prof'), h('b', null, `+${profBonus(c.level)}`)),
      h('div', { class: 'card stat' }, h('span', { class: 'small' }, 'Attack'), h('b', null, signed(wp.toHit)), h('span', { class: 'small' }, `${wp.dice}+${wp.damageBonus}`)),
      cls.castAbility ? h('div', { class: 'card stat' }, h('span', { class: 'small' }, 'Spell DC'), h('b', null, spellDC(c))) : h('div', { class: 'card stat' }, h('span', { class: 'small' }, 'Insp.'), h('b', null, c.inspiration)),
    ),
    h('div', { class: 'sheet-grid' }, ...ABILITIES.map((a) => h('div', { class: 'card stat' }, h('span', { class: 'small' }, a), h('b', null, stat(c, a)), h('span', { class: 'small' }, `${signed(mod(stat(c, a)))} · save ${signed(saveBonus(c, a))}`)))),
    h('div', { class: 'card col small' }, h('b', null, 'Skills'), h('div', { class: 'row wrap' }, ...SKILLS.map((s) => h('span', { class: 'tag', style: c.skills.includes(s) ? 'font-weight:bold;border-width:2px' : '' }, `${s} ${signed(skillBonus(c, s))}`)))),
    h('div', { class: 'card col small' }, h('b', null, 'Traits & quirks'), ...sp.traits.map((t) => h('div', null, `🧬 ${t.name}: ${t.desc}`)), ...c.quirks.map((q) => h('div', null, `🎭 ${C.quirks[q]?.name}: ${C.quirks[q]?.desc}`, h('div', { class: 'muted', style: 'font-style:italic' }, C.quirks[q]?.prompt ?? '')))),
    Object.keys(c.resources).length ? h('div', { class: 'card col small' }, h('b', null, 'Resources'), ...Object.values(c.resources).map((r) => h('div', null, `${r.name}: ${r.cur}/${r.max} (recovers on ${r.recover} rest)`))) : null,
    c.titles.length ? h('div', { class: 'card small' }, h('b', null, 'Titles: '), c.titles.join(', ')) : null,
    h('div', { class: 'card small' }, h('b', null, 'Deeds: '), `${c.stats.kills} foes defeated · ${c.stats.crits} crits · ${c.stats.damageDealt} damage · ${c.stats.healed} healed · ${c.stats.minigamesAced} perfect minigames`),
  ];
}

function itemCard(it: ItemInstance, acts: HTMLElement[]) {
  return h('div', { class: 'card item' }, h('span', { class: 'em' }, it.emoji), h('div', null, h('b', { class: `rarity-${it.rarity}` }, it.name), h('span', { class: 'badge' }, it.rarity), h('div', { class: 'small' }, itemStatLine(it)), h('div', { class: 'small muted' }, it.desc), acts.length ? h('div', { class: 'acts' }, ...acts) : null));
}

function bag(app: App, c: Character) {
  const v = app.view!;
  const intent = (i: Parameters<typeof app.send>[0] extends never ? never : object) => app.send({ t: 'intent', intent: i as never });
  const inCombat = v.scene.kind === 'combat';
  const others = Object.values(v.chars).filter((x) => x.id !== c.id && !x.dead);
  const eq = (['weapon', 'armor', 'trinket'] as const).map((slot) => {
    const it = c.equipment[slot];
    return it ? itemCard(it, inCombat ? [] : [h('button', { onclick: () => intent({ kind: 'unequip', slot }) }, 'Unequip')]) : h('div', { class: 'card small muted' }, `No ${slot} equipped`);
  });
  const inv = c.inventory.map((it) => {
    const acts: HTMLElement[] = [];
    if (!inCombat && (it.slot === 'weapon' || it.slot === 'armor' || it.slot === 'trinket')) acts.push(h('button', { class: 'primary', onclick: () => intent({ kind: 'equip', uid: it.uid }) }, 'Equip'));
    if (!inCombat && it.use && it.use.target !== 'enemy' && it.use.target !== 'allEnemies') {
      acts.push(h('button', { onclick: () => intent({ kind: 'use', uid: it.uid }) }, 'Use'));
      if (it.use.target === 'ally') for (const o of others) acts.push(h('button', { onclick: () => intent({ kind: 'use', uid: it.uid, target: o.id }) }, `Use on ${o.name}`));
    }
    acts.push(h('button', { class: 'ghost', onclick: () => intent({ kind: 'toStash', uid: it.uid }) }, '→ Stash'));
    for (const o of others.slice(0, 3)) acts.push(h('button', { class: 'ghost', onclick: () => intent({ kind: 'give', uid: it.uid, to: o.id }) }, `Give ${o.name}`));
    return itemCard(it, acts);
  });
  const stash = v.party.stash.map((it) => itemCard(it, inCombat ? [] : [h('button', { class: 'good', onclick: () => intent({ kind: 'fromStash', uid: it.uid }) }, 'Take')]));
  return [
    h('h2', null, '🛡️ Equipped'),
    ...eq,
    h('h2', null, `🎒 Your bag (${c.inventory.length})`),
    ...(inv.length ? inv : [h('div', { class: 'muted' }, 'Empty.')]),
    h('h2', null, `📦 Party stash (${v.party.stash.length}) · 💰 ${v.party.gold}g`),
    h('div', { class: 'small muted' }, 'Loot from fights lands here. First come, first served — be nice!'),
    ...(stash.length ? stash : [h('div', { class: 'muted' }, 'Empty.')]),
  ];
}

function powers(app: App, c: Character) {
  const v = app.view!;
  const inCombat = v.scene.kind === 'combat';
  const others = Object.values(v.chars).filter((x) => !x.dead || x.down);
  return [
    h('div', { class: 'card small' }, `🔷 Spell Points: ${c.sp}/${c.maxSp}`, ...Object.values(c.resources).map((r) => h('span', { class: 'tag' }, `${r.name} ${r.cur}/${r.max}`))),
    ...c.known.map((id) => {
      const a = C.abilities[id];
      if (!a) return null;
      const cost = [a.cost.sp ? `${a.cost.sp} SP` : '', a.cost.resource ? `${a.cost.amount ?? 1} ${c.resources[a.cost.resource]?.name ?? a.cost.resource}` : '', a.usesPerCombat ? `${a.usesPerCombat}/fight` : ''].filter(Boolean).join(', ');
      const acts: HTMLElement[] = [];
      if (a.outOfCombat && !inCombat) {
        if (a.target === 'allAllies' || a.target === 'self') acts.push(h('button', { class: 'good', onclick: () => app.send({ t: 'intent', intent: { kind: 'useAbility', id: a.id } }) }, 'Cast now'));
        else for (const o of others) acts.push(h('button', { class: 'good', onclick: () => app.send({ t: 'intent', intent: { kind: 'useAbility', id: a.id, target: o.id } }) }, `Cast on ${o.name}`));
      }
      return h(
        'div',
        { class: 'card item' },
        h('span', { class: 'em' }, a.emoji),
        h(
          'div',
          null,
          h('b', null, a.name),
          h('span', { class: 'badge' }, a.kind === 'passive' ? 'passive' : a.action === 'bonus' ? 'bonus' : a.kind),
          cost ? h('span', { class: 'badge' }, cost) : null,
          a.minigame ? h('span', { class: 'badge' }, `🎮 ${a.minigame.kind}`) : null,
          h('div', { class: 'small' }, a.desc),
          a.flavor ? h('div', { class: 'small muted', style: 'font-style:italic' }, a.flavor) : null,
          acts.length ? h('div', { class: 'acts' }, ...acts) : null,
        ),
      );
    }),
  ];
}

function journal(app: App, c: Character) {
  const v = app.view!;
  const w = v.world;
  const player = v.players.find((p) => p.id === v.me.id)!;
  const test = h('div', { class: 'small muted' });
  return [
    v.me.secrets.length ? h('div', { class: 'card col secret' }, h('b', null, '🤫 Secrets (only you can see these)'), ...v.me.secrets.map((s) => h('div', null, `• ${s.text}`))) : null,
    w ? h('div', { class: 'card col small' }, h('b', null, `🎯 ${w.objective.text}`), h('div', null, `🔑 ${w.objective.keyName}: ${w.objective.keys}/${w.objective.keysNeeded} · ⏳ Doom ${w.doom}/${w.doomMax}`), ...w.quests.filter((q) => q.status === 'active').map((q) => h('div', null, `📜 ${q.title}${q.privateFor ? ' (secret)' : ''} — ${q.desc}`))) : null,
    w ? h('div', { class: 'card small' }, ...w.factions.map((f) => h('span', { class: 'tag' }, `${f.emoji} ${f.name} ${f.rep >= 0 ? '+' : ''}${f.rep}`))) : null,
    h('div', { class: 'card col small' }, h('b', null, `📖 Chronicle of ${w?.kingdomName ?? 'the Realm'}`), ...[...v.journal].reverse().slice(0, 30).map((e) => h('div', null, h('span', { class: 'muted' }, `D${e.day} `), e.text))),
    h(
      'div',
      { class: 'card col' },
      h('b', null, '⚙️ Settings'),
      h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: player.physicalDice, style: 'width:auto', onchange: (e: Event) => app.send({ t: 'intent', intent: { kind: 'physicalDice', on: (e.target as HTMLInputElement).checked } }) }), '🎲 I roll real, physical dice (enter results myself)'),
      h('div', { class: 'row wrap' }, h('button', { onclick: async () => (test.textContent = (await requestMotion()) ? '✅ Motion sensors work' : '⚠️ No motion sensors — touch fallbacks will be used') }, '📳 Test motion'), h('button', { onclick: async () => {
        const ok = await startMic();
        test.textContent = ok ? '✅ Microphone works' : '⚠️ No microphone access — touch fallbacks will be used';
        setTimeout(stopMic, 1500);
      } }, '🎤 Test mic'), h('button', { onclick: () => (haptic([100, 50, 100]), sfx.unlock(), sfx.play('coin')) }, '🔔 Test buzz')),
      test,
      h('div', { class: 'small muted' }, `Sensors: motion ${caps.motion ? '✓' : '?'} · orientation ${caps.orientation ? '✓' : '?'} · mic ${caps.mic ? '✓' : '?'} · vibration ${caps.vibrate ? '✓' : '✗ (screen flash instead)'}${DEBUG ? ' · DEBUG' : ''}`),
      h('a', { href: `${location.pathname}?debug=1`, class: 'small' }, 'Open sensor debug mode'),
      h('button', { class: 'ghost small', onclick: () => {
        if (!confirm('Leave this game on this phone? Your hero stays with the party.')) return;
        try {
          localStorage.removeItem('pr_token');
        } catch {
          /* ignore */
        }
        location.reload();
      } }, '🚪 Leave game on this device'),
    ),
    h('div', { class: 'small muted center' }, `${c.name} · room ${v.code}`),
  ];
}
