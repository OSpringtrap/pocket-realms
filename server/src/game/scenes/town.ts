import {
  Rng,
  buyPrice,
  itemStatLine,
  longRest,
  makeItem,
  removeCurses,
  rollLoot,
  sellValue,
  type ChoiceOption,
  type ItemInstance,
  type Poi,
} from '@pr/shared';
import type { Game } from '../Game.js';
import { avgLevel } from '../effects.js';
import { makeQuest } from '../quests.js';
import { jackboxRound } from './jackbox.js';
import { partyVote } from './event.js';

function repDiscount(g: Game): number {
  const w = g.state.world;
  const gilded = w?.factions.find((f) => f.id === 'gilded')?.rep ?? 0;
  const home = w?.home?.shop ?? 1;
  return Math.max(-0.2, Math.min(0.35, gilded * 0.03 + (home - 1) * 0.07));
}

export function shopStock(g: Game, key: string, size: number): ItemInstance[] {
  const w = g.state.world;
  const rng = Rng.derive(g.state.seed, `shop:${key}:${w?.day ?? 1}`);
  const lvl = avgLevel(g);
  const out: ItemInstance[] = [makeItem('potion_healing', rng), makeItem(lvl >= 4 ? 'potion_greater' : 'potion_healing', rng), makeItem('ether_vial', rng), makeItem('antidote', rng)];
  for (let i = 0; i < size; i++) out.push(rollLoot(rng, { level: lvl, boost: 10, allowCursed: false, slot: i % 3 === 0 ? 'consumable' : undefined }));
  return out;
}

/** Each player browses on their own phone, concurrently. Party gold is shared. */
export async function shopScene(g: Game, name: string, size = 8, existingStock?: ItemInstance[]) {
  const stock = existingStock ?? shopStock(g, name, size);
  const prevScene = g.state.scene;
  const disc = repDiscount(g);
  g.state.scene = { kind: 'town', name, text: `${name} — browse on your phones.`, shop: { items: stock.map((it) => ({ uid: it.uid, item: it, price: buyPrice(it, disc) })), sellRate: 0.5 } };
  g.dirty();
  const ids = g.partyIds().filter((id) => !g.state.chars[id]!.dead && !g.players.get(id)?.isBot);
  await Promise.all(ids.map((id) => personalShop(g, id, stock, disc)));
  g.state.scene = prevScene;
  g.dirty();
}

async function personalShop(g: Game, pid: string, stock: ItemInstance[], disc: number) {
  const c = g.state.chars[pid]!;
  for (let guard = 0; guard < 40; guard++) {
    const opts: ChoiceOption[] = stock.map((it) => {
      const price = buyPrice(it, disc);
      return { id: `buy:${it.uid}`, label: `${it.name}`, emoji: it.emoji, desc: `${itemStatLine(it) || it.desc}`, cost: `${price}g`, group: 'Buy', disabled: price > g.state.party.gold ? 'Not enough gold' : undefined, tag: it.rarity };
    });
    const sellable = c.inventory.filter((it) => it.slot !== 'quest');
    for (const it of sellable) opts.push({ id: `sell:${it.uid}`, label: `Sell ${it.name}`, emoji: '💰', desc: it.desc, cost: `+${sellValue(it)}g`, group: 'Sell' });
    opts.push({ id: 'done', label: 'Done shopping', emoji: '✅', group: 'Buy' });
    const pick = await g.choose(pid, `🛒 Shop — party gold: ${g.state.party.gold}`, opts, { style: 'list', timeoutMs: 120000, fallback: 'done' });
    if (pick === 'done') return;
    if (pick.startsWith('buy:')) {
      const idx = stock.findIndex((x) => `buy:${x.uid}` === pick);
      const it = stock[idx];
      if (!it) continue;
      const price = buyPrice(it, disc);
      if (price > g.state.party.gold) continue;
      g.state.party.gold -= price;
      stock.splice(idx, 1);
      c.inventory.push(it);
      g.narrate(`${c.name} buys ${it.emoji} ${it.name} for ${price} gold.`);
      g.fx({ kind: 'sound', name: 'coin' });
    } else if (pick.startsWith('sell:')) {
      const idx = c.inventory.findIndex((x) => `sell:${x.uid}` === pick);
      const it = c.inventory[idx];
      if (!it) continue;
      c.inventory.splice(idx, 1);
      g.state.party.gold += sellValue(it);
      stock.push(it);
      g.narrate(`${c.name} sells ${it.name} for ${sellValue(it)} gold.`);
      g.fx({ kind: 'sound', name: 'coin' });
    }
    const scene = g.state.scene;
    if (scene.kind === 'town' && scene.shop) scene.shop.items = stock.map((it) => ({ uid: it.uid, item: it, price: buyPrice(it, disc) }));
    g.dirty();
  }
}

