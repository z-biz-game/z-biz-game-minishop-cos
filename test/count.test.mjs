// The exhaustive counter. Its contract is "the number is the truth, or say you did not
// finish", so every test below either compares it against a second program (the naive
// placement brute force written out here, in this file, not imported from js/core) or
// against a board a person can enumerate by hand.

import { test, run, ok, eq } from '../tools/harness.mjs';
import { countSolutions, isUnique, listSolutions } from '../js/core/count.js';
import { fitments, touching, cellsOf, FREE, serialize } from '../js/core/model.js';
import { validate } from '../js/core/check.js';
import { rngFrom } from '../js/core/rng.js';
import { UNIQUE_4x4, AMBIGUOUS_4x4, IMPOSSIBLE_4x4 } from './fixture.mjs';

// Independent enumeration: put the ships down one at a time in every legal spot, keep the
// boards whose row and column counts match. Slow, obvious, and it shares no code with the
// bitmask walker it is checked against. `spec.rowReq[r] === FREE` means "any count".
function brute(spec, limit = Infinity) {
  const { rows, cols, fleet, rowReq, colReq } = spec;
  const order = fleet.map((len, i) => ({ len, i })).sort((a, b) => b.len - a.len);
  const opts = order.map((s) => fitments(rows, cols, s.len).map((p, idx) => ({ ...p, _i: idx })));
  const ships = [];
  let count = 0;
  function rec(k) {
    if (count >= limit) return;
    if (k === order.length) {
      const grid = new Uint8Array(rows * cols);
      for (const s of ships) {
        for (const cell of cellsOf(s, cols)) {
          if (grid[cell]) return;
          grid[cell] = 1;
        }
      }
      for (let r = 0; r < rows; r++) {
        if (rowReq[r] === FREE) continue;
        let n = 0;
        for (let c = 0; c < cols; c++) n += grid[r * cols + c];
        if (n !== rowReq[r]) return;
      }
      for (let c = 0; c < cols; c++) {
        if (colReq[c] === FREE) continue;
        let n = 0;
        for (let r = 0; r < rows; r++) n += grid[r * cols + c];
        if (n !== colReq[c]) return;
      }
      count++;
      return;
    }
    for (const p of opts[k]) {
      // Two ships of equal length swapped are the same board: only walk nondecreasing indices.
      if (k && order[k].len === order[k - 1].len && p._i < ships[k - 1]._i) continue;
      if (ships.some((s) => touching(s, p))) continue;
      ships.push(p);
      rec(k + 1);
      ships.pop();
    }
  }
  rec(0);
  return count;
}

const keyOf = (ships) => ships.map((s) => `${s.len === 1 ? '-' : s.axis}${s.r},${s.c}+${s.len}`).sort().join('|');

test('the hand-worked 4x4 comes back with exactly one answer, and it is the hand answer', () => {
  const r = countSolutions(UNIQUE_4x4.spec, 2);
  eq([r.count, r.complete, r.stopped], [1, true, null]);
  eq(r.solutions.length, 1);
  eq(keyOf(r.solutions[0]), keyOf(UNIQUE_4x4.solution), 'the counter found the board the drawing shows');
  eq(brute(UNIQUE_4x4.spec), 1, 'and the naive count agrees');
});

test('the ambiguous 4x4 comes back with both answers, not a preferred one', () => {
  const r = countSolutions(AMBIGUOUS_4x4.spec, 5);
  eq([r.count, r.complete], [2, true]);
  eq(r.solutions.map(keyOf).sort(), AMBIGUOUS_4x4.solutions.map(keyOf).sort());
  eq(brute(AMBIGUOUS_4x4.spec), 2);
});

test('the impossible 4x4 comes back with zero, which is a different answer from "unknown"', () => {
  const r = countSolutions(IMPOSSIBLE_4x4.spec, 2);
  eq([r.count, r.complete, r.stopped], [0, true, null], 'a finished walk that found nothing');
  eq(brute(IMPOSSIBLE_4x4.spec), 0);
});

