// The exhaustive solution counter. This is the file the game's central claim rests on:
// "解数 = 1，已证明" is only true because something walked every possibility and came back
// with exactly one. Everything the UI prints about uniqueness, and the generator's
// accept/reject decision, comes out of here — never from a size heuristic or a special
// case for a particular grid.
//
// HOW IT SEARCHS
//
// It does not enumerate ship placements. It walks one line at a time and chooses, for each
// line, a bitmask of occupied cells. Two facts make that exact rather than approximate:
//
//   (A) Because ships may not touch — not even on a corner — a maximal run of occupied
//       cells in a line is either one ship lying along that line (run length >= 2) or a
//       slice of a ship crossing the line (run length 1). Two ships side by side in a line
//       is not a thing that can happen.
//   (B) So a full assignment of line masks decomposes into a fleet in exactly one way.
//       Counting assignments whose ships match the fleet multiset *is* counting solutions:
//       no double counting, no gaps.
//
// Consecutive lines are linked by three checks, and only three:
//   1. no corner touching:   ((prev << 1) | (prev >> 1)) & cur == 0
//   2. a shared column means the same ship crossing the line boundary, so that cell has to
//      be a run of length 1 in *both* lines — a ship lying along a line can never sit
//      directly on top of another ship
//   3. bookkeeping: the column clues must still be reachable, and the ship being built must
//      still be able to turn into one of the lengths the fleet is owed
//
// SEARCH ORDER
//
// The walk goes along whichever axis admits fewer candidate masks in total — the most
// tightly filled lines first, which is the "pick the most constrained line" heuristic from
// the spec made concrete. That can transpose the board; transposing is a bijection on
// solutions (ships rotate, a corner stays a corner, a count stays a count), so each
// solution is mapped back through the transpose before it is returned.
//
// BUDGETS
//
// `limit` stops the walk as soon as that many solutions are known, which is all the game
// ever needs: countSolutions(spec, 2) answers "unique, or not?" and costs one solution plus
// the discovery of a second. `nodes` bounds the walk for pathological specs; hitting it
// reports complete: false with stopped: 'budget' instead of guessing an answer.

import { FREE, popcount, runs, singletons, fleetCounts } from './model.js';

function transpose(spec) {
  return {
    rows: spec.cols,
    cols: spec.rows,
    fleet: spec.fleet.slice(),
    rowReq: spec.colReq.slice(),
    colReq: spec.rowReq.slice(),
  };
}

function untranspose(ship) {
  // A length-1 ship has no orientation, so it keeps the canonical 'h' rather than coming
  // back from a transposed walk labelled 'v' — the cell set is the answer, and the label is
  // not allowed to disagree with the one js/core/model.js's fitments() would have written.
  if (ship.len === 1) return { r: ship.c, c: ship.r, len: 1, axis: 'h' };
  return { r: ship.c, c: ship.r, len: ship.len, axis: ship.axis === 'h' ? 'v' : 'h' };
}

// Candidate masks for one line of `width` cells holding exactly `clue` occupied cells.
function masksFor(width, clue) {
  const out = [];
  const all = 1 << width;
  for (let m = 0; m < all; m++) {
    if (clue !== FREE && popcount(m) !== clue) continue;
    out.push(m);
  }
  return out;
}

// Which axis to walk along: the one whose lines admit fewer masks.
function walkColumns(spec) {
  let inRows = 0;
  for (const v of spec.rowReq) inRows += masksFor(spec.cols, v).length;
  let inCols = 0;
  for (const v of spec.colReq) inCols += masksFor(spec.rows, v).length;
  return inCols < inRows;
}

// The fleet a run of line masks describes. Only reached at a leaf, so it is written for
// clarity; fact (B) in the header is why this is unambiguous.
function decode(line, width, height) {
  const ships = [];
  const at = (r, c) => (r < 0 || c < 0 || r >= height || c >= width ? 0 : (line[r] >> c) & 1);
  for (let r = 0; r < height; r++) {
    for (const run of runs(line[r], width)) {
      if (run.len > 1) {
        ships.push({ r, c: run.from, len: run.len, axis: 'h' });
        continue;
      }
      const c = run.from;
      if (at(r - 1, c)) continue; // emitted from the row this ship started in
      let len = 1;
      while (at(r + len, c)) len++;
      ships.push({ r, c, len, axis: len === 1 ? 'h' : 'v' });
    }
  }
  return ships;
}

