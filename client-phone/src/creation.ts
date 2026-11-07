import { h } from '../../shared/src/browser/dom.js';
import { content } from '../../shared/src/content/index.js';
import { allowedQuirks, baseScores } from '../../shared/src/rules/character.js';
import { mod } from '../../shared/src/rules/stats.js';
import { ABILITIES, CLASSES, SKILLS, SPECIES, type ClassId, type Skill, type SpeciesId } from '../../shared/src/types.js';
import type { CreationView } from '../../shared/src/protocol.js';
import type { App } from './main.js';

const C = content();

interface Draft {
  name: string;
  species?: SpeciesId;
  cls?: ClassId;
  ancestry?: string;
  extraSkill?: Skill;
  quirks: string[];
  personality: string;
  portrait?: string;
}

export const creationFlags = { skipClaim: false };
let step = 0;
let draft: Draft = { name: '', quirks: [], personality: '' };
try {
  draft.name = localStorage.getItem('pr_name') ?? '';
} catch {
  /* ignore */
}

const STEPS = ['species', 'ancestry', 'class', 'quirks', 'personality', 'fate', 'portrait', 'review'] as const;

function visibleSteps() {
  return STEPS.filter((s) => s !== 'ancestry' || draft.species === 'dragonborn' || draft.species === 'human');
}

function go(app: App, delta: number) {
  const vs = visibleSteps();
  const idx = vs.indexOf(STEPS[step]!);
  const next = vs[Math.max(0, Math.min(vs.length - 1, idx + delta))]!;
  step = STEPS.indexOf(next);
  app.send({ t: 'creation:draft', species: draft.species, cls: draft.cls, step: next });
  app.rerender();
  window.scrollTo(0, 0);
}

function nav(app: App, canNext: boolean, nextLabel = 'Next →') {
  return h('div', { class: 'row', style: 'margin-top:8px' }, step > 0 ? h('button', { onclick: () => go(app, -1) }, '← Back') : null, h('span', { class: 'grow' }), h('button', { class: 'primary', disabled: !canNext, onclick: () => go(app, 1) }, nextLabel));
}

function stepDots() {
  const vs = visibleSteps();
  const idx = vs.indexOf(STEPS[step]!);
  return h('div', { class: 'steps' }, ...vs.map((_, i) => h('i', { class: i <= idx ? 'on' : '' })));
}

