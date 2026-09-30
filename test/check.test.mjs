// The independent checker. Five things can be wrong with a placement and each one has to be
// caught on its own, so a board that fails two tests cannot hide behind the third. The
// random identity sweep at the end is the外部对账 the README promises: three ways of counting
// the same cells, and a spec that fails it never reaches a solver.

import { test, run, ok, eq } from '../tools/harness.mjs';
import { validate, validateSpec, isSolved } from '../js/core/check.js';
import { rngFrom } from '../js/core/rng.js';
import { UNIQUE_4x4, AMBIGUOUS_4x4, IMPOSSIBLE_4x4, BROKEN_SPECS } from './fixture.mjs';

const { spec, solution } = UNIQUE_4x4;

test('the hand-worked board passes, and passes it means "nothing is wrong"', () => {
  eq(validate(spec, solution), null, 'the fixture must be a legal fleet for its own clues');
  eq(isSolved(spec, solution), true);
});

test('越界: a ship running off either edge is refused', () => {
  // The specs below reconcile (Σrow = Σcol = Σfleet = 4) so the bounds test is reached
  // before anything else can complain.
  const wide = { ...spec, fleet: [3, 1], rowReq: [1, 1, 1, 1], colReq: [2, 2, 0, 0] };
  ok(/right edge/.test(validate(wide, [{ r: 0, c: 2, len: 3, axis: 'h' }, { r: 3, c: 0, len: 1, axis: 'h' }])), 'horizontal overflow');
  ok(/bottom edge/.test(validate(wide, [{ r: 2, c: 0, len: 3, axis: 'v' }, { r: 0, c: 3, len: 1, axis: 'h' }])), 'vertical overflow');
  ok(/outside/.test(validate(spec, [{ r: 4, c: 0, len: 2, axis: 'v' }, { r: 0, c: 2, len: 1, axis: 'h' }])), 'a head cell off the grid');
  ok(/negative|outside/i.test(validate(spec, [{ r: -1, c: 0, len: 2, axis: 'v' }, { r: 3, c: 2, len: 1, axis: 'h' }])), 'negative row');
});

test('重叠: two ships on the same cell are refused', () => {
  const overlap = [{ r: 0, c: 0, len: 2, axis: 'v' }, { r: 0, c: 0, len: 1, axis: 'h' }];
  const err = validate(spec, overlap);
  ok(/shares a cell/.test(err), `wanted an overlap report, got ${err}`);
});

test('相邻: ships that touch side-on are refused', () => {
  const side = [{ r: 0, c: 0, len: 2, axis: 'v' }, { r: 2, c: 0, len: 1, axis: 'h' }];
  const err = validate({ ...spec, rowReq: [1, 1, 1, 0], colReq: [3, 0, 0, 0], fleet: [2, 1] }, side);
  ok(/touch/.test(err), `wanted a touch report, got ${err}`);
});

test('相邻含斜角: a corner touch is refused, and that is the Akaji rule', () => {
  // (0,0)-(0,1) lies along row 0; (1,2) touches its stern on the corner and nowhere else.
  const corner = [{ r: 0, c: 0, len: 2, axis: 'h' }, { r: 1, c: 2, len: 1, axis: 'h' }];
  const err = validate({ ...spec, rowReq: [2, 1, 0, 0], colReq: [1, 1, 1, 0], fleet: [2, 1] }, corner);
  ok(/corner/.test(err), `wanted a corner-touch report, got ${err}`);
  // One cell further away the same pair is legal, so the report above was not a false alarm.
  const far = [{ r: 0, c: 0, len: 2, axis: 'h' }, { r: 2, c: 2, len: 1, axis: 'h' }];
  eq(validate({ ...spec, rowReq: [2, 0, 1, 0], colReq: [1, 1, 1, 0], fleet: [2, 1] }, far), null);
});

test('行列占格数: a line with the wrong number of cells is refused, in both directions', () => {
  // Same fleet, shifted one column left: every clue but one is broken.
  const shifted = [{ r: 0, c: 0, len: 2, axis: 'v' }, { r: 3, c: 1, len: 1, axis: 'h' }];
  const err = validate(spec, shifted);
  ok(/column \d+ holds \d+ occupied cells, the clue says/.test(err), `wanted a clue-count report, got ${err}`);
  // A row that is one short, with the columns still balanced.
  const short = [{ r: 0, c: 0, len: 2, axis: 'h' }, { r: 3, c: 3, len: 1, axis: 'h' }];
  const err2 = validate(spec, short);
  ok(/row \d+ holds/.test(err2), `wanted a row-count report, got ${err2}`);
});

