// A puzzle in progress: the pure rules behind the canvas. No DOM in here, which is what
// lets test/game.test.mjs and tools/playtest.mjs drive the same object the screen drives.
//
// THE TWO COUNTS, and why there are two
//
//   ops    操作数  — every action that changes the board: placing, moving, taking a ship
//                    back, marking water, clearing a water mark.
//   steps  放置步数 — successful *placements* only. Marking water is an annotation, not a
//                    placement, so it never touches this number; neither does rotating.
//
// "What is the fewest operations?" only means something once that split is fixed, so README
// prints it next to the two numbers. `steps` has a provable floor: the fleet has m ships and
// each one has to be put down at least once, so par is m and hitting it means nothing was
// placed and then taken back. It is not a difficulty claim — the difficulty of a board in
// this game is 推理深度 k, which comes out of js/core/logic.js.
//
// Undo is a stack of typed actions, and each type knows exactly which counters it spent.
// That is why taking a ship back does not hand a placement step back, and why undoing a
// water mark cannot move a ship.

import { UNKNOWN, SHIP, WATER, FREE, cellsOf, placementOf } from './model.js';
import { validate } from './check.js';

const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

export function createGame(puzzle) {
  const spec = puzzle.spec;
  const n = spec.rows * spec.cols;
  return {
    id: puzzle.id,
    tier: puzzle.tier,
    depth: puzzle.depth,
    solution: puzzle.solution || puzzle.spec.ships,
    spec,
    rows: spec.rows,
    cols: spec.cols,
    grid: new Uint8Array(n), // SHIP where placed, WATER for marks, UNKNOWN elsewhere
    own: new Int16Array(n).fill(-1), // which ship index holds a cell
    ships: spec.fleet.map((len, i) => ({ i, len, axis: 'h', onBoard: false, r: -1, c: -1 })),
    ops: 0,
    steps: 0,
    hints: 0,
    history: [],
    done: false,
    par: spec.fleet.length, // the floor on `steps`: one placement per ship
  };
}

const cellOf = (game, r, c) => (r < 0 || c < 0 || r >= game.rows || c >= game.cols ? -1 : r * game.cols + c);

function paint(game, ship, i, value) {
  for (const cell of cellsOf(ship, game.cols)) {
    game.grid[cell] = value;
    game.own[cell] = value === SHIP ? i : -1;
  }
}

// Why a ship cannot go there: 'out' of bounds, 'water' (a mark is in the way), 'overlap'
// with another ship, 'touch' with another ship including on the corners. null means legal.
export function conflict(game, i, ship) {
  const { rows, cols } = game;
  if (ship.r < 0 || ship.c < 0 || ship.r >= rows || ship.c >= cols) return 'out';
  if (ship.axis === 'h' ? ship.c + ship.len > cols : ship.r + ship.len > rows) return 'out';
  const cells = cellsOf(ship, cols);
  const mine = new Set(cells);
  for (const cell of cells) {
    if (game.grid[cell] === WATER) return 'water';
    if (game.own[cell] >= 0 && game.own[cell] !== i) return 'overlap';
  }
  for (const cell of cells) {
    const r = Math.floor(cell / cols);
    const c = cell % cols;
    for (const [dr, dc] of DIRS) {
      const n = cellOf(game, r + dr, c + dc);
      if (n < 0 || mine.has(n)) continue;
      if (game.grid[n] === SHIP && game.own[n] >= 0 && game.own[n] !== i) return 'touch';
    }
  }
  return null;
}

// Put ship `i` down with its head cell at (r, c), in whatever orientation it currently
// holds. A rejected placement changes nothing at all — no op, no step, no history entry —
// which is what makes "冲突回弹不计数" a property of the rules rather than of the view.
export function place(game, i, r, c) {
  if (game.done) return { ok: false, reason: 'done' };
  const ship = game.ships[i];
  if (!ship) return { ok: false, reason: 'nope' };
  const want = { r, c, len: ship.len, axis: ship.axis };
  const reason = conflict(game, i, want);
  if (reason) return { ok: false, reason };
  // `len` travels with the saved shape on purpose: paint() walks cellsOf(), and a ship
  // record without a length paints nothing, which would leave the old hull printed on the
  // sea after the move. Same reason retrieve() below saves it.
  const was = { onBoard: ship.onBoard, r: ship.r, c: ship.c, len: ship.len, axis: ship.axis };
  if (ship.onBoard) paint(game, was, i, UNKNOWN);
  ship.onBoard = true;
  ship.r = r;
  ship.c = c;
  paint(game, want, i, SHIP);
  game.history.push({ kind: 'place', ship: i, was });
  game.ops++;
  game.steps++;
  game.done = checkDone(game);
  return { ok: true, moved: !was.onBoard, done: game.done };
}

