// Core domain types shared by server, clients, rules engine and content.

export const ABILITIES = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'] as const;
export type Ability = (typeof ABILITIES)[number];

export const SKILLS = [
  'athletics',
  'acrobatics',
  'stealth',
  'arcana',
  'nature',
  'religion',
  'insight',
  'perception',
  'persuasion',
  'deception',
  'intimidation',
  'performance',
] as const;
export type Skill = (typeof SKILLS)[number];

export const SKILL_ABILITY: Record<Skill, Ability> = {
  athletics: 'STR',
  acrobatics: 'DEX',
  stealth: 'DEX',
  arcana: 'INT',
  nature: 'INT',
  religion: 'INT',
  insight: 'WIS',
  perception: 'WIS',
  persuasion: 'CHA',
  deception: 'CHA',
  intimidation: 'CHA',
  performance: 'CHA',
};

/** Skills anyone can attempt with a little help from a minigame. */
export const OPEN_SKILLS: Skill[] = ['athletics', 'perception', 'persuasion', 'stealth'];

export const SPECIES = ['elf', 'dwarf', 'human', 'orc', 'dragonborn'] as const;
export type SpeciesId = (typeof SPECIES)[number];

export const CLASSES = ['wizard', 'rogue', 'paladin', 'cleric', 'bard', 'barbarian', 'warrior'] as const;
export type ClassId = (typeof CLASSES)[number];

export const CONDITIONS = [
  'poisoned',
  'stunned',
  'frightened',
  'prone',
  'blinded',
  'charmed',
  'burning',
  'slowed',
  'blessed',
  'inspired',
] as const;
export type ConditionId = (typeof CONDITIONS)[number];

export const DAMAGE_TYPES = [
  'slashing',
  'piercing',
  'bludgeoning',
  'fire',
  'cold',
  'lightning',
  'thunder',
  'poison',
  'acid',
  'necrotic',
  'radiant',
  'psychic',
  'force',
] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];
export const PHYSICAL: DamageType[] = ['slashing', 'piercing', 'bludgeoning'];

export const MINIGAMES = [
  'rune', // draw a shape ($1 recognizer)
  'swing', // accelerometer peak force
  'shout', // microphone volume
  'tilt', // gyroscope aim
  'shake', // shake intensity
  'hold', // press-and-hold charge & release
  'rhythm', // tap to the beat
  'steady', // hold the phone still
  'blow', // blow into the mic
  'hum', // match a pitch
  'scan', // turn around the room (compass)
  'sequence', // memory sequence
  'twofinger', // two-finger disarm
  'quiet', // stay silent
  'tap', // rapid tapping
] as const;
export type MinigameKind = (typeof MINIGAMES)[number];

export const BIOMES = ['plains', 'forest', 'swamp', 'mountains', 'desert', 'ruins', 'coast', 'water'] as const;
export type Biome = (typeof BIOMES)[number];

export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
export type Rarity = (typeof RARITIES)[number];

export type Difficulty = 'story' | 'normal' | 'heroic';
export type RunLength = 'oneshot' | 'campaign';
export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'night';
export type Weather = 'clear' | 'rain' | 'fog' | 'storm' | 'snow' | 'heat';

export type AbilityScores = Record<Ability, number>;

export interface ActiveCondition {
  id: ConditionId;
  turns: number; // remaining turns (decremented at end of the creature's turn); 99 = until removed
  source?: string;
}

export type BuffId =
  | 'ac' // +amount AC
  | 'attack' // +amount to attack rolls
  | 'damage' // +amount damage
  | 'resist' // halve physical damage
  | 'resistAll' // halve all damage
  | 'invisible' // attacks against have disadvantage, own attacks advantage; breaks on attack
  | 'rage' // +amount melee damage, resist physical, adv STR
  | 'shield' // +5 AC until next turn
  | 'dodge' // attacks against have disadvantage
  | 'smite' // next weapon hit deals extra dice (dice field)
  | 'taunt' // enemies must target this creature
  | 'regen' // heal amount at start of turn
  | 'thorns' // attackers take amount damage
  | 'sanctuary' // enemies must pass WIS save to target
  | 'reckless' // own attacks advantage, attacks against advantage
  | 'evasive' // DEX saves: no damage on success, half on fail
  | 'concentrate' // spirit guardians style aura: deals dice to enemies each turn
  | 'imbue' // weapon attacks deal +dice of dmg type
  | 'spiritWeapon' // at start of turn, deal dice force to a random enemy
  | 'haste' // extra attack each turn
  | 'marked'; // attacks against this creature +amount damage (hunter's mark / branding)

