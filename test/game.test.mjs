// The rules behind the canvas, and the save file behind them. `js/main.js` only forwards to
// these functions, so whatever a finger does the panel prints, this file is what decides it.
//
// The two counters are the point of the suite: 操作数 (`ops`) counts every board-changing
// action including water marks, 放置步数 (`steps`) counts placements only, and its floor is
// the fleet size. A rejected action must spend neither, which is why "冲突回弹不计数" is a
// rule of the core rather than an animation trick.

import { test, run, ok, eq } from '../tools/harness.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  createGame, place, retrieve, rotate, tapCell, undo, reset, hint, grade, verify, progress, conflict,
} from '../js/core/game.js';
import { UNKNOWN, SHIP, WATER } from '../js/core/model.js';
import { validate } from '../js/core/check.js';
import { countSolutions } from '../js/core/count.js';
import { byId } from '../js/core/library.js';
import { store } from '../js/core/storage.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// harbour-01, read from the shipped file: 4x4, fleet [2,1], solution
//   (2,0) vertical 2-ship and (2,2) length-1 ship.
const P = byId('harbour-01');
const SOLUTION = [
  { r: 2, c: 0, len: 2, axis: 'v' },
  { r: 2, c: 2, len: 1, axis: 'h' },
];
const fresh = () => createGame(P);

const shipsDown = (g) => g.ships.filter((s) => s.onBoard).map((s) => ({ r: s.r, c: s.c, len: s.len, axis: s.axis }));

// Put hull `i` on the board in the orientation the proved solution uses. `createGame` hands
// every ship out lying horizontally, so "rotate, then drop" is what a player actually does —
// tests that forget the rotation put a different board on the sea than the one they name.
function home(g, i) {
  const want = SOLUTION[i];
  while (g.ships[i].axis !== want.axis) {
    if (!rotate(g, i)) throw new Error(`ship ${i} cannot turn to ${want.axis}`);
  }
  return place(g, i, want.r, want.c);
}

test('a new board knows its fleet, its size and the floor on its placement count', () => {
  const g = fresh();
  eq([g.rows, g.cols], [4, 4]);
  eq(g.spec.fleet, [2, 1]);
  eq([g.ops, g.steps, g.hints, g.done], [0, 0, 0, false]);
  eq(g.par, g.spec.fleet.length, 'par is one placement per ship, and that is a proof not a mood');
  eq(g.par, 2);
  eq(g.ships.map((s) => s.len), [2, 1]);
  eq(g.ships.every((s) => !s.onBoard && s.r === -1), true);
  eq(g.grid.every((v) => v === UNKNOWN), true, 'the sea starts empty');
});

test('a legal placement spends one operation and one placement step', () => {
  const g = fresh();
  const res = place(g, 0, 2, 0);
  eq([res.ok, res.moved, res.done], [true, true, false]);
  eq([g.ops, g.steps], [1, 1]);
  eq(shipsDown(g), [{ r: 2, c: 0, len: 2, axis: 'h' }], 'the ship lands in the orientation it was holding');
  eq([g.grid[2 * 4 + 0], g.grid[2 * 4 + 1]], [SHIP, SHIP]);
  eq(g.ships[0].axis, 'h', 'the dock hands every hull out lying flat');
  eq(g.own.slice(8, 12).join(','), '0,0,-1,-1', 'and it owns exactly its own cells');
});

test('conflict(): every refusal has its own name — 出界 / 水点 / 重叠 / 相邻（含斜角）', () => {
  const g = fresh();
  eq(conflict(g, 0, { r: 0, c: 3, len: 2, axis: 'h' }), 'out', 'runs off the right edge');
  eq(conflict(g, 0, { r: 3, c: 0, len: 2, axis: 'v' }), 'out', 'runs off the bottom edge');
  eq(conflict(g, 0, { r: -1, c: 0, len: 2, axis: 'v' }), 'out', 'starts off the grid');
  eq(conflict(g, 0, { r: 0, c: 0, len: 2, axis: 'h' }), null, 'the same shape in bounds is fine');
  place(g, 0, 2, 0);
  eq(conflict(g, 1, { r: 2, c: 0, len: 1, axis: 'h' }), 'overlap', 'standing on another hull');
  eq(conflict(g, 1, { r: 1, c: 1, len: 1, axis: 'h' }), 'touch', 'side-on is adjacent');
  eq(conflict(g, 1, { r: 1, c: 0, len: 1, axis: 'h' }), 'touch', 'so is a corner — the Akaji rule');
  eq(conflict(g, 1, { r: 0, c: 2, len: 1, axis: 'h' }), null, 'one row clear of the keel is legal');
  tapCell(g, 0, 0);
  eq(conflict(g, 1, { r: 0, c: 0, len: 1, axis: 'h' }), 'water', 'a mark you made yourself blocks it');
});

