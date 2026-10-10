// The reasoning solver. Two things have to be true for 推理深度 to mean anything: each rule
// must fire on its own board (so a broken rule cannot be hidden by a stronger one), and the
// depth must be a measurement of this rule set rather than an opinion. Every rule is tested
// in isolation below, then the composition.
//
// The boards used by the per-rule tests are typed by hand and their expected boards are
// worked out by hand too (see the comments), so a rule that silently changed its mind about
// a cell fails here instead of quietly shifting a difficulty number.

import { test, run, ok, eq } from '../tools/harness.mjs';
import {
  blankState, cloneState, fits, ruleBuffer, ruleLineFilled, ruleLineSaturated,
  ruleSoleFitment, ruleDeadCell, ruleStarved, completeState, propagate, solveLogic,
} from '../js/core/logic.js';
import { countSolutions } from '../js/core/count.js';
import { UNKNOWN, SHIP, WATER, FREE, serialize, draw } from '../js/core/model.js';
import { validate } from '../js/core/check.js';
import { PUZZLES } from '../js/data/puzzles.js';
import { UNIQUE_4x4 } from './fixture.mjs';

const keySet = (ships) => {
  const cells = new Set();
  for (const s of ships) {
    for (let k = 0; k < s.len; k++) cells.add(`${s.axis === 'v' ? s.r + k : s.r},${s.axis === 'v' ? s.c : s.c + k}`);
  }
  return [...cells].sort().join(' ');
};

// '#'/ship nailed to a board, '+'/ship inferred by a rule but not yet owned by a ship,
// '~'/water, '.'/unknown. Printing `own` next to `grid` is the point: the difference
// between the two ship marks is what ruleBuffer keys off.
const ascii = (st) => {
  const lines = [];
  for (let r = 0; r < st.rows; r++) {
    let s = '';
    for (let c = 0; c < st.cols; c++) {
      const v = st.grid[r * st.cols + c];
      s += v === SHIP ? (st.own[r * st.cols + c] >= 0 ? '#' : '+') : v === WATER ? '~' : '.';
    }
    lines.push(s);
  }
  return lines.join('\n');
};

// A test-local "nail": put a ship on the board the way the rules do, so ruleBuffer and
// friends can be pointed at a state without going through solveLogic first.
function nail(st, ship) {
  const idx = st.ships.length;
  st.ships.push({ ...ship });
  for (let k = 0; k < ship.len; k++) {
    const r = ship.axis === 'v' ? ship.r + k : ship.r;
    const c = ship.axis === 'v' ? ship.c : ship.c + k;
    st.grid[r * st.cols + c] = SHIP;
    st.own[r * st.cols + c] = idx;
  }
  st.rest.set(ship.len, st.rest.get(ship.len) - 1);
}

// GRID is a real 5x5 puzzle, worked by hand: rows 3 and 4 want nothing and column 0 wants
// nothing, so column 1's three cells can only be rows 0,1,2 -> the only home for the 3-ship
// is vertical at (0,1). Row 2 then still wants two cells and columns 3 and 4 want one each,
// which leaves exactly (2,3)-(2,4) for the 2-ship. Unique, depth 0, and the exhaustive
// counter is checked to agree with that below.
const GRID = { rows: 5, cols: 5, fleet: [3, 2], rowReq: [1, 1, 3, 0, 0], colReq: [0, 3, 0, 1, 1] };
const GRID_SOLUTION = [{ r: 0, c: 1, len: 3, axis: 'v' }, { r: 2, c: 3, len: 2, axis: 'h' }];
// Every clue free, so the only thing that can veto a fitment is geometry: bounds, water,
// another hull, and the no-touching rule. This is what the `fits` tests are for.
const GEOMETRY = { rows: 4, cols: 4, fleet: [2, 2], rowReq: [FREE, FREE, FREE, FREE], colReq: [FREE, FREE, FREE, FREE] };

