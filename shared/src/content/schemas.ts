import { z } from 'zod';
import { isValidDice } from '../dice.js';
import {
  ABILITIES,
  BIOMES,
  CLASSES,
  CONDITIONS,
  DAMAGE_TYPES,
  MINIGAMES,
  RARITIES,
  SKILLS,
  SPECIES,
} from '../types.js';

/**
 * Content schemas. Every JSON file in shared/content is validated against these
 * at load time; any mistake throws with the file name and the failing path.
 */

export const zDice = z.string().refine(isValidDice, { message: 'invalid dice expression' });
export const zAbility = z.enum(ABILITIES);
export const zSkill = z.enum(SKILLS);
export const zSpecies = z.enum(SPECIES);
export const zClass = z.enum(CLASSES);
export const zCondition = z.enum(CONDITIONS);
export const zDamage = z.enum(DAMAGE_TYPES);
export const zMinigame = z.enum(MINIGAMES);
export const zBiome = z.enum(BIOMES);
export const zRarity = z.enum(RARITIES);
const zTime = z.enum(['morning', 'afternoon', 'evening', 'night']);
const zWeather = z.enum(['clear', 'rain', 'fog', 'storm', 'snow', 'heat']);
const zScores = z.object({ STR: z.number(), DEX: z.number(), CON: z.number(), INT: z.number(), WIS: z.number(), CHA: z.number() });
const zPartialScores = z.object({
  STR: z.number().optional(),
  DEX: z.number().optional(),
  CON: z.number().optional(),
  INT: z.number().optional(),
  WIS: z.number().optional(),
  CHA: z.number().optional(),
});
const zLevels = z.array(z.number()).length(10); // value per level 1..10

export const zBuffId = z.enum([
  'ac',
  'attack',
  'damage',
  'resist',
  'resistAll',
  'invisible',
  'rage',
  'shield',
  'dodge',
  'smite',
  'taunt',
  'regen',
  'thorns',
  'sanctuary',
  'reckless',
  'evasive',
  'concentrate',
  'imbue',
  'spiritWeapon',
  'haste',
  'marked',
]);

export const zBuff = z.object({
  id: zBuffId,
  turns: z.number().int().min(1).max(99),
  amount: z.number().optional(),
  dice: zDice.optional(),
  dmg: zDamage.optional(),
  condition: zCondition.optional(),
  name: z.string().optional(),
});

// ---------------------------------------------------------------- Spells & abilities

export const zEffect = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('damage'),
    dice: zDice,
    dmg: zDamage,
    /** add the caster's primary/casting modifier */
    addMod: z.boolean().default(false),
    /** use equipped weapon dice instead (dice field = extra dice) */
    weapon: z.boolean().default(false),
  }),
  z.object({ type: z.literal('heal'), dice: zDice, addMod: z.boolean().default(false) }),
  z.object({ type: z.literal('tempHp'), dice: zDice, addMod: z.boolean().default(false) }),
  z.object({ type: z.literal('condition'), id: zCondition, turns: z.number().int().min(1).max(99) }),
  z.object({ type: z.literal('removeCondition'), ids: z.array(zCondition).optional() }),
  z.object({ type: z.literal('buff'), buff: zBuff }),
  z.object({ type: z.literal('revive'), hp: z.number().int().min(1), dead: z.boolean().default(false) }),
  z.object({ type: z.literal('restoreSp'), amount: z.number().int() }),
  z.object({ type: z.literal('cancelTelegraph') }),
  z.object({ type: z.literal('extraAction') }),
  z.object({ type: z.literal('flee') }),
  z.object({ type: z.literal('steal'), gold: zDice }),
  z.object({ type: z.literal('push'), turns: z.number().default(1) }), // knock prone & delay
  z.object({ type: z.literal('execute'), threshold: z.number() }), // kill if hp <= threshold*level
  z.object({ type: z.literal('summonAlly'), monsterId: z.string() }),
  z.object({ type: z.literal('reveal') }),
]);
export type Effect = z.infer<typeof zEffect>;

export const zTarget = z.enum([
  'enemy',
  'ally', // any party member incl. self
  'otherAlly',
  'self',
  'allEnemies',
  'allAllies',
  'enemies2',
  'enemies3',
  'downedAlly',
]);