test('a rejected placement changes nothing at all: no op, no step, no history', () => {
  const g = fresh();
  const res = place(g, 0, 3, 3);
  eq([res.ok, res.reason], [false, 'out']);
  eq([g.ops, g.steps, g.history.length, g.done], [0, 0, 0, false]);
  eq(g.grid.every((v) => v === UNKNOWN), true, 'the board is byte-identical to before');
  place(g, 0, 2, 0);
  const before = JSON.stringify(shipsDown(g));
  eq(place(g, 1, 2, 1).reason, 'overlap');
  eq(JSON.stringify(shipsDown(g)), before, 'and a refused second hull leaves the first alone');
  eq([g.ops, g.steps], [1, 1], 'still one operation in total');
});

test('done means the independent checker signs the board, never "it looks like the answer"', () => {
  const g = fresh();
  eq(verify(g).why, '还有 2 艘没有放下水');
  home(g, 0);
  eq([progress(g).placed, progress(g).fleet], [1, 2]);
  eq(verify(g), { solved: false, why: '还有 1 艘没有放下水' });
  eq(g.done, false, 'a legal-but-unfinished fleet is never finished');
  place(g, 1, 2, 2);
  eq([g.done, g.ops, g.steps], [true, 2, 2], 'one rotate is free, so this is still par');
  eq(verify(g), { solved: true, why: null });
  eq(g.steps, g.par, 'a fleet placed once each is exactly par');
  eq(grade(g), { key: 'clean', label: '一子不差', stars: 3 });
  eq(validate(g.spec, shipsDown(g)), null, 'the checker re-signs it');
  eq(JSON.stringify(shipsDown(g)), JSON.stringify(SOLUTION), 'and that board is the uniquely proved one');
});

test('every other board the same fleet can be put on is refused, because uniqueness was proved', () => {
  // The flip side of 解数 = 1: exactly one placement passes the checker, so a "similar"
  // solution cannot be mistaken for the answer. countSolutions is re-run here rather than
  // trusted from the data file.
  eq(countSolutions(P.spec, 3).count, 1);
  const g = fresh();
  place(g, 0, 0, 0); // the same two hulls, one of them in row 0: legal geometry, wrong board
  place(g, 1, 2, 2);
  eq([g.done, g.steps], [false, 2]);
  eq(verify(g).solved, false);
  ok(/row 0 holds 2 occupied cells, the clue says 0/.test(verify(g).why),
    `the checker names the broken line: ${verify(g).why}`);
});

test('移动已放下的船是一步操作也是一次放置，取回只花操作不退还放置', () => {
  const g = fresh();
  place(g, 0, 2, 0);
  eq([g.ops, g.steps], [1, 1]);
  place(g, 0, 0, 0); // move it: the old cells are cleared first
  eq([g.ops, g.steps, g.history.length], [2, 2, 2]);
  eq(shipsDown(g), [{ r: 0, c: 0, len: 2, axis: 'h' }]);
  eq([g.grid[0], g.grid[1]], [SHIP, SHIP], 'the hull is where the record says it is');
  eq([g.grid[8], g.grid[9], g.grid[12], g.grid[13]], [UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN],
    'nothing was left behind — a move that keeps painting the old wake leaves a ghost hull on the sea');
  eq(g.own.slice(8, 12).join(','), '-1,-1,-1,-1', 'and the ownership map forgets those cells too');
  eq(retrieve(g, 0), true);
  eq([g.ops, g.steps], [3, 2], 'an operation, never a refunded placement');
  eq(g.grid.some((v) => v === SHIP), false, 'taking a hull back clears every cell it held');
  eq(retrieve(g, 0), false, 'and it cannot be taken back twice');
  eq(g.ops, 3);
});