export function retrieve(game, i) {
  if (game.done) return false;
  const ship = game.ships[i];
  if (!ship || !ship.onBoard) return false;
  const from = { r: ship.r, c: ship.c, len: ship.len, axis: ship.axis };
  paint(game, from, i, UNKNOWN);
  ship.onBoard = false;
  ship.r = -1;
  ship.c = -1;
  game.history.push({ kind: 'retrieve', ship: i, from });
  game.ops++; // an operation, never a placement step
  return true;
}

// Flip orientation. Free by rule: no op, no step. A ship already on the board only turns if
// the new shape still fits, so rotating can never be used to slip past a conflict. It is
// still on the undo stack, because taking a rotation back should not cost anything either.
//
// Turning a hull that is already down has to move its footprint with it. `grid`/`own` are
// what conflict(), tapCell() and progress() read, so an axis-only turn leaves a ghost of the
// old shape printed on the sea: the next legal drop beside the *new* shape gets refused as
// 'touch' (and one beside the *old* shape gets accepted), the row/column clues light up for
// cells nobody occupies, and a cell the hull has just moved onto can still be marked water.
// The sea print in draw() reads the ship records, which is exactly why this stayed invisible
// to anything that only looks at the board text.
export function rotate(game, i) {
  if (game.done) return false;
  const ship = game.ships[i];
  if (!ship) return false;
  const axis = ship.axis === 'h' ? 'v' : 'h';
  if (ship.onBoard && conflict(game, i, { r: ship.r, c: ship.c, len: ship.len, axis })) return false;
  game.history.push({ kind: 'rotate', ship: i, from: ship.axis });
  if (ship.onBoard) {
    const at = { r: ship.r, c: ship.c, len: ship.len, axis: ship.axis };
    paint(game, at, i, UNKNOWN); // clear first: the turned shape may share only its head cell
    ship.axis = axis;
    paint(game, { ...at, axis }, i, SHIP);
  } else {
    ship.axis = axis;
  }
  return true;
}

// A tap on a cell that holds no ship: mark it water, or clear a mark that is in the way.
// Returns what happened, or null when the tap is not a water action at all.
export function tapCell(game, r, c) {
  if (game.done) return null;
  const cell = cellOf(game, r, c);
  if (cell < 0 || game.grid[cell] === SHIP) return null;
  if (game.grid[cell] === WATER) {
    game.grid[cell] = UNKNOWN;
    game.history.push({ kind: 'clear', cell });
  } else {
    game.grid[cell] = WATER;
    game.history.push({ kind: 'water', cell });
  }
  game.ops++;
  return game.grid[cell] === WATER ? 'water' : 'clear';
}

export function undo(game) {
  const last = game.history.pop();
  if (!last) return false;
  game.done = false;
  const ship = last.ship === undefined ? null : game.ships[last.ship];
  if (last.kind === 'place') {
    paint(game, { r: ship.r, c: ship.c, len: ship.len, axis: ship.axis }, ship.i, UNKNOWN);
    ship.axis = last.was.axis;
    ship.onBoard = last.was.onBoard;
    ship.r = last.was.r;
    ship.c = last.was.c;
    if (last.was.onBoard) paint(game, last.was, ship.i, SHIP);
    game.ops--;
    game.steps--; // only a placement ever spent a step
  } else if (last.kind === 'retrieve') {
    ship.onBoard = true;
    ship.r = last.from.r;
    ship.c = last.from.c;
    ship.axis = last.from.axis;
    paint(game, last.from, ship.i, SHIP);
    game.ops--;
  } else if (last.kind === 'rotate') {
    if (ship.onBoard) paint(game, { r: ship.r, c: ship.c, len: ship.len, axis: ship.axis }, ship.i, UNKNOWN);
    ship.axis = last.from;
    if (ship.onBoard) paint(game, { r: ship.r, c: ship.c, len: ship.len, axis: ship.axis }, ship.i, SHIP);
  } else if (last.kind === 'water') {
    game.grid[last.cell] = UNKNOWN;
    game.ops--;
  } else if (last.kind === 'clear') {
    game.grid[last.cell] = WATER;
    game.ops--;
  }
  game.done = checkDone(game);
  return true;
}