test('GRID really is the hand-worked board the rule tests lean on', () => {
  eq(validate(GRID, GRID_SOLUTION), null, 'the hand-worked answer passes the independent checker');
  const C = countSolutions(GRID, 2);
  eq([C.count, C.complete], [1, true], 'and the counter says it is the only one');
  eq(keySet(C.solutions[0]), keySet(GRID_SOLUTION));
});

test('fits() refuses for exactly the reasons it should, and accepts what is legal', () => {
  // Bounds.
  const st = blankState(GEOMETRY);
  nail(st, { r: 1, c: 1, len: 2, axis: 'h' }); // occupies (1,1),(1,2)
  eq(fits(st, { r: 3, c: 3, len: 2, axis: 'h' }), false, 'a horizontal 2 at column 3 runs off the right edge');
  eq(fits(st, { r: 3, c: 0, len: 2, axis: 'v' }), false, 'a vertical 2 on the last row runs off the bottom');
  eq(fits(st, { r: 0, c: 0, len: 2, axis: 'h' }), false, 'but this one is refused for a different reason: (0,1) is directly above (1,1)');
  eq(fits(st, { r: 2, c: 3, len: 2, axis: 'v' }), false, '(2,3) sits on the corner of (1,2) — diagonals count');
  eq(fits(st, { r: 1, c: 0, len: 2, axis: 'h' }), false, 'and this one would stand on (1,1), which is taken');
  eq(fits(st, { r: 3, c: 0, len: 2, axis: 'h' }), true, 'the far row is clear of both hull and buffer');
  // Water.
  const wet = blankState(GEOMETRY);
  wet.grid[3 * 4 + 0] = WATER;
  eq(fits(wet, { r: 3, c: 0, len: 2, axis: 'v' }), false, 'a water mark blocks the cell it touches');
  eq(fits(wet, { r: 3, c: 1, len: 2, axis: 'h' }), true, 'and only that cell');
  // Clues: on GRID the same length-3 shape is legal in one column and illegal in its
  // neighbour, purely because of what the lines ask for.
  const sea = blankState(GRID);
  eq(fits(sea, { r: 0, c: 1, len: 3, axis: 'v' }), true, 'column 1 wants three cells and rows 0..2 are the only ones that want anything');
  eq(fits(sea, { r: 1, c: 1, len: 3, axis: 'v' }), false, 'the same ship one row down would stand in row 3, which wants nothing');
  eq(fits(sea, { r: 0, c: 0, len: 3, axis: 'h' }), false, 'row 0 wants one cell, not three');
  eq(fits(sea, { r: 2, c: 2, len: 2, axis: 'h' }), false, 'column 2 wants nothing, so (2,2) is unreachable');
});

test('ruleLineFilled: a line that already holds its clue is water everywhere else', () => {
  const st = blankState(GRID);
  nail(st, GRID_SOLUTION[0]);
  const changed = ruleLineFilled(st);
  ok(changed > 0, `the rule marked ${changed} cells`);
  // Rows 0 and 1 hold their single cell, column 1 holds its three, columns 0 and 2 and rows
  // 3 and 4 hold none and want none. Row 2 wants three and has one, so its two remaining
  // cells must stay unknown — that is the whole content of the rule.
  eq(ascii(st), ['~#~~~', '~#~~~', '~#~..', '~~~~~', '~~~~~'].join('\n'));
  eq(st.grid[2 * 5 + 3], UNKNOWN, 'row 2 still owes two cells');
  eq(st.grid[2 * 5 + 4], UNKNOWN);
  // A 0-clue line is "filled" by holding nothing, so the rule fires on an untouched board.
  const bare = blankState(GRID);
  eq(ruleLineFilled(bare), 16, 'rows 3-4 and columns 0 and 2 water themselves: 4*5 - 4 shared cells');
  eq(ascii(bare), ['~.~..', '~.~..', '~.~..', '~~~~~', '~~~~~'].join('\n'));
});

