import {
  addXp,
  buildEncounter,
  content,
  hexDist,
  longRest,
  makeItem,
  revealAround,
  rollDice,
  rollLoot,
  shortRest,
  type EventEffect,
  type Quest,
} from '@pr/shared';
import type { Game } from './Game.js';
import { combatScene, currentBiome, type CombatOutcome } from './scenes/combat.js';
import { handleLevelUps } from './scenes/levelup.js';
import { shopScene } from './scenes/town.js';
import { makeQuest } from './quests.js';

export function avgLevel(g: Game): number {
  const cs = g.partyChars();
  return Math.max(1, Math.round(cs.reduce((s, c) => s + c.level, 0) / Math.max(1, cs.length)));
}

export function partyLevels(g: Game): number[] {
  return g.partyChars().filter((c) => !c.dead).map((c) => c.level);
}

/** Apply narrative event effects. Returns a combat outcome if a fight broke out. */
export async function applyEffects(g: Game, effects: EventEffect[], actorId: string | undefined): Promise<CombatOutcome | undefined> {
  const s = g.state;
  const w = s.world;
  const chars = g.partyChars().filter((c) => !c.dead);
  const actor = (actorId && s.chars[actorId]) || chars[0];
  let combat: CombatOutcome | undefined;
  let xpGained = false;
  for (const e of effects) {
    switch (e.type) {
      case 'gold': {
        const before = s.party.gold;
        s.party.gold = Math.max(0, s.party.gold + e.amount);
        const d = s.party.gold - before;
        if (d) g.narrate(d > 0 ? `💰 +${d} gold.` : `💸 ${-d} gold lost.`, d > 0 ? 'good' : 'bad');
        if (d > 0) g.fx({ kind: 'sound', name: 'coin' });
        break;
      }
      case 'xp':
        for (const c of chars) addXp(c, e.amount * (s.settings.length === 'oneshot' ? 1.6 : 1));
        xpGained = true;
        break;
      case 'damage': {
        const targets = e.who === 'party' ? chars : e.who === 'random' ? [g.rng.pick(chars)] : actor ? [actor] : [];
        for (const c of targets) {
          const r = rollDice(g.rng, e.dice);
          c.hp = Math.max(1, c.hp - r.total);
          g.fx({ kind: 'damage', target: c.id, amount: r.total, dmg: e.dmg ?? 'bludgeoning' });
        }
        g.narrate(`${targets.map((c) => c.name).join(', ')} ${targets.length > 1 ? 'take' : 'takes'} damage.`, 'bad');
        break;
      }
      case 'heal': {
        const targets = e.who === 'actor' && actor ? [actor] : chars;
        for (const c of targets) {
          const r = rollDice(g.rng, e.dice);
          c.hp = Math.min(c.maxHp, c.hp + r.total);
          g.fx({ kind: 'heal', target: c.id, amount: r.total });
        }
        g.narrate(`💖 ${targets.length > 1 ? 'The party heals' : `${targets[0]?.name} heals`}.`, 'good');
        break;
      }
      case 'item':
      case 'itemId': {
        const it = e.type === 'item' ? rollLoot(g.rng, { level: avgLevel(g), rarity: e.rarity, slot: e.slot }) : makeItem(e.id, g.rng);
        s.party.stash.push(it);
        g.narrate(`🎁 Found ${it.emoji} ${it.name}${e.type === 'item' ? ` (${it.rarity})` : ''}! It's in the party stash.`, 'good');
        g.fx({ kind: 'sound', name: 'loot' });
        break;
      }
      case 'doom':
        if (w) {
          w.doom = Math.max(0, Math.min(w.doomMax, w.doom + e.amount));
          g.narrate(e.amount > 0 ? `⏳ The Doom Clock advances (+${e.amount}).` : `⏳ The Doom Clock is pushed back (${e.amount}).`, e.amount > 0 ? 'bad' : 'good');
          g.fx({ kind: 'sound', name: e.amount > 0 ? 'doom' : 'good' });
        }
        break;
      case 'combat': {
        const enc = buildEncounter(g.rng, {
          levels: g.partyChars().filter((c) => !c.dead).map((c) => c.level),
          difficulty: s.settings.difficulty,
          encounter: e.difficulty,
          biome: currentBiome(g),
          time: w?.time,
          family: e.family,
          monsterIds: e.monsters,
          directorMod: w?.directorMod,
        });
        combat = await combatScene(g, { encounter: enc, ambush: e.ambush, difficultyLabel: e.difficulty });
        if (w) w.combatStreak++;
        if (combat === 'defeat') return combat;
        break;
      }
      case 'condition': {
        const targets = e.who === 'party' ? chars : actor ? [actor] : [];
        for (const c of targets) if (!c.conditions.some((x) => x.id === e.id)) c.conditions.push({ id: e.id, turns: e.turns });
        g.narrate(`${targets.map((c) => c.name).join(', ')}: ${e.id}!`, e.id === 'blessed' || e.id === 'inspired' ? 'good' : 'bad');
        break;
      }
      case 'rep': {
        if (!w || !w.factions.length) break;
        const f = e.faction === 'random' ? g.rng.pick(w.factions) : w.factions.find((x) => x.id === e.faction);
        if (!f) break;
        f.rep = Math.max(-10, Math.min(10, f.rep + e.amount));
        g.narrate(`${f.emoji} ${f.name} ${e.amount > 0 ? 'likes' : 'dislikes'} that. (Reputation ${f.rep >= 0 ? '+' : ''}${f.rep})`, e.amount > 0 ? 'good' : 'bad');
        break;
      }
      case 'reveal':
        if (w) {
          const tiles = revealAround(w, w.party.q, w.party.r, e.radius + 1);
          for (const t of w.tiles) if (t.hidden && hexDist(t, w.party) <= e.radius + 1) t.visited = t.visited || false;
          g.narrate(`🗺️ The map grows: ${tiles.length} new places revealed.`, 'good');
        }
        break;
      case 'key':
        if (w) {
          w.objective.keys++;
          g.fx({ kind: 'banner', text: `🔑 ${w.objective.keyName} found! (${w.objective.keys}/${w.objective.keysNeeded})`, style: 'good' });
          g.narrate(`🔑 You obtained a ${w.objective.keyName}! (${w.objective.keys}/${w.objective.keysNeeded})`, 'good');
          g.journal('quest', `Recovered a ${w.objective.keyName}.`);
        }
        break;
      case 'quest': {
        if (!w) break;
        const q: Quest | undefined = makeQuest(g, e.questType);
        if (q) {
          w.quests.push(q);
          g.narrate(`📜 New quest: ${q.title} — ${q.desc}`, 'good');
          g.journal('quest', `Took the quest "${q.title}".`);
        }
        break;
      }
      case 'inspiration': {
        const targets = e.who === 'party' ? chars : actor ? [actor] : [];
        for (const c of targets) c.inspiration++;
        g.narrate(`✨ Inspiration for ${targets.map((c) => c.name).join(', ')}! (A free reroll.)`, 'good');
        break;
      }
      case 'sp': {
        const targets = e.who === 'actor' && actor ? [actor] : chars;
        for (const c of targets) c.sp = Math.max(0, Math.min(c.maxSp, c.sp + e.amount));
        break;
      }
      case 'move':
        if (w) w.bonusMoves = (w.bonusMoves ?? 0) + e.amount;
        g.narrate(`🥾 A shortcut! +${e.amount} move next turn.`, 'good');
        break;
      case 'rest':
        for (const c of chars) e.kind === 'long' ? longRest(c) : shortRest(c);
        g.narrate(e.kind === 'long' ? '🛏️ The party enjoys a full night of rest.' : '☕ The party catches its breath (short rest).', 'good');
        break;
      case 'lore':
        if (w) w.lore[e.key] = g.fillTemplate(e.text);
        g.journal('lore', e.text);
        break;
      case 'secret':
        if (actor) {
          (s.secrets[actor.id] ??= []).push({ id: `s${g.rng.int(0, 1e9)}`, text: g.fillTemplate(e.text), kind: 'whisper' });
          g.fxFor(actor.id, { kind: 'haptic', pattern: [40, 40, 40], playerId: actor.id });
        }
        break;
      case 'npc':
        if (w) {
          const npc = w.npcs.find((n) => !n.met && (!e.archetype || n.archetypeId === e.archetype)) ?? w.npcs.find((n) => !n.met);
          if (npc) {
            const { socialScene } = await import('./scenes/social.js');
            combat = (await socialScene(g, npc)) ?? combat;
            if (combat === 'defeat') return combat;
          }
        }
        break;
      case 'shop':
        await shopScene(g, 'Wandering Trader', 6);
        break;
      case 'curse':
        if (actor) {
          const cursedAffix = g.rng.pick(content().affixes.filter((a) => a.cursed && a.slots.includes('trinket')));
          const base = g.rng.pick(content().itemList.filter((b) => b.slot === 'trinket' && b.rarity === 'common'));
          const it = makeItem(base.id, g.rng, { rarity: 'uncommon', affixes: [cursedAffix] });
          if (actor.equipment.trinket && !actor.equipment.trinket.cursed) actor.inventory.push(actor.equipment.trinket);
          actor.equipment.trinket = it;
          g.narrate(`😈 A curse! ${actor.name} finds ${it.name} clamped onto them. It won't come off until cleansed at a shrine.`, 'bad');
        }
        break;
      case 'title':
        if (actor && !actor.titles.includes(e.text)) {
          actor.titles.push(e.text);
          g.narrate(`🏅 ${actor.name} earns the title "${e.text}"!`, 'title');
          g.journal('deed', `${actor.name} became known as "${e.text}".`);
        }
        break;
    }
    g.dirty();
  }
  if (xpGained) await handleLevelUps(g);
  return combat;
}
