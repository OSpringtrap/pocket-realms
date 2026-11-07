/** d20 resolution: advantage/disadvantage, crits and fumbles. */
export type AdvState = -1 | 0 | 1;

export function combineAdv(adv: number, dis: number): AdvState {
  if (adv > 0 && dis > 0) return 0;
  if (adv > 0) return 1;
  if (dis > 0) return -1;
  return 0;
}

export function d20Count(adv: AdvState): number {
  return adv === 0 ? 1 : 2;
}

export interface D20Result {
  rolls: number[];
  kept: number;
  modifier: number;
  total: number;
  crit: boolean;
  fumble: boolean;
  adv: AdvState;
}

export function resolveD20(rolls: number[], adv: AdvState, modifier: number, critRange = 20): D20Result {
  const valid = rolls.filter((r) => Number.isInteger(r) && r >= 1 && r <= 20);
  const r = valid.length ? valid : [10];
  let kept = r[0]!;
  if (r.length > 1) kept = adv === 1 ? Math.max(...r) : adv === -1 ? Math.min(...r) : r[0]!;
  return {
    rolls: r,
    kept,
    modifier,
    total: kept + modifier,
    crit: kept >= critRange,
    fumble: kept === 1,
    adv,
  };
}

export type Degree = 'crit' | 'success' | 'partial' | 'fail' | 'fumble';

/** Outcome tier for skill checks: nat 20 crit, nat 1 fumble, within 3 below DC is a partial success. */
export function checkDegree(res: D20Result, dc: number): Degree {
  if (res.crit && res.kept === 20) return 'crit';
  if (res.fumble) return 'fumble';
  if (res.total >= dc) return res.total >= dc + 10 ? 'crit' : 'success';
  if (res.total >= dc - 3) return 'partial';
  return 'fail';
}

/** Minigame score (0..1) -> tier. */
export type MiniTier = 'none' | 'good' | 'great';
export function miniTier(score: number | undefined): MiniTier {
  if (score === undefined || Number.isNaN(score)) return 'none';
  if (score >= 0.8) return 'great';
  if (score >= 0.45) return 'good';
  return 'none';
}
