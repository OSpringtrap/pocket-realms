/**
 * Wire protocol (WebSocket, JSON). Discriminated unions keyed by `t`.
 * Bump PROTOCOL_VERSION on breaking changes; clients with another version are asked to refresh.
 */
import type { PatchOp } from './diff.js';
import type { DieSides } from './dice.js';
import type {
  Biome,
  Character,
  ClassId,
  CombatLogEntry,
  Difficulty,
  Faction,
  ItemInstance,
  JournalEntry,
  MinigameKind,
  Monster,
  Npc,
  PoiKind,
  Quest,
  RunLength,
  SpeciesId,
  TimeOfDay,
  Weather,
} from './types.js';

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------- prompts (server -> phone)

export interface ChoiceOption {
  id: string;
  label: string;
  emoji?: string;
  desc?: string;
  disabled?: string;
  cost?: string;
  group?: string;
  tag?: string; // small badge, e.g. "Bonus", "Best fit"
}

interface PromptBase {
  id: string;
  title: string;
  text?: string;
  deadline?: number; // epoch ms when the server will auto-resolve
  urgent?: boolean;
}

export type Prompt =
  | (PromptBase & { kind: 'choice'; options: ChoiceOption[]; style?: 'action' | 'target' | 'vote' | 'list' | 'cards' | 'map'; allowNone?: string })
  | (PromptBase & { kind: 'roll'; faces: DieSides[]; bonus: number; dc?: number; adv?: -1 | 0 | 1; rollKind: string })
  | (PromptBase & { kind: 'minigame'; game: MinigameKind; param?: string; duration: number; difficulty?: number })
  | (PromptBase & { kind: 'text'; maxLen: number; placeholder?: string; suggestions?: string[] })
  | (PromptBase & { kind: 'draw'; maxBytes: number })
  | (PromptBase & { kind: 'notice'; okLabel: string });

export type PromptKind = Prompt['kind'];

// ---------------------------------------------------------------- views

export interface PlayerPublic {
  id: string;
  name: string;
  connected: boolean;
  ready: boolean;
  color: string;
  physicalDice: boolean;
  hasCharacter: boolean;
  creating?: { species?: SpeciesId; cls?: ClassId; step?: string };
  disconnectedAt?: number;
}

export interface TileView {
  q: number;
  r: number;
  biome: Biome;
  poi?: { id: string; kind: PoiKind; name: string; emoji: string; cleared?: boolean };
  visited: boolean;
  name?: string;
  reachable?: number; // move cost if reachable this turn
}

export interface WorldView {
  seed: string;
  radius: number;
  tiles: TileView[];
  totalTiles: number;
  party: { q: number; r: number };
  day: number;
  time: TimeOfDay;
  weather: Weather;
  doom: number;
  doomMax: number;
  antagonist: { name: string; title: string; emoji: string; desc: string };
  objective: { text: string; fortress?: { q: number; r: number }; keysNeeded: number; keys: number; keyName: string };
  factions: Faction[];
  npcs: Npc[];
  quests: Quest[];
  kingdomName: string;
  banner?: string;
  mascot?: string;
  lore: Record<string, string>;
  home?: { name: string; inn: number; shop: number; shrine: number };
  turn: number;
  movesLeft: number;
  moveBudget: number;
  leaderId?: string;
}

export interface CombatView {
  id: string;
  title: string;
  round: number;
  order: string[];
  current?: string;
  monsters: Monster[];
  log: CombatLogEntry[];
  bossFight?: boolean;
  biome: Biome;
}

export interface EventView {
  cardId: string;
  title: string;
  emoji: string;
  text: string;
  options: { label: string; emoji: string; skill?: string; dc?: number; best?: string; cost?: string; group?: boolean }[];
  votes?: Record<string, number>; // option index -> count
  chosen?: number;
  actorId?: string;
  outcome?: { degree: string; text: string };
}

export type SceneView =
  | { kind: 'title'; saves: SaveSummary[] }
  | { kind: 'lobby' }
  | { kind: 'creation' }
  | { kind: 'overworld' }
  | { kind: 'event'; event: EventView }
  | { kind: 'combat'; combat: CombatView }
  | { kind: 'camp'; text: string; prompt?: { a: string; b: string; text: string } }
  | { kind: 'town'; name: string; text: string; shop?: ShopView }
  | { kind: 'dungeon'; name: string; rooms: DungeonRoomView[]; current: number; text: string }
  | { kind: 'social'; npc: Npc; text: string; line?: string }
  | { kind: 'jackbox'; prompt: string; stage: 'writing' | 'voting' | 'result'; answers?: { id: string; text: string; votes?: number; author?: string }[]; winner?: string }
  | { kind: 'levelup'; names: string[] }
  | { kind: 'ending'; title: string; text: string; victory: boolean; stats: EndingStats }
  | { kind: 'loading'; text: string };

export interface ShopView {
  items: { uid: string; item: ItemInstance; price: number }[];
  sellRate: number;
}

export interface DungeonRoomView {
  id: number;
  kind: 'entrance' | 'combat' | 'trap' | 'puzzle' | 'treasure' | 'rest' | 'boss' | 'secret' | 'empty';
  revealed: boolean;
  cleared: boolean;
  links: number[];
  emoji: string;
  name: string;
}

export interface EndingStats {
  turns: number;
  days: number;
  doom: number;
  heroes: { name: string; title: string; kills: number; crits: number; damage: number; healed: number; level: number; dead: boolean }[];
}

export interface SaveSummary {
  id: string;
  name: string;
  updated: number;
  day: number;
  heroes: string[];
  mode: RunLength;
}