export interface Buff {
  id: BuffId;
  turns: number;
  amount?: number;
  dice?: string;
  dmg?: DamageType;
  condition?: ConditionId; // applied on hit (smites)
  source?: string;
  name?: string;
}

export interface ItemAffix {
  id: string;
  name: string; // "Flaming" / "of the Fox"
  kind: 'prefix' | 'suffix';
}

export type ItemSlot = 'weapon' | 'armor' | 'trinket' | 'consumable' | 'quest';

export interface ItemInstance {
  uid: string;
  baseId: string;
  name: string;
  slot: ItemSlot;
  rarity: Rarity;
  emoji: string;
  affixes: ItemAffix[];
  cursed?: boolean;
  identified?: boolean;
  setId?: string;
  value: number; // gold value
  // Rolled stats (resolved from base + affixes)
  damage?: string;
  damageType?: DamageType;
  finesse?: boolean;
  ranged?: boolean;
  twoHanded?: boolean;
  acBase?: number;
  acBonus?: number;
  dexCap?: number;
  attackBonus?: number;
  damageBonus?: number;
  extraDamage?: { dice: string; dmg: DamageType };
  abilityBonus?: Partial<AbilityScores>;
  skillBonus?: Partial<Record<Skill, number>>;
  resist?: DamageType[];
  maxHpBonus?: number;
  spBonus?: number;
  initBonus?: number;
  critRange?: number; // crits on >= this (default 20)
  use?: ConsumableUse;
  desc: string;
  charges?: number;
}

export interface ConsumableUse {
  heal?: string;
  sp?: number;
  cleanse?: boolean;
  condition?: ConditionId; // applies to target enemy (thrown)
  damage?: string;
  damageType?: DamageType;
  buff?: Buff;
  revive?: boolean;
  target: 'self' | 'ally' | 'enemy' | 'allEnemies';
}

export interface ResourcePool {
  cur: number;
  max: number;
  recover: 'short' | 'long';
  name: string;
}

export interface CharacterStats {
  kills: number;
  crits: number;
  fumbles: number;
  damageDealt: number;
  healed: number;
  downs: number;
  minigamesAced: number;
}

export interface Character {
  id: string; // = player id
  name: string;
  species: SpeciesId;
  cls: ClassId;
  ancestry?: string; // dragonborn color
  level: number;
  xp: number;
  abilities: AbilityScores;
  maxHp: number;
  hp: number;
  tempHp: number;
  skills: Skill[];
  quirks: string[];
  personality: string;
  portrait?: string; // small PNG data URL
  sp: number;
  maxSp: number;
  resources: Record<string, ResourcePool>;
  known: string[]; // ability/spell ids
  equipment: { weapon?: ItemInstance; armor?: ItemInstance; trinket?: ItemInstance };
  inventory: ItemInstance[];
  conditions: ActiveCondition[];
  buffs: Buff[];
  inspiration: number; // party-vote awarded rerolls
  death: { successes: number; failures: number; stable: boolean };
  down: boolean;
  dead: boolean;
  spirit?: boolean; // returned from the veil
  titles: string[];
  stats: CharacterStats;
  pendingLevelUps: number;
  passives: string[]; // chosen passive perk ids
  asi: Partial<AbilityScores>; // ability score increases taken
}

export interface MonsterAttack {
  name: string;
  toHit: number;
  damage: string;
  dmg: DamageType;
  /** saving throw instead of attack roll */
  save?: { ability: Ability; dc: number; half?: boolean };
  condition?: { id: ConditionId; turns: number; chance?: number };
  aoe?: boolean; // hits all party members
  telegraph?: boolean; // wind up one turn, then unleash
  weight?: number;
  heal?: string; // support: heals an ally
  summon?: string; // monster id
  emoji?: string;
  text?: string; // narration
}

export interface Monster {
  id: string; // instance id
  defId: string;
  name: string;
  emoji: string;
  side: 'enemy' | 'party';
  family: string;
  tier: number;
  hp: number;
  maxHp: number;
  tempHp: number;
  ac: number;
  abilities: AbilityScores;
  attacks: MonsterAttack[];
  behavior: 'brute' | 'skirmisher' | 'caster' | 'support' | 'boss' | 'coward' | 'companion';
  weakness?: DamageType;
  resist: DamageType[];
  immune: ConditionId[];
  tags: string[];
  conditions: ActiveCondition[];
  buffs: Buff[];
  xp: number;
  elite?: boolean;
  boss?: boolean;
  legendary?: number; // legendary actions per round
  legendaryLeft?: number;
  multiattack?: number;
  telegraph?: Telegraph;
  fled?: boolean;
  dead?: boolean;
  burned?: boolean; // took fire/acid since last turn (stops regeneration)
}