export function renderCreation(app: App) {
  const cr: CreationView | undefined = app.view?.me.creation;
  const s = STEPS[step]!;
  const out: HTMLElement[] = [stepDots()];
  if (cr?.error) out.push(h('div', { class: 'card', style: 'border-color:var(--red)' }, `⚠️ ${cr.error}`));
  switch (s) {
    case 'species':
      out.push(
        h('h2', null, 'Choose your folk'),
        h('div', { class: 'col' }, h('b', null, 'Hero name'), h('input', { value: draft.name, maxlength: 24, placeholder: 'Name your hero', oninput: (e: Event) => (draft.name = (e.target as HTMLInputElement).value) })),
        h(
          'div',
          { class: 'pickgrid' },
          ...SPECIES.map((id) => {
            const sp = C.species[id];
            return h(
              'button',
              {
                class: `pick${draft.species === id ? ' on' : ''}`,
                onclick: () => {
                  draft.species = id;
                  draft.quirks = draft.quirks.filter((q) => draft.cls && allowedQuirks(id, draft.cls).includes(q));
                  app.send({ t: 'creation:draft', species: id, cls: draft.cls, step: s });
                  app.rerender();
                },
              },
              h('span', { class: 'em' }, sp.emoji),
              h('b', null, sp.name),
              h('span', { class: 'ds' }, sp.desc),
              h('span', { class: 'ds' }, sp.traits.map((t) => t.name).join(' — ')),
            );
          }),
        ),
        nav(app, !!draft.species && draft.name.trim().length > 0),
      );
      break;
    case 'ancestry':
      if (draft.species === 'dragonborn') {
        const anc = C.species.dragonborn.ancestries ?? [];
        out.push(
          h('h2', null, 'Draconic ancestry'),
          h('div', { class: 'muted' }, 'Your breath weapon and resistance use this element.'),
          h('div', { class: 'pickgrid' }, ...anc.map((a) => h('button', { class: `pick${draft.ancestry === a.id ? ' on' : ''}`, onclick: () => ((draft.ancestry = a.id), app.rerender()) }, h('span', { class: 'em' }, a.emoji), h('b', null, a.name), h('span', { class: 'ds' }, a.dmg)))),
          nav(app, !!draft.ancestry),
        );
      } else {
        out.push(
          h('h2', null, 'Humans are versatile'),
          h('div', { class: 'muted' }, 'Pick one extra skill to be proficient in.'),
          h('div', { class: 'pickgrid' }, ...SKILLS.map((sk) => h('button', { class: `pick${draft.extraSkill === sk ? ' on' : ''}`, onclick: () => ((draft.extraSkill = sk), app.rerender()) }, h('b', null, sk)))),
          nav(app, !!draft.extraSkill),
        );
      }
      break;
    case 'class':
      out.push(
        h('h2', null, 'Choose your calling'),
        h(
          'div',
          { class: 'pickgrid' },
          ...CLASSES.map((id) => {
            const cl = C.classes[id];
            const taken = Object.values(app.view?.chars ?? {}).some((c) => c.cls === id);
            return h(
              'button',
              {
                class: `pick${draft.cls === id ? ' on' : ''}`,
                onclick: () => {
                  draft.cls = id;
                  draft.quirks = draft.quirks.filter((q) => draft.species && allowedQuirks(draft.species, id).includes(q));
                  app.send({ t: 'creation:draft', species: draft.species, cls: id, step: s });
                  app.rerender();
                },
              },
              h('span', { class: 'em' }, cl.emoji),
              h('b', null, cl.name),
              h('span', { class: 'ds' }, cl.desc),
              h('span', { class: 'ds' }, `❤️ d${cl.hitDie} — ${cl.primary}${cl.sp ? ' — spells' : ''}`),
              taken ? h('span', { class: 'badge' }, 'someone has this') : null,
            );
          }),
        ),
        nav(app, !!draft.cls),
      );
      break;
    case 'quirks': {
      const allowed = draft.species && draft.cls ? allowedQuirks(draft.species, draft.cls) : [];
      out.push(
        h('h2', null, 'Pick 1–2 quirks'),
        h('div', { class: 'muted' }, 'Each has a small effect and a roleplay prompt for campfire scenes.'),
        h(
          'div',
          { class: 'choice' },
          ...allowed.map((qid) => {
            const q = C.quirks[qid]!;
            const on = draft.quirks.includes(qid);
            return h(
              'button',
              {
                class: on ? 'pick on' : '',
                style: 'text-align:left;display:block',
                onclick: () => {
                  if (on) draft.quirks = draft.quirks.filter((x) => x !== qid);
                  else if (draft.quirks.length < 2) draft.quirks.push(qid);
                  else draft.quirks = [draft.quirks[1]!, qid];
                  app.rerender();
                },
              },
              h('div', { class: 'lbl' }, `${on ? '✅ ' : ''}${q.name}`, q.species.length ? h('span', { class: 'badge' }, C.species[q.species[0]!].name) : q.classes.length ? h('span', { class: 'badge' }, C.classes[q.classes[0]!].name) : h('span', { class: 'badge' }, 'anyone')),
              h('div', { class: 'ds' }, q.desc),
              h('div', { class: 'ds', style: 'font-style:italic' }, `🎭 ${q.prompt}`),
            );
          }),
        ),
        nav(app, draft.quirks.length >= 1),
      );
      break;
    }
    case 'personality': {
      const ta = h('textarea', { rows: 2, maxlength: 140, placeholder: 'One line about your hero...' }, draft.personality) as HTMLTextAreaElement;
      ta.addEventListener('input', () => (draft.personality = ta.value));
      out.push(
        h('h2', null, 'Who are you, really?'),
        ta,
        h('div', { class: 'muted small' }, 'Or pick one:'),
        h('div', { class: 'choice' }, ...C.names.personalities.slice(0, 8).map((p) => h('button', { onclick: () => ((draft.personality = p), app.rerender()) }, h('span', { class: 'em' }, '💬'), h('span', null, p)))),
        nav(app, true),
      );
      break;
    }
    case 'fate': {
      const fate = cr?.fate;
      out.push(
        h('h2', null, '🎲 Roll for Fate'),
        h('div', { class: 'muted' }, 'Your class gives you a standard set of ability scores. Roll a d20 to see how fate nudges them (optional, one roll).'),
        fate
          ? h('div', { class: 'card center' }, h('div', { style: 'font-size:3em' }, fate.roll === 20 ? '🌟' : fate.roll === 1 ? '💀' : '🎲'), h('h2', null, `You rolled ${fate.roll}`), h('div', null, fate.text))
          : h('button', { class: 'primary', style: 'font-size:1.3em;padding:16px', onclick: () => app.send({ t: 'creation:fate' }) }, '🎲 Roll the d20 of Fate'),
        nav(app, true, fate ? 'Next →' : 'Skip →'),
      );
      break;
    }
    case 'portrait':
      out.push(h('h2', null, '🎨 Draw your portrait'), h('div', { class: 'muted' }, 'Sketch your hero (or skip). It appears on the main screen.'), drawPad(draft.portrait, (url) => (draft.portrait = url)), nav(app, true, 'Next →'));
      break;
    case 'review': {
      const sp = draft.species ? C.species[draft.species] : undefined;
      const cl = draft.cls ? C.classes[draft.cls] : undefined;
      const fate = cr?.fate;
      const scores = draft.species && draft.cls ? baseScores(draft.species, draft.cls, fate ? { roll: fate.roll, text: fate.text, ability: fate.ability as never, delta: fate.delta } : undefined) : undefined;
      out.push(
        h('h2', null, 'Ready to adventure?'),
        h(
          'div',
          { class: 'card col' },
          h('div', { class: 'row' }, draft.portrait ? h('img', { src: draft.portrait, style: 'width:72px;height:72px;border-radius:50%;border:2px solid var(--ink-2)' }) : h('span', { style: 'font-size:3em' }, cl?.emoji ?? '?'), h('div', null, h('h2', null, draft.name || 'Nameless'), h('div', null, `${sp?.name ?? '?'} ${cl?.name ?? '?'}`))),
          scores ? h('div', { class: 'sheet-grid' }, ...ABILITIES.map((a) => h('div', { class: 'card stat' }, h('span', { class: 'small' }, a), h('b', null, scores[a]), h('span', { class: 'small' }, `${mod(scores[a]) >= 0 ? '+' : ''}${mod(scores[a])}`)))) : null,
          h('div', null, h('b', null, 'Quirks: '), draft.quirks.map((q) => C.quirks[q]?.name).join(', ')),
          h('div', { class: 'muted' }, `“${draft.personality || 'Mysterious and quiet.'}”`),
          h('div', { class: 'small' }, h('b', null, 'Starting powers: '), (cl?.startAbilities ?? []).map((a) => C.abilities[a]?.name).join(', ')),
        ),
        h('div', { class: 'row' }, h('button', { onclick: () => go(app, -1) }, '← Back'), h('span', { class: 'grow' }), h('button', { class: 'good', style: 'font-size:1.2em', onclick: () => app.send({ t: 'character:create', draft: { ...draft, personality: draft.personality || 'Mysterious and quiet.' } }) }, '✅ Create hero!')),
      );
      break;
    }
  }
  return out;
}

