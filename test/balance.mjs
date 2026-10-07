// What a level actually costs, measured rather than estimated.
//
//   node test/balance.mjs
//   SEEDS=12 node test/balance.mjs      # same shape tools/bake.mjs uses
//
// This is not an assertion suite: it is the number behind two claims the README makes —
// "generation is a build-time tool" and "difficulty is a measurement". Both stand or fall
// on the acceptance rate of a band and on how long one proved board takes, so this file
// prints both, from the shipped code, on the machine you are asking.
//
// Everything is counter-budgeted inside js/core/make.js (no clocks, no wall-clock cutoffs),
// so the attempt counts below reproduce exactly. Only the milliseconds are machine-dependent
// and they are printed as milliseconds, not as a claim.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TIERS, makePuzzle } from '../js/core/make.js';
import { countSolutions } from '../js/core/count.js';
import { solveLogic } from '../js/core/logic.js';
import { serialize, deserialize } from '../js/core/model.js';
import { validateSpec } from '../js/core/check.js';
import { PUZZLES } from '../js/data/puzzles.js';

const SEEDS = Number(process.env.SEEDS || 6);
const ms = (ns) => Number(ns) / 1e6;
const pad = (s, n) => String(s).padEnd(n);
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');

// 这张表以前只打印不表态：一档接不出一张板子，它照样把十列表打完然后 rc=0，而"改 band 之前
// 先跑这个文件"这句话指望的就是这个 rc。
const fails = [];

const hr = (fn, times) => {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < times; i++) fn(i);
  return ms(process.hrtime.bigint() - t0) / times;
};

// --------------------------------------------------------------- 1. acceptance per band

console.log(`\n生成成本（每个 tier 跑 ${SEEDS} 个种子，与 tools/bake.mjs 同一条流水线）\n`);
const W = [10, 6, 10, 8, 9, 9, 9, 12, 11];
const head = ['tier', 'grid', 'fleet', 'band', 'attempts', 'accepted', 'accept%', 'ms/accepted', 'ms/attempt'];
const row = (cells) => cells.map((v, i) => pad(v, W[i])).join('');
console.log(row(head));

const bands = [];