export function reset(game) {
  game.grid.fill(UNKNOWN);
  game.own.fill(-1);
  for (const ship of game.ships) {
    ship.onBoard = false;
    ship.r = -1;
    ship.c = -1;
    ship.axis = 'h';
  }
  game.ops = 0;
  game.steps = 0;
  game.hints = 0;
  game.history = [];
  game.done = false;
}

function checkDone(game) {
  if (game.ships.some((s) => !s.onBoard)) return false;
  return validate(game.spec, placementOf(game.ships)) === null;
}

// Done means: the fleet is down and the independent checker signs the board. It deliberately
// does NOT compare against the baked solution — js/core/count.js proved that exactly one
// placement can pass that check, so passing it *is* matching the baked answer, and
// test/puzzles.test.mjs asserts the two agree for every shipped puzzle. Asking the checker
// rather than looking the answer up also means a hand-edited data file cannot be "solved" by
// matching a wrong answer.
export function verify(game) {
  const ships = placementOf(game.ships);
  if (ships.length !== game.spec.fleet.length) {
    return { solved: false, why: `还有 ${game.spec.fleet.length - ships.length} 艘没有放下水` };
  }
  const err = validate(game.spec, ships);
  return err ? { solved: false, why: err } : { solved: true, why: null };
}

// Which clues are satisfied, line by line: the panel paints those, and the browser suite
// reads them back to prove a half-built board is never being called finished.
export function progress(game) {
  const rows = [];
  const cols = [];
  for (let r = 0; r < game.rows; r++) {
    const need = game.spec.rowReq[r];
    let have = 0;
    for (let c = 0; c < game.cols; c++) if (game.grid[r * game.cols + c] === SHIP) have++;
    rows.push(need === FREE ? null : have === need);
  }
  for (let c = 0; c < game.cols; c++) {
    const need = game.spec.colReq[c];
    let have = 0;
    for (let r = 0; r < game.rows; r++) if (game.grid[r * game.cols + c] === SHIP) have++;
    cols.push(need === FREE ? null : have === need);
  }
  let water = 0;
  for (const v of game.grid) if (v === WATER) water++;
  return {
    placed: game.ships.filter((s) => s.onBoard).length,
    fleet: game.ships.length,
    water,
    rows,
    cols,
  };
}

// The hint reads the baked answer, which is legitimate precisely because that answer was
// proved unique. It names the next ship that is not down where it belongs, and says whether
// the player's own board is in the way of putting it there.
//
// There is deliberately no "this cell has to be water" branch: `done` is reached exactly when
// the fleet matches the unique solution, so a board whose every ship is already home is a
// finished board, and a hint asked of it returns null below. Marking water is something the
// player does with taps, not something a hint has to spend.
export function hint(game) {
  if (game.done) return null;
  for (const ship of game.solution) {
    const there = game.ships.some((s) => s.onBoard && s.r === ship.r && s.c === ship.c && s.len === ship.len && s.axis === ship.axis);
    if (!there) {
      return { kind: 'ship', ship, r: ship.r, c: ship.c, blocked: conflict(game, -1, ship) };
    }
  }
  return null;
}

// Stars are a fact about the two counters: par on `steps` means the fleet went down without
// a single take-back, and no hint was spent.
export function grade(game) {
  if (game.steps > game.par) return { key: 'messy', label: '勉强成军', stars: 1 };
  if (game.hints > 0) return { key: 'aided', label: '有人指路', stars: 2 };
  return { key: 'clean', label: '一子不差', stars: 3 };
}
