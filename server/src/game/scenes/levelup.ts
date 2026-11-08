import { applyLevelUp, content, levelUpOptions, sanitizeText, type LevelChoice } from '@pr/shared';
import type { Game } from '../Game.js';

/** Every hero with pending levels picks one of three upgrades on their phone (in parallel). */
export async function handleLevelUps(g: Game) {
  const ready = g.partyChars().filter((c) => c.pendingLevelUps > 0 && !c.dead);
  if (!ready.length) return;
  const prev = g.state.scene;
  g.state.scene = { kind: 'levelup', names: ready.map((c) => c.name) };
  g.fx({ kind: 'banner', text: `⭐ Level up! ${ready.map((c) => c.name).join(', ')}`, style: 'good' }, { kind: 'sound', name: 'levelup' });
  g.dirty();
  await Promise.all(
    ready.map(async (c) => {
      while (c.pendingLevelUps > 0) {
        const opts: LevelChoice[] = levelUpOptions(c, g.rng);
        const id = await g.choose(
          c.id,
          `⭐ ${c.name} reaches level ${c.level + 1}! Choose one:`,
          opts.map((o, i) => ({ id: String(i), label: o.label, emoji: o.emoji, desc: o.desc, tag: o.kind === 'ability' ? 'New' : o.kind === 'asi' ? 'Stat' : 'Perk' })),
          { style: 'cards', timeoutMs: 120000, fallback: '0', bot: () => '0' },
        );
        const choice = opts[Number(id)] ?? opts[0]!;
        const text = applyLevelUp(c, choice);
        g.narrate(text, 'good');
        g.journal('level', text);
        // Every odd level from 3 on, another hero writes this hero an epithet
        if (c.level % 2 === 1 && c.level >= 3) await epithet(g, c.id);
      }
    }),
  );
  g.state.scene = prev;
  g.dirty();
}

async function epithet(g: Game, heroId: string) {
  const hero = g.state.chars[heroId];
  if (!hero) return;
  const others = g.partyIds().filter((id) => id !== heroId && !g.players.get(id)?.isBot);
  const writer = others.length ? g.rng.pick(others) : heroId;
  const sample = g.rng.pick(content().names.epithets);
  const text = await g.ask<string>(
    writer,
    { kind: 'text', title: `Give ${hero.name} an epithet!`, text: `Based on their deeds so far. e.g. "${sample}"`, maxLen: 32, placeholder: 'the Unflinching', suggestions: [sample, g.rng.pick(content().names.epithets)] },
    { timeoutMs: 45000, fallback: () => sample, bot: () => sample, validate: (v) => sanitizeText(v, 32) || undefined },
  );
  const t = text.startsWith('the ') || text.startsWith('of ') ? text : text;
  if (!hero.titles.includes(t)) hero.titles.push(t);
  g.narrate(`From now on, the bards call them ${hero.name} ${t}!`, 'title');
  g.journal('deed', `${hero.name} earned the epithet "${t}".`, g.displayName(writer));
}
