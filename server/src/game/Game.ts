import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_PLAYERS,
  PLAYER_COLORS,
  PROTOCOL_VERSION,
  Rng,
  clone,
  content,
  hexKey,
  randomSeedName,
  reachable,
  sanitizeText,
  scoreRune,
  validPhysical,
  type Character,
  type ChoiceOption,
  type DieSides,
  type Fx,
  type FateResult,
  type HostCommand,
  type Intent,
  type ItemInstance,
  type JournalEntry,
  type MinigameKind,
  type NarrationLine,
  type PhoneView,
  type Prompt,
  type PublicView,
  type RollRequest,
  type SaveSummary,
  type SceneView,
  type Secret,
  type Settings,
  type WaitingOn,
  type WorldState,
  type WorldView,
  type CreationView,
} from '@pr/shared';
import { randomBytes } from 'node:crypto';
import type { Clock } from '../clock.js';

export class Aborted extends Error {
  constructor() {
    super('aborted');
  }
}

export interface PlayerRec {
  id: string;
  name: string;
  token: string;
  color: string;
  connected: boolean;
  ready: boolean;
  physicalDice: boolean;
  disconnectedAt?: number;
  creating?: { species?: string; cls?: string; step?: string };
  isBot?: boolean;
  botSkill?: number;
}

export interface GameState {
  version: 1;
  id: string;
  name: string;
  seed: string;
  created: number;
  updated: number;
  settings: Settings;
  rng: number;
  phase: 'title' | 'lobby' | 'playing' | 'ended';
  scene: SceneView;
  chars: Record<string, Character>;
  party: { gold: number; stash: ItemInstance[]; name?: string; motto?: string };
  world?: WorldState;
  journal: JournalEntry[];
  narration: NarrationLine[];
  secrets: Record<string, Secret[]>;
  creation: Record<string, CreationView & { fateResult?: FateResult }>;
  stats: { combats: number; victories: number; events: number; turns: number; startedAt: number; rescues: number };
  outcome?: { victory: boolean; title: string; text: string };
}

type PromptInput = Prompt extends infer P ? (P extends Prompt ? Omit<P, 'id'> : never) : never;

interface Pending {
  id: string;
  playerId: string;
  prompt: Prompt;
  epoch: number;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer?: unknown;
  fallback: () => unknown;
  validate: (v: unknown) => { ok: true; value: unknown } | { ok: false; error?: string };
  originalDeadline?: number;
  rollReq?: RollRequest;
  created: number;
}

export const DEFAULT_SETTINGS: Settings = {
  difficulty: 'normal',
  length: 'oneshot',
  adaptive: true,
  textSpeed: 1,
  volume: 0.8,
  music: true,
  colorblind: false,
  textSize: 1,
  turnTimer: 75,
  reduceMotion: false,
};

export const DISCONNECT_GRACE_MS = 60_000;
const ROLL_TIMEOUT_MS = 30_000;

export interface GameOptions {
  clock: Clock;
  code: string;
  lanUrl: string;
  savesDir?: string;
  /** bots answer instantly (simulator) */
  instantBots?: boolean;
  log?: (msg: string) => void;
}