test('撤销 knows what each action type spent', () => {
  const g = fresh();
  eq(undo(g), false, 'an empty history is not undone');
  place(g, 0, 2, 0);
  undo(g);
  eq([g.ops, g.steps, g.history.length], [0, 0, 0]);
  eq(g.ships[0].onBoard, false, 'the hull went back to the dock');
  home(g, 0); // rotate (free) + place: one of each counter
  retrieve(g, 0);
  eq([g.ops, g.steps], [2, 1], 'taking it back spent an operation but no placement step');
  undo(g); // retrieve
  eq([g.ops, g.steps], [1, 1], 'the retrieval is unspent but the placement still stands');
  eq(shipsDown(g), SOLUTION.slice(0, 1), 'undoing a take-back puts the hull home again');
  eq([g.grid[8], g.grid[12]], [SHIP, SHIP], 'and repaints the cells it had cleared');
  tapCell(g, 0, 3);
  eq([g.ops, g.steps, g.grid[3]], [2, 1, WATER]);
  undo(g); // water
  eq([g.ops, g.steps, g.grid[3]], [1, 1, UNKNOWN], 'undoing a mark cannot move a ship');
  rotate(g, 1);
  eq([g.ops, g.steps], [1, 1], 'rotating is free');
  undo(g); // rotate
  eq(g.ships[1].axis, 'h', 'and undoing it puts the orientation back');
  tapCell(g, 0, 3);
  tapCell(g, 0, 3);
  eq([g.ops, g.grid[3], g.steps], [3, UNKNOWN, 1], 'mark, then clear: two operations, one cell each way');
});

test('点水只花操作数：水点与擦水是同一格的两个动作', () => {
  const g = fresh();
  eq(tapCell(g, 1, 1), 'water');
  eq([g.ops, g.steps], [1, 0], 'the placement count did not move');
  eq(tapCell(g, 1, 1), 'clear');
  eq(tapCell(g, 1, 1), 'water');
  place(g, 0, 2, 0);
  eq(tapCell(g, 2, 0), null, 'a cell that holds a hull is not a water tap');
  eq(tapCell(g, 9, 9), null, 'and off-board taps are not taps');
  eq([g.ops, g.steps], [4, 1]);
  reset(g);
  eq([g.ops, g.steps, g.hints, g.history.length, g.grid.some((v) => v !== UNKNOWN)], [0, 0, 0, 0, false]);
});

test('旋转 is free, and a hull that would not fit turned is refused', () => {
  const g = fresh();
  eq(rotate(g, 0), true);
  eq([g.ships[0].axis, g.ops, g.steps, g.history.length], ['v', 0, 0, 1]);
  place(g, 0, 0, 3); // in the dock, out of bounds is not yet a thing
  eq(rotate(g, 0), false, 'a 2-cell hull at column 3 cannot turn vertical on a 4-row board');
  eq(g.ships[0].axis, 'v', 'refused, so unchanged');
  eq(g.ops, 1, 'and still one operation from the placement');
  const g2 = fresh();
  place(g2, 0, 3, 0); // (3,0)-(3,1) along the last row
  eq(rotate(g2, 0), false, 'turning it would run off the bottom edge');
});

