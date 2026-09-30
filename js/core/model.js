// The board model — geometry and the shapes every other file argues about.
//
//   spec      { rows, cols, fleet: [len..], rowReq: [n | -1 ..], colReq: [n | -1 ..] }
//   ship      { r, c, len, axis: 'h' | 'v' }        // top-left cell, running right/down
//   placement [ ship, ... ]                         // one per fleet entry, same order
//
// A cell is UNKNOWN / SHIP / WATER. A clue of -1 (FREE) means the line is not
// constrained, which only ever happens in a deliberately weakened puzzle: the
// uniqueness refutation in test/count.test.mjs erases one row clue and expects the
// counter to notice.
//
// This file knows *geometry* only. It decides nothing about how many solutions a spec
// has (js/core/count.js) and nothing about whether a human can reason it out
// (js/core/logic.js), and the independent checker lives in js/core/check.js.

export const UNKNOWN = 0;
export const SHIP = 1;
export const WATER = 2;
export const FREE = -1;

// ---------------------------------------------------------------- ships and cells

export function axisOf(ship) {
  return ship.axis === 'v' ? 'v' : ship.axis === 'h' ? 'h' : null;
}

// Cells a ship covers, as [index, ...] into a rows×cols grid.
export function cellsOf(ship, cols) {
  const out = [];
  for (let k = 0; k < ship.len; k++) {
    out.push(ship.r * cols + ship.c + (ship.axis === 'v' ? k * cols : k));
  }
  return out;
}

export function inside(ship, rows, cols) {
  if (ship.r < 0 || ship.c < 0) return false;
  if (ship.r >= rows || ship.c >= cols) return false;
  return ship.axis === 'v' ? ship.r + ship.len <= rows : ship.c + ship.len <= cols;
}

// Every in-bounds position/orientation for one ship length. A length-1 ship has no
// orientation, so it gets one entry: otherwise "rotate the submarine" would be a second
// way to spell the same placement and every candidate count would double.
export function fitments(rows, cols, len) {
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c + len <= cols) out.push({ r, c, len, axis: 'h' });
      if (len > 1 && r + len <= rows) out.push({ r, c, len, axis: 'v' });
    }
  }
  return out;
}

// Chebyshev adjacency: two ships touch when any of their cells is a king's move apart.
// Diagonal counts — that is the Akaji rule, and it is the single assumption in this file
// that changes the solution count if you break it (README prints this).
export function cellsRC(ship) {
  const out = [];
  for (let k = 0; k < ship.len; k++) {
    out.push(ship.axis === 'v' ? [ship.r + k, ship.c] : [ship.r, ship.c + k]);
  }
  return out;
}

