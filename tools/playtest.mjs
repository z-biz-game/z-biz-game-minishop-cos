// Minimal CDP driver for headless playtesting (Node 21+ global WebSocket/fetch).
// env: CDP_PORT (devtools port, default 9360), BASE_URL (page to attach to, default
//      http://127.0.0.1:5271/)
// usage:
//   node tools/playtest.mjs open   <url>        # close our old pages, open this one
//   node tools/playtest.mjs nav    <url>
//   node tools/playtest.mjs eval   '<js>'       # pass `nonav` to skip the reload
//   node tools/playtest.mjs eval   '@boot'      # | @play | @routes | @save | @reloaded
//   node tools/playtest.mjs eval   '@pointer'   # real mouse over the canvas
//   node tools/playtest.mjs place  <i> <r> <c>  # one real drag of hull i onto cell (r,c)
//   node tools/playtest.mjs water  <r> <c>      # one real press+release on a cell
//   node tools/playtest.mjs shot   <path.png>
//   node tools/playtest.mjs logs
//
// Every scenario reports { rows, fail } in the same shape as tools/harness.mjs, so
// tools/verify.sh aggregates node suites and browser suites on one line.
//
// Why this file exists at all: js/core/* is proven in node, and the shell that wires it to
// the DOM is not. These suites attach to a real Chrome loading a real http:// URL, so the
// module graph, the canvas geometry, the pointer handlers and localStorage are the shipped
// ones rather than a mock of them.

const PORT = Number(process.env.CDP_PORT || 9360);
// Which page to attach to. Hard-coding the dev-server port silently evaluates against a
// fresh about:blank tab when pointed at any other origin.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5271/';
const SHELL_TIMEOUT = Number(process.env.SHELL_TIMEOUT || 30000);
const ORIGIN = new URL(BASE).origin;
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);
const cmd = process.argv[2];

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (globalThis.__printEvents) globalThis.__printEvents(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One real mouse event at a client-space coordinate. Shared by @pointer and the `place` /
// `water` commands so the two cannot drift apart in what "a press" means over the wire.
const mouseAt = (cdp, sessionId, type, x, y, buttons, clickCount = 0) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons, clickCount,
}, sessionId);

// Press on whatever the page says hull `i` occupies right now (dock slot or sea), travel to
// the centre of cell (r,c) in steps, release. This is the only way to test js/view.js: the
// view picks the head cell from the release point and refuses to commit a rebound drag.
async function dragShipTo(cdp, sessionId, runJS, i, r, c, steps = 6) {
  const from = await runJS(`window.minishop.shipPoint(${i})`);
  const to = await runJS(`window.minishop.cellPoint(${r},${c})`);
  if (!from || !to) return null;
  await mouseAt(cdp, sessionId, 'mousePressed', from.x, from.y, 1, 1);
  for (let k = 1; k <= steps; k++) {
    const x = Math.round(from.x + ((to.x - from.x) * k) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * k) / steps);
    await mouseAt(cdp, sessionId, 'mouseMoved', x, y, 1);
    await sleep(16);
  }
  await mouseAt(cdp, sessionId, 'mouseReleased', to.x, to.y, 0, 1);
  await sleep(120);
  return { from, to };
}

// Release in a corner of the canvas that is outside the board rectangle: the view reads that
// as "take the hull back to the dock".
async function dragOffBoard(cdp, sessionId, runJS, i) {
  const from = await runJS(`window.minishop.shipPoint(${i})`);
  const box = await runJS('(()=>{const b=document.getElementById("sea").getBoundingClientRect();'
    + 'return {x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height)};})()');
  if (!from || !box) return null;
  const to = { x: box.x + box.w - 3, y: box.y + box.h - 3 };
  await mouseAt(cdp, sessionId, 'mousePressed', from.x, from.y, 1, 1);
  for (let k = 1; k <= 5; k++) {
    await mouseAt(cdp, sessionId, 'mouseMoved',
      Math.round(from.x + ((to.x - from.x) * k) / 5), Math.round(from.y + ((to.y - from.y) * k) / 5), 1);
    await sleep(16);
  }
  await mouseAt(cdp, sessionId, 'mouseReleased', to.x, to.y, 0, 1);
  await sleep(120);
  return { from, to, box };
}