export const zAbilityDef = z.object({
  id: z.string(),
  name: z.string(),
  classes: z.array(zClass).min(1),
  level: z.number().int().min(1).max(10),
  kind: z.enum(['spell', 'ability', 'passive']),
  action: z.enum(['action', 'bonus', 'passive']).default('action'),
  emoji: z.string().default('✨'),
  cost: z
    .object({ sp: z.number().int().min(0).optional(), resource: z.string().optional(), amount: z.number().int().optional() })
    .default({}),
  range: z.enum(['melee', 'ranged', 'self', 'any']).default('any'),
  target: zTarget,
  resolve: z.enum(['weapon', 'spellAttack', 'save', 'auto']),
  save: z.object({ ability: zAbility, half: z.boolean().default(false) }).optional(),
  effects: z.array(zEffect).default([]),
  /** extra dice added per `every` character levels above the ability's level */
  scaling: z.object({ dice: zDice, every: z.number().int().min(1) }).optional(),
  minigame: z
    .object({
      kind: zMinigame,
      bonus: z.enum(['adv', 'bonusDie', 'critRange', 'damage', 'cost', 'potency']),
      param: z.string().optional(), // e.g. rune shape name
    })
    .optional(),
  usesPerCombat: z.number().int().optional(),
  attackBonus: z.number().int().optional(),
  critRange: z.number().int().optional(),
  /** weapon resolve: force a ranged attack (thrown/shot) */
  ranged: z.boolean().optional(),
  outOfCombat: z.boolean().default(false), // can be used from the sheet outside combat (heals)
  desc: z.string(),
  flavor: z.string().default(''),
  anim: z
    .enum(['fire', 'ice', 'lightning', 'holy', 'arcane', 'slash', 'heal', 'shadow', 'nature', 'sonic', 'poison', 'buff', 'shield', 'smoke'])
    .default('arcane'),
  sound: z.string().default('spell'),
  tags: z.array(z.string()).default([]),
});
export type AbilityDef = z.infer<typeof zAbilityDef>;

// ---------------------------------------------------------------- Species / class / quirks

export const zSpeciesDef = z.object({
  id: zSpecies,
  name: z.string(),
  emoji: z.string(),
  desc: z.string(),
  abilityBonus: zPartialScores,
  skills: z.array(zSkill).default([]),
  resist: z.array(zDamage).default([]),
  traits: z.array(z.object({ id: z.string(), name: z.string(), desc: z.string() })),
  ancestries: z.array(z.object({ id: z.string(), name: z.string(), dmg: zDamage, emoji: z.string() })).optional(),
  abilities: z.array(z.string()).default([]), // granted ability ids (e.g. breath weapon)
});
export type SpeciesDef = z.infer<typeof zSpeciesDef>;

export const zResourceDef = z.object({ id: z.string(), name: z.string(), max: zLevels, recover: z.enum(['short', 'long']) });

export const zClassDef = z.object({
  id: zClass,
  name: z.string(),
  emoji: z.string(),
  color: z.string(),
  desc: z.string(),
  hitDie: z.number().int(),
  primary: zAbility,
  castAbility: zAbility.optional(),
  saves: z.array(zAbility),
  array: zScores,
  skills: z.array(zSkill),
  startWeapon: z.string(),
  startArmor: z.string().optional(),
  startItems: z.array(z.string()).default([]),
  resources: z.array(zResourceDef).default([]),
  sp: zLevels.optional(), // max spell points per level
  startAbilities: z.array(z.string()),
  /** abilities offered at level-up are drawn from all class abilities with level <= char level */
});
export type ClassDef = z.infer<typeof zClassDef>;