export function touching(a, b) {
  const set = new Set(cellsRC(a).map(([r, c]) => `${r},${c}`));
  for (const [r, c] of cellsRC(b)) {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (set.has(`${r + dr},${c + dc}`)) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------- line geometry

export function popcount(mask) {
  let m = mask;
  let n = 0;
  while (m) {
    n += m & 1;
    m >>= 1;
  }
  return n;
}

export function bitsOf(mask) {
  const out = [];
  for (let b = 0; mask; b++, mask >>= 1) if (mask & 1) out.push(b);
  return out;
}

// Maximal runs of occupied cells in a line of `width` bits. The structural fact this
// whole model leans on: because two ships may not touch (even diagonally), a run of
// length >= 2 can only ever be ONE horizontal ship, and a run of length 1 is either a
// length-1 ship or a slice of a vertical one. So a set of row masks decomposes into a
// fleet in exactly one way — which is what lets js/core/count.js enumerate solutions by
// walking rows instead of guessing ship placements.
export function runs(mask, width) {
  const out = [];
  let start = -1;
  for (let c = 0; c <= width; c++) {
    const on = c < width && (mask >> c) & 1;
    if (on && start < 0) start = c;
    if (!on && start >= 0) {
      out.push({ from: start, len: c - start });
      start = -1;
    }
  }
  return out;
}

export function singletons(mask, width) {
  let s = 0;
  for (const run of runs(mask, width)) if (run.len === 1) s |= 1 << run.from;
  return s;
}

// The cells a mask rules out for the rows above and below: everything occupied, plus one
// column of slack on each side.
export function halo(mask) {
  return mask | (mask << 1) | (mask >> 1);
}

// ---------------------------------------------------------------- clues and identity

export function clueSums(spec) {
  let rowSum = 0;
  let colSum = 0;
  let rowOpen = 0;
  let colOpen = 0;
  for (const v of spec.rowReq) v === FREE ? rowOpen++ : (rowSum += v);
  for (const v of spec.colReq) v === FREE ? colOpen++ : (colSum += v);
  const fleetSum = spec.fleet.reduce((a, b) => a + b, 0);
  return { rowSum, colSum, fleetSum, rowOpen, colOpen };
}

// The free structural theorem: occupied cells counted by row, by column and by ship are
// three ways of counting the same set. If a spec fails this it does not describe a
// fleet, whatever the counters say — js/core/check.js rejects it on those grounds alone.
export function identity(spec) {
  const s = clueSums(spec);
  return { ...s, ok: s.rowOpen === 0 && s.colOpen === 0 && s.rowSum === s.colSum && s.colSum === s.fleetSum };
}

export function fleetCounts(fleet) {
  const need = new Map();
  for (const len of fleet) need.set(len, (need.get(len) || 0) + 1);
  return need;
}

// ---------------------------------------------------------------- state helpers

export function blankGrid(spec) {
  return new Uint8Array(spec.rows * spec.cols);
}

export function occupancy(ships, spec, into) {
  const grid = into || blankGrid(spec);
  grid.fill(UNKNOWN);
  for (const ship of ships) {
    for (const cell of cellsOf(ship, spec.cols)) grid[cell] = SHIP;
  }
  return grid;
}

// The placement a game in progress has committed, in fleet order — the shape
// js/core/check.js wants, and the shape a save file stores.
export function placementOf(ships) {
  return ships.filter((s) => s.onBoard).map((s) => ({ r: s.r, c: s.c, len: s.len, axis: s.axis }));
}

// Two placements agree when they cover the same cells with the same ships. A length-1 ship
// has no orientation, so its `axis` field is deliberately ignored — otherwise a counter that
// walked the transposed board would report the same solution as a different one.
export function sameShips(a, b) {
  if (a.length !== b.length) return false;
  const key = (s) => `${s.len === 1 ? '-' : s.axis}${s.r},${s.c}+${s.len}`;
  const sa = a.map(key).sort();
  const sb = b.map(key).sort();
  return sa.every((k, i) => k === sb[i]);
}

// ---------------------------------------------------------------- serialisation

// Specs are plain JSON by construction; these two exist so a test can round-trip a puzzle
// through exactly the bytes that ship in js/data/puzzles.js.
export function serialize(spec) {
  return JSON.stringify({
    rows: spec.rows,
    cols: spec.cols,
    fleet: spec.fleet.slice(),
    rowReq: spec.rowReq.slice(),
    colReq: spec.colReq.slice(),
    ships: (spec.ships || []).map((s) => ({ r: s.r, c: s.c, len: s.len, axis: s.axis })),
  });
}

export function deserialize(text) {
  const p = JSON.parse(text);
  return {
    rows: p.rows,
    cols: p.cols,
    fleet: p.fleet,
    rowReq: p.rowReq,
    colReq: p.colReq,
    ships: p.ships,
  };
}

// The board as text. Used by the docs and by test/fixture.test.mjs, whose expectations are
// typed by hand rather than produced by this function.
export function draw(spec, ships, waters = []) {
  const { rows, cols } = spec;
  const grid = occupancy(ships, spec);
  for (const w of waters) grid[w.r * cols + w.c] = WATER;
  const lines = [];
  for (let r = 0; r < rows; r++) {
    let s = '';
    for (let c = 0; c < cols; c++) {
      s += grid[r * cols + c] === SHIP ? '#' : grid[r * cols + c] === WATER ? '~' : '.';
    }
    lines.push(s);
  }
  return lines.join('\n');
}