test('ruleLineSaturated: the unknowns of a line that must be full all become ships', () => {
  // Column 1 wants three cells. Water two of them away and what is left has to be hull —
  // inferred hull, not nailed: `own` stays -1, because no ship has committed to the shape.
  const st = blankState(GRID);
  st.grid[3 * 5 + 1] = WATER;
  st.grid[4 * 5 + 1] = WATER;
  eq(ruleLineSaturated(st), 3, 'three unknowns, three wanted');
  eq(ascii(st), ['.+...', '.+...', '.+...', '.~...', '.~...'].join('\n'));
  eq(st.own[2 * 5 + 1], -1, 'inferred cells are not yet owned by a ship');
  eq(st.rest.get(3), 1, 'and no ship has been placed by the rule');
  // The near miss: one water mark leaves four unknowns for a clue of three, so the rule has
  // no right to decide anything.
  const shy = blankState(GRID);
  shy.grid[4 * 5 + 1] = WATER;
  eq(ruleLineSaturated(shy), 0, 'four candidates for three cells is not saturation');
  eq(shy.grid[0 * 5 + 1], UNKNOWN, 'nothing was marked');
});

test('ruleBuffer only buffers nailed cells — an inferred ship cell may still grow', () => {
  // The subtlest wrong turn in the file: (0,1),(1,1),(2,1) below are occupied by assumption,
  // not nailed. Watering their corners would kill the very ship they belong to.
  const st = blankState(GRID);
  for (const cell of [0 * 5 + 1, 1 * 5 + 1, 2 * 5 + 1]) st.grid[cell] = SHIP;
  eq(ruleBuffer(st), 0, 'inferred hull buffers nothing');
  eq(st.grid.filter((v) => v === UNKNOWN).length, 22, 'every free cell is still free');
  // Once the same cells belong to a nailed ship, the buffer is mandatory — corners included.
  const st2 = blankState(GRID);
  nail(st2, GRID_SOLUTION[0]);
  eq(ruleBuffer(st2), 9, 'the eight king-moves around the hull, one of which is off the top edge');
  eq(ascii(st2), ['~#~..', '~#~..', '~#~..', '~~~..', '.....'].join('\n'));
  eq(st2.grid[3 * 5 + 0], WATER, 'diagonal below-left of the keel');
  eq(st2.grid[3 * 5 + 2], WATER, 'diagonal below-right of the keel');
  eq(st2.grid[0 * 5 + 0], WATER, 'and the corner at the bow');
});

test('ruleSoleFitment: one legal spot left means the ship goes there', () => {
  // On GRID the 3-ship has exactly one home before a single mark is made (see the hand
  // worked comment), and once it is down the 2-ship has exactly one home too.
  const st = blankState(GRID);
  eq(ruleSoleFitment(st, new Map()), 1, 'the 3-ship went to its only possible column');
  eq(ruleSoleFitment(st, new Map()), 1, 'then the 2-ship found its only possible row');
  eq(ascii(st), ['.#...', '.#...', '.#.##', '.....', '.....'].join('\n'));
  eq(st.ships.length, 2);
  eq(keySet(st.ships), keySet(GRID_SOLUTION));
  eq([st.rest.get(3), st.rest.get(2)], [0, 0], 'the fleet is spent');
  // The negative: with two ships to place and dozens of spots, nothing may be concluded.
  const loose = blankState(GEOMETRY);
  eq(ruleSoleFitment(loose, new Map()), 0, 'a choice is still a choice');
  eq(loose.ships.length, 0);
  // And a water mark can be what collapses the choice: on this 4x4 the 3-ship fits along the
  // top row in two ways until (0,3) is denied. (The spec has two boards overall, so it is a
  // rule probe rather than a puzzle — which is exactly what a per-rule test needs.)
  const PROBE = { rows: 4, cols: 4, fleet: [3, 1], rowReq: [3, 0, 0, 1], colReq: [1, 1, 1, 1] };
  const wet = blankState(PROBE);
  eq(ruleSoleFitment(wet, new Map()), 0, 'two fitments left for the 3-ship');
  wet.grid[0 * 4 + 3] = WATER;
  eq(ruleSoleFitment(wet, new Map()), 1, 'one less cell makes it a certainty');
  eq(wet.ships, [{ r: 0, c: 0, len: 3, axis: 'h' }]);
  eq(wet.rest.get(1), 1, 'the submarine is still unplaced');
});

