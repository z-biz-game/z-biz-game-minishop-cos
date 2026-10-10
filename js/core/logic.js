// The reasoning solver. `js/core/count.js` answers "how many solutions are there?"; that
// is a fact about the spec but it is not a fact about how hard the puzzle is to *solve by
// looking*. This file answers the second question, and it does so with the one method that
// has a meaning for a human at a screen: local inference rules, applied until they stop,
// plus a counted number of guesses when they do.
//
// RULE SET  (the whole list — DESIGN.md repeats it, and the number below is meaningless
// without it: a different rule set gives a different depth. That is the honest clause.)
//
//   buffer        every cell touching a ship that is nailed to the board, corners included,
//                 is water (an occupied-but-unnailed cell is not a ship yet, so it buffers
//                 nothing — see ruleBuffer)
//   lineFilled    a line that already holds its clue has water everywhere else
//   lineSaturated a line whose remaining unknown cells exactly equal what it still needs
//                 has ships in all of them
//   soleFitment   a ship with exactly one legal place left on the board goes there
//   deadCell      an unknown cell that no remaining ship can ever occupy is water
//   starved       not a deduction but a stop: a line that can no longer reach its clue, a
//                 ship with nowhere to go, or an occupied cell no ship can cover
//
// "Legal place" always means: in bounds, no water, not on another ship, not touching
// another ship (corners included), and not breaking a line's clue.
//
// REASONING DEPTH k
//
// When the rules reach a standstill and the board is not finished, the solver picks the
// most constrained unknown cell — the one with the fewest possibilities, ties by position —
// and enumerates what could be true of it: "water", or "this ship of this length lies here"
// for every legal fitment through that cell. That enumeration is exhaustive and disjoint,
// so one of the alternatives is simply the truth, and assuming it costs **one layer**.
//
//   k(state) = 0                                  if the rules finish the board
//            = 1 + max over solvable alternatives of k(state and that alternative)   otherwise
//
// The max, not the min: the depth is what you pay when the guess tells you nothing, which
// on a puzzle with exactly one solution is the same as "the branch that was right". A branch
// that dies on a contradiction contributes nothing (that alternative was never the truth,
// and no real board passes through it).
//
// Every number here is a measurement of *this rule set*, reproducible cell for cell: no
// randomness, no time, and no input is ever mutated.

import { UNKNOWN, SHIP, WATER, FREE, fitments, cellsOf } from './model.js';

const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

export function blankState(spec) {
  const n = spec.rows * spec.cols;
  const rest = new Map();
  for (const len of spec.fleet) rest.set(len, (rest.get(len) || 0) + 1);
  return {
    spec,
    rows: spec.rows,
    cols: spec.cols,
    grid: new Uint8Array(n), // UNKNOWN everywhere
    own: new Int16Array(n).fill(-1), // which nailed ship holds this cell
    ships: [], // nailed placements
    rest, // lengths still unplaced
    inferences: 0,
  };
}

export function cloneState(st) {
  const rest = new Map(st.rest);
  return {
    spec: st.spec,
    rows: st.rows,
    cols: st.cols,
    grid: Uint8Array.from(st.grid),
    own: Int16Array.from(st.own),
    ships: st.ships.map((s) => ({ ...s })),
    rest,
    inferences: st.inferences,
  };
}

const at = (st, r, c) => (r < 0 || c < 0 || r >= st.rows || c >= st.cols ? -1 : r * st.cols + c);