test('舰长多重集: the wrong fleet is refused even when the board looks tidy', () => {
  // Every line count is satisfied here: two 1-cell ships at (0,0) and (2,2) against clues
  // [1,0,1,0]/[1,0,1,0]. Only the fleet itself is wrong — it asked for a 2-cell ship.
  const pairSpec = { ...spec, fleet: [2], rowReq: [1, 0, 1, 0], colReq: [1, 0, 1, 0] };
  const twoShort = [{ r: 0, c: 0, len: 1, axis: 'h' }, { r: 2, c: 2, len: 1, axis: 'h' }];
  eq(validate(pairSpec, twoShort), 'the fleet wants 1 ship(s) of length 2, the board has 0');
  // An empty board cannot be reported as a fleet problem: with the identity holding, a
  // missing ship always leaves a line short, and the line count is the more concrete report.
  const oneSpec = { rows: 4, cols: 4, fleet: [2], rowReq: [1, 0, 0, 1], colReq: [2, 0, 0, 0] };
  eq(validate(oneSpec, []), 'row 0 holds 0 occupied cells, the clue says 1');
  // Two submarines, laid where a destroyer should be, do satisfy every line: that is the
  // case only the multiset check can see.
  eq(validate(oneSpec, [{ r: 0, c: 0, len: 1, axis: 'h' }, { r: 3, c: 0, len: 1, axis: 'h' }]),
    'the fleet wants 1 ship(s) of length 2, the board has 0', 'two submarines are not a destroyer');
  // A third hull on the board is refused too, and by the line counts rather than by the
  // multiset: the identity fixes how many cells the fleet owes, so any extra hull must
  // overshoot some line before anything else can notice. That ordering is a property of the
  // checks, and this assertion is where it is written down.
  eq(validate(spec, [...solution, { r: 0, c: 3, len: 1, axis: 'h' }]),
    'row 0 holds 2 occupied cells, the clue says 1');
});

test('the five classes are separate: an illegal axis is its own report', () => {
  ok(/neither axis/.test(validate(spec, [{ r: 0, c: 0, len: 2, axis: 'd' }, solution[1]])));
  ok(/no length/.test(validate(spec, [{ r: 0, c: 0, len: 0, axis: 'v' }, solution[1]])));
  ok(/list of ships/.test(validate(spec, 'not a list')));
  eq(validate(null, []), 'no spec');
});

test('恒等式: a spec whose three counts disagree is rejected before searching', () => {
  for (const broken of BROKEN_SPECS) {
    const err = validateSpec(broken.spec);
    ok(err && /Σ/.test(err), `${broken.why}: wanted an identity report, got ${err}`);
    ok(/Σ\(row clues\)|Σ\(column clues\)/.test(err), `${broken.why}: the report names both sides`);
  }
});

test('恒等式: a hand-checked arithmetic reconciliation, not a shared helper', () => {
  // Recomputed here with plain loops so a bug in model.js clueSums() cannot be laundered
  // through the checker that is supposed to be the second opinion.
  let rows = 0;
  let cols = 0;
  for (const v of spec.rowReq) rows += v;
  for (const v of spec.colReq) cols += v;
  const fleet = spec.fleet.reduce((a, b) => a + b, 0);
  eq([rows, cols, fleet], [3, 3, 3], 'the fixture reconciles');
  eq(validateSpec(spec), null);
});

test('恒等式: 1000 random specs, every one that fails the sum is refused', () => {
  const rng = rngFrom('identity-sweep');
  let bad = 0;
  let good = 0;
  for (let i = 0; i < 1000; i++) {
    const rows = 3 + rng.int(4);
    const cols = 3 + rng.int(4);
    const fleet = [];
    const m = 1 + rng.int(3);
    for (let s = 0; s < m; s++) fleet.push(1 + rng.int(Math.min(rows, cols)));
    const rowReq = [];
    const colReq = [];
    for (let r = 0; r < rows; r++) rowReq.push(rng.int(cols + 1));
    for (let c = 0; c < cols; c++) colReq.push(rng.int(rows + 1));
    let sumR = 0;
    let sumC = 0;
    for (const v of rowReq) sumR += v;
    for (const v of colReq) sumC += v;
    const sumF = fleet.reduce((a, b) => a + b, 0);
    const reconciles = sumR === sumC && sumC === sumF;
    const err = validateSpec({ rows, cols, fleet, rowReq, colReq });
    if (reconciles) {
      good++;
      eq(err, null, `a spec that reconciles (${sumR}=${sumC}=${sumF}) must not be refused for its sums`);
    } else {
      bad++;
      ok(err && /Σ/.test(err), `refused only by the identity: got ${err} for ${sumR}/${sumC}/${sumF}`);
    }
  }
  ok(bad > 700, `the sweep has to be mostly negative to mean anything, got ${bad} rejects`);
  ok(good > 0, `and it has to let some through, got ${good} accepts`);
});

test('a spec with no solutions is still a legal spec: the counter decides that, not the checker', () => {
  eq(validateSpec(IMPOSSIBLE_4x4.spec), null, 'the clues add up: 3 = 3 = 3');
  // An empty board fails a *count* first — column 1 wants three cells — which is the right
  // order: the checker reports the most concrete thing it can see.
  eq(validate(IMPOSSIBLE_4x4.spec, []), 'row 0 holds 0 occupied cells, the clue says 1');
});

test('the ambiguous fixture validates with both of its answers', () => {
  for (const alt of AMBIGUOUS_4x4.solutions) {
    eq(validate(AMBIGUOUS_4x4.spec, alt), null, 'a second solution is a legal board too');
  }
});

run();