test('ruleDeadCell: a cell no remaining ship can ever occupy becomes water', () => {
  const st = blankState(GRID);
  nail(st, GRID_SOLUTION[0]);
  nail(st, GRID_SOLUTION[1]);
  eq([st.rest.get(3), st.rest.get(2)], [0, 0]);
  const before = st.grid.filter((v) => v === UNKNOWN).length;
  eq(before, 20);
  eq(ruleDeadCell(st, new Map()), before, 'with the fleet placed, every remaining cell is dead');
  eq(st.grid.filter((v) => v === UNKNOWN).length, 0);
  // Half-placed: only the two cells the owed 2-ship can still stand on stay unknown.
  const part = blankState(GRID);
  nail(part, GRID_SOLUTION[0]);
  eq(ruleDeadCell(part, new Map()), 20, 'the rest of the board is watered out');
  eq(ascii(part), ['~#~~~', '~#~~~', '~#~..', '~~~~~', '~~~~~'].join('\n'));
  eq(part.grid[2 * 5 + 3], UNKNOWN, 'the last ship is still looking');
});

test('ruleStarved: it names the contradiction instead of deducing anything', () => {
  const st = blankState(GRID);
  eq(ruleStarved(st, new Map()), null, 'an empty board is not starving');
  for (let c = 0; c < 5; c++) st.grid[1 * 5 + c] = WATER;
  eq(ruleStarved(st, new Map()), 'row 1 can no longer reach its clue', 'a line that cannot reach its clue');
  const column = blankState(GRID);
  for (let r = 0; r < 5; r++) column.grid[r * 5 + 4] = WATER;
  eq(ruleStarved(column, new Map()), 'column 4 can no longer reach its clue', 'the same story told down a column');
  // Row 0 asks for the whole board; it is only contradicted once a cell of it is denied.
  const greedy = blankState({ ...GRID, rowReq: [5, 0, 0, 0, 0], colReq: [1, 1, 1, 1, 1] });
  eq(ruleStarved(greedy, new Map()), null, 'a greedy clue is not yet a lie');
  greedy.grid[0 * 5 + 4] = WATER;
  eq(ruleStarved(greedy, new Map()), 'row 0 can no longer reach its clue');
  // A ship that fits nowhere on the board. On a 3x3 with a lone 3-ship and a clue of one
  // per line every row/column check passes — yet a length-3 ship always fills a whole line,
  // so no fitment exists. The counter independently says there are no boards at all.
  const TINY = { rows: 3, cols: 3, fleet: [3], rowReq: [1, 1, 1], colReq: [1, 1, 1] };
  eq(countSolutions(TINY, 4).count, 0, 'the fixture: no fleet satisfies it');
  const cross = blankState(TINY);
  eq(ruleStarved(cross, new Map()), 'no place left for a ship of length 3');
  eq(propagate(cross), { complete: false, dead: 'no place left for a ship of length 3' }, 'and propagate carries that verdict out');
  // The phantom: an occupied cell counted by a free line that no remaining ship can cover.
  const WEAK = { rows: 4, cols: 4, fleet: [2], rowReq: [2, FREE, FREE, FREE], colReq: [1, 1, FREE, FREE] };
  const phantom = blankState(WEAK);
  nail(phantom, { r: 0, c: 0, len: 2, axis: 'h' });
  phantom.grid[2 * 4 + 2] = SHIP;
  eq(ascii(phantom), ['##..', '....', '..+.', '....'].join('\n'));
  eq(ruleStarved(phantom, new Map()), 'an inferred ship cell has no ship that can cover it');
});

