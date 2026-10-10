// The shipped puzzle pool. The browser picks levels from here and never generates one,
// which is a measured decision rather than a stylistic one: test/balance.mjs reports the
// per-acceptance cost of a deep band (a few percent of attempts, each costing a solve plus
// an exhaustive count), so generation belongs to `node tools/bake.mjs` and a tap belongs to
// a lookup.
//
// Everything below is a pure lookup over js/data/puzzles.js. That is also why the daily
// puzzle and a shared `#/lot/<key>` link are reproducible with no server and no state: the
// pool is fixed at build time, and a seed only chooses an index into it.
//
// This file is display-side. The generation ladder and its search budgets live in
// js/core/make.js, which nothing in the shipped game imports.

import { PUZZLES, TIERS_META } from '../data/puzzles.js';
import { hashSeed } from './rng.js';

export const TIERS = TIERS_META;

// One prepared entry per baked line. `spec` is exactly the bytes in the data file, so the
// assertions in test/puzzles.test.mjs run against what actually ships rather than against a
// copy the generator held in memory.
const prepared = PUZZLES.map((row) => ({
  id: row.id,
  tier: row.tier,
  depth: row.depth,
  rows: row.spec.rows,
  cols: row.spec.cols,
  ships: row.spec.fleet.length,
  par: row.spec.fleet.length,
  spec: row.spec,
}));

export const ALL = prepared;

function pick(list, seed, salt) {
  if (!list.length) return null;
  return list[hashSeed(`${salt}|${seed}`) % list.length];
}

export function tierByKey(key) {
  return TIERS.find((t) => t.key === key) || TIERS[0];
}

export function puzzlesIn(key) {
  return prepared.filter((p) => p.tier === key);
}

export function byId(id) {
  return prepared.find((p) => p.id === id) || null;
}

// The campaign: every baked puzzle, band by band and inside a band lightest-reasoning
// first — which is the order tools/bake.mjs wrote them in.
export function campaign() {
  return prepared;
}

export function levelAt(index) {
  if (!prepared.length) return null;
  return prepared[((index % prepared.length) + prepared.length) % prepared.length];
}

// Endless play inside one band. A seed does the choosing, so `?seed=` stays honest.
export function randomPuzzle(seed, tierKey) {
  const list = tierKey ? puzzlesIn(tierKey) : prepared;
  return pick(list, seed, 'random');
}

// One board per calendar day, identical for everyone who opens it.
export function dailyPuzzle(dateKey) {
  return pick(prepared, dateKey, 'daily');
}

// What the pool actually contains, measured instead of asserted. The harness prints this,
// so a re-bake that quietly loses a band shows up as a changed number in the diff.
// `med` matters for the same reason: a tier whose whole band sits on one depth is one level
// wearing several costumes, and min/max alone cannot see that.
function median(sorted) {
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : Math.round((sorted[m - 1] + sorted[m]) / 2);
}

export function stats() {
  const byTier = {};
  for (const p of prepared) {
    const s = byTier[p.tier] || (byTier[p.tier] = {
      n: 0, min: Infinity, max: 0, shipsMin: Infinity, shipsMax: 0, cellsMin: Infinity, cellsMax: 0, depths: [],
    });
    s.n++;
    if (p.depth < s.min) s.min = p.depth;
    if (p.depth > s.max) s.max = p.depth;
    const ships = p.ships;
    if (ships < s.shipsMin) s.shipsMin = ships;
    if (ships > s.shipsMax) s.shipsMax = ships;
    const cells = p.rows * p.cols;
    if (cells < s.cellsMin) s.cellsMin = cells;
    if (cells > s.cellsMax) s.cellsMax = cells;
    s.depths.push(p.depth);
  }
  for (const s of Object.values(byTier)) {
    s.depths.sort((a, b) => a - b);
    s.med = median(s.depths);
    delete s.depths;
  }
  return { puzzles: prepared.length, byTier };
}