async function pressCell(cdp, sessionId, runJS, r, c, hold = 40) {
  const p = await runJS(`window.minishop.cellPoint(${r},${c})`);
  if (!p) return null;
  await mouseAt(cdp, sessionId, 'mousePressed', p.x, p.y, 1, 1);
  await sleep(hold);
  await mouseAt(cdp, sessionId, 'mouseReleased', p.x, p.y, 0, 1);
  await sleep(120);
  return p;
}

// A double click is what js/view.js binds rotation to on the sea, so it has to be a real one:
// two press/release pairs, the second at clickCount 2.
async function doubleClickCell(cdp, sessionId, runJS, r, c) {
  const p = await runJS(`window.minishop.cellPoint(${r},${c})`);
  if (!p) return null;
  for (const clickCount of [1, 2]) {
    await mouseAt(cdp, sessionId, 'mousePressed', p.x, p.y, 1, clickCount);
    await mouseAt(cdp, sessionId, 'mouseReleased', p.x, p.y, 0, clickCount);
    await sleep(40);
  }
  await sleep(120);
  return p;
}

// ---------------------------------------------------------------------------- in-page suites

// Each of these runs inside the page and returns { rows: [{ test, pass, detail }] }.
// `rec` has the same three-argument shape tools/harness.mjs uses, and window.__lastRows is
// published as we go so a scenario that throws still reports the rows it got through.
const PRELUDE = `
  const rows = [];
  window.__lastRows = rows;
  const rec = (test, pass, detail) => {
    rows.push({ test, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
  };
  const M = window.minishop;
  const st = () => M.state;
  const text = (id) => document.getElementById(id).textContent.trim();
  const click = (id) => document.getElementById(id).click();
  // model.draw() returns one string per row joined by \\n, '#' for hull and '~' for a mark.
  // Reading the sea through it is how these suites assert what the canvas is showing without
  // importing the view.
  const sea = () => M.board().split('\\n');
  // The canvas is the product, so "did it paint" is measured from pixels rather than from a
  // flag: sample points across the bitmap and count the colours the view put down.
  const paint = () => {
    const cv = document.getElementById('sea');
    const g = cv.getContext('2d');
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    const seen = new Set();
    let lit = 0;
    for (let i = 0; i < d.length; i += 4 * 401) {
      seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      if (d[i] + d[i + 1] + d[i + 2] > 90) lit++;
    }
    const box = cv.getBoundingClientRect();
    return { w: cv.width, h: cv.height, cssW: Math.round(box.width), cssH: Math.round(box.height), colors: seen.size, lit };
  };
  // Solve the chart the way the rules allow, from the answer that count.js proved unique.
  // \`waste\` puts the first hull down twice so a suite can measure steps > par.
  const solve = (waste) => {
    M.reset();
    const want = M.spec().ships;
    const cols = M.spec().cols;
    const covered = new Set();
    want.forEach((s) => { for (let k = 0; k < s.len; k++) covered.add(s.r * cols + s.c + (s.axis === 'v' ? k * cols : k)); });
    let free = 0;
    while (covered.has(free)) free++;
    M.tap(Math.floor(free / cols), free % cols);
    want.forEach((w, i) => {
      while (M.ships()[i].axis !== w.axis) M.rotate(i);
      M.place(i, w.r, w.c);
      if (waste && i === 0) { M.retrieve(i); M.place(i, w.r, w.c); }
    });
    return st();
  };
  const todayKey = () => {
    const n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  };
`;