for (const tier of TIERS) {
  const tally = {};
  const got = [];
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < SEEDS; i++) {
    const stats = {};
    const lot = makePuzzle(`balance-${tier.key}-${i}`, tier, stats);
    for (const [k, n] of Object.entries(stats)) tally[k] = (tally[k] || 0) + n;
    if (lot) got.push(lot);
  }
  const secs = ms(process.hrtime.bigint() - t0);
  const attempts = Object.entries(tally).reduce((a, [, n]) => a + n, 0);
  const accepted = tally.accepted || 0;
  const rejects = Object.entries(tally)
    .filter(([k]) => k !== 'accepted')
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}:${n}`);
  bands.push({ tier, attempts, accepted, got, secs, rejects });
  if (!accepted) fails.push(`${tier.key}：${SEEDS} 个种子一张板子都没接受 —— band 量不出难度，这张表在说谎`);
  console.log(row([
    tier.key,
    `${tier.rows}x${tier.cols}`,
    tier.fleet.join('+'),
    `k=${tier.k[0]}${tier.k[0] === tier.k[1] ? '' : `..${tier.k[1]}`}`,
    attempts,
    accepted,
    pct(accepted, attempts),
    accepted ? (secs / accepted).toFixed(0) : 'n/a',
    attempts ? (secs / attempts).toFixed(2) : 'n/a',
  ]));
  console.log(`  ↳ 被丢掉的原因：${rejects.join('  ') || 'none'}${tally.gaveUp ? `  gaveUp:${tally.gaveUp}` : ''}`);
}

const totalAttempts = bands.reduce((a, b) => a + b.attempts, 0);
const totalAccepted = bands.reduce((a, b) => a + b.accepted, 0);
console.log(`\n  ${totalAttempts} 次散点换来 ${totalAccepted} 张可发的板子（${pct(totalAccepted, totalAttempts)}）。`);
console.log('  深层 band 只要百分之几，所以生成只能在 build 时跑：见 tools/bake.mjs 的注释。');

// --------------------------------------------------- 2. the price of one proved board

// The above amortises the rejections. This is the part that must never happen on a tap:
// one exhaustive count and one depth-bounded solve over a board that already passed.
console.log(`\n单张板子的证明成本（对已接受的 spec 反复计时）\n`);
console.log(pad('tier', 10) + pad('count ms', 11) + pad('count nodes', 13) + pad('logic ms', 11) + pad('depth', 7) + 'logic nodes');
for (const { tier, got } of bands) {
  if (!got.length) {
    console.log(pad(tier.key, 10) + 'no accepted board in this run');
    continue;
  }
  const specs = got.map((lot) => deserialize(serialize(lot.spec)));
  const cMs = hr((i) => countSolutions(specs[i % specs.length], 2, { nodes: tier.countNodes }), 200);
  const cNodes = Math.max(...specs.map((s) => countSolutions(s, 2, { nodes: tier.countNodes }).nodes));
  const lMs = hr((i) => solveLogic(specs[i % specs.length], { maxDepth: tier.k[1] + 1, nodes: tier.logicNodes }), 40);
  const L = specs.map((s) => solveLogic(s, { maxDepth: tier.k[1] + 1, nodes: tier.logicNodes }));
  // 第二只眼睛：makePuzzle 自报"这张在 band 里"，这里把 serialize→deserialize 之后的同一批
  // spec 重新量一遍深度。往返掉了信息时，band 就只存在于出货前的那份内存里。
  const offBand = L.filter((x) => !x.solved || x.depth < tier.k[0] || x.depth > tier.k[1]).length;
  if (offBand) fails.push(`${tier.key}：${offBand}/${L.length} 张往返后复测的深度不在 k=${tier.k[0]}..${tier.k[1]} —— band 不再描述这批板子`);
  console.log(pad(tier.key, 10) + pad(cMs.toFixed(3), 11) + pad(cNodes, 13)
    + pad(lMs.toFixed(3), 11) + pad(L[0].depth, 7) + Math.max(...L.map((x) => x.nodes)));
}

// ------------------------------------------------------------- 3. the pool re-proves

// The shipped file is the artifact the browser reads, so the cost that matters for the
// build is "re-prove all 48 boards from the bytes in js/data/puzzles.js".
const file = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'js', 'data', 'puzzles.js'), 'utf8');
const rows = PUZZLES.map((p) => ({ ...p, spec: deserialize(serialize(p.spec)) }));
for (const p of rows) {
  const bad = validateSpec(p.spec);
  if (bad) throw new Error(`${p.id}: shipped spec is malformed: ${bad}`);
}

const t0 = process.hrtime.bigint();
let proofs = 0;
let maxNodes = 0;
for (const p of rows) {
  const c = countSolutions(p.spec, 2);
  if (!c.complete || c.count !== 1) throw new Error(`${p.id}: count ${c.count} complete=${c.complete}`);
  const L = solveLogic(p.spec, { maxDepth: p.depth + 1 });
  if (!L.solved || !L.certain || L.depth !== p.depth) throw new Error(`${p.id}: depth ${p.depth} not reproducible`);
  proofs++;
  maxNodes = Math.max(maxNodes, c.nodes);
}
const allMs = ms(process.hrtime.bigint() - t0);
console.log(`\n全池复证：${proofs} 张板子（计数 + 逐深度复解）用时 ${allMs.toFixed(0)} ms，`);
console.log(`  其中计数节点最大 ${maxNodes}，js/data/puzzles.js 现有 ${(file.length / 1024).toFixed(1)} KB。`);
console.log('  每张板子的 depth / guesses / nodes 都能从文件里的字节重算出来，所以 hand-edit 是有下限的。');

// ------------------------------------------- 4. why "unique" is a property of the clues

// Erasing one clue is the refutation the counter can see. Doing it line by line is also the
// cheapest way to ask a question the UI never answers: how many of these clues are actually
// load-bearing? A clue you can erase and still have exactly one solution is decoration.
const countIsUnique = (spec) => {
  const c = countSolutions(spec, 2);
  return c.complete ? c.count === 1 : null; // null = the budget ran out, which we never accept silently
};

console.log(`\n擦线索一：单擦一条（countSolutions(spec, 2)，撞到第二个解就停）\n`);
console.log(pad('tier', 10) + pad('board', 13) + pad('clues', 7) + pad('load-bearing', 14) + '擦掉后仍然唯一的线');
for (const tier of TIERS) {
  const p = rows.find((x) => x.tier === tier.key);
  const spec = p.spec;
  let loadBearing = 0;
  const stillUnique = [];
  const total = spec.rows + spec.cols;
  for (let i = 0; i < total; i++) {
    const rowReq = spec.rowReq.slice();
    const colReq = spec.colReq.slice();
    if (i < spec.rows) rowReq[i] = -1;
    else colReq[i - spec.rows] = -1;
    const unique = countIsUnique({ ...spec, rowReq, colReq });
    if (unique === null) throw new Error(`${p.id}: line ${i} erasure did not finish inside the budget`);
    if (unique) stillUnique.push(i < spec.rows ? `row ${i}` : `col ${i - spec.rows}`);
    else loadBearing++;
  }
  console.log(pad(tier.key, 10) + pad(p.id, 13) + pad(total, 7) + pad(`${loadBearing}/${total}`, 14)
    + (stillUnique.join(' ') || 'none'));
}

// Nothing is load-bearing on its own, so the honest statement is about the *combination* of
// clues. Greedy erasure (two passes, because freeing a line can make another line redundant)
// measures how few clues a board still needs to keep exactly one solution.
const minimize = (spec) => {
  const rowReq = spec.rowReq.slice();
  const colReq = spec.colReq.slice();
  const total = spec.rows + spec.cols;
  let erased = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < total; i++) {
      const isRow = i < spec.rows;
      const arr = isRow ? rowReq : colReq;
      const at = isRow ? i : i - spec.rows;
      if (arr[at] === -1) continue;
      const was = arr[at];
      arr[at] = -1;
      if (countIsUnique({ ...spec, rowReq, colReq }) === true) {
        erased++; // a line already freed is skipped above, so nothing is counted twice
      } else {
        arr[at] = was;
      }
    }
  }
  return { kept: total - erased, total };
};

console.log(`\n擦线索二：贪心擦到不能再擦，剩下的就是这张板子的最小线索集\n`);
console.log(pad('tier', 10) + pad('board', 13) + pad('clues', 7) + 'minimal');
const mins = [];
for (const tier of TIERS) {
  const mine = [];
  for (const p of rows.filter((x) => x.tier === tier.key)) {
    const m = minimize(p.spec);
    mine.push(m);
    mins.push(m);
  }
  const kept = mine.map((m) => m.kept);
  console.log(pad(tier.key, 10) + pad(`${mine.length} boards`, 13)
    + pad(mine[0].total, 7)
    + `kept ${Math.min(...kept)}..${Math.max(...kept)}（${(kept.reduce((a, b) => a + b, 0) / kept.length).toFixed(1)} 平均，即每条约 ${((100 * kept.reduce((a, b) => a + b, 0)) / mine.reduce((a, m) => a + m.total, 0)).toFixed(0)}%）`);
}
const best = mins.reduce((a, m) => (m.kept < a.kept ? m : a), mins[0]);
console.log(`\n  全池最少的一张：${best.kept} 条线索就够（发了 ${best.total} 条），其余的线索是冗余而非错误。`);
console.log('  难度不在这张表里：difficulty 是 depth k，见 tools/bake.mjs 写进 js/data/puzzles.js 的那一列。');

console.log('\n结论：难度是量出来的 —— tier 的 k 来自 solveLogic，accept% 来自这张表，');
console.log('不是任何人手写的标签。改 js/core/make.js 的 band 之前先跑这个文件。\n');

fails.forEach((f) => console.log(`FAIL balance: ${f}`));
process.exit(fails.length ? 1 : 0);