// 浏览器三条腿的红都落在这一条规矩上，而 99 条逻辑断言一条都没抓到它：core 里的旋转测试
// 全是「先在舰队条上转、再下水」（home() 就是这个顺序），没有任何一处转一条已经下水的船，
// 于是 rotate() 只改 axis、不改 grid/own 这件事在纯逻辑那半是隐形的。grid 是 conflict()、
// tapCell() 与 progress() 读的那一份，海图文字 draw() 读的是船的记录 —— 所以板子看起来对、
// 规则读到的是一份旧足迹。
test('转过一条已经下水的船，足迹必须跟着走：grid/own 才是冲突与线索读的那一份', () => {
  const g = fresh();
  place(g, 0, 2, 0); // (2,0)-(2,1) lying flat
  eq(rotate(g, 0), true, 'the turn itself is free and allowed');
  eq(shipsDown(g), [{ r: 2, c: 0, len: 2, axis: 'v' }], 'the record says it now runs down');
  eq([g.grid[8], g.grid[9], g.grid[12], g.grid[13]], [SHIP, UNKNOWN, SHIP, UNKNOWN],
    'the wake it left is open sea again — an axis-only turn keeps painting the old shape');
  eq(g.own.slice(8, 12).join(','), '0,-1,-1,-1', 'and it owns only the cells it now covers');
  eq(conflict(g, 1, { r: 2, c: 2, len: 1, axis: 'h' }), null,
    'the proved home of the second hull is legal next to the turned shape');
  eq(conflict(g, 1, { r: 2, c: 1, len: 1, axis: 'h' }), 'touch', 'the cell the hull vacated is no longer a hull');
  eq(conflict(g, 1, { r: 3, c: 1, len: 1, axis: 'h' }), 'touch', 'the cell beside the new keel is the one that touches');
  eq([g.ops, g.steps], [1, 1], 'none of the above spent anything');
  eq(place(g, 1, 2, 2).ok, true, 'so the last legal drop lands');
  eq([g.done, g.ops, g.steps], [true, 2, 2], 'and it finishes the chart at par');

  const g2 = fresh();
  place(g2, 0, 2, 0);
  rotate(g2, 0);
  eq(tapCell(g2, 3, 0), null, 'the cell the hull has just turned into is not a water tap');
  eq(tapCell(g2, 2, 1), 'water', 'the cell it left is open sea and can be marked');
  undo(g2); // the mark
  undo(g2); // the turn
  eq([g2.ships[0].axis, g2.grid[8], g2.grid[9], g2.grid[12]], ['h', SHIP, SHIP, UNKNOWN],
    'undoing a turn puts the paint back where the hull lay, not on top of the ghost');

  const g3 = fresh();
  place(g3, 0, 2, 0);
  eq(progress(g3).rows, [true, true, true, false], 'flat: row 2 hits its 2, row 3 is short of its 1');
  rotate(g3, 0);
  eq(progress(g3).rows, [true, true, false, true], 'turned: the clues move with the hull');
  eq(progress(g3).cols, [true, true, false, true], 'and so do the columns');
});

test('完成后一切都被拒：done 是一个状态而不是一条提示', () => {
  const g = fresh();
  home(g, 0);
  place(g, 1, 2, 2);
  eq(g.done, true);
  eq([place(g, 1, 0, 0), retrieve(g, 0), rotate(g, 0), tapCell(g, 0, 0), hint(g)],
    [{ ok: false, reason: 'done' }, false, false, null, null]);
  eq([g.ops, g.steps], [2, 2], 'none of them spent anything');
  undo(g);
  eq([g.done, g.ops, g.steps], [false, 1, 1], 'but 撤销 does take the last hull back');
});

test('progress() 逐条线索报告满足情况，半完成的板子不会被当成完成', () => {
  const g = fresh();
  eq(progress(g).rows, [true, true, false, false], 'row clues 0,0,2,1: an empty sea satisfies the two zeros');
  eq(progress(g).cols, [false, true, false, true], 'column clues 2,0,1,0, and the two real clues are still short');
  home(g, 0);
  const pr = progress(g);
  eq(pr.rows, [true, true, false, true], 'the 2-ship stands in column 0, so row 2 is still one short');
  eq(pr.cols, [true, true, false, true], 'and column 2 has asked for one it does not have yet');
  eq([pr.placed, pr.fleet, pr.water], [1, 2, 0], 'one hull down out of a fleet of two');
  tapCell(g, 0, 3);
  eq(progress(g).water, 1, 'marks are counted separately from hulls');
  eq(progress(g).rows[0], true, 'and a mark never makes a clue satisfied');
  place(g, 1, 2, 2);
  const done = progress(g);
  eq(done.rows, [true, true, true, true]);
  eq(done.cols, [true, true, true, true]);
  eq([done.placed, done.fleet], [2, 2]);
  eq(g.done, true, 'every line satisfied plus the checker is what done means here');
});

test('hint() 指向唯一解里下一个没回位的船，并说明玩家自己是否挡住了它', () => {
  const g = fresh();
  const h = hint(g);
  eq([h.kind, h.ship.r, h.ship.c, h.ship.len, h.ship.axis], ['ship', 2, 0, 2, 'v']);
  eq(h.blocked, null, 'nothing is in the way yet');
  place(g, 0, 0, 0); // put the 2-ship somewhere else, lying flat
  eq(hint(g).ship, SOLUTION[0], 'it still names the proved home, not the hull that is down');
  eq(hint(g).blocked, null, 'the wrong placement is far enough away');
  tapCell(g, 2, 0);
  eq(hint(g).blocked, 'water', 'and now it says the player is standing on it');
  place(g, 1, 0, 3);
  eq(hint(g).ship, SOLUTION[0], 'a second hull down wrongly still does not count as home');
  reset(g);
  home(g, 0);
  eq(hint(g).ship, SOLUTION[1], 'with the first hull home it names the second');
  place(g, 1, 2, 2);
  eq(hint(g), null, 'a finished board has nothing left to say');
  eq(g.hints, 0, 'core does not bill hints, the shell does');
});

