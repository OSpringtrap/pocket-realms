/** Synchronous IO + controller used by tests, the simulator and auto-play. */
import type { Rng } from '../rng.js';
import type { Character } from '../types.js';
import { botAction, botBonus } from './ai.js';
import { enemies, partyChars, isActive, type CombatCtx, type CombatEvent, type CombatIO, type RollRequest } from './combat.js';
import type { CombatController, TurnChoice } from './runner.js';

export interface BotIOOptions {
  skill?: [number, number]; // minigame score range
  onEvent?: (e: CombatEvent) => void;
}

export function botIO(rng: Rng, opts: BotIOOptions = {}): CombatIO & { rolls: number } {
  const [lo, hi] = opts.skill ?? [0.25, 0.95];
  const io = {
    rolls: 0,
    async minigame() {
      return lo + rng.next() * (hi - lo);
    },
    async roll(_pid: string, req: RollRequest) {
      io.rolls++;
      return req.faces.map((f) => rng.die(f));
    },
    async rollMany(reqs: { playerId: string; req: RollRequest }[]) {
      const out: Record<string, number[]> = {};
      for (const r of reqs) out[r.playerId] = r.req.faces.map((f) => rng.die(f));
      return out;
    },
    async braceMany(ids: string[]) {
      const out: Record<string, number> = {};
      for (const id of ids) out[id] = lo + rng.next() * (hi - lo);
      return out;
    },
    emit(e: CombatEvent) {
      opts.onEvent?.(e);
    },
    async pause() {},
  };
  return io;
}

export function botController(): CombatController {
  const bonusTaken = new Set<string>();
  return {
    async chooseAction(c: Character, _opts, ctx: CombatCtx): Promise<TurnChoice> {
      const key = `${ctx.combat.round}:${c.id}`;
      if (!bonusTaken.has(key) && !ctx.combat.actorBonusUsed) {
        bonusTaken.add(key);
        const b = botBonus(ctx, c);
        if (b) return b;
      }
      return botAction(ctx, c);
    },
    async chooseSpiritTarget(_c: Character, ctx: CombatCtx) {
      const ally = partyChars(ctx).find((p) => isActive(p));
      return ally?.id ?? enemies(ctx)[0]?.id ?? null;
    },
  };
}
