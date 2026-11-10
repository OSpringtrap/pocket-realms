import {
  CLASSES,
  SPECIES,
  speciesName,
  allowedQuirks,
  content,
  createCharacter,
  randomDiceStyle,
  equipItem,
  generateWorld,
  healUnit,
  isDieSides,
  parseDice,
  refreshDerived,
  resolveFate,
  rollDice,
  sanitizeText,
  unequipItem,
  validateDraft,
  XP_TABLE,
  type CharacterDraft,
  type HostCommand,
  type Intent,
  type Settings,
} from '@pr/shared';
import { Aborted, Game, type PlayerRec } from './Game.js';
import { avgLevel } from './effects.js';
import { jackboxRound } from './scenes/jackbox.js';
import { overworldLoop } from './scenes/overworld.js';
import { assignGoals } from './goals.js';

export function toTitle(g: Game) {
  g.reset();
  const settings = g.state.settings;
  g.state = Game.blankState();
  g.state.settings = settings;
  g.state.scene = { kind: 'title', saves: g.listSaves() };
  for (const p of [...g.players.values()]) {
    if (p.isBot) g.players.delete(p.id);
    else {
      p.ready = false;
      p.creating = undefined;
    }
  }
  g.dirty();
}

function sanitizeSettings(raw: Partial<Settings> | undefined): Partial<Settings> {
  const out: Partial<Settings> = {};
  if (!raw || typeof raw !== 'object') return out;
  if (raw.difficulty === 'story' || raw.difficulty === 'normal' || raw.difficulty === 'heroic') out.difficulty = raw.difficulty;
  if (raw.length === 'oneshot' || raw.length === 'campaign') out.length = raw.length;
  if (typeof raw.adaptive === 'boolean') out.adaptive = raw.adaptive;
  if (typeof raw.music === 'boolean') out.music = raw.music;
  if (typeof raw.colorblind === 'boolean') out.colorblind = raw.colorblind;
  if (typeof raw.reduceMotion === 'boolean') out.reduceMotion = raw.reduceMotion;
  if (typeof raw.voice === 'boolean') out.voice = raw.voice;
  const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined);
  const ts = num(raw.textSpeed, 0.5, 2.5);
  if (ts !== undefined) out.textSpeed = ts;
  const vol = num(raw.volume, 0, 1);
  if (vol !== undefined) out.volume = vol;
  const size = num(raw.textSize, 0.8, 1.8);
  if (size !== undefined) out.textSize = size;
  const tt = num(raw.turnTimer, 0, 300);
  if (tt !== undefined) out.turnTimer = Math.round(tt);
  return out;
}

export function startNewCampaign(g: Game, settings?: Partial<Settings>, seed?: string) {
  g.reset();
  for (const p of [...g.players.values()]) if (p.isBot) g.players.delete(p.id);
  g.newCampaignState(sanitizeSettings(settings), seed);
  g.legacyQueue = [];
  g.narrate('A new adventure awaits! Join on your phones and create your heroes.', 'title');
  g.dirty();
  g.runDirector(() => lobbyThenPlay(g, false));
}

export function continueCampaign(g: Game, saveId: string): string | null {
  g.reset();
  if (!g.loadSave(saveId)) {
    toTitle(g);
    return 'Could not load that save.';
  }
  g.state.phase = 'lobby';
  g.state.scene = { kind: 'lobby' };
  g.narrate('The adventure continues! Rejoin on your phones — your heroes are waiting.', 'title');
  g.dirty();
  g.runDirector(() => lobbyThenPlay(g, true));
  return null;
}