const SCENARIOS = {
  boot: `${PRELUDE}
  (() => {
    rec('the shell boots and exposes exactly one hook', !!M && M.version === 1, M && M.version);
    const s = st();
    rec('#/ is campaign level 1 = harbour-01', s.mode === 'campaign' && s.index === 1 && s.id === 'harbour-01' && s.tier === 'harbour', s);
    rec('a fresh board has spent nothing and proved nothing yet',
      s.ops === 0 && s.steps === 0 && s.par === 2 && s.hints === 0 && s.done === false && s.curtain === false, s);
    rec('the depth printed is the depth measured for this band', s.depth === 0, { depth: s.depth });
    const g = M.grid();
    rec('the sea is rows*cols unknown cells', g.length === s.rows * s.cols && g.every((v) => v === 0), { len: g.length });
    const p = paint();
    rec('the canvas is sized by CSS, not by the 300x150 default',
      p.w >= p.cssW && p.h >= p.cssH && p.cssW > 300 && p.cssH > 300, p);
    rec('the view really drew something', p.colors >= 4 && p.lit > 40, p);
    const read = text('readout');
    rec('the panel prints both counters and the proof',
      ['操作数', '放置步数', '解数', '推理深度', '最佳'].every((k) => read.includes(k)), read);
    rec('the crumbs name the level and its band', text('crumbs').includes('近岸'), text('crumbs'));
    const shelf = document.getElementById('shelf').querySelectorAll('button[data-index]');
    const locked = document.querySelectorAll('#shelf button[disabled]').length;
    rec('the shelf is all 48 levels, 47 of them locked on a clean device',
      shelf.length === 48 && locked === 47, { shelf: shelf.length, locked });
    const pool = M.pool;
    rec('the pool the UI reads is the pool that shipped',
      pool.puzzles === 48 && Object.keys(pool.byTier).length === 4 && Object.values(pool.byTier).every((t) => t.n === 12),
      { puzzles: pool.puzzles, byTier: Object.keys(pool.byTier).length });
    rec('each band ships the depth it claims',
      ['harbour', 'patrol', 'crossing', 'lone'].every((k, i) => pool.byTier[k].min === i && pool.byTier[k].max === i),
      Object.entries(pool.byTier).map(([k, v]) => \`\${k}:\${v.min}-\${v.max}\`));
    rec('the ladder is four bands long and in order', M.tiers.map((t) => t.key).join(',') === 'harbour,patrol,crossing,lone', M.tiers.map((t) => t.key));
    rec('the title in the tab is the title in the README', /孤舰/.test(document.title), document.title);
    return { rows, state: s, paint: p };
  })()`,

  play: `${PRELUDE}
  (() => {
    M.load('#/c/1');
    M.reset();
    const before = st();
    rec('reached level 1 through the router with nothing spent',
      before.id === 'harbour-01' && before.ops === 0 && before.history === 0, before);
    rec('rotating in the dock is free', M.rotate(0) === true && st().ops === 0 && st().steps === 0, st());
    rec('the dock hands out flat hulls until you turn one', M.ships()[0].axis === 'v', M.ships()[0]);
    rec('placing hull 1 spends one operation and one placement step',
      M.place(0, 2, 0).ok === true && st().ops === 1 && st().steps === 1, st());
    rec('the board the view prints agrees with the rules',
      JSON.stringify(sea()) === JSON.stringify(['....', '....', '##..', '....']), sea());
    const touch = M.place(1, 2, 1);
    rec('a hull dropped beside another bounces: reason 相邻, counters unmoved',
      touch.ok === false && touch.reason === 'touch' && st().ops === 1 && st().steps === 1, touch);
    rec('the shell says why out loud', text('hintline').includes('相邻'), text('hintline'));
    M.tap(0, 3);
    rec('marking water is an operation, never a placement step',
      st().ops === 2 && st().steps === 1 && M.grid()[3] === 2, st());
    const inWater = M.place(1, 0, 3);
    rec('your own mark is a real obstacle', inWater.ok === false && inWater.reason === 'water', inWater);
    M.tap(0, 3);
    rec('clearing a mark costs the same as making one', st().ops === 3 && M.grid()[3] === 0, st());
    rec('one hull down is not a fleet',
      st().done === false && st().curtain === false && M.verify().solved === false, M.verify());
    const prog = M.progress();
    rec('the clue strip reports line by line',
      JSON.stringify(prog.rows) === '[true,true,false,true]' && JSON.stringify(prog.cols) === '[true,true,false,true]', prog);
    M.place(1, 2, 2);
    const s = st();
    rec('the last hull finishes it: 2 placements out of 4 operations',
      s.done === true && s.ops === 4 && s.steps === 2 && s.par === 2, s);
    rec('the checker, not the baked answer, said so', M.verify().solved === true, M.verify());
    rec('the curtain is up with three stars for hitting par',
      s.curtain === true && text('stars') === '★★★' && text('verdict') === '一子不差', { stars: text('stars'), verdict: text('verdict') });
    const tally = text('tally');
    rec('the tally prints both counters and the proof',
      tally.includes('操作') && tally.includes('放置') && tally.includes('解数'), tally);
    const saved = M.store.record('harbour-01');
    rec('the save holds the best of this level',
      saved && saved.solved === true && saved.bestSteps === 2 && saved.bestOps === 4, saved);
    rec('the totals strip counted it', text('totals').includes('已通'), text('totals'));
    rec('everything is refused once it is done',
      M.place(1, 0, 0).reason === 'done' && M.retrieve(0) === false && M.rotate(0) === false && M.tap(1, 1) === false, st());
    M.hintOnce();
    rec('a hint is billable and names a home', st().hints === 1 && text('hintline').includes('提示'), text('hintline'));
    M.reset();
    rec('reopening clears the board and keeps the record',
      st().ops === 0 && st().steps === 0 && st().done === false && M.store.record('harbour-01').solved === true, st());
    const sloppy = solve(true);
    rec('placing one hull twice is legal and scores worse',
      sloppy.done === true && sloppy.steps === sloppy.par + 1, sloppy);
    rec('two stars for a fleet that went down twice', text('stars') === '★★☆' && text('verdict') === '勉强成军',
      { stars: text('stars'), verdict: text('verdict') });
    rec('the record still remembers the better run', M.store.record('harbour-01').bestSteps === 2, M.store.record('harbour-01'));
    click('again');
    rec('再来一次 puts the fleet back in the dock',
      st().ops === 0 && st().steps === 0 && st().curtain === false && sea().every((r) => /^\\.+$/.test(r)),
      { state: st(), sea: sea() });
    return { rows, save: M.store.record('harbour-01'), stats: M.store.stats };
  })()`,

  routes: `${PRELUDE}
  (() => {
    const one = (hash) => { M.load(hash); return st(); };
    const a = one('#/c/13');
    rec('#/c/13 is the first patrol board', a.id === 'patrol-01' && a.tier === 'patrol' && a.depth === 1, a);
    const b = one('#/c/48');
    rec('the last level of the ladder is a lone board', b.id === 'lone-12' && b.tier === 'lone' && b.depth === 3, b);
    const c = one('#/c/999');
    rec('an out-of-range level clamps instead of crashing', c.index === 48 && location.hash === '#/c/48', { index: c.index, hash: location.hash });
    const d = one('#/c/0');
    rec('level zero becomes level one', d.index === 1 && d.id === 'harbour-01', d);
    const e = one('#/daily');
    rec('#/daily is a real chart labelled with today',
      e.mode === 'daily' && e.label.includes(todayKey()) && /^[a-z]+-\\d\\d$/.test(e.id), { id: e.id, label: e.label });
    one('#/c/7');
    M.load('#/daily');
    rec('the daily route lands on the same board twice in a row', st().id === e.id, { again: st().id, first: e.id });
    const f = one('#/random/lone/abc123');
    const f2 = one('#/random/lone/xyz789');
    rec('#/random/<tier>/<token> is the token and nothing else', f.tier === 'lone' && f.id !== f2.id, { a: f.id, b: f2.id });
    one('#/c/1');
    one('#/random/lone/abc123');
    rec('the same token is the same chart after visiting other routes', st().id === f.id, { id: st().id, want: f.id });
    one('#/random/patrol');
    const h = st();
    rec('a bare #/random/patrol mints a token into the URL so a link means one board',
      h.mode === 'random' && /^#\\/random\\/patrol\\/[a-z0-9]+$/.test(location.hash) && h.tier === 'patrol', { hash: location.hash });
    const i = one('#/lot/crossing-07');
    rec('#/lot/<id> opens that exact chart', i.id === 'crossing-07' && i.mode === 'lot' && i.tier === 'crossing' && i.depth === 2, i);
    const j = one('#/lot/nope-42');
    rec('an id nobody baked falls back to level 1 rather than throwing', j.id === 'harbour-01' && j.mode === 'lot', j);
    rec('the router can be asked without navigating', M.route('#/random/harbour/fix') === '#/random/harbour/fix', M.route('#/random/harbour/fix'));
    const sizes = [1, 14, 25, 37].map((n) => { const s = one('#/c/' + n); return [s.id, s.rows, s.cols]; });
    rec('the grid grows with the band',
      JSON.stringify(sizes) === JSON.stringify([['harbour-01', 4, 4], ['patrol-01', 6, 6], ['crossing-01', 7, 7], ['lone-01', 8, 8]]), sizes);
    const g2 = one('#/c/25');
    rec('a bigger chart means a bigger dock', M.ships().length === g2.par && M.ships().length === 4, { par: g2.par });
    one('#/c/1');
    return { rows, sizes };
  })()`,

  save: `${PRELUDE}
  (() => {
    const KEY = 'minishop.save.v1';
    const raw = () => localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
    M.store.reset();
    M.load('#/c/1');
    rec('a clean device has one unlocked level and no records',
      Object.keys(M.store.records).length === 0 && st().solved === 0 && st().unlocked === 1, st());
    rec('nothing is written until something happens', raw() === null, raw());
    const s = solve(false);
    const written = JSON.parse(raw() || 'null');
    rec('finishing a level writes one localStorage key', !!written && !!written.records, raw() && raw().slice(0, 140));
    rec('the file holds records, not the answer',
      written.records['harbour-01'].bestSteps === 2 && !/ships/.test(raw()), Object.keys(written));
    rec('the solve was billed to the totals',
      written.stats.solves === 1 && s.ops === written.records['harbour-01'].bestOps, written.stats);
    rec('clearing level 1 unlocked level 2', written.unlocked === 2 && st().unlocked === 2, { unlocked: st().unlocked });
    M.load('#/c/2');
    rec('level 2 is now reachable', st().index === 2 && document.querySelectorAll('#shelf button[disabled]').length === 46,
      { id: st().id, locked: document.querySelectorAll('#shelf button[disabled]').length });
    const sloppy = solve(true);
    rec('a messier replay still finishes and cannot raise the record',
      sloppy.done === true && sloppy.steps > sloppy.par && M.store.record(sloppy.id).bestSteps === sloppy.par,
      { steps: sloppy.steps, par: sloppy.par, best: M.store.record(sloppy.id).bestSteps });
    M.hintOnce();
    rec('the shelf marks what has been passed',
      document.querySelectorAll('#shelf button.done, #shelf button.perfect').length >= 2,
      { done: document.querySelectorAll('#shelf button.done').length, perfect: document.querySelectorAll('#shelf button.perfect').length });
    const daily = (() => { M.load('#/daily'); return solve(false); })();
    rec('the daily chart is remembered by date',
      !!M.store.dailyDone(todayKey()) && M.store.dailyDone(todayKey()).id === daily.id, M.store.dailyDone(todayKey()));
    click('wipe');
    rec('one click on 清空存档 only arms the warning',
      text('toast').includes('再点一次') && Object.keys(M.store.records).length > 0, text('toast'));
    click('wipe');
    rec('the second click really wipes it',
      Object.keys(M.store.records).length === 0 && st().unlocked === 1 && st().solved === 0, st());
    rec('a wipe removes the key rather than emptying it', raw() === null, raw());
    // Two broken files are handed to the two suites that boot on them: the store caches the
    // save in memory for the life of the page, so a corrupt file can only be tested at boot.
    localStorage.setItem(KEY, 'not json at all');
    return { rows, totals: text('totals') };
  })()`,

  reloaded: `${PRELUDE}
  (() => {
    // The driver navigated to get here, so this page has really been reloaded — and the file
    // it booted on is the string @save left behind.
    rec('a page that boots on a garbage save still boots', !!M && !!st().id, M && st());
    rec('the garbage was discarded rather than trusted',
      Object.keys(M.store.records).length === 0 && st().unlocked === 1, st());
    rec('a reloaded page starts from an empty board',
      st().ops === 0 && st().steps === 0 && st().done === false && st().curtain === false, st());
    const p = paint();
    rec('the canvas paints on that boot too, without a resize event', p.colors >= 4 && p.lit > 40, p);
    const one = (hash) => { M.load(hash); return st(); };
    const s = one('#/lot/crossing-07');
    rec('a shared link opens the same chart on a device with no save',
      s.id === 'crossing-07' && s.tier === 'crossing' && s.depth === 2 && s.rows === 7, s);
    const done = solve(false);
    rec('a deep band is playable straight from its link',
      done.done === true && done.steps === done.par && done.ops >= done.par, done);
    const fresh = JSON.parse(localStorage.getItem('minishop.save.v1'));
    rec('the save file is a real one again', fresh.records['crossing-07'].bestSteps === 4 && fresh.unlocked === 1,
      { records: Object.keys(fresh.records), unlocked: fresh.unlocked });
    rec('the totals strip knows it was reopened from nothing', text('totals').includes('已通'), text('totals'));
    // Hand the next suite a half-corrupt file: valid JSON, junk in one field.
    localStorage.setItem('minishop.save.v1', '{"records":{"harbour-01":{"bestSteps":99}},"unlocked":"nope","stats":null}');
    return { rows, state: done, paint: p };
  })()`,

  partial: `${PRELUDE}
  (() => {
    const KEY = 'minishop.save.v1';
    rec('the shell boots on a half-corrupt file', !!M && !!st().id, M && st());
    rec('junk in the unlocked field becomes 1', st().unlocked === 1, { unlocked: st().unlocked });
    rec('the one record that parsed is kept rather than rewritten',
      !!M.store.record('harbour-01') && M.store.record('harbour-01').bestSteps === 99, M.store.record('harbour-01'));
    rec('a missing stats object is filled in, not read as zero',
      M.store.stats.solves === 0 && 'ops' in M.store.stats && 'hints' in M.store.stats, M.store.stats);
    const s = solve(false);
    rec('and level 1 is still winnable from that boot', s.done === true && s.steps === 2 && s.ops === 3, s);
    rec('a better run beats the 99 that survived', M.store.record('harbour-01').bestSteps === 2, M.store.record('harbour-01'));
    localStorage.removeItem(KEY);
    return { rows, stats: M.store.stats };
  })()`,
};

