import type { Character } from '../types.js';
import {
  actionOptions,
  advanceTurn,
  checkOver,
  currentId,
  deathSave,
  endTurn,
  getUnit,
  isActive,
  isChar,
  legendaryActions,
  monsterTurn,
  performAction,
  spiritNudge,
  startTurn,
  type ActionOption,
  type CombatAction,
  type CombatCtx,
  type CombatIO,
} from './combat.js';

export type TurnChoice = CombatAction | { type: 'endTurn' };

export interface CombatController {
  /** Ask a player for their next action. `bonusOnly` after the main action is spent but a bonus remains. */
  chooseAction(c: Character, options: ActionOption[], ctx: CombatCtx, error?: string): Promise<TurnChoice>;
  /** A fallen hero's spirit picks someone to nudge; null to skip. */
  chooseSpiritTarget?(c: Character, ctx: CombatCtx): Promise<string | null>;
  onTurnStart?(id: string, ctx: CombatCtx): Promise<void> | void;
  onTurnEnd?(id: string, ctx: CombatCtx): Promise<void> | void;
}

export const MAX_ROUNDS = 25;

export async function runCombat(ctx: CombatCtx, io: CombatIO, ctl: CombatController): Promise<'victory' | 'defeat' | 'fled'> {
  let guard = 0;
  while (!checkOver(ctx)) {
    if (++guard > 2000) break;
    const id = currentId(ctx);
    if (!id) break;
    const u = getUnit(ctx, id);
    if (!u) {
      advanceTurn(ctx);
      continue;
    }
    await ctl.onTurnStart?.(id, ctx);
    const canAct = await startTurn(ctx, io, id);
    if (checkOver(ctx)) break;
    if (isChar(u)) {
      if (u.dead) {
        if (ctl.chooseSpiritTarget) {
          const t = await ctl.chooseSpiritTarget(u, ctx);
          if (t) spiritNudge(ctx, io, u, t);
        }
      } else if (u.down) {
        await deathSave(ctx, io, u);
      } else if (canAct) {
        await playerTurn(ctx, io, ctl, u);
      }
      if (!checkOver(ctx) && isChar(u)) await legendaryActions(ctx, io);
    } else if (canAct) {
      await monsterTurn(ctx, io, u);
    }
    endTurn(ctx, id);
    await ctl.onTurnEnd?.(id, ctx);
    if (checkOver(ctx)) break;
    advanceTurn(ctx);
    if (ctx.combat.round > MAX_ROUNDS) {
      // Safety valve: exhausted enemies give up rather than an endless slog.
      for (const m of ctx.combat.monsters) if (m.side === 'enemy' && isActive(m)) m.fled = true;
      ctx.combat.over = 'victory';
      io.emit({ k: 'log', text: 'Exhausted, the remaining enemies flee into the wilds!', tone: 'info' });
    }
  }
  return ctx.combat.over ?? 'victory';
}

async function playerTurn(ctx: CombatCtx, io: CombatIO, ctl: CombatController, c: Character) {
  let actions = 1;
  let errors = 0;
  let lastError: string | undefined;
  while (actions > 0 && !checkOver(ctx) && isActive(c)) {
    const opts = actionOptions(ctx, c, false);
    const choice = await ctl.chooseAction(c, opts, ctx, lastError);
    lastError = undefined;
    if (choice.type === 'endTurn') break;
    const res = await performAction(ctx, io, c.id, choice);
    if (!res.ok) {
      lastError = res.error;
      if (++errors >= 3) {
        await performAction(ctx, io, c.id, { type: 'defend' });
        break;
      }
      continue;
    }
    if (res.fled) break;
    if (res.extraAction) actions++;
    if (res.bonus) continue;
    actions--;
  }
}
