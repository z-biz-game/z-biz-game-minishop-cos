// The shipped data file is the game's whole claim, so this suite reads *only* the bytes in
// js/data/puzzles.js — never the generator's in-memory object — and re-runs both proofs on
// them: js/core/count.js must return exactly one solution, and js/core/logic.js must reach
// the depth printed beside it. A hand-edited row therefore cannot survive this file, which
// is why the docs are allowed to print 解数 = 1 已证明.
//
// Every expectation here is either typed by hand (the counts, the bands) or is the row's own
// printed number, deliberately re-derived rather than trusted.

import { test, run, ok, eq } from '../tools/harness.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { PUZZLES, TIERS_META } from '../js/data/puzzles.js';
import { countSolutions, isUnique } from '../js/core/count.js';
import { solveLogic } from '../js/core/logic.js';
import { validate, validateSpec } from '../js/core/check.js';
import { serialize, deserialize, sameShips, identity, draw } from '../js/core/model.js';
import { hashSeed, mulberry32, rngFrom, todayKey } from '../js/core/rng.js';
import { scatter, tierByKey, TIERS } from '../js/core/make.js';
import {
  ALL, TIERS as LIB_TIERS, byId, levelAt, puzzlesIn, randomPuzzle, dailyPuzzle, campaign, stats,
} from '../js/core/library.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const BANDS = { harbour: 0, patrol: 1, crossing: 2, lone: 3 };
const PER_BAND = 12;

test('the pool is 48 boards, twelve per band, and the bands are the four the ladder names', () => {
  eq(PUZZLES.length, 48, 'row count of js/data/puzzles.js');
  eq(Object.keys(BANDS), TIERS.map((t) => t.key), 'js/core/make.js ladder');
  for (const [tier, k] of Object.entries(BANDS)) {
    eq(puzzlesIn(tier).length, PER_BAND, `${tier} ships ${PER_BAND} boards`);
    for (const p of puzzlesIn(tier)) {
      eq(p.depth, k, `${p.id} sits in the k=${k} band`);
      eq(p.tier, tier);
    }
  }
});

test('every shipped spec is a legal spec: the counting identity holds row by row', () => {
  for (const p of PUZZLES) {
    eq(validateSpec(p.spec), null, `${p.id} validateSpec`);
    const id = identity(p.spec);
    eq([id.rowSum === id.colSum, id.colSum === id.fleetSum, id.rowOpen, id.colOpen],
      [true, true, 0, 0], `${p.id} Σ(row) = Σ(col) = Σ(fleet)`);
  }
});

test('解数 = 1 是复算出来的：反序列化之后重新穷举，48 题全部只有一解', () => {
  const t0 = Date.now();
  for (const p of PUZZLES) {
    const spec = deserialize(serialize(p.spec)); // exactly the bytes that ship
    const c = countSolutions(spec, 2);
    eq([c.count, c.complete, c.stopped], [1, true, null], `${p.id} exhaustive count`);
    eq(isUnique(spec).unique, true, `${p.id} isUnique agrees`);
  }
  ok(Date.now() - t0 < 4000, `the whole re-proof took ${Date.now() - t0} ms`);
});

test('the one solution the counter finds is the board baked into the same row', () => {
  for (const p of PUZZLES) {
    const c = countSolutions(deserialize(serialize(p.spec)), 2);
    ok(sameShips(c.solutions[0], p.spec.ships), `${p.id}: the unique board is the printed fleet`);
    eq(validate(deserialize(serialize(p.spec)), p.spec.ships), null, `${p.id}: and the checker signs it`);
  }
});

test('nodes 那一列也是量出来的：重跑计数器必须复现印着的搜索节点数', () => {
  for (const p of PUZZLES) {
    eq(countSolutions(deserialize(serialize(p.spec)), 2).nodes, p.nodes, `${p.id} nodes`);
  }
  eq(Math.max(...PUZZLES.map((p) => p.nodes)), 287, 'the deepest search the pool needed');
});

test('推理深度 k 复现：把预算放宽一层，逻辑求解器给出同一道题的同一个数', () => {
  for (const p of PUZZLES) {
    const L = solveLogic(deserialize(serialize(p.spec)), { maxDepth: p.depth + 1, nodes: 200000 });
    eq([L.solved, L.certain, L.depth, L.guesses], [true, true, p.depth, p.guesses], `${p.id} depth`);
    ok(L.placements.every((s) => s.len >= 1), `${p.id} returned whole ships`);
    ok(sameShips(L.placements, p.spec.ships), `${p.id}: reasoning lands on the exhaustively unique board`);
  }
});