test('grade() 是这两个计数和一个提示数的函数，不是手感', () => {
  const g = fresh();
  g.steps = g.par;
  eq(grade(g).stars, 3, 'par with no hints');
  g.hints = 1;
  eq(grade(g), { key: 'aided', label: '有人指路', stars: 2 });
  g.hints = 0;
  g.steps = g.par + 1;
  eq(grade(g), { key: 'messy', label: '勉强成军', stars: 1 });
  g.steps = 99;
  eq(grade(g).key, 'messy', 'over par stays over par');
});

test('存档：没有 window 时退化为内存，不抛异常也不写花屏', () => {
  eq(typeof globalThis.window, 'undefined', 'this suite runs in node, so localStorage does not exist');
  store.reset();
  eq([Object.keys(store.records).length, store.unlocked, store.stats.solves], [0, 1, 0]);
  const rec = store.solve('harbour-01', { ops: 5, steps: 2, par: 2, hints: 0 });
  eq([rec.solved, rec.bestOps, rec.bestSteps, rec.perfect, rec.plays], [true, 5, 2, true, 1]);
  eq(store.record('harbour-01').bestSteps, 2, 'and it came back out of the same store');
  eq(store.record('nope-99'), null);
});

test('存档：best 只降不升，unlock 只升不降，清档真的清空', () => {
  const visits = store.record('harbour-01').plays; // the store is one singleton for the whole file
  eq(store.solve('harbour-01', { ops: 9, steps: 7, par: 2, hints: 2 }).bestSteps, 2, 'a sloppier replay cannot raise the record');
  eq(store.solve('harbour-01', { ops: 9, steps: 7, par: 2, hints: 2 }).perfect, true, 'the perfect flag, once earned, stays earned');
  const clean = store.solve('harbour-01', { ops: 3, steps: 2, par: 2, hints: 0 });
  eq([clean.bestOps, clean.bestSteps, clean.plays], [3, 2, visits + 3], 'the lower of both wins, plays just counts visits');
  eq(store.unlocked, 1);
  eq(store.unlock(5), 5);
  eq(store.unlock(2), 5, 're-solving an early level cannot lock a later one away');
  eq(store.unlock(5), 5);
  store.markDaily('2026-09-27', 'harbour-01');
  eq(store.dailyDone('2026-09-27').id, 'harbour-01');
  eq(store.dailyDone('2026-09-26'), null);
  eq(store.stats.solves, 4, 'every solve is tallied');
  ok(store.stats.steps >= 8 && store.stats.hints >= 2, JSON.stringify(store.stats));
  store.reset();
  eq([Object.keys(store.records).length, Object.keys(store.daily).length, store.unlocked], [0, 0, 1], 'the wipe is total');
  eq(store.dailyDone('2026-09-27'), null);
});

test('分层：js/core/* 里没有 window、document 或 localStorage（storage.js 之外），也不反向引用上层', () => {
  const dir = join(root, 'js', 'core');
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  eq(files.length, 9, `the pure layer has nine files, found: ${files.join(' ')}`);
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    const isStorage = f === 'storage.js';
    if (isStorage) {
      ok(/try \{[\s\S]*?window\.localStorage[\s\S]*?\} catch/.test(text),
        'storage.js touches localStorage guardedly, so node can import it');
      ok(/cache = blank\(\)/.test(text), 'and it keeps an in-memory copy when the write is refused');
    } else {
      ok(!/\bwindow\.|\bdocument\.|localStorage/.test(text), `${f} stays out of the DOM`);
    }
    ok(!/from '\.\.\/(view|main)\.js'/.test(text), `${f} does not import upward`);
    ok(!/require\(/.test(text), `${f} is a plain ES module`);
  }
  const view = readFileSync(join(root, 'js', 'view.js'), 'utf8');
  ok(!/from '\.\/core\/(count|logic|make)\.js'/.test(view), 'the view never asks a solver anything');
  const main = readFileSync(join(root, 'js', 'main.js'), 'utf8');
  ok(/window\.minishop = \{/.test(main), 'the shell exposes exactly one test hook');
});

run();