export const zQuirkEffect = z.discriminatedUnion('type', [
  z.object({ type: z.literal('skill'), skill: zSkill, amount: z.number() }),
  z.object({ type: z.literal('save'), ability: zAbility, amount: z.number() }),
  z.object({ type: z.literal('attackVsTag'), tag: z.string(), amount: z.number() }), // + or -
  z.object({ type: z.literal('disadvVsTag'), tag: z.string() }),
  z.object({ type: z.literal('advVsTag'), tag: z.string() }),
  z.object({ type: z.literal('damageVsTag'), tag: z.string(), amount: z.number() }),
  z.object({ type: z.literal('hp'), amount: z.number() }),
  z.object({ type: z.literal('ac'), amount: z.number() }),
  z.object({ type: z.literal('init'), amount: z.number() }),
  z.object({ type: z.literal('gold'), amount: z.number() }),
  z.object({ type: z.literal('resist'), dmg: zDamage }),
  z.object({ type: z.literal('healBonus'), amount: z.number() }),
  z.object({ type: z.literal('lootLuck'), amount: z.number() }),
  z.object({ type: z.literal('sp'), amount: z.number() }),
  z.object({ type: z.literal('critRange'), amount: z.number() }),
  z.object({ type: z.literal('minigame'), kind: zMinigame, amount: z.number() }), // score bonus
  z.object({ type: z.literal('immune'), condition: zCondition }),
  z.object({ type: z.literal('flavor') }),
]);
export type QuirkEffect = z.infer<typeof zQuirkEffect>;

export const zQuirkDef = z.object({
  id: z.string(),
  name: z.string(),
  species: z.array(zSpecies).default([]),
  classes: z.array(zClass).default([]),
  desc: z.string(),
  prompt: z.string(),
  effects: z.array(zQuirkEffect),
});
export type QuirkDef = z.infer<typeof zQuirkDef>;

// ---------------------------------------------------------------- Monsters

export const zMonsterAttack = z.object({
  name: z.string(),
  toHit: z.number().default(0),
  damage: zDice,
  dmg: zDamage,
  save: z.object({ ability: zAbility, dc: z.number(), half: z.boolean().default(true) }).optional(),
  condition: z.object({ id: zCondition, turns: z.number(), chance: z.number().min(0).max(1).optional() }).optional(),
  aoe: z.boolean().optional(),
  telegraph: z.boolean().optional(),
  weight: z.number().default(1),
  heal: zDice.optional(),
  summon: z.string().optional(),
  emoji: z.string().optional(),
  text: z.string().optional(),
});

export const zMonsterDef = z.object({
  id: z.string(),
  name: z.string(),
  emoji: z.string(),
  family: z.string(),
  tier: z.number().int().min(1).max(6),
  xp: z.number().int(),
  hp: z.number().int(),
  ac: z.number().int(),
  stats: zScores,
  attacks: z.array(zMonsterAttack).min(1),
  multiattack: z.number().int().default(1),
  behavior: z.enum(['brute', 'skirmisher', 'caster', 'support', 'boss', 'coward', 'companion']),
  weakness: zDamage.optional(),
  resist: z.array(zDamage).default([]),
  immune: z.array(zCondition).default([]),
  tags: z.array(z.string()).default([]),
  biomes: z.array(zBiome).default([]),
  night: z.boolean().default(false),
  boss: z.boolean().default(false),
  legendary: z.number().int().default(0),
  desc: z.string(),
  gold: z.number().default(0),
});
export type MonsterDef = z.infer<typeof zMonsterDef>;

// ---------------------------------------------------------------- Items

const zItemMods = z.object({
  attackBonus: z.number().optional(),
  damageBonus: z.number().optional(),
  acBonus: z.number().optional(),
  extraDamage: z.object({ dice: zDice, dmg: zDamage }).optional(),
  abilityBonus: zPartialScores.optional(),
  skillBonus: z.record(zSkill, z.number()).optional(),
  resist: z.array(zDamage).optional(),
  maxHpBonus: z.number().optional(),
  spBonus: z.number().optional(),
  initBonus: z.number().optional(),
  critRange: z.number().optional(),
  damageType: zDamage.optional(),
});

export const zConsumableUse = z.object({
  heal: zDice.optional(),
  sp: z.number().optional(),
  cleanse: z.boolean().optional(),
  condition: zCondition.optional(),
  damage: zDice.optional(),
  damageType: zDamage.optional(),
  buff: zBuff.optional(),
  revive: z.boolean().optional(),
  target: z.enum(['self', 'ally', 'enemy', 'allEnemies']),
});

export const zItemBase = z
  .object({
    id: z.string(),
    name: z.string(),
    slot: z.enum(['weapon', 'armor', 'trinket', 'consumable', 'quest']),
    emoji: z.string(),
    rarity: zRarity.default('common'),
    value: z.number(),
    damage: zDice.optional(),
    damageType: zDamage.optional(),
    finesse: z.boolean().optional(),
    ranged: z.boolean().optional(),
    twoHanded: z.boolean().optional(),
    acBase: z.number().optional(),
    dexCap: z.number().optional(),
    use: zConsumableUse.optional(),
    setId: z.string().optional(),
    unique: z.boolean().optional(),
    desc: z.string(),
  })
  .merge(zItemMods);