test('propagate closes the hand-worked board with no help, and knows what it did', () => {
  const st = blankState(UNIQUE_4x4.spec);
  const run1 = propagate(st);
  eq([run1.complete, run1.dead], [true, null]);
  eq(completeState(st), true);
  eq(keySet(st.ships), keySet(UNIQUE_4x4.solution));
  ok(st.inferences > 0, `the rules made ${st.inferences} marks on their own`);
  eq(validate(UNIQUE_4x4.spec, st.ships), null, 'and the independent checker signs the result');
  eq(propagate(blankState(GRID)).complete, true, 'the 5x5 hand-worked board closes too');
});

test('propagate reports a standstill as a standstill, not as a solution', () => {
  // Four identical 1-cell ships on a 4x4 whose clues pin the counts but not the columns:
  // the rules have nothing to say and must not invent an answer.
  const st = blankState({ rows: 4, cols: 4, fleet: [1, 1, 1, 1], rowReq: [1, 1, 1, 1], colReq: [1, 1, 1, 1] });
  const r = propagate(st);
  eq([r.complete, r.dead], [false, null], 'no deduction is available and nothing is contradicted');
  const solved = countSolutions(st.spec, 3);
  ok(solved.count >= 2, `and indeed there are ${solved.count} boards, so a standstill is correct`);
  eq(completeState(st), false, 'and the board is honestly unfinished');
});

test('the hand-worked fixture is depth 0 and its answer is the counter\'s answer', () => {
  const L = solveLogic(UNIQUE_4x4.spec, { maxDepth: 3 });
  eq([L.solved, L.certain, L.depth], [true, true, 0]);
  eq(L.guesses, 0, 'not one assumption');
  eq(keySet(L.placements), keySet(UNIQUE_4x4.solution));
  const C = countSolutions(UNIQUE_4x4.spec, 2);
  eq(keySet(L.placements), keySet(C.solutions[0]), 'reasoning and exhaustive agree here');
});

test('depth is a measurement: the same spec, measured five times, gives five identical numbers', () => {
  const sample = PUZZLES.filter((p, i) => i % 7 === 0);
  ok(sample.length >= 6, `sampling ${sample.length} baked puzzles`);
  for (const p of sample) {
    const spec = JSON.parse(serialize(p.spec));
    const first = solveLogic(spec, { maxDepth: 5, nodes: 200000 });
    for (let i = 0; i < 4; i++) {
      const again = solveLogic(JSON.parse(serialize(p.spec)), { maxDepth: 5, nodes: 200000 });
      eq([again.solved, again.certain, again.depth, again.guesses, again.inferences, again.nodes],
        [first.solved, first.certain, first.depth, first.guesses, first.inferences, first.nodes],
        `${p.id} is not reproducible`);
    }
  }
});

test('cutting the budget makes the solver uncertain, never wrong', () => {
  const hard = PUZZLES.find((p) => p.depth >= 2);
  ok(hard, 'the pool has a deep board to test with');
  const deep = solveLogic(hard.spec, { maxDepth: 5, nodes: 400000 });
  eq([deep.solved, deep.certain, deep.depth], [true, true, hard.depth], `${hard.id} measured differently`);
  eq(deep.nodes, 5, 'this board is a five node search, which is why the budgets below are tiny');
  const shallow = solveLogic(hard.spec, { maxDepth: 1 });
  eq(shallow.certain, false, 'a depth-1 search cannot settle this board, and says so');
  eq(shallow.solved, false, 'it does not claim an answer either');
  // Three nodes: the route it did find is still the right one, but a branch was cut, so the
  // number is no longer a proof. This is the difference between "unsure" and "wrong".
  const cut = solveLogic(hard.spec, { maxDepth: 5, nodes: 3 });
  eq([cut.solved, cut.certain], [true, false], 'an unfinished search keeps its answer and loses its certainty');
  eq(cut.why, 'ok');
  const tight = solveLogic(hard.spec, { maxDepth: 5, nodes: 2 });
  eq([tight.solved, tight.certain], [false, false], 'and a search cut before it finishes loses both');
  eq(tight.why, 'not proved within the budget');
});