export async function shrineVisit(g: Game, pid: string, opts: { free?: boolean } = {}) {
  const c = g.state.chars[pid]!;
  const dead = g.partyChars().filter((x) => x.dead);
  const cursed = [c.equipment.weapon, c.equipment.armor, c.equipment.trinket, ...c.inventory].filter((x) => x?.cursed).length;
  const lvl = avgLevel(g);
  const options: ChoiceOption[] = [
    ...dead.map((d) => ({ id: `rez:${d.id}`, label: `Resurrect ${d.name}`, emoji: '🕊️', cost: opts.free ? 'free' : `${40 * lvl}g`, disabled: !opts.free && g.state.party.gold < 40 * lvl ? 'Not enough gold' : undefined })),
    { id: 'cleanse', label: 'Cleanse curses', emoji: '🧼', cost: opts.free ? 'free' : '25g', disabled: cursed === 0 ? 'Nothing cursed' : !opts.free && g.state.party.gold < 25 ? 'Not enough gold' : undefined },
    { id: 'bless', label: 'Receive a blessing', emoji: '🙏', desc: 'Blessed for your next fight.', cost: opts.free ? 'free' : '10g', disabled: !opts.free && g.state.party.gold < 10 ? 'Not enough gold' : undefined },
    { id: 'leave', label: 'Leave the shrine', emoji: '🚶' },
  ];
  const pick = await g.choose(pid, '⛩️ The shrine is quiet and warm.', options, { timeoutMs: 60000, fallback: 'leave' });
  if (pick.startsWith('rez:')) {
    const d = g.state.chars[pick.slice(4)];
    if (d?.dead) {
      if (!opts.free) g.state.party.gold -= 40 * lvl;
      d.dead = false;
      d.down = false;
      d.hp = d.maxHp;
      g.narrate(`🕊️ ${d.name} is restored to life at the shrine!`, 'good');
      g.journal('death', `${d.name} was resurrected.`);
    }
  } else if (pick === 'cleanse') {
    if (!opts.free) g.state.party.gold -= 25;
    const n = removeCurses(c);
    g.narrate(`🧼 ${n} curse${n === 1 ? '' : 's'} lifted from ${c.name}.`, 'good');
  } else if (pick === 'bless') {
    if (!opts.free) g.state.party.gold -= 10;
    if (!c.conditions.some((x) => x.id === 'blessed')) c.conditions.push({ id: 'blessed', turns: 4 });
    g.narrate(`🙏 ${c.name} is blessed.`, 'good');
  }
  g.dirty();
}

