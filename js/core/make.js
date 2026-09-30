// The generator. There is no hand-authored level file in this repo, and that is the
// point: a puzzle is only worth shipping once two programs have said something about it —
// the exhaustive counter (exactly one solution) and the reasoning solver (how many
// guesses a pure-logic solve costs).
//
// FORWARD CONSTRUCTION, not "random grid then hope":
//
//   1. scatter the fleet at random, legally: no overlap, no touching, corners included
//   2. read the row and column clues off the scattered board
//   3. countSolutions(spec, 2) — keep it only if the walk came back with exactly one
//   4. solveLogic(spec) — keep it only if the depth lands inside this tier's band
//
// Steps 1-2 make the counting identity true by construction, which is why nothing here
// has to repair a spec that fails it; step 3 is the hard gate and is never relaxed; step 4
// is what decides the tier, so difficulty is measured rather than labelled.
//
// A rejected attempt is normal and cheap: the acceptance rates measured in
// test/balance.mjs run from a few percent (deep bands) to most of the board (shallow
// bands), and one attempt costs a fraction of a millisecond to a few. That is what makes
// this file a build-time tool: nothing in the shipped game imports it, the browser only
// reads js/data/puzzles.js (see js/core/library.js).
//
// Determinism: every budget here is a counter, never a clock. Same seed, same puzzle, on
// any machine — which is what lets a shared link and a daily puzzle mean the same board
// to everyone.

import { fitments, touching, cellsOf, sameShips } from './model.js';
import { countSolutions } from './count.js';
import { solveLogic } from './logic.js';
import { validate } from './check.js';
import { rngFrom } from './rng.js';

// The ladder. `k` is the reasoning-depth band the tier accepts, and the four bands are
// disjoint by construction: 0, 1, 2, 3. `maxDepth` is always one past the top of the band
// so that a board needing more is *measured* as out of band rather than guessed; if the
// solver cannot finish a branch it reports uncertain and the attempt is thrown away, which
// keeps "深度 = 3" a fact instead of an opinion.
export const TIERS = [
  {
    key: 'harbour', label: '近岸', rows: 4, cols: 4, fleet: [2, 1],
    k: [0, 0], tries: 900, countNodes: 200000, logicNodes: 20000,
    blurb: '4×4 · 两条船 · 不用猜',
  },
  {
    key: 'patrol', label: '巡航', rows: 6, cols: 6, fleet: [4, 3, 2],
    k: [1, 1], tries: 2600, countNodes: 400000, logicNodes: 60000,
    blurb: '6×6 · 三处落子 · 猜一层',
  },
  {
    key: 'crossing', label: '拐角', rows: 7, cols: 7, fleet: [5, 4, 3, 2],
    k: [2, 2], tries: 6000, countNodes: 600000, logicNodes: 120000,
    blurb: '7×7 · 四条船 · 猜两层',
  },
  {
    key: 'lone', label: '孤舰', rows: 8, cols: 8, fleet: [6, 5, 3, 1],
    k: [3, 3], tries: 9000, countNodes: 800000, logicNodes: 200000,
    blurb: '8×8 · 四条船 · 猜三层',
  },
];

export function tierByKey(key) {
  return TIERS.find((t) => t.key === key) || TIERS[0];
}

// One attempt: scatter, then read the clues back out. Returns the spec plus the scattered
// fleet, or null when the fleet would not fit (a long ship boxes itself in on a small
// board, which the shuffle simply walks past on the next attempt).
export function scatter(seed, tier) {
  const { rows, cols, fleet } = tier;
  const rng = rngFrom(`${tier.key}|${seed}`);
  const ships = [];
  for (const len of fleet) {
    const pool = fitments(rows, cols, len).filter((p) => !ships.some((s) => touching(s, p)));
    rng.shuffle(pool);
    if (!pool.length) return null;
    ships.push(pool[0]);
  }
  const grid = new Uint8Array(rows * cols);
  for (const s of ships) for (const cell of cellsOf(s, cols)) grid[cell] = 1;
  const rowReq = [];
  const colReq = [];
  for (let r = 0; r < rows; r++) {
    let n = 0;
    for (let c = 0; c < cols; c++) n += grid[r * cols + c];
    rowReq.push(n);
  }
  for (let c = 0; c < cols; c++) {
    let n = 0;
    for (let r = 0; r < rows; r++) n += grid[r * cols + c];
    colReq.push(n);
  }
  const spec = { rows, cols, fleet: fleet.slice(), rowReq, colReq, ships };
  return spec;
}

// makePuzzle(seed, tier, stats?) -> { spec, solution, depth, guesses, attempts } | null
// The one loop that decides whether a board becomes a level. Every `continue` below is a
// counted reason, so test/balance.mjs can print where the attempts actually go.
export function makePuzzle(seed, tier, stats) {
  const hit = (k) => {
    if (stats) stats[k] = (stats[k] || 0) + 1;
  };
  const maxDepth = tier.k[1] + 1;
  for (let i = 0; i < tier.tries; i++) {
    const spec = scatter(`${seed}#${i}`, tier);
    if (!spec) {
      hit('nofit');
      continue;
    }
    const bad = validate(spec, spec.ships);
    if (bad) {
      // Unreachable by construction — scatter cannot write an illegal board — but a silent
      // bug in the generator would show up here rather than in someone's browser.
      hit('invalid');
      continue;
    }
    const c = countSolutions(spec, 2, { nodes: tier.countNodes });
    if (c.count > 1) {
      // The walk stopped early *because* it found a second solution: ambiguous, thrown away.
      hit('ambiguous');
      continue;
    }
    if (!c.complete) {
      hit('countBudget');
      continue;
    }
    if (c.count === 0) {
      hit('unsolved');
      continue;
    }
    const L = solveLogic(spec, { maxDepth, nodes: tier.logicNodes });
    if (!L.solved || !L.certain) {
      hit('depthBudget');
      continue;
    }
    if (L.depth < tier.k[0] || L.depth > tier.k[1]) {
      hit(`k${L.depth}`);
      continue;
    }
    // The scattered board is the unique solution; the counter agrees; the reasoning solver
    // reaches the same one. Belt and braces, because all three ship in the data file.
    if (!sameShips(c.solutions[0], spec.ships)) {
      hit('disagree');
      continue;
    }
    hit('accepted');
    return {
      spec,
      solution: c.solutions[0],
      depth: L.depth,
      guesses: L.guesses,
      inferences: L.inferences,
      nodes: c.nodes,
      attempts: i + 1,
      seed: `${seed}#${i}`,
      tier: tier.key,
    };
  }
  if (stats) stats.gaveUp = (stats.gaveUp || 0) + 1;
  return null;
}
