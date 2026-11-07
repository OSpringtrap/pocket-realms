import { averageDice, content, equipItem, getAc, parseDice, weaponProfile, type Character, type ItemInstance } from '@pr/shared';
import type { Game } from './Game.js';
import { playerIntent } from './director.js';

function weaponScore(c: Character, it: ItemInstance | undefined): number {
  if (!it?.damage) return 0;
  const d = averageDice(parseDice(it.damage)) + (it.damageBonus ?? 0) + (it.attackBonus ?? 0) * 0.8 + (it.extraDamage ? averageDice(parseDice(it.extraDamage.dice)) : 0);
  const caster = !!content().classes[c.cls].castAbility && c.cls !== 'paladin';
  return d + (it.spBonus ?? 0) * (caster ? 2 : 0) + (it.ranged && !it.finesse && c.cls !== 'rogue' ? -2 : 0);
}

/**
 * What bot players do between scenes (humans do this on their phones): grab
 * useful loot from the stash, equip upgrades, and patch themselves up.
 */
export function botUpkeep(g: Game) {
  const bots = g.partyIds().filter((id) => g.players.get(id)?.isBot);
  for (const id of bots) {
    const c = g.state.chars[id];
    if (!c || c.dead) continue;
    // take a fair share of the stash
    for (const it of [...g.state.party.stash]) {
      const better =
        (it.slot === 'weapon' && weaponScore(c, it) > weaponScore(c, c.equipment.weapon) + 0.5) ||
        (it.slot === 'armor' && (c.equipment.armor ? (it.acBase ?? 0) + (it.acBonus ?? 0) > (c.equipment.armor.acBase ?? 0) + (c.equipment.armor.acBonus ?? 0) : !c.known.includes('unarmored_defense') && (it.acBase ?? 0) > 11)) ||
        (it.slot === 'trinket' && !c.equipment.trinket && !it.cursed) ||
        (it.slot === 'consumable' && c.inventory.filter((x) => x.slot === 'consumable').length < 4);
      if (!better || it.cursed) continue;
      const before = getAc(c);
      playerIntent(g, id, { kind: 'fromStash', uid: it.uid });
      if (it.slot !== 'consumable') {
        const err = equipItem(c, it.uid);
        if (!err && it.slot === 'armor' && getAc(c) < before && c.equipment.armor?.uid === it.uid) {
          // turned out worse (e.g. heavy armor on a dex build): swap back
          const old = c.inventory.find((x) => x.slot === 'armor');
          if (old) equipItem(c, old.uid);
        }
      }
    }
    void weaponProfile;
    // heal up with spells/potions when hurt
    for (let i = 0; i < 3 && c.hp < c.maxHp * 0.6; i++) {
      const heal = c.known.map((a) => content().abilities[a]!).find((a) => a.outOfCombat && a.effects.some((e) => e.type === 'heal') && (!a.cost.sp || c.sp >= a.cost.sp + 1) && (!a.cost.resource || (c.resources[a.cost.resource]?.cur ?? 0) > 0));
      if (heal) {
        playerIntent(g, id, { kind: 'useAbility', id: heal.id, target: c.id });
        continue;
      }
      const pot = c.inventory.find((x) => x.use?.heal && x.use.target !== 'enemy' && !x.use.revive);
      if (pot) playerIntent(g, id, { kind: 'use', uid: pot.uid });
      else break;
    }
    // healers top up friends
    for (const friend of g.partyChars()) {
      if (friend.id === c.id || friend.dead || friend.hp >= friend.maxHp * 0.5) continue;
      const heal = c.known.map((a) => content().abilities[a]!).find((a) => a.outOfCombat && a.effects.some((e) => e.type === 'heal') && (!a.cost.sp || c.sp >= a.cost.sp + 2));
      if (heal) playerIntent(g, id, { kind: 'useAbility', id: heal.id, target: friend.id });
    }
  }
}