test('k 是最小的那一层：少给一层假设预算，深度 > 0 的每一道题就不再被证明解出', () => {
  // This is what makes the printed 深度 a lower bound rather than an opinion: the rule set
  // provably cannot finish these boards with fewer assumptions. (Depth 0 rows are skipped —
  // there is no budget below zero, and logic.test.mjs already pins those on the fixtures.)
  const deeper = PUZZLES.filter((p) => p.depth > 0);
  eq(deeper.length, 36, 'three bands of twelve');
  for (const p of deeper) {
    const L = solveLogic(deserialize(serialize(p.spec)), { maxDepth: p.depth - 1, nodes: 200000 });
    eq([L.solved, L.certain], [false, false], `${p.id} at maxDepth ${p.depth - 1}`);
    // Two honest verdicts, never a fake one: either the rule set ran out of deductions at
    // depth 0 (`maxDepth: 0` cannot even cut a branch), or the branch budget stopped it.
    ok(['the rule set cannot finish this board', 'not proved within the budget'].includes(L.why),
      `${p.id} says why: ${L.why}`);
    // One layer of slack is not decoration: at exactly `k` the walk can still be cut while
    // proving that no shallower route exists (js/core/make.js documents `maxDepth = k + 1`
    // for this reason). What must never happen is a shortened search inventing a *different*
    // board, so the answer is cross-checked whenever it is returned at all.
    const exact = solveLogic(deserialize(serialize(p.spec)), { maxDepth: p.depth, nodes: 200000 });
    if (exact.solved) {
      ok(sameShips(exact.placements, p.spec.ships), `${p.id} at maxDepth ${p.depth}: same unique board`);
    } else {
      eq(exact.certain, false, `${p.id} at maxDepth ${p.depth} says it is unsure rather than guessing`);
    }
  }
});

test('TIERS_META 的区间是发出去的关卡算出来的，不是生成器的愿望', () => {
  for (const meta of TIERS_META) {
    const mine = puzzlesIn(meta.key);
    const depths = mine.map((p) => p.depth);
    eq([meta.min, meta.max], [Math.min(...depths), Math.max(...depths)], `${meta.key} band`);
    eq([meta.rows, meta.cols], [mine[0].spec.rows, mine[0].spec.cols], `${meta.key} grid size`);
    eq(meta.fleet, mine[0].spec.fleet, `${meta.key} fleet`);
    ok(new RegExp(`${meta.rows}×${meta.cols}`).test(meta.blurb), meta.blurb);
  }
  eq(TIERS_META.map((t) => `${t.key}:${t.min}`).join(','), 'harbour:0,patrol:1,crossing:2,lone:3');
});

test('library.stats() measures the pool instead of restating it', () => {
  const s = stats();
  eq(s.puzzles, 48);
  eq(Object.keys(s.byTier), ['harbour', 'patrol', 'crossing', 'lone']);
  for (const [key, t] of Object.entries(s.byTier)) {
    eq([t.n, t.min, t.max, t.med], [12, BANDS[key], BANDS[key], BANDS[key]], `${key} depth band`);
    const tier = TIERS.find((x) => x.key === key);
    eq([t.shipsMin, t.shipsMax], [tier.fleet.length, tier.fleet.length], `${key} fleet size`);
    eq([t.cellsMin, t.cellsMax], [tier.rows * tier.cols, tier.rows * tier.cols], `${key} grid`);
    ok(Number.isFinite(t.shipsMin) && Number.isFinite(t.cellsMax), `${key} has no unset statistic`);
  }
  eq(s.byTier.crossing.med, 2);
});

test('the campaign order is shallowest reasoning first, then smallest search', () => {
  eq(campaign(), ALL, 'the campaign is the whole pool in file order');
  eq(ALL.map((p) => p.id), PUZZLES.map((p) => p.id), 'and the prepared rows keep the baked order');
  for (const tier of Object.keys(BANDS)) {
    const nodes = puzzlesIn(tier).map((p) => p.nodes);
    eq(nodes, nodes.slice().sort((a, b) => a - b), `${tier} is ordered by measured nodes`);
  }
  eq(ALL[0].id, 'harbour-01');
  eq(ALL[47].id, 'lone-12');
  eq(byId('crossing-03').tier, 'crossing');
  eq(byId('not-a-level'), null, 'an unknown id is null, and main.js falls back to ALL[0]');
  eq(levelAt(0).id, 'harbour-01');
  eq(levelAt(47).id, 'lone-12');
  eq(levelAt(48).id, 'harbour-01', 'the index wraps rather than falling off');
});

test('每日题与分享链接在任何设备上落到同一道题', () => {
  const day = '2026-09-27';
  const first = dailyPuzzle(day);
  eq(dailyPuzzle(day).id, first.id, 'the same date twice');
  eq(dailyPuzzle(day).id, byId(first.id).id, 'and it is a real row of the pool');
  // The lookup is `ALL[hashSeed('daily|<date>') % 48]`, so the date drives the index and
  // nothing else does. Recompute that arithmetic here rather than calling the helper twice.
  eq(ALL[hashSeed(`daily|${day}`) % ALL.length].id, first.id);
  const distinct = new Set(['2026-01-01', '2026-02-14', '2026-03-07', '2026-07-01', '2026-12-31']
    .map((d) => dailyPuzzle(d).id));
  ok(distinct.size >= 3, `five dates gave ${distinct.size} different boards, a daily slot has to move`);
  eq(todayKey(new Date(2026, 8, 27)), '2026-09-27', 'the date key is zero-padded local time');
  for (const tier of LIB_TIERS) {
    const got = randomPuzzle('fixedseed', tier.key);
    eq(got.tier, tier.key, `${tier.key} random stays in its band`);
    const band = puzzlesIn(tier.key);
    eq(band[hashSeed('random|fixedseed') % band.length].id, got.id, `${tier.key} index is the seed`);
  }
});