export function renderClaim(app: App, list: NonNullable<CreationView['claimable']>) {
  return [
    h('h2', null, '📖 The adventure continues!'),
    h('div', { class: 'muted' }, 'Which hero are you?'),
    h(
      'div',
      { class: 'choice' },
      ...list.map((c) => h('button', { onclick: () => app.send({ t: 'claim', charId: c.id }) }, h('span', { class: 'em' }, C.classes[c.cls].emoji), h('span', null, h('div', { class: 'lbl' }, c.name), h('div', { class: 'ds' }, `Level ${c.level} ${C.species[c.species].name} ${C.classes[c.cls].name}`)))),
    ),
    h('div', { class: 'muted small' }, 'Joining fresh? Create a new hero instead:'),
    h('button', { onclick: () => ((creationFlags.skipClaim = true), app.rerender()) }, 'I am new here'),
  ];
}

/** Touch drawing pad that exports a small PNG data URL. */
export function drawPad(initial: string | undefined, onChange: (url: string | undefined) => void, size = 240) {
  const canvas = h('canvas', { class: 'drawpad', width: size, height: size }) as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fffaf0';
  ctx.fillRect(0, 0, size, size);
  if (initial) {
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, size, size);
    img.src = initial;
  }
  let color = '#2b1d0e';
  let width = 5;
  let drawing = false;
  let last: [number, number] | null = null;
  const pos = (e: PointerEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * size, ((e.clientY - r.top) / r.height) * size];
  };
  const save = () => {
    let url = canvas.toDataURL('image/webp', 0.7);
    if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/png');
    if (url.length > 85000) url = canvas.toDataURL('image/jpeg', 0.6);
    onChange(url);
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    drawing = true;
    last = pos(e);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(last[0], last[1], width / 2, 0, Math.PI * 2);
    ctx.fill();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing || !last) return;
    const p = pos(e);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(last[0], last[1]);
    ctx.lineTo(p[0], p[1]);
    ctx.stroke();
    last = p;
  });
  const end = () => {
    if (drawing) save();
    drawing = false;
    last = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  const palette = ['#2b1d0e', '#7a1f1f', '#c0392b', '#d68910', '#f1c40f', '#229954', '#2471a3', '#7d3c98', '#f5cba7', '#ffffff'];
  return h(
    'div',
    { class: 'col' },
    canvas,
    h('div', { class: 'colors' }, ...palette.map((c) => h('button', { style: `background:${c}`, onclick: () => (color = c), title: c }))),
    h(
      'div',
      { class: 'row' },
      h('button', { onclick: () => (width = 3) }, '✏️ thin'),
      h('button', { onclick: () => (width = 8) }, '🖌️ thick'),
      h('button', { onclick: () => (width = 22) }, '🧽 huge'),
      h('span', { class: 'grow' }),
      h(
        'button',
        {
          class: 'ghost',
          onclick: () => {
            ctx.fillStyle = '#fffaf0';
            ctx.fillRect(0, 0, size, size);
            onChange(undefined);
          },
        },
        'Clear',
      ),
    ),
  );
}