// Could a ship of this shape go here, given what is nailed and marked so far?
export function fits(st, ship) {
  const cells = cellsOf(ship, st.cols);
  if (ship.r < 0 || ship.c < 0 || ship.r >= st.rows || ship.c >= st.cols) return false;
  if (ship.axis === 'h' ? ship.c + ship.len > st.cols : ship.r + ship.len > st.rows) return false;
  const mine = new Set(cells);
  for (const cell of cells) {
    if (st.grid[cell] === WATER) return false;
    if (st.own[cell] >= 0) return false; // another ship is standing here
  }
  for (const cell of cells) {
    const r = Math.floor(cell / st.cols);
    const c = cell % st.cols;
    for (const [dr, dc] of DIRS) {
      const n = at(st, r + dr, c + dc);
      if (n < 0 || mine.has(n)) continue;
      if (st.grid[n] === SHIP) return false; // touching, corner included
    }
  }
  // A line may not be pushed past its clue by these cells.
  for (let r = 0; r < st.rows; r++) {
    const need = st.spec.rowReq[r];
    if (need === FREE) continue;
    let have = 0;
    for (let c = 0; c < st.cols; c++) {
      const cell = r * st.cols + c;
      if (st.grid[cell] === SHIP || (st.own[cell] < 0 && mine.has(cell))) have++;
    }
    if (have > need) return false;
  }
  for (let c = 0; c < st.cols; c++) {
    const need = st.spec.colReq[c];
    if (need === FREE) continue;
    let have = 0;
    for (let r = 0; r < st.rows; r++) {
      const cell = r * st.cols + c;
      if (st.grid[cell] === SHIP || (st.own[cell] < 0 && mine.has(cell))) have++;
    }
    if (have > need) return false;
  }
  return true;
}

function legalFitments(st, len, cache) {
  if (cache && cache.has(len)) return cache.get(len);
  const out = fitments(st.rows, st.cols, len).filter((s) => fits(st, s));
  if (cache) cache.set(len, out);
  return out;
}

function nail(st, ship) {
  const idx = st.ships.length;
  st.ships.push({ ...ship });
  for (const cell of cellsOf(ship, st.cols)) {
    st.grid[cell] = SHIP;
    st.own[cell] = idx;
  }
  st.rest.set(ship.len, st.rest.get(ship.len) - 1);
}

function lineCount(st, row, col) {
  let ship = 0;
  let unknown = 0;
  if (row >= 0) {
    for (let c = 0; c < st.cols; c++) {
      const v = st.grid[row * st.cols + c];
      if (v === SHIP) ship++;
      else if (v === UNKNOWN) unknown++;
    }
  } else {
    for (let r = 0; r < st.rows; r++) {
      const v = st.grid[r * st.cols + col];
      if (v === SHIP) ship++;
      else if (v === UNKNOWN) unknown++;
    }
  }
  return { ship, unknown };
}

// ---------------------------------------------------------------- the rules
// Each one returns how many cells it changed. Zero means it did not fire, which is what
// lets test/logic.test.mjs hold each rule up to the light on its own board.

// Buffer only around ships that are actually on the board. An occupied cell inferred from
// a saturated line is not yet a ship — it may be the middle of one — and watering its
// corners would water the very cells its own ship needs. test/logic.test.mjs has a case
// for exactly this, because it is the subtlest wrong turn in the file.
export function ruleBuffer(st) {
  let n = 0;
  const marks = [];
  for (let r = 0; r < st.rows; r++) {
    for (let c = 0; c < st.cols; c++) {
      const cell = r * st.cols + c;
      if (st.grid[cell] !== SHIP || st.own[cell] < 0) continue;
      for (const [dr, dc] of DIRS) {
        const near = at(st, r + dr, c + dc);
        if (near >= 0 && st.grid[near] === UNKNOWN) marks.push(near);
      }
    }
  }
  for (const cell of marks) {
    if (st.grid[cell] !== UNKNOWN) continue;
    st.grid[cell] = WATER;
    n++;
  }
  st.inferences += n;
  return n;
}

export function ruleLineFilled(st) {
  let n = 0;
  for (let r = 0; r < st.rows; r++) {
    const need = st.spec.rowReq[r];
    if (need === FREE) continue;
    const { ship } = lineCount(st, r, -1);
    if (ship !== need) continue;
    for (let c = 0; c < st.cols; c++) {
      const cell = r * st.cols + c;
      if (st.grid[cell] === UNKNOWN) {
        st.grid[cell] = WATER;
        n++;
      }
    }
  }
  for (let c = 0; c < st.cols; c++) {
    const need = st.spec.colReq[c];
    if (need === FREE) continue;
    const { ship } = lineCount(st, -1, c);
    if (ship !== need) continue;
    for (let r = 0; r < st.rows; r++) {
      const cell = r * st.cols + c;
      if (st.grid[cell] === UNKNOWN) {
        st.grid[cell] = WATER;
        n++;
      }
    }
  }
  st.inferences += n;
  return n;
}