test('hashSeed 是 FNV-1a 派生的两轮 UTF-16 混合，不是教科书 FNV-1a', () => {
  // Asserted against itself, never against a published vector: the mixer folds the low byte
  // and the high byte of each code unit with two multiplies, so the ASCII answer differs
  // from the textbook one on purpose. 3826002220 is what a textbook FNV-1a would say.
  eq(hashSeed('a'), 723832900, 'two-round mixer');
  ok(hashSeed('a') !== 3826002220, 'and that is deliberately not the textbook FNV-1a vector');
  eq(hashSeed(''), 0x811c9dc5, 'the empty string is the offset basis');
  eq(hashSeed('daily|2026-09-27'), hashSeed('daily|2026-09-27'), 'pure: same input, same output');
  for (const s of ['', 'a', 'ab', 'lone', 'crossing-12', 'harbour|bake-0', '孤']) {
    const h = hashSeed(s);
    ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff, `${s || '∅'} -> ${h} stays inside 32 bits`);
  }
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(hashSeed(`seed-${i}`));
  ok(seen.size >= 495, `500 seeds landed in ${seen.size} buckets`);
  const above = PUZZLES.filter((p) => hashSeed(p.id) % 2 === 0).length;
  ok(above >= 16 && above <= 32, `ids spread ${above}/48 to one side`);
});

test('mulberry32 and the generator are reproducible: same seed, same scattered fleet', () => {
  eq(mulberry32(7).int(100), mulberry32(7).int(100));
  eq(rngFrom('x').shuffle([1, 2, 3, 4, 5, 6]).join(','), rngFrom('x').shuffle([1, 2, 3, 4, 5, 6]).join(','));
  ok(rngFrom('x').shuffle([1, 2, 3, 4, 5, 6]).join(',') !== '1,2,3,4,5,6', 'and it actually moved them');
  for (const tier of TIERS) {
    const one = scatter('probe-seed', tier);
    const two = scatter('probe-seed', tier);
    ok(one, `${tier.key} scatter returned a board`);
    eq(serialize(one), serialize(two), `${tier.key} scatter is a function of the seed`);
    eq(validate(one, one.ships), null, `${tier.key} scatter is legal by construction`);
    // The clues are *read off* the scattered fleet, not guessed at: recompute them here with
    // plain loops so a scatter that wrote a friendly number would show up.
    const occupied = new Map();
    for (const s of one.ships) {
      for (let k = 0; k < s.len; k++) {
        const r = s.axis === 'v' ? s.r + k : s.r;
        const c = s.axis === 'v' ? s.c : s.c + k;
        occupied.set(`${r},${c}`, true);
      }
    }
    for (let r = 0; r < tier.rows; r++) {
      let n = 0;
      for (let c = 0; c < tier.cols; c++) if (occupied.has(`${r},${c}`)) n++;
      eq(one.rowReq[r], n, `${tier.key} row ${r} clue is what the fleet says`);
    }
    for (let c = 0; c < tier.cols; c++) {
      let n = 0;
      for (let r = 0; r < tier.rows; r++) if (occupied.has(`${r},${c}`)) n++;
      eq(one.colReq[c], n, `${tier.key} column ${c} clue is what the fleet says`);
    }
    ok(serialize(scatter('other-seed', tier)) !== serialize(one), 'a different seed moves it');
  }
});

test('序列化是稳定的：spec 过一遍 JSON 再画一次，还是那张图', () => {
  const p = byId('harbour-01');
  const round = deserialize(serialize(p.spec));
  eq(serialize(round), serialize(p.spec));
  eq(draw(p.spec, p.spec.ships), ['....', '....', '#.#.', '#...'].join('\n'),
    'harbour-01: the vertical 2-ship at (2,0)-(3,0) and the 1-ship at (2,2), read off the file by hand');
  eq(draw(round, round.ships).split('\n').map((l) => (l.match(/#/g) || []).length), p.spec.rowReq,
    'and the drawing adds up to the row clues printed in the same row');
});

test('the pool file itself is generated text, not a hand-typed table', () => {
  const text = readFileSync(join(root, 'js', 'data', 'puzzles.js'), 'utf8');
  ok(text.startsWith('// Generated by tools/bake.mjs'), 'the bake banner is the first line');
  ok(/`node test\/puzzles\.test\.mjs` re-runs both proofs/.test(text), 'and it points at this file');
  eq((text.match(/"id":"/g) || []).length, 48, 'one row per puzzle in the bytes on disk');
  eq((text.match(/"guesses":0/g) || []).length, 12, 'only the k=0 band has a guess-free board');
});

run();
