/**
 * Balance simulator: auto-plays full runs with 1–6 bot parties through the real
 * server game logic (instant clock, bot answers) and reports win rates, run length
 * and combat length. `--ci` fails (exit 1) if balance drifts out of range.
 *
 *   npm run sim                 # default: oneshot, normal, 1-6 players
 *   npm run sim -- --runs 30 --length campaign --difficulty heroic
 */
import { instantClock } from '../server/src/clock.js';
import { Game } from '../server/src/game/Game.js';
import { hostCommand, installHandlers, startNewCampaign } from '../server/src/game/director.js';
import type { Difficulty, RunLength } from '../shared/src/index.js';

interface RunResult {
  victory: boolean;
  turns: number;
  combats: number;
  victories: number;
  rescues: number;
  level: number;
  minutes: number;
  doom: number;
  doomMax: number;
  rounds: number[];
  error?: string;
}

const argv = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : def;
};
const CI = argv.includes('--ci');
const RUNS = Number(arg('runs', CI ? '12' : '20'));
const LENGTH = arg('length', 'oneshot') as RunLength;
const DIFF = arg('difficulty', 'normal') as Difficulty;
const SIZES = arg('sizes', '1,2,3,4,5,6').split(',').map(Number);

// Rough human time per prompt (seconds) to estimate real session length
const HUMAN_SECONDS: Record<string, number> = { choice: 9, roll: 4, text: 35, draw: 45, notice: 20, minigame: 8 };

export async function simulateRun(seed: string, players: number, difficulty: Difficulty, length: RunLength): Promise<RunResult> {
  const clock = instantClock();
  const start = clock.now();
  const g = new Game({ clock, code: 'SIMU', lanUrl: '', instantBots: true });
  installHandlers(g);
  const rounds: number[] = [];
  let combatRoundsWatcher = 0;
  g.onChange = () => {
    const sc = g.state.scene;
    if (sc.kind === 'combat') combatRoundsWatcher = (sc.combat as { round: number }).round;
    else if (combatRoundsWatcher) {
      rounds.push(combatRoundsWatcher);
      combatRoundsWatcher = 0;
    }
  };
  startNewCampaign(g, { difficulty, length, adaptive: true, turnTimer: 60 }, seed);
  for (let i = 0; i < players; i++) {
    const err = hostCommand(g, { cmd: 'addBot' });
    if (err) throw new Error(err);
  }
  const err = hostCommand(g, { cmd: 'start' });
  if (err) throw new Error(`start: ${err}`);
  let error: string | undefined;
  const deadline = Date.now() + 60_000;
  // The director runs on microtasks; yield to the event loop until the run ends.
  while (g.state.phase !== 'ended' && Date.now() < deadline) {
    await new Promise((r) => setImmediate(r));
    if (g.state.phase === 'title') {
      error = 'returned to title';
      break;
    }
  }
  if (g.state.phase !== 'ended') error = error ?? `timeout (turn ${g.state.world?.turn}, scene ${g.state.scene.kind}, pending ${g.pending.size})`;
  const virtualSec = (clock.now() - start) / 1000;
  const humanSec = Object.entries(g.promptStats).reduce((s, [k, n]) => s + (HUMAN_SECONDS[k.split(':')[0]!] ?? 6) * n, 0) / Math.max(1, players * 0.8);
  const w = g.state.world;
  const chars = Object.values(g.state.chars);
  g.reset();
  return {
    victory: !!g.state.outcome?.victory,
    turns: w?.turn ?? 0,
    combats: g.state.stats.combats,
    victories: g.state.stats.victories,
    rescues: g.state.stats.rescues,
    level: chars.reduce((s, c) => s + c.level, 0) / Math.max(1, chars.length),
    minutes: (virtualSec + humanSec) / 60,
    doom: w?.doom ?? 0,
    doomMax: w?.doomMax ?? 1,
    rounds,
    error,
  };
}

const RANGES: Record<Difficulty, { win: [number, number] }> = {
  story: { win: [0.8, 1.0] },
  normal: { win: [0.45, 0.98] },
  heroic: { win: [0.2, 0.9] },
};

async function main() {
  console.log(`Pocket Realms balance sim — ${LENGTH}, ${DIFF}, ${RUNS} runs per party size\n`);
  console.log('size  win%   turns  combats  avgRounds  level  est.min  rescues  errors');
  let failed = false;
  const errors: string[] = [];
  for (const n of SIZES) {
    const res: RunResult[] = [];
    for (let i = 0; i < RUNS; i++) {
      try {
        res.push(await simulateRun(`SIM-${n}-${i}`, n, DIFF, LENGTH));
      } catch (e) {
        res.push({ victory: false, turns: 0, combats: 0, victories: 0, rescues: 0, level: 0, minutes: 0, doom: 0, doomMax: 1, rounds: [], error: String((e as Error).stack ?? e) });
      }
    }
    const ok = res.filter((r) => !r.error);
    const avg = (f: (r: RunResult) => number) => ok.reduce((s, r) => s + f(r), 0) / Math.max(1, ok.length);
    const win = ok.filter((r) => r.victory).length / Math.max(1, ok.length);
    const allRounds = ok.flatMap((r) => r.rounds);
    const avgRounds = allRounds.reduce((a, b) => a + b, 0) / Math.max(1, allRounds.length);
    const errs = res.filter((r) => r.error);
    errors.push(...errs.map((r) => `[${n}p] ${r.error}`));
    console.log(
      `${String(n).padStart(4)}  ${(win * 100).toFixed(0).padStart(4)}  ${avg((r) => r.turns).toFixed(1).padStart(6)}  ${avg((r) => r.combats).toFixed(1).padStart(7)}  ${avgRounds.toFixed(1).padStart(9)}  ${avg((r) => r.level).toFixed(1).padStart(5)}  ${avg((r) => r.minutes).toFixed(0).padStart(7)}  ${avg((r) => r.rescues).toFixed(2).padStart(7)}  ${String(errs.length).padStart(6)}`,
    );
    const [lo, hi] = RANGES[DIFF].win;
    if (CI && (win < lo || win > hi)) {
      console.error(`  ✗ win rate ${(win * 100).toFixed(0)}% outside ${lo * 100}-${hi * 100}%`);
      failed = true;
    }
    if (CI && avgRounds > 7) {
      console.error(`  ✗ combats too long (${avgRounds.toFixed(1)} rounds)`);
      failed = true;
    }
  }
  if (errors.length) {
    console.error(`\n${errors.length} run(s) errored:`);
    for (const e of errors.slice(0, 5)) console.error(' -', e.split('\n').slice(0, 6).join('\n   '));
    failed = true;
  }
  if (CI && failed) process.exit(1);
  console.log(CI ? '\n✓ balance within range' : '');
}

if (process.argv[1]?.includes('sim')) main();