export function ruleLineSaturated(st) {
  let n = 0;
  const mark = (r, c) => {
    const cells = [];
    if (r >= 0) for (let x = 0; x < st.cols; x++) cells.push(r * st.cols + x);
    else for (let y = 0; y < st.rows; y++) cells.push(y * st.cols + c);
    for (const cell of cells) {
      if (st.grid[cell] === UNKNOWN) {
        st.grid[cell] = SHIP;
        n++;
      }
    }
  };
  for (let r = 0; r < st.rows; r++) {
    const need = st.spec.rowReq[r];
    if (need === FREE) continue;
    const { ship, unknown } = lineCount(st, r, -1);
    if (unknown && ship + unknown === need) mark(r, -1);
  }
  for (let c = 0; c < st.cols; c++) {
    const need = st.spec.colReq[c];
    if (need === FREE) continue;
    const { ship, unknown } = lineCount(st, -1, c);
    if (unknown && ship + unknown === need) mark(-1, c);
  }
  st.inferences += n;
  return n;
}

export function ruleSoleFitment(st, cache) {
  let fired = 0;
  for (const [len, left] of st.rest) {
    if (left <= 0) continue;
    const legal = legalFitments(st, len, cache);
    if (legal.length === 0) continue; // `starved` calls that a contradiction
    if (legal.length > left) continue; // still a choice to make
    for (const ship of legal) {
      if (fits(st, ship)) {
        nail(st, ship);
        fired++;
      }
    }
    break; // the board moved; the next round recomputes every candidate list
  }
  st.inferences += fired;
  return fired;
}

export function ruleDeadCell(st, cache) {
  const covering = new Uint8Array(st.rows * st.cols);
  for (const [len, left] of st.rest) {
    if (left <= 0) continue;
    for (const ship of legalFitments(st, len, cache)) {
      for (const cell of cellsOf(ship, st.cols)) covering[cell] = 1;
    }
  }
  let n = 0;
  for (let cell = 0; cell < covering.length; cell++) {
    if (st.grid[cell] === UNKNOWN && !covering[cell]) {
      st.grid[cell] = WATER;
      n++;
    }
  }
  st.inferences += n;
  return n;
}

// Not a deduction: the point at which the state is known to describe no board at all.
export function ruleStarved(st, cache) {
  for (let r = 0; r < st.rows; r++) {
    const need = st.spec.rowReq[r];
    if (need === FREE) continue;
    const { ship, unknown } = lineCount(st, r, -1);
    if (ship > need || ship + unknown < need) return `row ${r} can no longer reach its clue`;
  }
  for (let c = 0; c < st.cols; c++) {
    const need = st.spec.colReq[c];
    if (need === FREE) continue;
    const { ship, unknown } = lineCount(st, -1, c);
    if (ship > need || ship + unknown < need) return `column ${c} can no longer reach its clue`;
  }
  for (const [len, left] of st.rest) {
    if (left > 0 && legalFitments(st, len, cache).length === 0) return `no place left for a ship of length ${len}`;
  }
  // An occupied cell that no remaining ship is able to cover is a phantom: it is in the
  // count of some line but no ship will ever stand on it.
  for (let cell = 0; cell < st.grid.length; cell++) {
    if (st.grid[cell] !== SHIP || st.own[cell] >= 0) continue;
    let coverable = false;
    for (const [len, left] of st.rest) {
      if (left <= 0) continue;
      if (legalFitments(st, len, cache).some((s) => cellsOf(s, st.cols).includes(cell))) {
        coverable = true;
        break;
      }
    }
    if (!coverable) return 'an inferred ship cell has no ship that can cover it';
  }
  return null;
}

