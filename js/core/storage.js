// The save file. One localStorage key, plain JSON, and a versioned shape so an old save is
// recognised rather than mistaken for a new one.
//
// Records are keyed by puzzle id (ids are stable within a bake; a re-bake is a different
// game — see README). Alongside them: a daily log and the campaign unlock pointer.
//
// Two numbers get stored because the game counts two things (see js/core/game.js): `ops`
// is everything you touched, `steps` is the placements that stayed. `steps` has a proven
// floor — one per ship in the fleet — so "perfect" here is a fact about the puzzle rather
// than a feeling: you matched the fleet size with no help.
//
// Everything degrades to memory when localStorage is denied, which it is under file://, in
// private windows, and in the node test suite that runs this file without a browser.

const KEY = 'minishop.save.v1';

function blank() {
  return {
    records: {},
    daily: {},
    unlocked: 1,
    stats: { solves: 0, perfect: 0, ops: 0, steps: 0, hints: 0 },
  };
}

let cache = null;

function load() {
  if (cache) return cache;
  let raw = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch (err) {
    raw = null;
  }
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        const base = blank();
        cache = {
          records: p.records && typeof p.records === 'object' ? p.records : base.records,
          daily: p.daily && typeof p.daily === 'object' ? p.daily : base.daily,
          unlocked: Number(p.unlocked) > 0 ? Number(p.unlocked) : base.unlocked,
          stats: { ...base.stats, ...(p.stats || {}) },
        };
        return cache;
      }
    } catch (err) {
      // A corrupt save is not worth keeping; start clean rather than crash the shell.
    }
  }
  cache = blank();
  return cache;
}

function persist() {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cache));
  } catch (err) {
    /* memory-only session */
  }
}

// Only downwards: a sloppy replay must never be able to erase a good record.
function lower(prev, next) {
  if (prev == null) return next;
  return next < prev ? next : prev;
}

export const store = {
  get records() { return load().records; },
  get stats() { return load().stats; },
  get daily() { return load().daily; },
  get unlocked() { return load().unlocked; },

  record(id) {
    return load().records[id] || null;
  },

  // Unlocking is monotone: re-solving an early level cannot hide a later one.
  unlock(n) {
    const s = load();
    if (n > s.unlocked) s.unlocked = n;
    persist();
    return s.unlocked;
  },

  markDaily(dateKey, id) {
    const s = load();
    s.daily[dateKey] = { id, at: Date.now() };
    persist();
  },

  dailyDone(dateKey) {
    return load().daily[dateKey] || null;
  },

  solve(id, { ops, steps, par, hints }) {
    const s = load();
    const prev = s.records[id];
    const clean = steps <= par && !hints;
    const cur = {
      solved: true,
      bestOps: lower(prev && prev.bestOps, ops),
      bestSteps: lower(prev && prev.bestSteps, steps),
      plays: (prev && prev.plays ? prev.plays : 0) + 1,
      perfect: (prev && prev.perfect) || clean,
    };
    s.records[id] = cur;
    s.stats.solves += 1;
    s.stats.ops += ops;
    s.stats.steps += steps;
    s.stats.hints += hints || 0;
    if (clean) s.stats.perfect += 1;
    persist();
    return cur;
  },

  reset() {
    cache = blank();
    try {
      window.localStorage.removeItem(KEY);
    } catch (err) {
      /* nothing was ever persisted */
    }
  },
};