async function lobbyThenPlay(g: Game, resumed: boolean) {
  await g.waitFor('start');
  const s = g.state;
  if (!resumed) {
    const n = g.partyIds().length;
    s.world = generateWorld({ seed: s.seed, length: s.settings.length, partySize: n });
    s.name = `${s.world.antagonist.name}'s Shadow`;
    s.party.gold = 30 + 15 * n;
    for (const c of g.partyChars()) for (const q of c.quirks) for (const e of content().quirks[q]?.effects ?? []) if (e.type === 'gold') s.party.gold += e.amount;
    s.phase = 'playing';
    s.scene = { kind: 'overworld' };
    const w = s.world;
    g.fx({ kind: 'sound', name: 'fanfare' });
    g.narrate(`Darkness gathers over the land. ${w.antagonist.emoji} ${w.antagonist.name} ${w.antagonist.title} stirs in ${w.lore.fortress}.`, 'title');
    await g.beat(2400);
    g.narrate(`Your quest: ${w.objective.text} You will need ${w.objective.keysNeeded} ${w.objective.keyName}${w.objective.keysNeeded > 1 ? 's' : ''} to break its seal — the dungeons (🕳️) hold them.`);
    await g.beat(2600);
    g.journal('quest', w.objective.text);
    // World-building: name the kingdom, then draw its banner
    const humans = g.partyIds().filter((id) => !g.players.get(id)?.isBot);
    if (humans.length) {
      await jackboxRound(g, 'kingdom');
      const artist = g.rng.pick(humans);
      const banner = await g.ask<string | null>(
        artist,
        { kind: 'draw', title: `🎨 Draw the banner of ${w.kingdomName}!`, text: 'Everyone will march under it.', maxBytes: 90_000 },
        { timeoutMs: 90000, fallback: () => null, validate: (v) => (typeof v === 'string' && v.length < 90_000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : undefined) },
      );
      if (banner) {
        w.banner = banner;
        g.journal('world', `${g.displayName(artist)} painted the banner of ${w.kingdomName}.`, g.displayName(artist));
        g.narrate(`The banner of ${w.kingdomName} is raised!`, 'good');
      }
    }
    assignGoals(g);
    g.save();
  } else {
    assignGoals(g);
    s.phase = 'playing';
    s.scene = { kind: 'overworld' };
    g.narrate(`Day ${s.world?.day}. The heroes regroup and press on.`, 'title');
  }
  g.dirty();
  await overworldLoop(g);
}

// ------------------------------------------------------------ host commands

export function hostCommand(g: Game, cmd: HostCommand): string | null {
  switch (cmd.cmd) {
    case 'newCampaign':
      startNewCampaign(g, cmd.settings, typeof cmd.seed === 'string' ? cmd.seed : undefined);
      return null;
    case 'continue':
      return typeof cmd.saveId === 'string' ? continueCampaign(g, cmd.saveId) : 'Bad save id';
    case 'deleteSave': {
      if (g.state.scene.kind !== 'title') return 'Campaigns can only be removed from the title screen.';
      if (typeof cmd.saveId !== 'string' || !g.deleteSave(cmd.saveId)) return 'Could not remove that campaign.';
      g.state.scene = { kind: 'title', saves: g.listSaves() };
      g.dirty();
      return null;
    }
    case 'start': {
      if (g.state.phase !== 'lobby') return 'Nothing to start.';
      const players = [...g.players.values()].filter((p) => p.connected || p.isBot);
      const withChars = players.filter((p) => g.state.chars[p.id]);
      if (!withChars.length) return 'At least one hero is needed.';
      const unready = players.filter((p) => !g.state.chars[p.id] || !p.ready);
      if (unready.length) return `Waiting for: ${unready.map((p) => p.name).join(', ')}`;
      if (!g.hasWaiter('start')) return 'Not ready yet.';
      // players who never made a hero (disconnected) are removed
      for (const p of [...g.players.values()]) if (!g.state.chars[p.id] && !p.connected) g.players.delete(p.id);
      g.signal('start', true);
      return null;
    }
    case 'settings': {
      Object.assign(g.state.settings, sanitizeSettings(cmd.settings));
      if (!g.state.settings.voice) g.voice?.stop();
      g.dirty();
      return null;
    }
    case 'kick':
      g.kick(cmd.playerId);
      return null;
    case 'skip': {
      // Resolve every human prompt with its fallback (keeps the table moving)
      for (const p of [...g.pending.values()]) g.cancelPromptsFor(p.playerId);
      return null;
    }
    case 'title':
      toTitle(g);
      return null;
    case 'pause':
      g.pausedReason = cmd.on ? 'Paused by host' : undefined;
      g.dirty();
      return null;
    case 'move': {
      const leader = g.leaderId();
      const pend = [...g.pending.values()].find((p) => p.playerId === leader && p.prompt.kind === 'choice' && p.prompt.style === 'map');
      if (!pend) return 'Not waiting for a move.';
      return g.answer(pend.playerId, pend.id, `${cmd.q},${cmd.r}`);
    }
    case 'addBot': {
      if (g.state.phase !== 'lobby') return 'Bots can only join in the lobby.';
      const species = g.rng.pick(SPECIES);
      const p = g.addPlayer(`🤖 ${speciesName(g.rng, species).split(' ')[0]}`, { bot: true, botSkill: 0.6 });
      if (typeof p === 'string') return p;
      const taken = new Set(Object.values(g.state.chars).map((c) => c.cls));
      const free = CLASSES.filter((c) => !taken.has(c));
      const cls = free.length ? g.rng.pick(free) : g.rng.pick(CLASSES);
      const draft: CharacterDraft = { name: p.name.replace('🤖 ', ''), species, cls, quirks: [g.rng.pick(allowedQuirks(species, cls))], personality: g.rng.pick(content().names.personalities), dice: randomDiceStyle() };
      finishCreation(g, p, draft);
      return null;
    }
  }
}