// ------------------------------------------------------------------------------- pointer

// The one suite a page-side script cannot run: real input. Everything below goes through
// Chrome's own mouse over the canvas, so what gets asserted is the pointer-to-cell wiring in
// js/view.js — the geometry, the 5-pixel drag threshold, the rebound drop — not the rule.
async function pointerScenario(cdp, sessionId, runJS) {
  const rows = [];
  const rec = (test, pass, detail) => rows.push({ test, pass: !!pass, detail: detail === undefined ? null : detail });
  const S = async () => JSON.parse(await runJS('JSON.stringify(window.minishop.state)'));
  const B = async () => runJS('window.minishop.board().split("\\n")');
  const boardOf = (lines) => JSON.stringify(lines);
  // model.draw() prints '#' for a hull and '~' for a water mark, so a real drop can be read
  // back as text rather than as a colour the assertion would have to guess at.
  const seaIs = async (lines) => JSON.stringify(await B()) === boardOf(lines);

  await runJS('window.minishop.load("#/c/1"); window.minishop.reset(); 1');
  await runJS('document.getElementById("sea").scrollIntoView({block:"center"}); 1');
  await sleep(250);

  const cell = JSON.parse(await runJS('JSON.stringify(window.minishop.cellPoint(2,0))'));
  const dock = JSON.parse(await runJS('JSON.stringify(window.minishop.shipPoint(0))'));
  rec('the view tells the mouse where the cells and the dock are', !!cell && !!dock, { cell, dock });
  const reach = await runJS(`(()=>{const p=window.minishop.cellPoint(2,0);const b=document.getElementById('sea').getBoundingClientRect();
    return {y:Math.round(p.y),top:Math.round(b.top),bottom:Math.round(b.bottom),inner:Math.round(innerHeight)};})()`);
  rec('the board is on screen so a real click can reach it',
    reach.y > reach.top - 2 && reach.y < Math.min(reach.bottom, reach.inner), reach);

  const start = await S();
  const d1 = await dragShipTo(cdp, sessionId, runJS, 0, 2, 0);
  rec('a drag from the dock puts a hull on the sea', !!d1, d1);
  const afterDrop = await S();
  rec('the drag cost exactly one operation and one placement',
    afterDrop.ops === start.ops + 1 && afterDrop.steps === start.steps + 1 && afterDrop.done === false, afterDrop);
  rec('the cell the finger released over is the cell that filled',
    (await seaIs(['....', '....', '##..', '....'])), await B());

  const p2 = await pressCell(cdp, sessionId, runJS, 0, 3);
  rec('a press and release with no travel is a water mark', !!p2, p2);
  const afterTap = await S();
  const g3 = await runJS('window.minishop.grid()[3]');
  rec('the mark spent an operation and no placement',
    afterTap.ops === afterDrop.ops + 1 && afterTap.steps === afterDrop.steps && g3 === 2, { afterTap, g3 });
  rec('the sea print shows the mark', await seaIs(['...~', '....', '##..', '....']), await B());
  await pressCell(cdp, sessionId, runJS, 0, 3);
  const afterClear = await S();
  rec('tapping the same cell again clears it, and that is an operation too',
    (await runJS('window.minishop.grid()[3]')) === 0 && afterClear.ops === afterTap.ops + 1 && afterClear.steps === afterTap.steps, afterClear);

  const dbl = await doubleClickCell(cdp, sessionId, runJS, 2, 0);
  rec('a real double click on a hull is a rotate', !!dbl, dbl);
  const afterDbl = await S();
  const axis = await runJS('window.minishop.ships()[0].axis');
  rec('double clicking turned it and spent nothing',
    axis === 'v' && afterDbl.ops === afterClear.ops && afterDbl.steps === afterClear.steps, { axis, afterDbl });
  rec('the sea now holds the turned hull', await seaIs(['....', '....', '#...', '#...']), await B());

  const bad = await dragShipTo(cdp, sessionId, runJS, 1, 2, 1);
  rec('a hull was dragged for real onto a cell beside another hull', !!bad, bad);
  const afterBad = await S();
  rec('it rebounded: no operation, no placement, no second hull on the sea',
    afterBad.ops === afterDbl.ops && afterBad.steps === afterDbl.steps
    && await seaIs(['....', '....', '#...', '#...']),
    { afterBad, board: await B() });

  await dragShipTo(cdp, sessionId, runJS, 1, 2, 2);
  const finished = await S();
  rec('the last legal drop finished the chart through the mouse alone',
    finished.done === true && finished.ops === afterBad.ops + 1 && finished.steps === 2, finished);
  const stars = await runJS('document.getElementById("stars").textContent');
  rec('the curtain came up by itself', finished.curtain === true && stars === '★★★', { curtain: finished.curtain, stars });

  await dragOffBoard(cdp, sessionId, runJS, 0);
  const afterFinishedDrag = await S();
  rec('a finished chart ignores the mouse entirely',
    afterFinishedDrag.ops === finished.ops && afterFinishedDrag.steps === finished.steps, afterFinishedDrag);

  await runJS('window.minishop.click("again"); 1');
  await sleep(150);
  const afterAgain = await S();
  rec('再来一次 puts the fleet back in the dock',
    afterAgain.ops === 0 && afterAgain.steps === 0 && afterAgain.done === false
    && await seaIs(['....', '....', '....', '....']),
    { afterAgain, board: await B() });

  const second = await dragShipTo(cdp, sessionId, runJS, 0, 0, 0);
  rec('dragging out of the dock after a reset works again', !!second && (await S()).ops === 1, second);
  await dragOffBoard(cdp, sessionId, runJS, 0);
  const retrieved = await S();
  rec('dragging a hull off the board takes it back: an operation, not a refunded placement',
    retrieved.ops === 2 && retrieved.steps === 1
    && await seaIs(['....', '....', '....', '....']), { retrieved, board: await B() });
  return { rows, notes: { cell, dock } };
}

