import { z } from 'zod';
import abilitiesJson from '../../content/abilities.json';
import affixesJson from '../../content/affixes.json';
import antagonistsJson from '../../content/antagonists.json';
import barksJson from '../../content/barks.json';
import campJson from '../../content/camp.json';
import classesJson from '../../content/classes.json';
import eventsJson from '../../content/events.json';
import factionsJson from '../../content/factions.json';
import itemsJson from '../../content/items.json';
import monstersJson from '../../content/monsters.json';
import namesJson from '../../content/names.json';
import npcsJson from '../../content/npcs.json';
import promptsJson from '../../content/prompts.json';
import questsJson from '../../content/quests.json';
import quirksJson from '../../content/quirks.json';
import setsJson from '../../content/sets.json';
import speciesJson from '../../content/species.json';
import type { ClassId, SpeciesId } from '../types.js';
import {
  zAbilityDef,
  zAffixDef,
  zAntagonist,
  zBark,
  zCampPrompt,
  zClassDef,
  zEventCard,
  zFactionDef,
  zItemBase,
  zJackboxPrompt,
  zMonsterDef,
  zNames,
  zNpcArchetype,
  zQuestTemplate,
  zQuirkDef,
  zSetDef,
  zSpeciesDef,
  type AbilityDef,
  type AffixDef,
  type AntagonistDef,
  type BarkDef,
  type ClassDef,
  type EventCard,
  type ItemBase,
  type MonsterDef,
  type NpcArchetype,
  type QuirkDef,
  type SetDef,
  type SpeciesDef,
} from './schemas.js';

export * from './schemas.js';

export class ContentError extends Error {}

function parseList<T extends z.ZodTypeAny>(file: string, schema: T, data: unknown): z.infer<T>[] {
  const res = z.array(schema).safeParse(data);
  if (!res.success) {
    const issues = res.error.issues
      .slice(0, 8)
      .map((i) => {
        const idx = typeof i.path[0] === 'number' ? (data as { id?: string }[])[i.path[0]]?.id : undefined;
        return `  - ${file}${idx ? ` [${idx}]` : ''} at ${i.path.join('.')}: ${i.message}`;
      })
      .join('\n');
    throw new ContentError(`Invalid content in ${file}:\n${issues}`);
  }
  const list = res.data as z.infer<T>[];
  const seen = new Set<string>();
  for (const item of list as { id?: string }[]) {
    if (!item.id) continue;
    if (seen.has(item.id)) throw new ContentError(`Duplicate id "${item.id}" in ${file}`);
    seen.add(item.id);
  }
  return list;
}

function byId<T extends { id: string }>(list: T[]): Record<string, T> {
  return Object.fromEntries(list.map((x) => [x.id, x]));
}

export interface Content {
  abilities: Record<string, AbilityDef>;
  abilityList: AbilityDef[];
  classes: Record<ClassId, ClassDef>;
  species: Record<SpeciesId, SpeciesDef>;
  quirks: Record<string, QuirkDef>;
  quirkList: QuirkDef[];
  monsters: Record<string, MonsterDef>;
  monsterList: MonsterDef[];
  items: Record<string, ItemBase>;
  itemList: ItemBase[];
  affixes: AffixDef[];
  sets: Record<string, SetDef>;
  events: EventCard[];
  npcs: NpcArchetype[];
  factions: z.infer<typeof zFactionDef>[];
  antagonists: AntagonistDef[];
  barks: Record<string, BarkDef>;
  quests: z.infer<typeof zQuestTemplate>[];
  prompts: z.infer<typeof zJackboxPrompt>[];
  camp: z.infer<typeof zCampPrompt>[];
  names: z.infer<typeof zNames>;
}