export interface Telegraph {
  attackIndex: number;
  targetId: string; // party creature id (or 'all')
  text: string;
  dc: number;
  braced?: Record<string, number>; // creature id -> minigame score
}

export type CreatureRef = { kind: 'char'; id: string } | { kind: 'mon'; id: string };

export interface CombatLogEntry {
  t: number;
  text: string;
  tone?: 'hit' | 'miss' | 'crit' | 'heal' | 'info' | 'bad' | 'good' | 'fumble';
}

export interface CombatState {
  id: string;
  round: number;
  order: string[]; // creature ids in initiative order
  initiative: Record<string, number>;
  turn: number; // index into order
  monsters: Monster[]; // enemies & party companions
  over?: 'victory' | 'defeat' | 'fled';
  xpPool: number;
  goldPool: number;
  lootRarityBoost: number;
  bossFight?: boolean;
  isFinal?: boolean;
  title: string;
  biome: Biome;
  turnsTaken: number;
  usedThisCombat: Record<string, Record<string, number>>; // creatureId -> abilityId -> uses
  actorBonusUsed?: boolean;
  log: CombatLogEntry[];
}

export interface HexTile {
  q: number;
  r: number;
  biome: Biome;
  poi?: Poi;
  revealed: boolean;
  visited: boolean;
  elevation: number;
  hidden?: boolean; // hidden cache: only seen when revealed + searched
  name?: string;
}

export type PoiKind = 'town' | 'dungeon' | 'camp' | 'shrine' | 'merchant' | 'lair' | 'cache' | 'fortress' | 'ruin' | 'portal';

export interface Poi {
  id: string;
  kind: PoiKind;
  name: string;
  emoji: string;
  cleared?: boolean;
  data?: Record<string, unknown>;
  questId?: string;
}

export interface Faction {
  id: string;
  name: string;
  emoji: string;
  desc: string;
  rep: number; // -10..10
}

export interface Npc {
  id: string;
  name: string;
  archetypeId: string;
  emoji: string;
  title: string;
  motivation: string;
  factionId?: string;
  attitude: number; // -3..3
  met?: boolean;
}

export type QuestType = 'rescue' | 'fetch' | 'escort' | 'investigate' | 'hunt' | 'negotiate' | 'heist';

export interface Quest {
  id: string;
  type: QuestType;
  title: string;
  desc: string;
  giverNpcId?: string;
  targetTile?: { q: number; r: number };
  factionId?: string;
  reward: { gold: number; xp: number; rep?: number; key?: boolean; item?: Rarity };
  status: 'active' | 'done' | 'failed';
  main?: boolean;
  privateFor?: string; // player id for secret quests
  progress?: number;
  goal?: number;
}

export interface JournalEntry {
  id: string;
  day: number;
  kind: 'lore' | 'event' | 'combat' | 'quest' | 'deed' | 'world' | 'death' | 'level';
  text: string;
  author?: string;
}

export interface WorldState {
  seed: string;
  radius: number;
  tiles: HexTile[];
  party: { q: number; r: number };
  day: number;
  time: TimeOfDay;
  weather: Weather;
  doom: number;
  doomMax: number;
  doomEvents: number[]; // thresholds already triggered
  antagonist: { id: string; name: string; title: string; emoji: string; bossId: string; desc: string };
  objective: { text: string; fortress: { q: number; r: number }; keysNeeded: number; keys: number; keyName: string };
  factions: Faction[];
  npcs: Npc[];
  quests: Quest[];
  kingdomName: string;
  banner?: string;
  mascot?: string;
  lore: Record<string, string>; // world-building facts woven into narration
  home?: { name: string; inn: number; shop: number; shrine: number; q: number; r: number };
  recentEvents: string[]; // last event card ids (anti-repeat)
  combatStreak: number; // director: consecutive combats
  hardSinceRest: boolean;
  directorMod: number; // adaptive difficulty multiplier offset (-0.3..+0.3)
  winStreak: number;
  turn: number;
  moveBudget: number;
  movesLeft: number;
  leaderIdx: number;
  turnsSincePrompt: number;
  bonusMoves?: number;
  doomRescues?: number;
  finished?: boolean;
}