export function completeState(st) {
  for (const left of st.rest.values()) if (left !== 0) return false;
  for (let cell = 0; cell < st.grid.length; cell++) {
    if (st.grid[cell] === UNKNOWN) return false;
    if (st.grid[cell] === SHIP && st.own[cell] < 0) return false;
  }
  return true;
}

// Apply the rules until nothing changes. Returns { complete, dead }.
export function propagate(st) {
  const cache = new Map();
  for (let guard = 0; guard < 10000; guard++) {
    let dead = ruleStarved(st, cache);
    if (dead) return { complete: false, dead };
    if (completeState(st)) return { complete: true, dead: null };
    cache.clear();
    const fired = ruleBuffer(st) || ruleLineFilled(st) || ruleLineSaturated(st)
      || ruleSoleFitment(st, cache) || ruleDeadCell(st, cache);
    if (!fired) {
      dead = ruleStarved(st, new Map());
      if (dead) return { complete: false, dead };
      return { complete: false, dead: null }; // standstill: a guess is needed
    }
  }
  return { complete: false, dead: 'the rules stopped changing anything' };
}

// The alternatives available at one cell: water, or a ship of some owed length through it.
function hypotheses(st, cell) {
  const out = [{ kind: 'water', cell }];
  const r = Math.floor(cell / st.cols);
  const c = cell % st.cols;
  for (const [len, left] of st.rest) {
    if (left <= 0) continue;
    for (const ship of fitments(st.rows, st.cols, len)) {
      if (ship.r > r || ship.c > c) continue;
      if (!cellsOf(ship, st.cols).includes(cell)) continue;
      if (fits(st, ship)) out.push({ kind: 'ship', ship });
    }
  }
  return out;
}

function pickCell(st) {
  let best = null;
  for (let cell = 0; cell < st.grid.length; cell++) {
    if (st.grid[cell] !== UNKNOWN) continue;
    const n = hypotheses(st, cell).length;
    if (!best || n < best.options) best = { cell, options: n };
    if (n <= 1) break; // nothing is better constrained than a cell with one option left
  }
  return best;
}

// solveLogic(spec) -> { solved, depth, guesses, inferences, placements, certain, why }
// `depth` is the reasoning depth k; it is only trustworthy when `certain` is true, i.e. no
// branch was cut short by the budgets below.
export function solveLogic(spec, opts = {}) {
  const maxDepth = opts.maxDepth === undefined ? 4 : opts.maxDepth;
  const maxNodes = opts.nodes === undefined ? 20000 : opts.nodes;
  let nodes = 0;
  let certain = true;
  let guesses = 0;
  let inferred = 0;

  function search(st, depth) {
    nodes++;
    if (nodes > maxNodes) {
      certain = false;
      return null;
    }
    const state = cloneState(st);
    const run = propagate(state);
    if (state.inferences > inferred) inferred = state.inferences;
    if (run.complete) return { placements: state.ships.map((s) => ({ r: s.r, c: s.c, len: s.len, axis: s.axis })), depth: 0 };
    if (run.dead) return null; // a contradiction: this alternative was never the truth
    if (depth >= maxDepth) {
      certain = false;
      return null;
    }
    const pick = pickCell(state);
    if (!pick) {
      certain = false;
      return null;
    }
    guesses++;
    let best = null;
    for (const hypo of hypotheses(state, pick.cell)) {
      const child = cloneState(state);
      if (hypo.kind === 'water') {
        child.grid[hypo.cell] = WATER;
      } else {
        if (!fits(child, hypo.ship)) {
          certain = false;
          continue;
        }
        nail(child, hypo.ship);
      }
      const r = search(child, depth + 1);
      if (!r) continue;
      if (!best || r.depth > best.depth) best = r;
    }
    if (!best) return null;
    return { placements: best.placements, depth: best.depth + 1 };
  }

  const root = search(blankState(spec), 0);
  return {
    solved: !!root,
    depth: root ? root.depth : null,
    certain: certain && !!root,
    placements: root ? root.placements : null,
    guesses,
    inferences: inferred,
    nodes,
    why: root ? 'ok' : certain ? 'the rule set cannot finish this board' : 'not proved within the budget',
  };
}
