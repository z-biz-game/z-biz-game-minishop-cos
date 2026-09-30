// The independent checker. If a number in this game is going to be called "proved", the
// thing doing the proving must not share code with the thing being proved — so this file
// deliberately re-derives everything the slow, obvious way: nested loops over cells, a
// plain array of occupancy, no bitmasks, no line plans, nothing imported from
// js/core/count.js or js/core/logic.js.
//
// What it checks, in the order the spec lists it:
//   1. the spec itself is well-formed and passes the counting identity
//      (Σ row clues = Σ col clues = Σ ship lengths)
//   2. every ship sits inside the grid
//   3. no two ships share a cell
//   4. no two ships touch — edge or corner (the Akaji rule)
//   5. every constrained row and column holds exactly its clue of occupied cells
//   6. the placed lengths are exactly the fleet, as a multiset

import { FREE, cellsRC, fleetCounts } from './model.js';

// ---------------------------------------------------------------- 1. the spec

export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') return 'no spec';
  const { rows, cols, fleet, rowReq, colReq } = spec;
  if (!Number.isInteger(rows) || rows < 1) return 'grid needs a positive row count';
  if (!Number.isInteger(cols) || cols < 1) return 'grid needs a positive column count';
  if (!Array.isArray(fleet) || !fleet.length) return 'fleet is empty';
  for (const len of fleet) {
    if (!Number.isInteger(len) || len < 1) return 'a ship needs a whole length of at least 1';
    if (len > rows && len > cols) return 'a ship is longer than the grid can hold in either direction';
  }
  if (!Array.isArray(rowReq) || rowReq.length !== rows) return 'one row clue per row, no more';
  if (!Array.isArray(colReq) || colReq.length !== cols) return 'one column clue per column, no more';
  for (const [i, v] of rowReq.entries()) {
    if (v !== FREE && (!Number.isInteger(v) || v < 0 || v > cols)) return `row clue ${i} is not a cell count for a ${cols}-wide row`;
  }
  for (const [i, v] of colReq.entries()) {
    if (v !== FREE && (!Number.isInteger(v) || v < 0 || v > rows)) return `column clue ${i} is not a cell count for a ${rows}-tall column`;
  }

  // The identity. Three ways of counting the same occupied cells; if they disagree the
  // "puzzle" describes no fleet at all and no counter's opinion about it is worth printing.
  let rowSum = 0;
  let colSum = 0;
  for (const v of rowReq) if (v !== FREE) rowSum += v;
  for (const v of colReq) if (v !== FREE) colSum += v;
  const fleetSum = fleet.reduce((a, b) => a + b, 0);
  if (rowSum !== colSum) return `Σ(row clues) = ${rowSum} but Σ(column clues) = ${colSum}`;
  if (colSum !== fleetSum) return `Σ(column clues) = ${colSum} but the fleet adds up to ${fleetSum}`;
  return null;
}

// ---------------------------------------------------------------- the five placement checks

export function validate(spec, placement) {
  const specErr = validateSpec(spec);
  if (specErr) return specErr;
  if (!Array.isArray(placement)) return 'placement is not a list of ships';
  const { rows, cols } = spec;

  // A plain rows×cols tally board, written out longhand. Cell counts and the overlap and
  // touch tests all read from this, so there is exactly one picture of the board.
  const grid = [];
  for (let r = 0; r < rows; r++) grid.push(new Array(cols).fill(0));
  const seen = [];

  for (const [i, ship] of placement.entries()) {
    const axis = ship.axis === 'v' ? 'v' : ship.axis === 'h' ? 'h' : null;
    if (!axis) return `ship ${i} has neither axis`;
    if (!Number.isInteger(ship.len) || ship.len < 1) return `ship ${i} has no length`;
    if (!Number.isInteger(ship.r) || !Number.isInteger(ship.c)) return `ship ${i} is not on a cell`;

    // 2. in bounds
    if (ship.r < 0 || ship.c < 0 || ship.r >= rows || ship.c >= cols) return `ship ${i} starts outside the grid`;
    if (axis === 'h' && ship.c + ship.len > cols) return `ship ${i} runs off the right edge`;
    if (axis === 'v' && ship.r + ship.len > rows) return `ship ${i} runs off the bottom edge`;

    const cells = cellsRC(ship);
    if (cells.length !== ship.len) return `ship ${i} covers the wrong number of cells`;

    // 3. overlap
    for (const [r, c] of cells) {
      if (grid[r][c] === 1) return `ship ${i} shares a cell with an earlier ship`;
      grid[r][c] = 1;
    }
    seen.push({ i, cells });
  }

  // 4. touch — including corners. Deliberately a separate pass over the finished grid so a
  // bug in the overlap test cannot quietly make it pass.
  for (const ship of seen) {
    for (const [r, c] of ship.cells) {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          if (!grid[rr][cc]) continue;
          const owner = seen.find((s) => s.cells.some(([x, y]) => x === rr && y === cc));
          if (owner && owner.i !== ship.i) return `ships ${ship.i} and ${owner.i} touch${dr && dc ? ' on a corner' : ''}`;
        }
      }
    }
  }

  // 5. row and column occupancy against the clues
  for (let r = 0; r < rows; r++) {
    if (spec.rowReq[r] === FREE) continue;
    let n = 0;
    for (let c = 0; c < cols; c++) n += grid[r][c];
    if (n !== spec.rowReq[r]) return `row ${r} holds ${n} occupied cells, the clue says ${spec.rowReq[r]}`;
  }
  for (let c = 0; c < cols; c++) {
    if (spec.colReq[c] === FREE) continue;
    let n = 0;
    for (let r = 0; r < rows; r++) n += grid[r][c];
    if (n !== spec.colReq[c]) return `column ${c} holds ${n} occupied cells, the clue says ${spec.colReq[c]}`;
  }

  // 6. the fleet as a multiset
  const need = fleetCounts(spec.fleet);
  const got = fleetCounts(placement.map((s) => s.len));
  for (const [len, n] of need) if ((got.get(len) || 0) !== n) return `the fleet wants ${n} ship(s) of length ${len}, the board has ${got.get(len) || 0}`;
  for (const [len, n] of got) if ((need.get(len) || 0) !== n) return `the board carries ${n} extra ship(s) of length ${len}`;
  return null;
}

// "Is this the solved board?" — one call, one answer, and the answer comes from the
// checker above rather than from the solver that baked the puzzle.
export function isSolved(spec, placement) {
  if (placement.length !== spec.fleet.length) return false;
  return validate(spec, placement) === null;
}