export function countSolutions(spec, limit = 2, opts = {}) {
  const budget = opts.nodes === undefined ? 2000000 : opts.nodes;
  const flip = opts.axis === 'cols' ? true : opts.axis === 'rows' ? false : walkColumns(spec);
  const s = flip ? transpose(spec) : spec;
  const rows = s.rows;
  const cols = s.cols;
  const maxLen = Math.max(...s.fleet);
  const W = maxLen + 1; // length slot width, indexed by ship length

  const need = new Int16Array(W);
  for (const [len, n] of fleetCounts(s.fleet)) need[len] = n;

  // Per-depth state in indexed slots. A child writes only into its own slot, so a rejected
  // attempt needs no unwinding at all and the parent's numbers are never touched.
  const line = new Int32Array(rows);
  const open = new Int16Array((rows + 1) * cols); // crossing ship length ending at line t-1
  const col = new Int16Array((rows + 1) * cols); // cells still owed to each column
  const used = new Int16Array((rows + 1) * W); // ships of each length closed so far
  // A FREE column is not a target, it is an upper bound: it owes nothing, so the "can this
  // column still be filled?" prune and the "is every column full?" leaf test both skip it.
  const colFree = new Int8Array(cols);
  for (let c = 0; c < cols; c++) {
    colFree[c] = s.colReq[c] === FREE ? 1 : 0;
    col[c] = colFree[c] ? rows : s.colReq[c];
  }

  const cand = s.rowReq.map((v) => masksFor(cols, v));
  const singles = new Map();
  const singleOf = (m) => {
    let v = singles.get(m);
    if (v === undefined) {
      v = singletons(m, cols);
      singles.set(m, v);
    }
    return v;
  };

  let count = 0;
  let visited = 0;
  let stopped = null;
  const found = [];

  // Is any ship still owed that this crossing ship could turn out to be?
  function owed(base, len) {
    for (let l = len; l < W; l++) if (used[base + l] < need[l]) return true;
    return false;
  }

  function audit(t) {
    const cBase = t * cols;
    const uBase = t * W;
    const closing = [];
    for (let c = 0; c < cols; c++) {
      if (col[cBase + c] !== 0 && !colFree[c]) return; // a column clue nobody filled
      if (open[cBase + c]) closing.push(open[cBase + c]);
    }
    // Everything still crossing the bottom edge closes right here.
    let ok = true;
    for (const len of closing) {
      if (used[uBase + len] >= need[len]) {
        ok = false;
        break;
      }
      used[uBase + len]++;
    }
    if (ok) {
      for (let l = 1; l < W; l++) if (used[uBase + l] !== need[l]) { ok = false; break; }
    }
    for (const len of closing) used[uBase + len]--;
    if (!ok) return;
    count++;
    if (found.length < limit) {
      const ships = decode(line, cols, rows);
      found.push(flip ? ships.map(untranspose) : ships);
    }
    if (count >= limit) stopped = 'limit';
  }

  function walk(t) {
    if (stopped) return;
    visited++;
    if (visited > budget) {
      stopped = 'budget';
      return;
    }
    if (t === rows) {
      audit(t);
      return;
    }
    const mBase = t * cols;
    const nBase = (t + 1) * cols;
    const uHere = t * W;
    const uNext = (t + 1) * W;
    const prev = t ? line[t - 1] : 0;
    const rowsLeft = rows - t - 1;

    for (const m of cand[t]) {
      if (prev) {
        if ((((prev << 1) | (prev >> 1)) & m) !== 0) continue; // 1. no corners touching
        const shared = prev & m;
        if (shared && (shared & ~(singleOf(prev) & singleOf(m)))) continue; // 2. crossings only
      }
      for (let l = 1; l < W; l++) used[uNext + l] = used[uHere + l];
      let ok = true;
      for (let c = 0; c < cols; c++) {
        const was = open[mBase + c];
        if ((m >> c) & 1) {
          const left = col[mBase + c] - 1;
          if (left < 0 || (!colFree[c] && left > rowsLeft)) {
            ok = false;
            break;
          }
          col[nBase + c] = left;
          // Only a run of length 1 can be a ship crossing this line; a cell inside a
          // longer run belongs to a ship lying along the line, which closed the moment
          // it was written, so it opens nothing below.
          if ((singleOf(m) >> c) & 1) {
            const len = was ? was + 1 : 1;
            if (len > maxLen || !owed(uNext, len)) {
              ok = false;
              break;
            }
            open[nBase + c] = len;
          } else {
            if (was) {
              ok = false;
              break;
            }
            open[nBase + c] = 0;
          }
        } else {
          col[nBase + c] = col[mBase + c];
          open[nBase + c] = 0;
          if (was) {
            if (used[uNext + was] >= need[was]) {
              ok = false;
              break;
            }
            used[uNext + was]++;
          }
        }
      }
      if (ok) {
        for (const run of runs(m, cols)) {
          if (run.len < 2) continue;
          // A run longer than the longest ship in the fleet is not a fleet: with a free line
          // clue the mask generator will happily hand one back, and `need[len]` for a length
          // the fleet never promised reads as undefined, which compares false against
          // everything. Refuse it by name instead.
          if (run.len > maxLen) {
            ok = false;
            break;
          }
          if (used[uNext + run.len] >= need[run.len]) {
            ok = false;
            break;
          }
          used[uNext + run.len]++;
        }
      }
      if (!ok) continue;
      line[t] = m;
      walk(t + 1);
      if (stopped) return;
    }
  }

  walk(0);

  return {
    count,
    complete: stopped === null,
    stopped,
    nodes: visited,
    axis: flip ? 'cols' : 'rows',
    solutions: found,
  };
}

// "Exactly one?" — the only question the rest of the game asks of the counter. `unique` is
// only ever true when the walk finished, so a budget hit reads as "not proved", never as
// "no".
export function isUnique(spec, opts) {
  const r = countSolutions(spec, 2, opts);
  return {
    unique: r.count === 1 && r.complete,
    solutions: r.count,
    complete: r.complete,
    stopped: r.stopped,
    nodes: r.nodes,
    solution: r.solutions[0] || null,
  };
}

// Every solution up to `limit`, for the cross-check in test/count.test.mjs that compares
// the reasoning solver's answer against a board the counter itself found.
export function listSolutions(spec, limit = 4, opts) {
  const r = countSolutions(spec, limit, opts);
  return { solutions: r.solutions, count: r.count, complete: r.complete, stopped: r.stopped, nodes: r.nodes };
}