export type ItemBase = z.infer<typeof zItemBase>;

export const zAffixDef = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['prefix', 'suffix']),
  slots: z.array(z.enum(['weapon', 'armor', 'trinket'])),
  minRarity: zRarity.default('uncommon'),
  weight: z.number().default(1),
  cursed: z.boolean().default(false),
  mods: zItemMods,
  desc: z.string(),
});
export type AffixDef = z.infer<typeof zAffixDef>;

export const zSetDef = z.object({
  id: z.string(),
  name: z.string(),
  pieces: z.array(z.string()).min(2),
  bonus: zItemMods,
  desc: z.string(),
});
export type SetDef = z.infer<typeof zSetDef>;

// ---------------------------------------------------------------- Events

export const zEventEffect = z.discriminatedUnion('type', [
  z.object({ type: z.literal('gold'), amount: z.number() }),
  z.object({ type: z.literal('xp'), amount: z.number() }),
  z.object({ type: z.literal('damage'), dice: zDice, who: z.enum(['actor', 'party', 'random']).default('actor'), dmg: zDamage.optional() }),
  z.object({ type: z.literal('heal'), dice: zDice, who: z.enum(['actor', 'party']).default('party') }),
  z.object({ type: z.literal('item'), rarity: zRarity, slot: z.enum(['weapon', 'armor', 'trinket', 'consumable']).optional() }),
  z.object({ type: z.literal('itemId'), id: z.string() }),
  z.object({ type: z.literal('doom'), amount: z.number() }),
  z.object({
    type: z.literal('combat'),
    family: z.string().optional(),
    monsters: z.array(z.string()).optional(),
    ambush: z.boolean().default(false),
    difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
  }),
  z.object({ type: z.literal('condition'), id: zCondition, turns: z.number(), who: z.enum(['actor', 'party']).default('actor') }),
  z.object({ type: z.literal('rep'), faction: z.string().default('random'), amount: z.number() }),
  z.object({ type: z.literal('reveal'), radius: z.number().default(2) }),
  z.object({ type: z.literal('key') }),
  z.object({ type: z.literal('quest'), questType: z.enum(['rescue', 'fetch', 'escort', 'investigate', 'hunt', 'negotiate', 'heist']).optional() }),
  z.object({ type: z.literal('inspiration'), who: z.enum(['actor', 'party']).default('actor') }),
  z.object({ type: z.literal('sp'), amount: z.number(), who: z.enum(['actor', 'party']).default('party') }),
  z.object({ type: z.literal('move'), amount: z.number() }),
  z.object({ type: z.literal('rest'), kind: z.enum(['short', 'long']) }),
  z.object({ type: z.literal('lore'), key: z.string(), text: z.string() }),
  z.object({ type: z.literal('secret'), text: z.string() }),
  z.object({ type: z.literal('npc'), archetype: z.string().optional() }),
  z.object({ type: z.literal('shop') }),
  z.object({ type: z.literal('curse') }),
  z.object({ type: z.literal('title'), text: z.string() }),
]);
export type EventEffect = z.infer<typeof zEventEffect>;

const zOutcome = z.object({ text: z.array(z.string()).min(1), effects: z.array(zEventEffect).default([]) });

export const zEventOption = z.object({
  label: z.string(),
  emoji: z.string().default('•'),
  skill: zSkill.optional(),
  ability: zAbility.optional(),
  dc: z.number().int().default(12),
  group: z.boolean().default(false), // everyone rolls, majority decides
  best: z.object({ classes: z.array(zClass).default([]), species: z.array(zSpecies).default([]) }).optional(),
  minigame: zMinigame.optional(),
  cost: z.object({ gold: z.number().optional(), sp: z.number().optional() }).optional(),
  outcomes: z.object({
    crit: zOutcome.optional(),
    success: zOutcome,
    partial: zOutcome.optional(),
    fail: zOutcome.optional(),
    fumble: zOutcome.optional(),
  }),
});
export type EventOption = z.infer<typeof zEventOption>;