// ------------------------------------------------------------ creation

export function creationDraft(g: Game, pid: string, d: { species?: unknown; cls?: unknown; step?: unknown }) {
  const p = g.players.get(pid);
  if (!p) return;
  p.creating = {
    species: SPECIES.includes(d.species as never) ? (d.species as string) : undefined,
    cls: CLASSES.includes(d.cls as never) ? (d.cls as string) : undefined,
    step: typeof d.step === 'string' ? d.step.slice(0, 16) : undefined,
  };
  g.dirty();
}

export function creationFate(g: Game, pid: string): string | null {
  const cr = (g.state.creation[pid] ??= {});
  if (cr.fate) return 'You already rolled for fate.';
  if (g.pending.size && [...g.pending.values()].some((x) => x.playerId === pid && x.rollReq?.kind === 'fate')) return null;
  const cls = (g.players.get(pid)?.creating?.cls as never) ?? 'warrior';
  g.rollDice(pid, { kind: 'fate', label: '🎲 Roll for Fate!', faces: [20], bonus: 0 }, { quiet: true, timeoutMs: 60000 })
    .then(([roll]) => {
      const fate = resolveFate(roll ?? 10, cls, g.rng);
      cr.fate = { roll: fate.roll, text: fate.text, ability: fate.ability, delta: fate.delta };
      cr.fateResult = fate;
      g.dirty();
    })
    .catch(() => {});
  return null;
}

export function createHero(g: Game, pid: string, raw: unknown): string | null {
  const p = g.players.get(pid);
  if (!p) return 'Unknown player';
  if (g.state.chars[pid]) return 'You already have a hero.';
  if (g.state.phase === 'title') return 'The host has not started a campaign yet.';
  const d = validateDraft(raw);
  if (typeof d === 'string') {
    (g.state.creation[pid] ??= {}).error = d;
    g.dirty();
    return d;
  }
  finishCreation(g, p, d);
  return null;
}

function finishCreation(g: Game, p: PlayerRec, d: CharacterDraft) {
  const legacyIdx = g.legacyQueue.findIndex((l) => l.playerId === p.id);
  const legacy = legacyIdx >= 0 ? g.legacyQueue.splice(legacyIdx, 1)[0] : undefined;
  const level = legacy?.level ?? (g.state.phase === 'playing' ? avgLevel(g) : 1);
  const fate = g.state.creation[p.id]?.fateResult;
  // Late joiners and heirs start at level 1 and choose their own upgrades up to the party's level
  const c = createCharacter(p.id, d, g.rng, fate, 1);
  if (level > 1) {
    c.xp = XP_TABLE[level - 1] ?? c.xp;
    c.pendingLevelUps = level - 1;
  }
  if (legacy) {
    c.inventory.push(...legacy.gear.filter((x) => !x.cursed));
    c.titles.push(`Heir of ${legacy.oldName}`);
    g.narrate(`${c.name} takes up ${legacy.oldName}'s gear and joins the party!`, 'good');
  } else if (g.state.phase === 'playing') g.narrate(`${c.name} the ${content().species[c.species].name} ${content().classes[c.cls].name} joins the adventure!`, 'good');
  g.state.chars[p.id] = c;
  p.ready = true;
  if (g.state.phase === 'playing') queueMicrotask(() => assignGoals(g));
  p.creating = undefined;
  if (g.state.creation[p.id]) g.state.creation[p.id]!.error = undefined;
  g.dirty();
}