test('limit=2 comes back early: it stops as soon as a second solution exists', () => {
  // A board with a lot of answers: free clues everywhere on a 6x6 with a modest fleet.
  const wide = { rows: 6, cols: 6, fleet: [3, 2], rowReq: [FREE, FREE, FREE, FREE, FREE, FREE], colReq: [FREE, FREE, FREE, FREE, FREE, FREE] };
  const two = countSolutions(wide, 2);
  eq([two.count, two.complete, two.stopped], [2, false, 'limit'], 'the walk stopped on the second solution');
  eq(two.solutions.length, 2, 'and it kept both boards it found');
  const all = countSolutions(wide, 1000000);
  ok(all.complete, 'with no limit the same board is finished');
  ok(two.nodes < all.nodes, `early exit has to be cheaper: ${two.nodes} vs ${all.nodes} nodes`);
  ok(all.count > 100, `the same board has ${all.count} answers, so "2" is a real early return`);
  eq(countSolutions(wide, 1).stopped, 'limit', 'a limit of one stops at the first');
});

test('a budget is reported as unfinished, never as a smaller number', () => {
  // A 6x6 with nothing written down: the mask choices alone are astronomically many, so any
  // real walk needs many nodes. The budget is the only thing being tested here.
  const sea = { rows: 6, cols: 6, fleet: [4, 3, 2], rowReq: [-1, -1, -1, -1, -1, -1], colReq: [-1, -1, -1, -1, -1, -1] };
  const tight = countSolutions(sea, 2, { nodes: 40 });
  eq([tight.complete, tight.stopped], [false, 'budget']);
  ok(tight.count < 2, `an unfinished walk cannot claim two, got ${tight.count}`);
  eq(isUnique(sea, { nodes: 40 }).unique, false, 'and isUnique refuses to call an unfinished walk unique');
  const room = countSolutions(UNIQUE_4x4.spec, 2, { nodes: 40 });
  ok(room.complete, 'a small spec does fit in 40 nodes, so the flag is not always false');
  eq(isUnique(UNIQUE_4x4.spec, { nodes: 40 }).unique, true);
});

test('isUnique: "not proved" and "not unique" are different answers', () => {
  const u = isUnique(UNIQUE_4x4.spec);
  eq([u.unique, u.solutions, !!u.solution], [true, 1, true]);
  eq(keyOf(u.solution), keyOf(UNIQUE_4x4.solution));
  const a = isUnique(AMBIGUOUS_4x4.spec);
  eq([a.unique, a.solutions, a.complete], [false, 2, false], 'two answers means the walk stopped early');
  const n = isUnique(IMPOSSIBLE_4x4.spec);
  eq([n.unique, n.solutions, n.complete], [false, 0, true], 'zero answers is a finished walk too');
});

test('listSolutions hands back whole boards, and they all pass the independent checker', () => {
  const r = listSolutions(AMBIGUOUS_4x4.spec, 4);
  eq([r.solutions.length, r.count], [2, 2]);
  for (const ships of r.solutions) eq(validate(AMBIGUOUS_4x4.spec, ships), null, 'a counted board is a legal board');
});

test('searching rows or searching columns gives the same count and the same boards', () => {
  const rng = rngFrom('axis-agreement');
  for (let i = 0; i < 40; i++) {
    const rows = 4 + rng.int(3);
    const cols = 4 + rng.int(3);
    const fleet = [2 + rng.int(3), 1 + rng.int(3)];
    const spec = { rows, cols, fleet, rowReq: [], colReq: [] };
    for (let r = 0; r < rows; r++) spec.rowReq.push(rng.int(cols + 1));
    for (let c = 0; c < cols; c++) spec.colReq.push(rng.int(rows + 1));
    const a = countSolutions(spec, 6, { axis: 'rows' });
    const b = countSolutions(spec, 6, { axis: 'cols' });
    eq(b.count, a.count, `spec ${serialize(spec)} disagrees between axes`);
    eq(keyOf(a.solutions[0] || []), keyOf(b.solutions[0] || []), 'and the boards themselves');
  }
});