export interface Settings {
  difficulty: Difficulty;
  length: RunLength;
  adaptive: boolean;
  textSpeed: number; // 0.5 .. 2
  volume: number; // 0..1
  music: boolean;
  colorblind: boolean;
  textSize: number; // 1..1.6
  turnTimer: number; // seconds, 0 = off
  reduceMotion: boolean;
}

export interface NarrationLine {
  id: number;
  text: string;
  style?: 'normal' | 'title' | 'good' | 'bad' | 'whisper';
}

export interface WaitingOn {
  playerId: string;
  label: string;
  deadline?: number;
}

export interface PublicView {
  v: number;
  code: string;
  lanUrl: string;
  settings: Settings;
  players: PlayerPublic[];
  chars: Record<string, Character>; // public sheets (portraits included)
  party: { gold: number; stash: ItemInstance[]; name?: string; motto?: string };
  world?: WorldView;
  scene: SceneView;
  narration: NarrationLine[];
  journal: JournalEntry[];
  waiting: WaitingOn[];
  campaign?: { id: string; name: string; seed: string; started: number };
  paused?: string;
}

export interface Secret {
  id: string;
  text: string;
  kind: 'quest' | 'loot' | 'whisper' | 'traitor';
}

export interface CreationView {
  fate?: { roll: number; text: string; ability: string; delta: number };
  error?: string;
  claimable?: { id: string; name: string; cls: ClassId; species: SpeciesId; level: number }[];
}

export interface PhoneView extends PublicView {
  me: {
    id: string;
    prompts: Prompt[];
    secrets: Secret[];
    creation?: CreationView;
    physicalDice: boolean;
    token: string;
    isLeader: boolean;
  };
}

// ---------------------------------------------------------------- transient fx (both screens)

export type Fx =
  | {
      kind: 'roll';
      id: string;
      playerId: string;
      name: string;
      label: string;
      faces: DieSides[];
      values: number[];
      bonus: number;
      total: number;
      kept?: number;
      adv?: -1 | 0 | 1;
      dc?: number;
      success?: boolean;
      crit?: boolean;
      fumble?: boolean;
      physical?: boolean;
    }
  | { kind: 'damage'; target: string; amount: number; dmg: string; crit?: boolean; weak?: boolean; resist?: boolean }
  | { kind: 'heal'; target: string; amount: number }
  | { kind: 'miss'; target: string }
  | { kind: 'anim'; anim: string; source: string; targets: string[] }
  | { kind: 'sound'; name: string }
  | { kind: 'telegraph'; source: string; target: string; text: string }
  | { kind: 'banner'; text: string; style?: 'good' | 'bad' | 'title' }
  | { kind: 'enemyRoll'; who: string; label: string; rolls: number[]; total: number; dc?: number; success?: boolean }
  | { kind: 'haptic'; pattern: number[]; playerId?: string }
  | { kind: 'minigame'; playerId: string; name: string; game: string; score: number };

// ---------------------------------------------------------------- client -> server

export type Intent =
  | { kind: 'equip'; uid: string }
  | { kind: 'unequip'; slot: 'weapon' | 'armor' | 'trinket' }
  | { kind: 'use'; uid: string; target?: string }
  | { kind: 'useAbility'; id: string; target?: string }
  | { kind: 'toStash'; uid: string }
  | { kind: 'fromStash'; uid: string }
  | { kind: 'give'; uid: string; to: string }
  | { kind: 'physicalDice'; on: boolean }
  | { kind: 'move'; q: number; r: number }
  | { kind: 'camp' }
  | { kind: 'ping'; q: number; r: number };

export type HostCommand =
  | { cmd: 'newCampaign'; settings?: Partial<Settings>; seed?: string }
  | { cmd: 'continue'; saveId: string }
  | { cmd: 'start' }
  | { cmd: 'settings'; settings: Partial<Settings> }
  | { cmd: 'kick'; playerId: string }
  | { cmd: 'skip' }
  | { cmd: 'title' }
  | { cmd: 'pause'; on: boolean }
  | { cmd: 'move'; q: number; r: number }
  | { cmd: 'addBot' };

export type C2S =
  | { t: 'hello'; v: number; role: 'host'; key?: string }
  | { t: 'join'; v: number; code: string; name: string; token?: string }
  | { t: 'resume'; v: number; token: string }
  | { t: 'claim'; charId: string }
  | { t: 'creation:draft'; species?: SpeciesId; cls?: ClassId; step?: string }
  | { t: 'creation:fate' }
  | { t: 'character:create'; draft: unknown }
  | { t: 'ready'; ready: boolean }
  | { t: 'answer'; id: string; value: unknown }
  | { t: 'roll:throw'; id: string; intensity?: number }
  | { t: 'roll:physical'; id: string; values: number[] }
  | { t: 'input:result'; id: string; data: unknown }
  | { t: 'intent'; intent: Intent }
  | { t: 'host'; key?: string; command: HostCommand }
  | { t: 'ping'; at: number };

export type S2C =
  | { t: 'welcome'; v: number; role: 'host' | 'phone' | 'spectator'; playerId?: string; token?: string; code: string }
  | { t: 'state'; seq: number; view: PublicView | PhoneView }
  | { t: 'patch'; seq: number; ops: PatchOp[] }
  | { t: 'fx'; fx: Fx[] }
  | { t: 'error'; msg: string; fatal?: boolean }
  | { t: 'pong'; at: number };

export const PLAYER_COLORS = ['#c0392b', '#2471a3', '#229954', '#d68910', '#7d3c98', '#17a589'];
export const MAX_PLAYERS = 6;
