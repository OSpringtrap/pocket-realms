import { addXp, type CharacterStats } from '@pr/shared';
import type { Game } from './Game.js';

interface GoalDef {
  id: string;
  name: string;
  stat: keyof CharacterStats;
  range: [number, number];
  text: (n: number) => string;
  classes?: string[];
}

const GOALS: GoalDef[] = [
  { id: 'slayer', name: 'Monster Slayer', stat: 'kills', range: [4, 7], text: (n) => `Personally defeat ${n} enemies.` },
  { id: 'lucky', name: 'Fortune\'s Favorite', stat: 'crits', range: [2, 3], text: (n) => `Land ${n} critical hits.` },
  { id: 'medic', name: 'Secret Healer', stat: 'healed', range: [25, 50], text: (n) => `Heal your friends for ${n} HP in total.`, classes: ['cleric', 'paladin', 'bard'] },
  { id: 'ace', name: 'Show-Off', stat: 'minigamesAced', range: [3, 5], text: (n) => `Ace ${n} challenges (80%+ on a minigame).` },
  { id: 'bruiser', name: 'Wrecking Ball', stat: 'damageDealt', range: [70, 140], text: (n) => `Deal ${n} damage in total.`, classes: ['barbarian', 'warrior', 'rogue', 'paladin', 'wizard'] },
];

export interface Goal {
  id: string;
  name: string;
  stat: keyof CharacterStats;
  target: number;
  base: number;
  done: boolean;
}

/** Every human hero gets a private objective, visible only on their phone. */
export function assignGoals(g: Game) {
  const s = g.state as typeof g.state & { goals?: Record<string, Goal> };
  s.goals ??= {};
  const scale = s.settings.length === 'campaign' ? 2.2 : 1;
  for (const id of g.partyIds()) {
    if (s.goals[id] || g.players.get(id)?.isBot) continue;
    const c = s.chars[id]!;
    const fits = GOALS.filter((x) => !x.classes || x.classes.includes(c.cls));
    const def = g.rng.pick(fits);
    const target = Math.round(g.rng.int(def.range[0], def.range[1]) * scale);
    s.goals[id] = { id: def.id, name: def.name, stat: def.stat, target, base: c.stats[def.stat], done: false };
    (s.secrets[id] ??= []).push({ id: `goal_${id}`, text: `🎯 Secret goal — ${def.name}: ${def.text(target)} Keep it to yourself!`, kind: 'quest' });
  }
  g.dirty();
}

export function checkGoals(g: Game) {
  const s = g.state as typeof g.state & { goals?: Record<string, Goal> };
  for (const [id, goal] of Object.entries(s.goals ?? {})) {
    const c = s.chars[id];
    if (!c || goal.done) continue;
    const progress = c.stats[goal.stat] - goal.base;
    if (progress >= goal.target) {
      goal.done = true;
      c.inspiration++;
      addXp(c, s.settings.length === 'oneshot' ? 80 : 60);
      if (!c.titles.includes(goal.name)) c.titles.push(goal.name);
      g.fx({ kind: 'banner', text: `🎯 ${c.name} completed a secret goal!`, style: 'good' });
      g.narrate(`🎯 ${c.name} reveals a secret goal — "${goal.name}" — and completes it! (+Inspiration, +XP)`, 'good');
      g.journal('deed', `${c.name} completed the secret goal "${goal.name}".`);
      (s.secrets[id] ??= []).push({ id: `goal_done_${id}`, text: `✅ You completed your secret goal: ${goal.name}!`, kind: 'quest' });
    }
  }
}