export function setReady(g: Game, pid: string, ready: boolean) {
  const p = g.players.get(pid);
  if (!p) return;
  p.ready = ready && !!g.state.chars[pid];
  g.dirty();
}

// ------------------------------------------------------------ intents (phone)

export function playerIntent(g: Game, pid: string, intent: Intent): string | null {
  const c = g.state.chars[pid];
  const inCombat = g.state.scene.kind === 'combat';
  if (!intent || typeof intent !== 'object') return 'Bad intent';
  switch (intent.kind) {
    case 'physicalDice': {
      const p = g.players.get(pid);
      if (p) p.physicalDice = !!intent.on;
      g.dirty();
      return null;
    }
    case 'equip':
      if (!c) return 'No hero';
      if (inCombat) return "You can't change gear mid-fight!";
      return finish(g, equipItem(c, String(intent.uid)));
    case 'unequip':
      if (!c) return 'No hero';
      if (inCombat) return "You can't change gear mid-fight!";
      if (!['weapon', 'armor', 'trinket'].includes(intent.slot)) return 'Bad slot';
      return finish(g, unequipItem(c, intent.slot));
    case 'toStash': {
      if (!c) return 'No hero';
      const idx = c.inventory.findIndex((i) => i.uid === intent.uid);
      if (idx < 0) return 'Item not found';
      g.state.party.stash.push(...c.inventory.splice(idx, 1));
      return finish(g, null);
    }
    case 'fromStash': {
      if (!c) return 'No hero';
      if (inCombat) return 'Not during a fight.';
      const idx = g.state.party.stash.findIndex((i) => i.uid === intent.uid);
      if (idx < 0) return 'Someone already took it!';
      const [it] = g.state.party.stash.splice(idx, 1);
      c.inventory.push(it!);
      g.narrate(`${c.name} takes ${it!.emoji} ${it!.name} from the stash.`, 'normal', { quiet: true });
      return finish(g, null);
    }
    case 'give': {
      const to = g.state.chars[String(intent.to)];
      if (!c || !to) return 'No such hero';
      const idx = c.inventory.findIndex((i) => i.uid === intent.uid);
      if (idx < 0) return 'Item not found';
      to.inventory.push(...c.inventory.splice(idx, 1));
      return finish(g, null);
    }
    case 'use': {
      if (!c) return 'No hero';
      if (inCombat) return 'Use items from your turn menu during combat.';
      const idx = c.inventory.findIndex((i) => i.uid === intent.uid);
      const it = c.inventory[idx];
      if (!it?.use) return 'That item cannot be used.';
      if (it.use.target === 'enemy' || it.use.target === 'allEnemies') return 'Save that for a fight!';
      const target = (intent.target && g.state.chars[intent.target]) || c;
      if (it.use.revive && !target.dead && !target.down && target.hp > 0) return 'Nobody needs reviving.';
      c.inventory.splice(idx, 1);
      if (it.use.revive) {
        target.dead = false;
        target.down = false;
        target.hp = Math.max(1, target.hp);
      }
      if (it.use.heal) {
        const r = rollDice(g.rng, it.use.heal);
        target.hp = Math.min(target.maxHp, target.hp + r.total);
        g.fx({ kind: 'heal', target: target.id, amount: r.total });
      }
      if (it.use.sp) target.sp = Math.min(target.maxSp, target.sp + it.use.sp);
      if (it.use.cleanse) target.conditions = target.conditions.filter((x) => x.id === 'blessed' || x.id === 'inspired');
      g.narrate(`${c.name} uses ${it.emoji} ${it.name}${target !== c ? ` on ${target.name}` : ''}.`, 'normal', { quiet: true });
      g.fx({ kind: 'sound', name: 'potion' });
      return finish(g, null);
    }
    case 'useAbility': {
      if (!c) return 'No hero';
      if (inCombat) return 'Use abilities from your turn menu during combat.';
      const a = content().abilities[String(intent.id)];
      if (!a || !c.known.includes(a.id) || !a.outOfCombat) return 'You can only use healing abilities outside combat.';
      if (a.cost.sp && c.sp < a.cost.sp) return 'Not enough SP';
      if (a.cost.resource && (c.resources[a.cost.resource]?.cur ?? 0) < (a.cost.amount ?? 1)) return 'No uses left';
      const targets = a.target === 'allAllies' ? g.partyChars().filter((x) => !x.dead) : [(intent.target && g.state.chars[intent.target]) || c];
      if (a.cost.sp) c.sp -= a.cost.sp;
      if (a.cost.resource) c.resources[a.cost.resource]!.cur -= a.cost.amount ?? 1;
      for (const e of a.effects) {
        if (e.type === 'heal') {
          const d = parseDice(e.dice);
          const extra = a.scaling ? Math.max(0, Math.floor((c.level - a.level) / a.scaling.every)) : 0;
          const amt = rollDice(g.rng, { ...d, count: d.count + (isDieSides(d.sides) ? extra : 0) }).total + (e.addMod ? Math.max(0, Math.floor((c.abilities[content().classes[c.cls].castAbility ?? 'WIS'] - 10) / 2)) : 0);
          for (const t of targets) {
            const fakeCtx = { combat: { log: [] } } as never;
            healUnit(fakeCtx, { emit: () => {} } as never, t, amt, c);
            g.fx({ kind: 'heal', target: t.id, amount: amt });
          }
        }
        if (e.type === 'revive') for (const t of targets) if (t.dead || t.down) {
          t.dead = false;
          t.down = false;
          t.hp = Math.max(1, e.hp + c.level);
        }
        if (e.type === 'removeCondition') for (const t of targets) t.conditions = t.conditions.filter((x) => (e.ids ? !e.ids.includes(x.id) : x.id === 'blessed' || x.id === 'inspired'));
      }
      g.narrate(`${c.name} casts ${a.emoji} ${a.name}.`, 'good', { quiet: true });
      g.fx({ kind: 'sound', name: 'heal' });
      return finish(g, null);
    }
    case 'ping': {
      const q = Number(intent.q);
      const r = Number(intent.r);
      if (!Number.isInteger(q) || !Number.isInteger(r)) return 'Bad ping';
      g.pings = [...g.pings.filter((p) => p.playerId !== pid), { q, r, playerId: pid, at: g.clock.now() }].slice(-6);
      g.fx({ kind: 'sound', name: 'ping' });
      g.dirty();
      return null;
    }
    case 'move':
    case 'camp': {
      const leader = g.leaderId();
      const leaderRec = leader ? g.players.get(leader) : undefined;
      const canAct = pid === leader || !leaderRec?.connected || leaderRec.isBot;
      if (!canAct) return 'Only the leader picks the path this turn.';
      const pend = [...g.pending.values()].find((p) => p.playerId === leader && p.prompt.kind === 'choice' && p.prompt.style === 'map');
      if (!pend) return 'Not waiting for a move.';
      return g.answer(pend.playerId, pend.id, intent.kind === 'camp' ? 'camp' : `${intent.q},${intent.r}`);
    }
  }
  return 'Unknown intent';
}