// ------------------------------------------------------------------------------------ main

async function main() {
  const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  let list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  if (cmd === 'open') {
    for (const t of list) if (t.type === 'page' && isOurs(t.url)) {
      try { await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId }); } catch { /* gone already */ }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isOurs(t.url));
  let targetId, sessionId;
  if (existing) {
    targetId = existing.id || existing.targetId;
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  } else {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  }
  const logs = [];
  globalThis.__printEvents = (m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${e.exception?.description || e.text}\n  at ${e.url}:${e.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error' || e.source === 'rendering') logs.push(`[log:${e.level}] ${e.text} ${e.url || ''}`);
    }
  };
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const runJS = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const oneLine = async () => runJS('window.minishop.state.id + " ops=" + window.minishop.state.ops'
    + ' + " steps=" + window.minishop.state.steps + " done=" + window.minishop.state.done');

  // Wait on the shell, not on a timer. This page is a module graph fetched over the network:
  // a fixed sleep is long enough for a localhost server and too short for GitHub Pages, where
  // it used to hand back `window.minishop === undefined` and a canvas still at the unstyled
  // 300x150 default — which the paint assertions above would then report as a broken view.
  const waitShell = async (floorMs, budgetMs = SHELL_TIMEOUT) => {
    await sleep(floorMs);
    const deadline = Date.now() + budgetMs;
    for (;;) {
      let ready = false;
      try {
        ready = await runJS('!!(window.minishop && window.minishop.state && window.minishop.state.id)');
      } catch { ready = false; }
      if (ready) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  };

  const url = process.argv[4] || process.argv[3] || BASE;

  if (cmd === 'open') {
    await cdp.send('Page.navigate', { url }, sessionId);
    await waitShell(600);
    console.log(`opened ${url}\n` + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'nav') {
    await cdp.send('Page.navigate', { url }, sessionId);
    await waitShell(400);
    console.log('navigated\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'place' || cmd === 'water') {
    // One real gesture against the page that is already open, for a human reproducing a
    // failure or taking the screenshot they will actually look at.
    const a = process.argv.slice(3).map(Number);
    const got = cmd === 'place'
      ? await dragShipTo(cdp, sessionId, runJS, a[0], a[1], a[2])
      : await pressCell(cdp, sessionId, runJS, a[0], a[1]);
    console.log(`${cmd} -> ${JSON.stringify(got)} :: ${await oneLine()}`);
  } else if (cmd === 'eval') {
    const arg = process.argv[3];
    if (process.argv[4] !== 'nonav') {
      await cdp.send('Page.navigate', { url: BASE }, sessionId);
      await waitShell(300);
    }
    if (arg && arg.startsWith('@')) {
      const name = arg.slice(1);
      let value = null;
      if (name === 'pointer') {
        value = await pointerScenario(cdp, sessionId, runJS);
      } else if (SCENARIOS[name]) {
        // Clear the row buffer *before* running. With `nonav` every scenario is evaluated in
        // the same page, so if this suite throws at parse time the fallback below would
        // otherwise hand back the previous suite's rows and verify.sh would print them as if
        // they belonged to this one — a broken suite that looks green.
        await runJS('window.__lastRows = null; 1');
        try {
          value = await runJS(SCENARIOS[name]);
        } catch (err) {
          const dumped = await runJS('JSON.stringify(window.__lastRows||[])').catch(() => '[]');
          value = { rows: JSON.parse(dumped) };
          value.rows.push({ test: `@${name} threw`, pass: false, detail: String(err.message).slice(0, 300) });
        }
      } else {
        console.log('unknown scenario ' + name + ' — have ' + Object.keys(SCENARIOS).join(', ') + ', pointer');
        process.exit(1);
      }
      value.fail = (value.rows || []).filter((r) => !r.pass).map((r) => r.test);
      console.log(JSON.stringify(value, null, 2));
    } else {
      try {
        console.log(JSON.stringify(await runJS(arg), null, 2));
      } catch (err) {
        console.log('EVAL THROW: ' + err.message);
      }
    }
    if (logs.length) console.log('--- console ---\n' + logs.join('\n'));
  } else if (cmd === 'shot') {
    await runJS('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    (await import('node:fs')).writeFileSync(process.argv[3], Buffer.from(data, 'base64'));
    console.log(`wrote ${process.argv[3]} (${Math.round(data.length / 1024)}kB b64)`);
  } else if (cmd === 'logs') {
    await sleep(800);
    console.log(logs.join('\n') || '(none)');
  } else {
    console.log('usage: node tools/playtest.mjs open|nav|eval|place|water|shot|logs ...');
    process.exit(2);
  }
  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('PLAYTEST FAILED: ' + ((err && err.stack) || err));
  process.exit(1);
});
