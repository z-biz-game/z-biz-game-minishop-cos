// The content pipeline: this is where the levels come from, and the browser never
// generates one at play time.
//
// Why offline: `node test/balance.mjs` measures the honest cost of a single accepted board
// per band (an exhaustive count plus a depth-bounded reasoning solve, repeated over every
// rejected attempt). For the deep bands only a few percent of scatterings land inside the
// band, so a level is worth a few hundred milliseconds at build time and must never be
// worth a tap on the screen.
//
//   node tools/bake.mjs
//   PER_TIER=24 node tools/bake.mjs
//
// Nothing unmeasured ships. A board only enters js/data/puzzles.js after the *serialised*
// spec — the exact bytes that go into the file — is re-proved by three separate programs:
//   countSolutions(spec, 2)   -> exactly one solution, and it is the fleet we scattered
//   solveLogic(spec)          -> solves, certainly, at the depth printed beside it
//   validate(spec, solution)  -> the independent checker finds nothing wrong
// If any of those disagree the bake throws instead of writing a file, because a data file
// whose numbers are a lie is worse than no data file.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TIERS, makePuzzle } from '../js/core/make.js';
import { countSolutions } from '../js/core/count.js';
import { solveLogic } from '../js/core/logic.js';
import { validate } from '../js/core/check.js';
import { serialize, deserialize, sameShips } from '../js/core/model.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PER_TIER = Number(process.env.PER_TIER || 12);

// Two boards with the same clues and the same fleet are the same puzzle even if the
// generator appended its ships in a different order.
function signature(spec) {
  const fleet = spec.fleet.slice().sort((a, b) => a - b).join(',');
  return `${spec.rows}x${spec.cols}|${fleet}|${spec.rowReq.join(',')}|${spec.colReq.join(',')}`;
}

const out = [];
const measured = [];

for (const tier of TIERS) {
  const seen = new Set();
  const picked = [];
  const tally = {};
  const t0 = Date.now();
  let seeds = 0;
  let dry = 0;
  while (picked.length < PER_TIER && seeds < PER_TIER * 40) {
    const lot = makePuzzle(`bake-${tier.key}-${seeds}`, tier, tally);
    seeds++;
    if (!lot) {
      // The tier's own try budget ran out. Two of those in a row means the band is not
      // findable at this grid size, which is a report problem, not a retry problem.
      if (++dry >= 2) break;
      continue;
    }
    dry = 0;
    // Round-trip first: everything below reads the bytes that ship, not the object the
    // generator built.
    const spec = deserialize(serialize(lot.spec));
    const err = validate(spec, spec.ships);
    if (err) throw new Error(`${tier.key}: generator emitted an illegal fleet: ${err}`);
    const c = countSolutions(spec, 2);
    if (!c.complete || c.count !== 1) {
      throw new Error(`${tier.key}: uniqueness not reproducible (count=${c.count} complete=${c.complete})`);
    }
    if (!sameShips(c.solutions[0], spec.ships)) {
      throw new Error(`${tier.key}: the unique solution is not the scattered fleet`);
    }
    const L = solveLogic(spec, { maxDepth: tier.k[1] + 1 });
    if (!L.solved || !L.certain || L.depth !== lot.depth) {
      throw new Error(`${tier.key}: depth ${lot.depth} not reproducible (solved=${L.solved} certain=${L.certain} got=${L.depth})`);
    }
    const sig = signature(spec);
    if (seen.has(sig)) continue;
    seen.add(sig);
    picked.push({
      id: `${tier.key}-${String(picked.length + 1).padStart(2, '0')}`,
      tier: tier.key,
      depth: L.depth,
      guesses: L.guesses,
      nodes: c.nodes,
      spec,
    });
    process.stdout.write(`\r${tier.key}: ${picked.length}/${PER_TIER}  ${((Date.now() - t0) / 1000).toFixed(0)}s   `);
  }
  process.stdout.write(`\n`);
  const attempts = Object.entries(tally).reduce((a, [, n]) => a + n, 0);
  const accepted = tally.accepted || 0;
  const secs = (Date.now() - t0) / 1000;
  measured.push({
    tier: tier.key,
    grid: `${tier.rows}×${tier.cols}`,
    fleet: tier.fleet.join('+'),
    band: tier.k[0] === tier.k[1] ? `k=${tier.k[1]}` : `k=${tier.k[0]}..${tier.k[1]}`,
    seeds,
    attempts,
    accepted,
    acceptPct: attempts ? `${((100 * accepted) / attempts).toFixed(1)}%` : 'n/a',
    perSec: secs > 0 ? (accepted / secs).toFixed(1) : 'n/a',
    msEach: accepted ? `${((1000 * secs) / accepted).toFixed(0)} ms` : 'n/a',
    rejects: Object.entries(tally).filter(([k]) => k !== 'accepted').sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(' '),
  });
  if (picked.length < PER_TIER) console.error(`warn: ${tier.key} only reached ${picked.length}/${PER_TIER} puzzles`);
  // A tier is played as a curve, so order it by the number that means something: shallowest
  // reasoning first, then the smallest search tree.
  picked.sort((a, b) => a.depth - b.depth || a.nodes - b.nodes);
  picked.forEach((p, i) => { p.id = `${tier.key}-${String(i + 1).padStart(2, '0')}`; });
  out.push(...picked);
}

// The band the UI prints comes off the puzzles that actually shipped, not off the
// generator's wish list — so a re-bake that lands lighter or heavier says so out loud.
const meta = TIERS.map((t) => {
  const mine = out.filter((p) => p.tier === t.key).map((p) => p.depth);
  const lo = mine.length ? Math.min(...mine) : t.k[0];
  const hi = mine.length ? Math.max(...mine) : t.k[1];
  return {
    key: t.key,
    label: t.label,
    rows: t.rows,
    cols: t.cols,
    fleet: t.fleet.slice(),
    min: lo,
    max: hi,
    blurb: `${t.rows}×${t.cols} · ${t.fleet.length} 条船 · 猜 ${lo === hi ? lo : `${lo}-${hi}`} 层`,
  };
});

const lines = [
  '// Generated by tools/bake.mjs — the levels in this game are measurements, not opinions.',
  '// `depth` is the assumption depth js/core/logic.js needed to solve the spec on the same',
  '// line, after js/core/count.js proved that spec has exactly one solution. Hand-editing is',
  '// pointless: `node test/puzzles.test.mjs` re-runs both proofs against these very bytes.',
  `export const TIERS_META = ${JSON.stringify(meta)};`,
  'export const PUZZLES = [',
  ...out.map((p) => `  ${JSON.stringify(p)},`),
  '];',
  '',
];
const path = join(root, 'js', 'data', 'puzzles.js');
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, lines.join('\n'));

console.table(measured);
const byTier = {};
for (const p of out) byTier[p.tier] = (byTier[p.tier] || 0) + 1;
console.log(`wrote ${out.length} puzzles (${Object.entries(byTier).map(([k, n]) => `${k}:${n}`).join(' ')}) -> js/data/puzzles.js`);