function finish(g: Game, err: string | null): string | null {
  g.dirty();
  return err;
}

export function claimCharacter(g: Game, pid: string, charId: string): { ok: true; player: PlayerRec } | { ok: false; error: string } {
  const me = g.players.get(pid);
  const target = g.players.get(String(charId));
  const ch = g.state.chars[String(charId)];
  if (!me || !ch) return { ok: false, error: 'No such hero.' };
  if (target && target.connected && !target.isBot) return { ok: false, error: 'That hero is already being played.' };
  if (g.state.chars[pid]) return { ok: false, error: 'You already have a hero.' };
  // Take over the old identity; drop the temporary one
  g.players.delete(pid);
  const rec: PlayerRec = target ?? { id: ch.id, name: me.name, token: me.token, color: me.color, connected: true, ready: true, physicalDice: me.physicalDice };
  rec.connected = true;
  rec.disconnectedAt = undefined;
  rec.ready = true;
  rec.name = me.name || rec.name;
  g.players.set(rec.id, rec);
  g.setConnected(rec.id, true);
  g.dirty();
  return { ok: true, player: rec };
}

export function installHandlers(g: Game) {
  g.hostCommandHandler = (cmd) => hostCommand(g, cmd);
  g.intentHandler = (pid, intent) => playerIntent(g, pid, intent);
}

export { Aborted, refreshDerived, sanitizeText };