export const zEventCard = z.object({
  id: z.string(),
  title: z.string(),
  emoji: z.string(),
  biomes: z.array(z.union([zBiome, z.literal('any')])).default(['any']),
  time: z.array(zTime).optional(),
  weather: z.array(zWeather).optional(),
  weight: z.number().default(1),
  minDoom: z.number().default(0),
  tags: z.array(z.string()).default([]),
  text: z.array(z.string()).min(1),
  options: z.array(zEventOption).min(1).max(5),
});
export type EventCard = z.infer<typeof zEventCard>;

// ---------------------------------------------------------------- voices and barks

/** Reference voices in voice/voices/ (cloned by the TTS worker). */
export const VOICE_IDS = ['narrator', 'villain', 'gruff', 'goblin', 'brute', 'undead', 'crone', 'zealot', 'man', 'woman', 'lady', 'elder', 'youth', 'sly'] as const;
export type VoiceId = (typeof VOICE_IDS)[number];

/** Short scripted lines a monster says in combat. `id` is a monster id or a family (monster id wins). */
export const zBark = z.object({
  id: z.string(),
  voice: z.enum(VOICE_IDS).optional(),
  silent: z.boolean().optional(),
  taunt: z.array(z.string()).default([]), // the fight begins
  attack: z.array(z.string()).default([]), // after acting on its turn
  hurt: z.array(z.string()).default([]), // first drop under half HP
  windup: z.array(z.string()).default([]), // winding up a telegraphed attack
  death: z.array(z.string()).default([]),
  flee: z.array(z.string()).default([]),
});
export type BarkDef = z.infer<typeof zBark>;
export type BarkKind = 'taunt' | 'attack' | 'hurt' | 'windup' | 'death' | 'flee';

// ---------------------------------------------------------------- NPCs, factions, antagonists, quests, prompts

export const zNpcArchetype = z.object({
  id: z.string(),
  title: z.string(),
  emoji: z.string(),
  names: z.array(z.string()).min(2),
  motivations: z.array(z.string()).min(1),
  faction: z.string().optional(),
  greet: z.array(z.string()).min(1),
  ask: z.array(z.string()).min(1), // what they want from the party
  /** one voice per name (same order), see VOICE_IDS */
  voices: z.array(z.enum(VOICE_IDS)).optional(),
  pleased: z.array(z.string()).default([]), // said when the party wins them over
  displeased: z.array(z.string()).default([]), // said when it goes badly
  tags: z.array(z.string()).default([]),
});
export type NpcArchetype = z.infer<typeof zNpcArchetype>;

export const zFactionDef = z.object({ id: z.string(), name: z.string(), emoji: z.string(), desc: z.string() });

export const zAntagonist = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  emoji: z.string(),
  bossId: z.string(),
  desc: z.string(),
  fortress: z.string(),
  objective: z.string(),
  keyName: z.string(),
  minions: z.array(z.string()).min(1), // monster families
  doomText: z.array(z.string()).min(3), // narration at 1/3, 2/3, full
});
export type AntagonistDef = z.infer<typeof zAntagonist>;

export const zQuestTemplate = z.object({
  type: z.enum(['rescue', 'fetch', 'escort', 'investigate', 'hunt', 'negotiate', 'heist']),
  titles: z.array(z.string()).min(1),
  desc: z.array(z.string()).min(1),
  goal: z.number().default(1),
});

export const zJackboxPrompt = z.object({
  id: z.string(),
  text: z.string(),
  use: z.enum(['kingdom', 'mascot', 'rumor', 'npc', 'place', 'deed', 'lore', 'tavern', 'motto', 'title']),
  examples: z.array(z.string()).default([]),
});

export const zCampPrompt = z.object({ id: z.string(), text: z.string(), quirk: z.string().optional(), cls: zClass.optional() });

export const zNames = z.object({
  townPre: z.array(z.string()),
  townSuf: z.array(z.string()),
  wild: z.record(z.string(), z.array(z.string())),
  dungeon: z.array(z.string()),
  dungeonSuf: z.array(z.string()),
  heroic: z.array(z.string()),
  personalities: z.array(z.string()),
  epithets: z.array(z.string()),
});

export const zRuneDef = z.object({ name: z.string(), label: z.string(), points: z.array(z.tuple([z.number(), z.number()])).min(3) });
