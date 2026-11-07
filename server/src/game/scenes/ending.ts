import { buildBossEncounter, content, longRest, type EndingStats } from '@pr/shared';
import type { Game } from '../Game.js';
import { partyLevels } from '../effects.js';
import { combatScene, currentBiome } from './combat.js';

export async function finalBattle(g: Game, opts: { empowered?: boolean } = {}) {
  const w = g.state.world!;
  const ant = content().antagonists.find((a) => a.id === w.antagonist.id)!;
  g.fx({ kind: 'banner', text: `${w.antagonist.emoji} ${w.antagonist.name} ${w.antagonist.title}`, style: 'bad' });
  g.narrate(opts.empowered ? ant.doomText[2]! : `You storm ${w.lore.fortress ?? 'the fortress'}. At its heart waits ${w.antagonist.name} ${w.antagonist.title}.`, 'title');
  await g.beat(2500);
  if (w.home && w.home.shrine >= 2) {
    for (const c of g.partyChars()) if (!c.dead && !c.conditions.some((x) => x.id === 'blessed')) c.conditions.push({ id: 'blessed', turns: 4 });
    g.narrate(`The shrine of ${w.home.name} sends its blessing: the party is Blessed!`, 'good');
  }
  const enc = buildBossEncounter(g.rng, {
    bossId: w.antagonist.bossId,
    levels: partyLevels(g),
    difficulty: g.state.settings.difficulty,
    families: ant.minions,
    biome: currentBiome(g),
    empowered: opts.empowered,
    directorMod: w.directorMod,
  });
  enc.monsters[0]!.name = `${w.antagonist.name} ${w.antagonist.title}`;
  for (;;) {
    const res = await combatScene(g, { encounter: enc, bossFight: true, isFinal: true, difficultyLabel: 'boss', title: `${w.antagonist.name} ${w.antagonist.title}` });
    if (res === 'victory') return ending(g, true);
    if (g.state.settings.difficulty === 'story') {
      g.narrate('Fate refuses to let your story end here. You wake at the fortress gates, healed, for one more try.', 'whisper');
      for (const c of g.partyChars()) {
        c.dead = false;
        c.down = false;
        longRest(c);
      }
      const fresh = buildBossEncounter(g.rng, { bossId: w.antagonist.bossId, levels: partyLevels(g), difficulty: 'story', families: ant.minions, biome: currentBiome(g) });
      enc.monsters = fresh.monsters;
      continue;
    }
    return ending(g, false);
  }
}

/** Total party wipe outside the final battle: rescue once on Normal, always on Story. */
export async function handleDefeat(g: Game): Promise<boolean> {
  const w = g.state.world!;
  const diff = g.state.settings.difficulty;
  const rescues = w.doomRescues ?? 0;
  if (diff === 'story' || (diff === 'normal' && rescues < 1)) {
    w.doomRescues = rescues + 1;
    g.state.stats.rescues++;
    const lost = Math.floor(g.state.party.gold / 2);
    g.state.party.gold -= lost;
    w.doom = Math.min(w.doomMax - 1, w.doom + 2);
    const home = w.home;
    if (home) w.party = { q: home.q, r: home.r };
    for (const c of g.partyChars()) {
      c.dead = false;
      c.down = false;
      longRest(c);
    }
    g.fx({ kind: 'banner', text: '🌅 Rescued!', style: 'good' });
    g.narrate(`Everything goes dark... You wake in ${home?.name ?? 'town'}, patched up by kind strangers. You lost ${lost} gold and precious time (+2 Doom).${diff === 'normal' ? " Fate won't be this generous twice." : ''}`, 'whisper');
    g.journal('death', 'The party was defeated, but rescued and carried home.');
    await g.beat(3000);
    return true;
  }
  await ending(g, false);
  return false;
}

export async function ending(g: Game, victory: boolean) {
  const s = g.state;
  const w = s.world!;
  const doomRatio = w.doom / w.doomMax;
  const topFaction = [...w.factions].sort((a, b) => b.rep - a.rep)[0];
  const lowFaction = [...w.factions].sort((a, b) => a.rep - b.rep)[0];
  let title: string;
  let text: string;
  if (victory) {
    if (doomRatio < 0.45) {
      title = 'A Golden Age';
      text = `${w.antagonist.name} falls, and ${w.kingdomName} rejoices. Bells ring for a week. ${w.mascot ? `${w.mascot} is given a tiny medal.` : ''}`;
    } else if (doomRatio < 0.85) {
      title = 'A Hard-Won Peace';
      text = `${w.antagonist.name} is defeated, though the scars on ${w.kingdomName} will take years to heal. The songs about you are only slightly exaggerated.`;
    } else {
      title = 'Victory at the Brink';
      text = `With the Doom Clock about to strike, you bring down ${w.antagonist.name}. ${w.kingdomName} survives — barely — and will never forget how close it came.`;
    }
    if (topFaction && topFaction.rep >= 3) text += ` ${topFaction.emoji} ${topFaction.name} sing your praises and offer you seats of honor.`;
    if (lowFaction && lowFaction.rep <= -3) text += ` ${lowFaction.emoji} ${lowFaction.name}, however, have put prices on your heads.`;
  } else {
    title = 'Darkness Falls';
    text = `The heroes have fallen, and ${w.antagonist.name} ${w.antagonist.title} claims ${w.kingdomName}. Perhaps another band of fools will rise... someday.`;
  }
  if (s.party.motto) text += ` Their motto echoes on: "${s.party.motto}".`;
  const stats: EndingStats = {
    turns: w.turn,
    days: w.day,
    doom: w.doom,
    heroes: g.partyChars().map((c) => ({
      name: c.name,
      title: c.titles[c.titles.length - 1] ?? '',
      kills: c.stats.kills,
      crits: c.stats.crits,
      damage: c.stats.damageDealt,
      healed: c.stats.healed,
      level: c.level,
      dead: c.dead,
    })),
  };
  s.outcome = { victory, title, text };
  s.scene = { kind: 'ending', title, text, victory, stats };
  s.phase = 'ended';
  w.finished = true;
  g.fx({ kind: 'banner', text: victory ? `🏆 ${title}` : `💀 ${title}`, style: victory ? 'good' : 'bad' }, { kind: 'sound', name: victory ? 'fanfare' : 'defeat' });
  g.narrate(text, victory ? 'good' : 'bad');
  g.journal('world', `${title}. ${text}`);
  g.dirty();
  g.save();
}