test('the counter agrees with a naive placement search over 400 random specs, free clues included', () => {
  const rng = rngFrom('counter-fuzz');
  let checked = 0;
  let freeSpecs = 0;
  for (let i = 0; i < 400; i++) {
    const rows = 3 + rng.int(3);
    const cols = 3 + rng.int(3);
    const m = 1 + rng.int(3);
    const fleet = [];
    for (let s = 0; s < m; s++) fleet.push(1 + rng.int(Math.min(rows, cols)));
    const spec = { rows, cols, fleet, rowReq: [], colReq: [] };
    const freeChance = i % 4 === 3;
    for (let r = 0; r < rows; r++) spec.rowReq.push(freeChance && rng.chance(0.35) ? FREE : rng.int(cols + 1));
    for (let c = 0; c < cols; c++) spec.colReq.push(freeChance && rng.chance(0.35) ? FREE : rng.int(rows + 1));
    if (freeChance) freeSpecs++;
    const a = brute(spec);
    const b = countSolutions(spec, 1000000);
    checked++;
    ok(b.complete, `a bounded fuzz should finish, spec ${serialize(spec)}`);
    eq(b.count, a, `count mismatch on ${serialize(spec)}`);
  }
  ok(freeSpecs >= 80, `the fuzz has to lean on FREE lines, got ${freeSpecs} specs with them`);
  ok(checked === 400);
});

test('抹一条线索：解数不变 —— 恒等式把那条线的数字顶住了', () => {
  // Not a weakness of the counter, a theorem about the model: with every other row and
  // every column still exact, the total number of occupied cells is fixed at Σfleet, so the
  // erased line's count is implied by arithmetic. The spec suggested this erasure would
  // create a second answer; on a full-clue Akaji board it cannot, and the assertion here is
  // the honest version of that test.
  const base = countSolutions(UNIQUE_4x4.spec, 4);
  eq(base.count, 1);
  for (let r = 0; r < 4; r++) {
    const weak = { ...UNIQUE_4x4.spec, rowReq: UNIQUE_4x4.spec.rowReq.map((v, i) => (i === r ? FREE : v)) };
    eq(countSolutions(weak, 4).count, 1, `erasing row ${r} alone`);
  }
  for (let c = 0; c < 4; c++) {
    const weak = { ...UNIQUE_4x4.spec, colReq: UNIQUE_4x4.spec.colReq.map((v, i) => (i === c ? FREE : v)) };
    eq(countSolutions(weak, 4).count, 1, `erasing column ${c} alone`);
  }
});

test('抹两条线索：解数从 1 涨到 ≥2 —— 计数器真的在数', () => {
  const spec = UNIQUE_4x4.spec;
  let grew = 0;
  for (let r = 0; r < 4; r++) {
    for (let r2 = r + 1; r2 < 4; r2++) {
      const weak = { ...spec, rowReq: spec.rowReq.map((v, i) => (i === r || i === r2 ? FREE : v)) };
      const c = countSolutions(weak, 8);
      if (c.count >= 2) grew++;
      ok(c.count >= 1, `a weakened spec cannot lose its only answer (rows ${r},${r2})`);
    }
  }
  ok(grew >= 4, `pair erasures have to open the board up, only ${grew} did`);
  // The specific pair 抹行 0 和 行 2 — the two rows whose clues were doing the real work.
  const pair = { ...spec, rowReq: [FREE, spec.rowReq[1], FREE, spec.rowReq[3]] };
  eq(countSolutions(pair, 8).count, 3, 'rows 0 and 2 erased leaves three boards');
});

test('the counter does not touch its input', () => {
  const spec = serialize(UNIQUE_4x4.spec);
  const r = countSolutions(UNIQUE_4x4.spec, 2);
  eq(serialize(UNIQUE_4x4.spec), spec, 'the spec is byte-identical afterwards');
  r.solutions[0][0].r = 99;
  eq(serialize(UNIQUE_4x4.spec), spec, 'and mutating a returned board cannot reach back into it');
  eq(countSolutions(UNIQUE_4x4.spec, 2).count, 1, 'a second call gives the same answer');
});

test('the axis choice is reported, and both axes are still correct', () => {
  const r = countSolutions(UNIQUE_4x4.spec, 2);
  ok(r.axis === 'rows' || r.axis === 'cols', r.axis);
  const forced = countSolutions(UNIQUE_4x4.spec, 2, { axis: r.axis === 'rows' ? 'cols' : 'rows' });
  eq(forced.count, r.count);
});

run();