export async function townScene(g: Game, poi: Poi) {
  const w = g.state.world!;
  const isHome = !!poi.data?.home;
  const firstVisit = !poi.data?.visited;
  poi.data = { ...(poi.data ?? {}), visited: true };
  const text = isHome ? `Home sweet home: ${poi.name}, the heart of ${w.kingdomName}.` : `The town of ${poi.name}. Smoke rises from chimneys and someone is selling suspicious pies.`;
  g.state.scene = { kind: 'town', name: poi.name, text };
  g.fx({ kind: 'sound', name: 'town' });
  g.narrate(`🏘️ ${text}`, 'title');
  g.dirty();
  await g.beat(1200);

  if (firstVisit && !isHome && g.partyIds().length >= 2) {
    await jackboxRound(g, 'tavern');
    await jackboxRound(g, 'rumor');
  }
  if (firstVisit && w.npcs.some((n) => !n.met) && g.rng.chance(isHome ? 0.4 : 0.7)) {
    const { socialScene } = await import('./social.js');
    const res = await socialScene(g);
    if (res === 'defeat') return;
    g.state.scene = { kind: 'town', name: poi.name, text };
  }

  const stock = shopStock(g, poi.id, 6 + (isHome ? (w.home?.shop ?? 1) * 2 : 0));
  const board: ReturnType<typeof makeQuest>[] = [makeQuest(g), makeQuest(g)].filter(Boolean);
  const ids = g.partyIds().filter((id) => !g.state.chars[id]!.dead && !g.players.get(id)?.isBot);
  const disc = repDiscount(g);
  g.state.scene = { kind: 'town', name: poi.name, text, shop: { items: stock.map((it) => ({ uid: it.uid, item: it, price: buyPrice(it, disc) })), sellRate: 0.5 } };
  g.dirty();
  await Promise.all(
    ids.map(async (pid) => {
      for (let guard = 0; guard < 20; guard++) {
        const opts: ChoiceOption[] = [
          { id: 'shop', label: 'Visit the shop', emoji: '🛒', desc: `Party gold: ${g.state.party.gold}` },
          { id: 'shrine', label: 'Visit the shrine', emoji: '⛩️', desc: 'Resurrect the fallen, cleanse curses, get blessed.' },
          { id: 'quests', label: 'Quest board', emoji: '📜', desc: board.length ? `${board.length} posting(s)` : 'Empty', disabled: board.length ? undefined : 'No quests left' },
        ];
        if (isHome && g.state.settings.length === 'campaign') opts.push({ id: 'upgrade', label: 'Improve the town', emoji: '🏗️', desc: 'Spend gold to upgrade the inn, shop or shrine.' });
        opts.push({ id: 'done', label: 'Ready to move on', emoji: '✅' });
        const pick = await g.choose(pid, `🏘️ ${poi.name}`, opts, { timeoutMs: 150000, fallback: 'done' });
        if (pick === 'done') return;
        if (pick === 'shop') await personalShop(g, pid, stock, disc);
        if (pick === 'shrine') await shrineVisit(g, pid);
        if (pick === 'quests' && board.length) {
          const q = await g.choose(
            pid,
            '📜 Quest board',
            [...board.map((b, i) => ({ id: String(i), label: b!.title, emoji: '📜', desc: `${b!.desc} Reward: ${b!.reward.gold}g, ${b!.reward.xp} XP${b!.reward.key ? `, and a lead on a ${w.objective.keyName}! 🔑` : '.'}` })), { id: 'back', label: 'Back', emoji: '↩️' }],
            { timeoutMs: 60000, fallback: 'back' },
          );
          if (q !== 'back') {
            const [taken] = board.splice(Number(q), 1);
            if (taken) {
              w.quests.push(taken);
              g.narrate(`📜 ${g.players.get(pid)?.name} takes the quest "${taken.title}". The target is marked on the map.`, 'good');
              g.journal('quest', `Took the quest "${taken.title}".`);
            }
          }
        }
        if (pick === 'upgrade') await upgradeHome(g, pid);
        g.dirty();
      }
    }),
  );
  // Rest at the inn?
  const innCost = Math.max(4, 8 - (w.home && isHome ? w.home.inn * 2 : 0)) * g.partyIds().length;
  const hurt = g.partyChars().some((c) => c.hp < c.maxHp * 0.8 || c.sp < c.maxSp * 0.6);
  if (g.state.party.gold >= innCost && hurt) {
    const pick = await partyVote(g, `🛏️ Rest at the inn tonight? (${innCost}g, full rest)`, [
      { id: 'yes', label: 'Rest (long rest)', emoji: '🛏️', cost: `${innCost}g` },
      { id: 'no', label: 'Keep moving', emoji: '🥾' },
    ]);
    if (pick === 0) {
      g.state.party.gold -= innCost;
      await innRest(g);
    }
  } else if (isHome && hurt) {
    g.narrate('Your friends at home put you up for the night, free of charge.', 'good');
    await innRest(g);
  }
}

export async function innRest(g: Game) {
  const w = g.state.world!;
  for (const c of g.partyChars()) longRest(c);
  w.hardSinceRest = false;
  w.combatStreak = 0;
  w.time = 'night';
  g.fx({ kind: 'sound', name: 'rest' });
  g.narrate('🛏️ A warm bed, a hot meal. Everyone wakes fully rested.', 'good');
  g.dirty();
  await g.beat(1500);
}

async function upgradeHome(g: Game, pid: string) {
  const w = g.state.world!;
  const home = w.home!;
  const cost = (lvl: number) => 60 * lvl;
  const opts: ChoiceOption[] = (['inn', 'shop', 'shrine'] as const).map((k) => ({
    id: k,
    label: `${k === 'inn' ? 'Inn' : k === 'shop' ? 'Shop' : 'Shrine'} (level ${home[k]} → ${home[k] + 1})`,
    emoji: k === 'inn' ? '🍺' : k === 'shop' ? '🛒' : '⛩️',
    desc: k === 'inn' ? 'Cheaper rest; party heals between turns at home.' : k === 'shop' ? 'More stock and better prices.' : 'Blessings before final battles; free resurrections at home.',
    cost: `${cost(home[k])}g`,
    disabled: home[k] >= 3 ? 'Max level' : g.state.party.gold < cost(home[k]) ? 'Not enough gold' : undefined,
  }));
  opts.push({ id: 'back', label: 'Back', emoji: '↩️' });
  const pick = await g.choose(pid, `🏗️ Improve ${home.name}`, opts, { timeoutMs: 60000, fallback: 'back' });
  if (pick === 'inn' || pick === 'shop' || pick === 'shrine') {
    const c = cost(home[pick]);
    if (g.state.party.gold >= c && home[pick] < 3) {
      g.state.party.gold -= c;
      home[pick]++;
      g.narrate(`🏗️ ${home.name}'s ${pick} is upgraded to level ${home[pick]}!`, 'good');
      g.journal('world', `The ${pick} of ${home.name} was improved (level ${home[pick]}).`);
    }
  }
}