test('the k=0 tier: reasoning reproduces the exhaustive answer on every shipped board', () => {
  const zero = PUZZLES.filter((p) => p.depth === 0);
  ok(zero.length >= 4, `the pool has ${zero.length} depth-0 boards`);
  for (const p of zero) {
    const L = solveLogic(p.spec, { maxDepth: 0 });
    eq([L.solved, L.certain, L.depth, L.guesses], [true, true, 0, 0], `${p.id} should need no guess`);
    const C = countSolutions(p.spec, 2);
    eq(C.count, 1);
    eq(keySet(L.placements), keySet(C.solutions[0]), `${p.id}: the two solvers disagree`);
    eq(validate(p.spec, L.placements), null, `${p.id}: and the checker agrees`);
  }
});

test('a depth-1 board is a depth-1 board: one assumption suffices, zero do not', () => {
  const one = PUZZLES.filter((p) => p.depth === 1);
  ok(one.length >= 2, `the pool has ${one.length} depth-1 boards`);
  for (const p of one) {
    const L = solveLogic(p.spec, { maxDepth: 4, nodes: 200000 });
    eq([L.solved, L.certain, L.depth], [true, true, 1], `${p.id} measured differently`);
    ok(L.guesses >= 1, `${p.id} guessed ${L.guesses} times`);
    const C = countSolutions(p.spec, 2);
    eq(keySet(L.placements), keySet(C.solutions[0]), `${p.id}: the assumed route still lands on the unique board`);
    const nope = solveLogic(p.spec, { maxDepth: 0 });
    eq(nope.certain, false, `${p.id} cannot be finished without an assumption`);
  }
});

test('solveLogic does not mutate its spec, and its state clones do not alias', () => {
  const before = serialize(UNIQUE_4x4.spec);
  const st = blankState(UNIQUE_4x4.spec);
  const copy = cloneState(st);
  copy.grid[0] = WATER;
  copy.ships.push({ r: 9, c: 9, len: 1, axis: 'h' });
  copy.rest.set(2, 99);
  eq(st.grid[0], UNKNOWN, 'the clone is a copy');
  eq([st.ships.length, st.rest.get(2)], [0, 1], 'including the bookkeeping');
  solveLogic(UNIQUE_4x4.spec, { maxDepth: 2 });
  eq(serialize(UNIQUE_4x4.spec), before);
  eq(draw(UNIQUE_4x4.spec, UNIQUE_4x4.solution), ['#...', '#...', '....', '..#.'].join('\n'));
});

test('the rule set is what defines the number: erasing one clue can cost an assumption layer', () => {
  // Uniqueness is blind to this clue (see the identity theorem tested in count.test.mjs —
  // Σ(row clues) pins what the erased line has to hold), but deduction is not: the 0-clue on
  // row 2 is what lets ruleLineFilled water that row out, and without it the rules stall.
  const weak = { ...UNIQUE_4x4.spec, rowReq: [1, 1, FREE, 1] };
  const C = countSolutions(weak, 3);
  eq([C.count, C.complete], [1, true], 'the weakened spec is still unique');
  eq(keySet(C.solutions[0]), keySet(UNIQUE_4x4.solution), 'and it is the same board');
  const strict = solveLogic(UNIQUE_4x4.spec, { maxDepth: 0 });
  eq([strict.solved, strict.certain, strict.depth], [true, true, 0], 'fully clued: pure deduction');
  const stalled = solveLogic(weak, { maxDepth: 0 });
  eq([stalled.solved, stalled.certain], [false, false], 'one clue lighter: the same rule set no longer finishes it');
  const L = solveLogic(weak, { maxDepth: 2 });
  eq([L.solved, L.certain, L.depth, L.guesses], [true, true, 1, 1], 'and exactly one assumption buys it back');
  eq(keySet(L.placements), keySet(C.solutions[0]), 'still the same single board');
});

run();