export class Game {
  state: GameState;
  players = new Map<string, PlayerRec>();
  pending = new Map<string, Pending>();
  epoch = 0;
  rng: Rng;
  onChange?: () => void;
  onFx?: (fx: Fx[], onlyPlayer?: string) => void;
  private promptSeq = 0;
  private narrSeq = 0;
  director?: Promise<void>;
  /** counts of prompts by kind, used by the simulator to estimate real play time */
  promptStats: Record<string, number> = {};
  private waiters = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void; epoch: number; filter: (v: unknown) => boolean }[]>();
  pausedReason?: string;
  stateCombat?: import('@pr/shared').CombatCtx;
  legacyQueue: { playerId: string; level: number; gear: ItemInstance[]; oldName: string }[] = [];
  pings: { q: number; r: number; playerId: string; at: number }[] = [];

  constructor(public opts: GameOptions) {
    this.state = Game.blankState();
    this.rng = new Rng(this.state.rng);
  }

  static blankState(): GameState {
    return {
      version: 1,
      id: '',
      name: 'New Campaign',
      seed: '',
      created: 0,
      updated: 0,
      settings: { ...DEFAULT_SETTINGS },
      rng: 1,
      phase: 'title',
      scene: { kind: 'title', saves: [] },
      chars: {},
      party: { gold: 0, stash: [] },
      journal: [],
      narration: [],
      secrets: {},
      creation: {},
      stats: { combats: 0, victories: 0, events: 0, turns: 0, startedAt: 0, rescues: 0 },
    };
  }

  get clock() {
    return this.opts.clock;
  }
  log(msg: string) {
    this.opts.log?.(msg);
  }

  // ------------------------------------------------------------ change notification

  dirty() {
    this.state.rng = this.rng.state;
    this.onChange?.();
  }
  fx(...fx: Fx[]) {
    this.onFx?.(fx);
  }
  fxFor(playerId: string, ...fx: Fx[]) {
    this.onFx?.(fx, playerId);
  }

  // ------------------------------------------------------------ players

  activePlayers(): PlayerRec[] {
    return [...this.players.values()];
  }
  partyIds(): string[] {
    return [...this.players.values()].filter((p) => this.state.chars[p.id]).map((p) => p.id);
  }
  partyChars(): Character[] {
    return this.partyIds().map((id) => this.state.chars[id]!);
  }

  addPlayer(name: string, opts: { bot?: boolean; botSkill?: number } = {}): PlayerRec | string {
    if (this.players.size >= MAX_PLAYERS) return 'The party is full (6 heroes max).';
    const clean = sanitizeText(name, 20) || `Hero ${this.players.size + 1}`;
    const used = new Set([...this.players.values()].map((p) => p.color));
    const id = `p_${randomBytes(4).toString('hex')}`;
    const p: PlayerRec = {
      id,
      name: clean,
      token: randomBytes(16).toString('hex'),
      color: PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0]!,
      connected: true,
      ready: false,
      physicalDice: false,
      isBot: opts.bot,
      botSkill: opts.botSkill,
    };
    this.players.set(id, p);
    this.dirty();
    return p;
  }

  findByToken(token: string): PlayerRec | undefined {
    if (typeof token !== 'string' || token.length < 10) return undefined;
    return [...this.players.values()].find((p) => p.token === token);
  }

  setConnected(pid: string, connected: boolean) {
    const p = this.players.get(pid);
    if (!p || p.isBot) return;
    if (p.connected === connected) return;
    p.connected = connected;
    const now = this.clock.now();
    if (!connected) {
      p.disconnectedAt = now;
      // Give the player up to 60s to come back before their prompts auto-resolve.
      for (const pend of this.pending.values()) if (pend.playerId === pid) this.reschedule(pend, Math.min(pend.prompt.deadline ?? Infinity, now + DISCONNECT_GRACE_MS));
    } else {
      p.disconnectedAt = undefined;
      for (const pend of this.pending.values())
        if (pend.playerId === pid) this.reschedule(pend, pend.originalDeadline ? Math.max(pend.originalDeadline, now + 8000) : undefined);
    }
    this.dirty();
  }

  kick(pid: string) {
    const p = this.players.get(pid);
    if (!p) return;
    for (const pend of [...this.pending.values()]) if (pend.playerId === pid) this.resolvePending(pend, pend.fallback());
    this.players.delete(pid);
    if (this.state.phase !== 'playing') delete this.state.chars[pid];
    this.dirty();
  }

  // ------------------------------------------------------------ narration / journal

  narrate(text: string, style: NarrationLine['style'] = 'normal') {
    const line: NarrationLine = { id: ++this.narrSeq, text: this.fillTemplate(text), style };
    this.state.narration.push(line);
    if (this.state.narration.length > 14) this.state.narration.splice(0, this.state.narration.length - 14);
    this.dirty();
  }

  journal(kind: JournalEntry['kind'], text: string, author?: string) {
    this.state.journal.push({ id: `j${this.state.journal.length}_${this.rng.int(0, 1e6)}`, day: this.state.world?.day ?? 1, kind, text: this.fillTemplate(text), author });
    if (this.state.journal.length > 200) this.state.journal.shift();
    this.dirty();
  }

  fillTemplate(text: string, extra: Record<string, string> = {}): string {
    const w = this.state.world;
    const vars: Record<string, string> = {
      party: this.state.party.name ?? 'the party',
      kingdom: w?.kingdomName ?? 'the Realm',
      mascot: w?.mascot ?? 'the town goose',
      antagonist: w ? `${w.antagonist.name} ${w.antagonist.title}` : 'the enemy',
      fortress: w?.lore.fortress ?? 'the fortress',
      town: w?.home?.name ?? 'town',
      ...extra,
    };
    return text.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
  }

  /** Delay scaled by the text-speed setting (narration pacing). */
  async beat(ms = 1600) {
    const speed = this.state.settings.textSpeed || 1;
    await this.sleep(ms / speed);
  }

  async sleep(ms: number) {
    const ep = this.epoch;
    await this.clock.sleep(ms);
    if (ep !== this.epoch) throw new Aborted();
  }

  checkAbort(ep: number) {
    if (ep !== this.epoch) throw new Aborted();
  }

  // ------------------------------------------------------------ prompts

  private reschedule(p: Pending, deadline: number | undefined) {
    if (p.timer !== undefined) this.clock.clearTimeout(p.timer);
    p.timer = undefined;
    p.prompt.deadline = deadline && Number.isFinite(deadline) ? deadline : undefined;
    if (p.prompt.deadline) {
      const ms = Math.max(0, p.prompt.deadline - this.clock.now());
      p.timer = this.clock.setTimeout(() => this.timeoutPending(p.id), ms);
    }
  }

  private timeoutPending(id: string) {
    const p = this.pending.get(id);
    if (!p) return;
    if (p.rollReq) {
      this.completeRoll(p, undefined, false);
      return;
    }
    this.resolvePending(p, p.fallback());
  }

  private resolvePending(p: Pending, value: unknown) {
    if (!this.pending.has(p.id)) return;
    this.pending.delete(p.id);
    if (p.timer !== undefined) this.clock.clearTimeout(p.timer);
    this.dirty();
    p.resolve(value);
  }

  /**
   * Ask one player something. Resolves with a validated value, or `fallback()` on timeout,
   * disconnect grace expiry or kick. Bots answer through `botAnswer`.
   */
  ask<T>(
    playerId: string,
    prompt: PromptInput,
    opts: { timeoutMs?: number; fallback: () => T; validate?: (v: unknown) => T | undefined; bot?: () => T },
  ): Promise<T> {
    const id = `q${++this.promptSeq}`;
    const full = { ...prompt, id } as Prompt;
    const epoch = this.epoch;
    const player = this.players.get(playerId);
    return new Promise<T>((resolve, reject) => {
      if (!player) {
        resolve(opts.fallback());
        return;
      }
      const pend: Pending = {
        id,
        playerId,
        prompt: full,
        epoch,
        resolve: resolve as (v: unknown) => void,
        reject,
        fallback: opts.fallback,
        validate: (v) => {
          if (!opts.validate) return { ok: true, value: v };
          const r = opts.validate(v);
          return r === undefined ? { ok: false } : { ok: true, value: r };
        },
        created: this.clock.now(),
      };
      this.pending.set(id, pend);
      const statKey = full.kind === 'minigame' ? `minigame:${full.game}` : full.kind;
      this.promptStats[statKey] = (this.promptStats[statKey] ?? 0) + 1;
      const now = this.clock.now();
      let deadline = opts.timeoutMs ? now + opts.timeoutMs : undefined;
      pend.originalDeadline = deadline;
      if (!player.connected && !player.isBot) deadline = Math.min(deadline ?? Infinity, (player.disconnectedAt ?? now) + DISCONNECT_GRACE_MS);
      this.reschedule(pend, deadline);
      this.dirty();
      if (player.isBot) {
        const answer = () => {
          if (!this.pending.has(id)) return;
          if (pend.rollReq) this.completeRoll(pend, undefined, false);
          else this.resolvePending(pend, opts.bot ? opts.bot() : opts.fallback());
        };
        if (this.opts.instantBots) queueMicrotask(answer);
        else this.clock.setTimeout(answer, 400 + this.rng.int(0, 900));
      }
    });
  }

  /** Ask several players at once; resolves when all have answered (or timed out). */
  async askAll<T>(
    ids: string[],
    mk: (pid: string) => PromptInput,
    opts: { timeoutMs?: number; fallback: (pid: string) => T; validate?: (v: unknown, pid: string) => T | undefined; bot?: (pid: string) => T },
  ): Promise<Record<string, T>> {
    const entries = await Promise.all(
      ids.map(async (pid) => {
        const v = await this.ask<T>(pid, mk(pid), {
          timeoutMs: opts.timeoutMs,
          fallback: () => opts.fallback(pid),
          validate: opts.validate ? (v) => opts.validate!(v, pid) : undefined,
          bot: opts.bot ? () => opts.bot!(pid) : undefined,
        });
        return [pid, v] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  cancelPromptsFor(playerId: string) {
    for (const p of [...this.pending.values()]) if (p.playerId === playerId) this.resolvePending(p, p.fallback());
  }

  /** A choice prompt with option validation. */
  choose(
    playerId: string,
    title: string,
    options: ChoiceOption[],
    opts: { text?: string; style?: 'action' | 'target' | 'vote' | 'list' | 'cards' | 'map'; timeoutMs?: number; fallback?: string; bot?: () => string; allowNone?: string; urgent?: boolean } = {},
  ): Promise<string> {
    const enabled = options.filter((o) => !o.disabled);
    const fb = () => opts.fallback ?? enabled[0]?.id ?? options[0]?.id ?? '';
    return this.ask<string>(
      playerId,
      { kind: 'choice', title, text: opts.text, options, style: opts.style ?? 'list', allowNone: opts.allowNone, urgent: opts.urgent },
      {
        timeoutMs: opts.timeoutMs,
        fallback: fb,
        bot: opts.bot ?? (() => (enabled.length ? this.rng.pick(enabled).id : fb())),
        validate: (v) => {
          if (typeof v !== 'string') return undefined;
          if (opts.allowNone && v === '__none') return v;
          const o = options.find((x) => x.id === v);
          return o && !o.disabled ? v : undefined;
        },
      },
    );
  }

  answer(playerId: string, promptId: string, value: unknown): string | null {
    const p = this.pending.get(promptId);
    if (!p || p.playerId !== playerId) return 'That question has expired.';
    if (p.rollReq || p.prompt.kind === 'minigame') return 'Wrong answer type';
    const res = p.validate(value);
    if (!res.ok) return res.error ?? 'Invalid answer';
    this.resolvePending(p, res.value);
    return null;
  }

  // ------------------------------------------------------------ dice

  /**
   * Request a dice roll from a player's phone. Digital: server RNG (fair). Physical: the
   * entered values are validated against the dice. Fx is broadcast so both screens animate.
   */
  async rollDice(playerId: string, req: RollRequest, opts: { timeoutMs?: number; quiet?: boolean } = {}): Promise<number[]> {
    if (!req.faces.length) return [];
    const p = this.players.get(playerId);
    if (!p) return req.faces.map((f) => this.rng.die(f));
    const values = await new Promise<number[]>((resolve, reject) => {
      const id = `r${++this.promptSeq}`;
      const prompt: Prompt = { id, kind: 'roll', title: req.label, faces: req.faces, bonus: req.bonus, dc: req.dc, adv: req.adv, rollKind: req.kind, urgent: req.kind === 'save' || req.kind === 'death' };
      const pend: Pending = {
        id,
        playerId,
        prompt,
        epoch: this.epoch,
        resolve: resolve as (v: unknown) => void,
        reject,
        fallback: () => req.faces.map((f) => this.rng.die(f)),
        validate: () => ({ ok: false }),
        rollReq: req,
        created: this.clock.now(),
      };
      this.pending.set(id, pend);
      this.promptStats.roll = (this.promptStats.roll ?? 0) + 1;
      const now = this.clock.now();
      let deadline: number | undefined = now + (opts.timeoutMs ?? ROLL_TIMEOUT_MS);
      pend.originalDeadline = deadline;
      if (!p.connected && !p.isBot) deadline = Math.min(deadline, (p.disconnectedAt ?? now) + DISCONNECT_GRACE_MS);
      this.reschedule(pend, deadline);
      this.dirty();
      if (p.isBot) {
        if (this.opts.instantBots) queueMicrotask(() => this.completeRoll(pend, undefined, false));
        else this.clock.setTimeout(() => this.completeRoll(pend, undefined, false), 500 + this.rng.int(0, 800));
      }
    });
    if (!opts.quiet) await this.beat(1500);
    return values;
  }

  private completeRoll(p: Pending, physicalValues: number[] | undefined, physical: boolean) {
    if (!this.pending.has(p.id)) return;
    const req = p.rollReq!;
    const values = physicalValues ?? req.faces.map((f) => this.rng.die(f));
    const player = this.players.get(p.playerId);
    const isD20 = req.faces.length > 0 && req.faces.every((f) => f === 20) && req.faces.length <= 2;
    const kept = isD20 ? (req.faces.length === 2 ? (req.adv === -1 ? Math.min(...values) : Math.max(...values)) : values[0]) : undefined;
    const total = (isD20 ? kept! : values.reduce((s, v) => s + v, 0)) + req.bonus;
    this.fx({
      kind: 'roll',
      id: p.id,
      playerId: p.playerId,
      name: player?.name ?? '?',
      label: req.label,
      faces: req.faces,
      values,
      bonus: req.bonus,
      total,
      kept,
      adv: req.adv,
      dc: req.dc,
      success: req.dc !== undefined ? total >= req.dc : undefined,
      crit: isD20 && kept === 20,
      fumble: isD20 && kept === 1,
      physical,
    });
    this.resolvePending(p, values);
  }

  rollThrow(playerId: string, id: string): string | null {
    const p = this.pending.get(id);
    if (!p || p.playerId !== playerId || !p.rollReq) return 'That roll has expired.';
    this.completeRoll(p, undefined, false);
    return null;
  }

  rollPhysical(playerId: string, id: string, values: unknown): string | null {
    const p = this.pending.get(id);
    if (!p || p.playerId !== playerId || !p.rollReq) return 'That roll has expired.';
    const player = this.players.get(playerId);
    if (!player?.physicalDice) return 'Physical dice mode is off.';
    if (!validPhysical(p.rollReq.faces, values)) return `Enter ${p.rollReq.faces.map((f) => `1–${f}`).join(', ')}`;
    this.completeRoll(p, values as number[], true);
    return null;
  }

  // ------------------------------------------------------------ minigames

  static MINIGAME_DURATION: Record<MinigameKind, number> = {
    rune: 6000,
    swing: 3500,
    shout: 3000,
    tilt: 5000,
    shake: 3000,
    hold: 4000,
    rhythm: 6000,
    steady: 4000,
    blow: 3000,
    hum: 4500,
    scan: 12000,
    sequence: 12000,
    twofinger: 4000,
    quiet: 4000,
    tap: 3000,
    search: 9000,
    listen: 9000,
    plates: 7000,
  };

  async minigame(playerId: string, game: MinigameKind, title: string, param?: string): Promise<number> {
    const duration = Game.MINIGAME_DURATION[game] ?? 4000;
    const p = this.players.get(playerId);
    const skill = p?.botSkill ?? 0.6;
    const score = await this.ask<number>(
      playerId,
      { kind: 'minigame', game, title, param, duration },
      {
        timeoutMs: duration + 25_000,
        fallback: () => 0.3,
        bot: () => Math.max(0, Math.min(1, skill + (this.rng.next() - 0.5) * 0.5)),
        validate: (v) => scoreMinigame(game, param, v),
      },
    );
    const name = this.players.get(playerId)?.name ?? '?';
    this.fx({ kind: 'minigame', playerId, name, game, score });
    return score;
  }

  inputResult(playerId: string, id: string, data: unknown): string | null {
    const p = this.pending.get(id);
    if (!p || p.playerId !== playerId || p.prompt.kind !== 'minigame') return 'That challenge has expired.';
    const res = p.validate(data);
    if (!res.ok) return 'Invalid result';
    this.resolvePending(p, res.value);
    return null;
  }

  // ------------------------------------------------------------ generic waits (intents)

  /** Wait for a specific intent/host event. Used for overworld movement and town "ready" checks. */
  waitFor<T>(channel: string, filter: (v: unknown) => boolean = () => true): Promise<T> {
    const ep = this.epoch;
    return new Promise<T>((resolve, reject) => {
      const list = this.waiters.get(channel) ?? [];
      list.push({ resolve: resolve as (v: unknown) => void, reject, epoch: ep, filter });
      this.waiters.set(channel, list);
    });
  }
  signal(channel: string, value: unknown): boolean {
    const list = this.waiters.get(channel);
    if (!list?.length) return false;
    const idx = list.findIndex((w) => w.filter(value));
    if (idx < 0) return false;
    const [w] = list.splice(idx, 1);
    w!.resolve(value);
    return true;
  }
  hasWaiter(channel: string): boolean {
    return (this.waiters.get(channel)?.length ?? 0) > 0;
  }

  // ------------------------------------------------------------ reset

  /** Abort the running director, all prompts and waits. */
  reset() {
    this.epoch++;
    for (const p of this.pending.values()) {
      if (p.timer !== undefined) this.clock.clearTimeout(p.timer);
      p.reject(new Aborted());
    }
    this.pending.clear();
    for (const list of this.waiters.values()) for (const w of list) w.reject(new Aborted());
    this.waiters.clear();
  }

  runDirector(fn: () => Promise<void>) {
    const ep = this.epoch;
    this.director = fn().catch((e) => {
      if (e instanceof Aborted || ep !== this.epoch) return;
      console.error('[director] crashed:', e);
      this.narrate('The fates stumble... (an error occurred; returning to the map)', 'bad');
      this.log(String(e?.stack ?? e));
    });
  }

  // ------------------------------------------------------------ views

  private worldView(): WorldView | undefined {
    const w = this.state.world;
    if (!w) return undefined;
    const leaderId = this.leaderId();
    let reach: Map<string, { cost: number }> | undefined;
    if (this.state.scene.kind === 'overworld' && w.movesLeft > 0) reach = reachable(w, w.movesLeft);
    return {
      seed: w.seed,
      radius: w.radius,
      tiles: w.tiles
        .filter((t) => t.revealed)
        .map((t) => ({
          q: t.q,
          r: t.r,
          biome: t.biome,
          visited: t.visited,
          name: t.name,
          poi: t.poi && (!t.hidden || t.visited) ? { id: t.poi.id, kind: t.poi.kind, name: t.poi.name, emoji: t.poi.emoji, cleared: t.poi.cleared } : undefined,
          reachable: reach?.get(hexKey(t.q, t.r))?.cost,
        })),
      fogReach: reach ? w.tiles.filter((t) => !t.revealed && reach!.has(hexKey(t.q, t.r))).map((t) => ({ q: t.q, r: t.r, cost: reach!.get(hexKey(t.q, t.r))!.cost })) : undefined,
      totalTiles: w.tiles.length,
      party: w.party,
      day: w.day,
      time: w.time,
      weather: w.weather,
      doom: w.doom,
      doomMax: w.doomMax,
      antagonist: { name: w.antagonist.name, title: w.antagonist.title, emoji: w.antagonist.emoji, desc: w.antagonist.desc },
      objective: w.objective,
      factions: w.factions,
      npcs: w.npcs.filter((n) => n.met),
      quests: w.quests.filter((q) => !q.privateFor),
      kingdomName: w.kingdomName,
      banner: w.banner,
      mascot: w.mascot,
      lore: w.lore,
      home: w.home,
      turn: w.turn,
      movesLeft: w.movesLeft,
      moveBudget: w.moveBudget,
      leaderId,
    };
  }

  leaderId(): string | undefined {
    const ids = this.partyIds().filter((id) => {
      const c = this.state.chars[id];
      return c && !c.dead;
    });
    if (!ids.length) return this.partyIds()[0];
    const w = this.state.world;
    return ids[(w?.leaderIdx ?? 0) % ids.length];
  }

  waitingOn(): WaitingOn[] {
    const out: WaitingOn[] = [];
    for (const p of this.pending.values()) {
      const pl = this.players.get(p.playerId);
      if (!pl || pl.isBot) continue;
      const verb = p.prompt.kind === 'roll' ? 'to roll' : p.prompt.kind === 'minigame' ? 'to play' : p.prompt.kind === 'text' ? 'to write' : p.prompt.kind === 'draw' ? 'to draw' : 'to choose';
      out.push({ playerId: p.playerId, label: `${pl.name} ${verb}${pl.connected ? '' : ' (reconnecting…)'}`, deadline: p.prompt.deadline });
    }
    return out;
  }

  publicView(): PublicView {
    const s = this.state;
    return {
      v: PROTOCOL_VERSION,
      code: this.opts.code,
      lanUrl: this.opts.lanUrl,
      settings: s.settings,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        ready: p.ready,
        color: p.color,
        physicalDice: p.physicalDice,
        hasCharacter: !!s.chars[p.id],
        creating: p.creating as never,
        disconnectedAt: p.disconnectedAt,
      })),
      chars: s.chars,
      party: { gold: s.party.gold, stash: s.party.stash, name: s.party.name, motto: s.party.motto },
      world: this.worldView(),
      scene: s.scene,
      narration: s.narration,
      journal: s.journal.slice(-60),
      waiting: this.waitingOn(),
      campaign: s.id ? { id: s.id, name: s.name, seed: s.seed, started: s.created } : undefined,
      paused: this.pausedReason,
    };
  }

  phoneView(pid: string, shared?: PublicView): PhoneView {
    const pub = shared ?? this.publicView();
    const p = this.players.get(pid)!;
    const prompts = [...this.pending.values()]
      .filter((x) => x.playerId === pid)
      .sort((a, b) => Number(!!b.prompt.urgent) - Number(!!a.prompt.urgent) || a.created - b.created)
      .map((x) => x.prompt);
    const creation = this.state.creation[pid];
    const privQuests = this.state.world?.quests.filter((q) => q.privateFor === pid) ?? [];
    return {
      ...pub,
      world: pub.world ? { ...pub.world, quests: [...pub.world.quests, ...privQuests] } : undefined,
      me: {
        id: pid,
        prompts,
        secrets: this.state.secrets[pid] ?? [],
        creation: creation ? { fate: creation.fate, error: creation.error, claimable: this.claimable() } : { claimable: this.claimable() },
        physicalDice: p.physicalDice,
        token: p.token,
        isLeader: this.leaderId() === pid,
      },
    };
  }

  /** Characters from a loaded save that no connected player has claimed yet. */
  claimable(): CreationView['claimable'] {
    // heroes whose player is missing or offline can be picked up from another device
    return Object.values(this.state.chars)
      .filter((c) => {
        const p = this.players.get(c.id);
        return !p || (!p.connected && !p.isBot);
      })
      .map((c) => ({ id: c.id, name: c.name, cls: c.cls, species: c.species, level: c.level }));
  }

  // ------------------------------------------------------------ saves

  savesDir() {
    return this.opts.savesDir;
  }

  save() {
    const dir = this.opts.savesDir;
    if (!dir || !this.state.id) return;
    this.state.updated = Date.now();
    this.state.rng = this.rng.state;
    const data = {
      version: 1,
      state: this.state,
      players: [...this.players.values()].filter((p) => this.state.chars[p.id]).map((p) => ({ id: p.id, name: p.name, token: p.token, color: p.color, physicalDice: p.physicalDice, isBot: p.isBot })),
    };
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${this.state.id}.json`);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error('[save] failed:', e);
    }
  }

  listSaves(): SaveSummary[] {
    const dir = this.opts.savesDir;
    if (!dir || !fs.existsSync(dir)) return [];
    const out: SaveSummary[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { state: GameState };
        if (d.state.phase === 'ended') continue;
        out.push({
          id: d.state.id,
          name: d.state.name,
          updated: d.state.updated,
          day: d.state.world?.day ?? 1,
          heroes: Object.values(d.state.chars).map((c) => `${c.name} (L${c.level} ${c.cls})`),
          mode: d.state.settings.length,
        });
      } catch {
        /* skip corrupt save */
      }
    }
    return out.sort((a, b) => b.updated - a.updated).slice(0, 8);
  }

  loadSave(id: string): boolean {
    const dir = this.opts.savesDir;
    if (!dir || !/^[a-z0-9_-]+$/i.test(id)) return false;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')) as { state: GameState; players: { id: string; name: string; token: string; color: string; physicalDice: boolean; isBot?: boolean }[] };
      this.state = { ...Game.blankState(), ...d.state, settings: { ...DEFAULT_SETTINGS, ...d.state.settings } };
      this.rng = new Rng(this.state.rng);
      // Restore identities so phones with stored tokens rejoin as the same hero
      for (const [pid, p] of [...this.players]) if (!this.state.chars[pid]) this.players.delete(pid);
      for (const sp of d.players) {
        if (this.players.has(sp.id)) continue;
        if (sp.isBot) continue;
        this.players.set(sp.id, { id: sp.id, name: sp.name, token: sp.token, color: sp.color, physicalDice: sp.physicalDice, connected: false, ready: true, disconnectedAt: this.clock.now() });
      }
      return true;
    } catch (e) {
      console.error('[load] failed:', e);
      return false;
    }
  }

  newCampaignState(settings: Partial<Settings>, seed?: string) {
    const s = Game.blankState();
    s.id = `c_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
    s.seed = (seed && sanitizeText(seed, 32).toUpperCase()) || randomSeedName();
    s.created = Date.now();
    s.settings = { ...this.state.settings, ...settings };
    s.rng = new Rng(`${s.seed}::play`).state;
    s.phase = 'lobby';
    s.scene = { kind: 'lobby' };
    s.stats.startedAt = Date.now();
    this.state = s;
    this.rng = new Rng(s.rng);
    for (const p of this.players.values()) {
      p.ready = false;
      p.creating = undefined;
    }
  }

  snapshot(): GameState {
    return clone(this.state);
  }

  // hooks implemented by the director module
  hostCommandHandler?: (cmd: HostCommand) => string | null;
  intentHandler?: (pid: string, intent: Intent) => string | null;
}

/** Server-side scoring of minigame results; never trusts more than a bounded score. */
export function scoreMinigame(game: MinigameKind, param: string | undefined, v: unknown): number | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const d = v as { score?: unknown; points?: unknown; fallback?: unknown };
  if (game === 'rune') {
    if (Array.isArray(d.points)) {
      const target = param && content() ? param : 'circle';
      return scoreRune(d.points, target).score;
    }
    // tap-the-dots fallback still reports a score but is capped
    const s = Number(d.score);
    return Number.isFinite(s) ? Math.max(0, Math.min(0.85, s)) : undefined;
  }
  const s = Number(d.score);
  if (!Number.isFinite(s)) return undefined;
  return Math.max(0, Math.min(1, s));
}

export type { DieSides };