export function loadContent(): Content {
  const abilityList = parseList('abilities.json', zAbilityDef, abilitiesJson);
  const classList = parseList('classes.json', zClassDef, classesJson);
  const speciesList = parseList('species.json', zSpeciesDef, speciesJson);
  const quirkList = parseList('quirks.json', zQuirkDef, quirksJson);
  const monsterList = parseList('monsters.json', zMonsterDef, monstersJson);
  const itemList = parseList('items.json', zItemBase, itemsJson);
  const affixes = parseList('affixes.json', zAffixDef, affixesJson);
  const setList = parseList('sets.json', zSetDef, setsJson);
  const events = parseList('events.json', zEventCard, eventsJson);
  const npcs = parseList('npcs.json', zNpcArchetype, npcsJson);
  const factions = parseList('factions.json', zFactionDef, factionsJson);
  const antagonists = parseList('antagonists.json', zAntagonist, antagonistsJson);
  const barkList = parseList('barks.json', zBark, barksJson);
  const quests = parseList('quests.json', zQuestTemplate, questsJson);
  const prompts = parseList('prompts.json', zJackboxPrompt, promptsJson);
  const camp = parseList('camp.json', zCampPrompt, campJson);
  const namesRes = zNames.safeParse(namesJson);
  if (!namesRes.success) throw new ContentError(`Invalid names.json: ${namesRes.error.message}`);

  const c: Content = {
    abilities: byId(abilityList),
    abilityList,
    classes: byId(classList) as Record<ClassId, ClassDef>,
    species: byId(speciesList) as Record<SpeciesId, SpeciesDef>,
    quirks: byId(quirkList),
    quirkList,
    monsters: byId(monsterList),
    monsterList,
    items: byId(itemList),
    itemList,
    affixes,
    sets: byId(setList),
    events,
    npcs,
    factions,
    antagonists,
    barks: byId(barkList),
    quests,
    prompts,
    camp,
    names: namesRes.data,
  };
  crossCheck(c);
  return c;
}

/** Referential integrity: every id referenced from one file must exist in another. */
function crossCheck(c: Content) {
  const errs: string[] = [];
  const need = (cond: boolean, msg: string) => {
    if (!cond) errs.push(msg);
  };
  for (const cls of Object.values(c.classes)) {
    for (const a of cls.startAbilities) need(!!c.abilities[a], `class ${cls.id}: unknown start ability ${a}`);
    need(!!c.items[cls.startWeapon], `class ${cls.id}: unknown weapon ${cls.startWeapon}`);
    if (cls.startArmor) need(!!c.items[cls.startArmor], `class ${cls.id}: unknown armor ${cls.startArmor}`);
    for (const i of cls.startItems) need(!!c.items[i], `class ${cls.id}: unknown item ${i}`);
    for (const ab of Object.values(c.abilities)) {
      if (ab.cost.resource && ab.classes.includes(cls.id) && !ab.tags.includes('species')) {
        // resource must exist on at least one class that has the ability
      }
    }
  }
  for (const ab of c.abilityList) {
    if (ab.cost.resource) {
      const owners = ab.classes.map((id) => c.classes[id]).filter((x) => x.resources.some((r) => r.id === ab.cost.resource));
      need(owners.length > 0, `ability ${ab.id}: no class has resource ${ab.cost.resource}`);
    }
    if (ab.kind !== 'passive' && ab.effects.length === 0) errs.push(`ability ${ab.id}: non-passive with no effects`);
    for (const e of ab.effects) if (e.type === 'summonAlly') need(!!c.monsters[e.monsterId], `ability ${ab.id}: unknown monster ${e.monsterId}`);
  }
  for (const sp of Object.values(c.species)) for (const a of sp.abilities) need(!!c.abilities[a], `species ${sp.id}: unknown ability ${a}`);
  for (const m of c.monsterList) for (const a of m.attacks) if (a.summon) need(!!c.monsters[a.summon], `monster ${m.id}: unknown summon ${a.summon}`);
  for (const s of Object.values(c.sets)) for (const p of s.pieces) need(c.items[p]?.setId === s.id, `set ${s.id}: piece ${p} missing or not tagged`);
  const families = new Set(c.monsterList.map((m) => m.family));
  for (const ev of c.events)
    for (const o of ev.options)
      for (const oc of Object.values(o.outcomes))
        for (const e of oc?.effects ?? []) {
          if (e.type === 'combat') {
            if (e.family) need(families.has(e.family), `event ${ev.id}: unknown family ${e.family}`);
            for (const m of e.monsters ?? []) need(!!c.monsters[m], `event ${ev.id}: unknown monster ${m}`);
          }
          if (e.type === 'itemId') need(!!c.items[e.id], `event ${ev.id}: unknown item ${e.id}`);
        }
  for (const a of c.antagonists) {
    need(!!c.monsters[a.bossId]?.boss, `antagonist ${a.id}: boss ${a.bossId} missing or not a boss`);
    for (const f of a.minions) need(families.has(f), `antagonist ${a.id}: unknown family ${f}`);
  }
  for (const b of Object.values(c.barks)) {
    need(!!c.monsters[b.id] || families.has(b.id), `barks ${b.id}: not a monster id or family`);
    need(!!b.silent || !!b.voice, `barks ${b.id}: needs a voice (or silent: true)`);
  }
  if (errs.length) throw new ContentError(`Content cross-reference errors:\n  - ${errs.join('\n  - ')}`);
}

let cached: Content | undefined;
/** Validated content singleton. Throws loudly on bad JSON. */
export function content(): Content {
  if (!cached) cached = loadContent();
  return cached;
}
