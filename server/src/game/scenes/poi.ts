import { buildEncounter, content, rollLoot, type HexTile } from '@pr/shared';
import type { Game } from '../Game.js';
import { applyEffects, avgLevel, hiddenLoot, partyLevels } from '../effects.js';
import { combatScene, type CombatOutcome } from './combat.js';
import { dungeonScene } from './dungeon.js';
import { finalBattle } from './ending.js';
import { eventScene, heroCheck, pickEventCard, scaledDc } from './event.js';
import { campScene } from './jackbox.js';
import { shopScene, shrineVisit, townScene } from './town.js';

/** Resolve arriving at a point of interest. Returns 'defeat' on a total party wipe. */
export async function poiScene(g: Game, tile: HexTile): Promise<CombatOutcome | 'ended' | undefined> {
  const poi = tile.poi!;
  const w = g.state.world!;
  switch (poi.kind) {
    case 'town':
      await townScene(g, poi);
      return;
    case 'merchant':
      g.narrate(`🛒 ${poi.name}: "Come, come! Bargains for brave souls!"`, 'title');
      await shopScene(g, poi.name, 7);
      return;
    case 'camp': {
      const r = await campScene(g, { canLongRest: true });
      if (r === 'ambush') {
        const enc = buildEncounter(g.rng, { levels: partyLevels(g), difficulty: g.state.settings.difficulty, encounter: 'medium', biome: tile.biome, time: 'night', directorMod: w.directorMod });
        return combatScene(g, { encounter: enc, ambush: true, difficultyLabel: 'medium' });
      }
      return;
    }
    case 'shrine': {
      g.state.scene = { kind: 'camp', text: `${poi.name}. Candles burn that nobody lit.` };
      g.narrate(`⛩️ ${poi.name}. Candles burn that nobody lit.`, 'title');
      g.dirty();
      if (!poi.cleared) {
        const chars = g.partyChars().filter((c) => !c.dead);
        const priest = [...chars].sort((a, b) => Number(['cleric', 'paladin'].includes(b.cls)) - Number(['cleric', 'paladin'].includes(a.cls)))[0]!;
        const res = await heroCheck(g, priest, { skill: 'religion', label: 'Pray at the shrine', minigame: 'hum' }, scaledDc(g, 11));
        if (res.degree === 'crit' || res.degree === 'success') {
          await applyEffects(g, [{ type: 'heal', dice: `${2 + avgLevel(g)}d6`, who: 'party' }, { type: 'sp', amount: 3, who: 'party' }, { type: 'condition', id: 'blessed', turns: 4, who: 'party' }, { type: 'doom', amount: res.degree === 'crit' ? -2 : -1 }], priest.id);
        } else await applyEffects(g, [{ type: 'heal', dice: '2d6', who: 'party' }], priest.id);
        poi.cleared = true;
      }
      const ids = g.partyIds().filter((id) => !g.players.get(id)?.isBot && !g.state.chars[id]!.dead);
      await Promise.all(ids.map((id) => shrineVisit(g, id, { free: true })));
      return;
    }
    case 'cache': {
      const chars = g.partyChars().filter((c) => !c.dead);
      const seeker = [...chars].sort((a, b) => Number(b.skills.includes('perception')) - Number(a.skills.includes('perception')))[0]!;
      g.narrate('💎 Something glints... a hidden cache! Search carefully.', 'title');
      const res = await heroCheck(g, seeker, { skill: 'perception', label: 'Search the cache', minigame: 'scan' }, scaledDc(g, 12));
      const boost = res.degree === 'crit' ? 40 : res.degree === 'success' ? 25 : 10;
      const it = rollLoot(g.rng, { level: avgLevel(g), boost });
      g.state.party.stash.push(it);
      const gold = g.rng.int(15, 35) * avgLevel(g);
      g.state.party.gold += gold;
      g.narrate(`Inside: ${gold} gold and ${it.emoji} ${it.name} (${it.rarity})!`, 'good');
      g.fx({ kind: 'sound', name: 'loot' });
      poi.cleared = true;
      if (res.degree === 'crit' || res.degree === 'success' || g.rng.chance(0.3)) await hiddenLoot(g, seeker.id);
      return;
    }
    case 'lair': {
      g.narrate(`🐉 ${poi.name}. Bones crunch underfoot. Something big lives here.`, 'title');
      await g.beat(1200);
      const enc = buildEncounter(g.rng, { levels: partyLevels(g), difficulty: g.state.settings.difficulty, encounter: 'hard', biome: tile.biome, directorMod: w.directorMod, minTier: Math.min(4, Math.ceil(avgLevel(g) / 2)) });
      const res = await combatScene(g, { encounter: enc, difficultyLabel: 'hard', rewardMult: 1.4 });
      if (res === 'victory') {
        poi.cleared = true;
        await applyEffects(g, [{ type: 'item', rarity: avgLevel(g) >= 4 ? 'epic' : 'rare' }], undefined);
      }
      return res;
    }
    case 'ruin': {
      const card = pickEventCard(g, (c) => c.tags.includes('puzzle') || c.biomes.includes('ruins'));
      poi.cleared = true;
      return eventScene(g, card);
    }
    case 'dungeon': {
      const res = await dungeonScene(g, poi);
      return res === 'defeat' ? 'defeat' : undefined;
    }
    case 'fortress': {
      if (w.objective.keys >= w.objective.keysNeeded) {
        await finalBattle(g);
        return 'ended';
      }
      g.narrate(`🏰 ${poi.name} is sealed by ${w.objective.keysNeeded - w.objective.keys} glowing ward${w.objective.keysNeeded - w.objective.keys > 1 ? 's' : ''}. You'll need ${w.objective.keysNeeded - w.objective.keys} more ${w.objective.keyName} — try the dungeons (🕳️).`, 'bad');
      const ant = content().antagonists.find((a) => a.id === w.antagonist.id);
      if (ant) g.narrate(`From within, ${w.antagonist.name} laughs. ${w.antagonist.desc}`, 'whisper');
      return;
    }
    default:
      return;
  }
}
