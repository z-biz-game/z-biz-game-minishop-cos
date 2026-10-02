// Minimal CDP driver for headless playtesting (Node 21+ global WebSocket/fetch).
// env: CDP_PORT (devtools port, default 9375), BASE_URL (page to attach to, default
//      http://127.0.0.1:5275/)
//      5275/9375 是本仓在 z-biz-game 端口表里占的那一对。5271/9371 不是：那一对写在
//      z-biz-game-battleship-cos 的 verify.sh 里（"5271 is battleship's and nothing else's"），
//      9371 还被 z-biz-game-euclid-cos 占着。在这个仓的历史里出现过 5271 是搬代码带来的
//      遗产，不是本仓的号——附到别人的 Chrome 上会把断言打在别人的页面上，那种绿比红更糟。
// usage:
//   node tools/playtest.mjs open   <url>        # close our old pages, open this one
//   node tools/playtest.mjs nav    <url> same   # fragment nav: must NOT be a new document
//   node tools/playtest.mjs reload              # real reload: must BE a new document
//   node tools/playtest.mjs eval   '<js>'       # pass `nonav` to skip the reload
//   node tools/playtest.mjs eval   '@boot'      # | @play | @win | @routes | @save | @reloaded | @partial
//   node tools/playtest.mjs eval   '@pointer'   # real mouse over the canvas
//   node tools/playtest.mjs leg    touch|keys   # node-side leg: real touch / real key events
//   node tools/playtest.mjs place  <i> <r> <c>  # one real drag of hull i onto cell (r,c)
//   node tools/playtest.mjs water  <r> <c>      # one real press+release on a cell
//   node tools/playtest.mjs shot   <path.png>
//   node tools/playtest.mjs logs
//
// Every reporting command prints one `RESULT {json}` line: {leg, checks, rows, fail}. That is
// the only shape tools/verify.sh aggregates, so a leg that prints no RESULT cannot be green.
//
// Why this file exists at all: js/core/* is proven in node, and the shell that wires it to
// the DOM is not. These suites attach to a real Chrome loading a real http:// URL, so the
// module graph, the canvas geometry, the pointer handlers and localStorage are the shipped
// ones rather than a mock of them.

const PORT = Number(process.env.CDP_PORT || 9375);
// Which page to attach to. Hard-coding the dev-server port silently evaluates against a
// fresh about:blank tab when pointed at any other origin.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5275/';
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

// One real touch point. js/view.js listens for pointer events, and Chrome only synthesises a
// pointer event with pointerType 'touch' from Input.dispatchTouchEvent — so the touch leg and
// the mouse leg are two different channels over the wire, not one channel asserted twice.
const touchAt = (cdp, sessionId, type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints }, sessionId);
const fingerAt = (x, y) => [{ x, y, radiusX: 6, radiusY: 6, force: 1, id: 1 }];

// keyDown -> char -> keyUp, the same three messages a real key produces.
//
// 绝不给 nativeVirtualKeyCode：在 macOS 上 Chrome 把它当平台原生键码，于是这只键被 raw
// keyboard 路径反复补发（实测 500 ms 内到达数千次 keydown）。只给 windowsVirtualKeyCode，
// 让 Chrome 自己推原生键码，一次派发才正好是一次按键。
const KEYCODES = {
  u: { code: 'KeyU', vk: 85 }, h: { code: 'KeyH', vk: 72 }, r: { code: 'KeyR', vk: 82 },
  '0': { code: 'Digit0', vk: 48 }, Escape: { code: 'Escape', vk: 27 }, x: { code: 'KeyX', vk: 88 },
};
async function keyPress(cdp, sessionId, key, { ctrl = false } = {}) {
  const map = KEYCODES[key];
  if (!map) throw new Error('keys leg has no wire mapping for ' + key);
  const text = key.length === 1 ? key : undefined;
  const base = { key, code: map.code, windowsVirtualKeyCode: map.vk };
  if (ctrl) base.modifiers = 2; // CDP modifier bitmask: 2 = Ctrl
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text }, sessionId);
  if (text) await cdp.send('Input.dispatchKeyEvent', { type: 'char', ...base, text }, sessionId);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId);
  await sleep(70);
}

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

// The touch twins of dragShipTo / pressCell: the same targets, the same number of steps, the
// same waits, only a different input channel. If these two sets of coordinates drifted apart,
// the touch leg would be testing a different gesture than the mouse leg while both went green.
async function touchDragTo(cdp, sessionId, runJS, i, r, c, steps = 6) {
  const from = await runJS(`window.minishop.shipPoint(${i})`);
  const to = await runJS(`window.minishop.cellPoint(${r},${c})`);
  if (!from || !to) return null;
  await touchAt(cdp, sessionId, 'touchStart', fingerAt(from.x, from.y));
  for (let k = 1; k <= steps; k++) {
    const x = Math.round(from.x + ((to.x - from.x) * k) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * k) / steps);
    await touchAt(cdp, sessionId, 'touchMove', fingerAt(x, y));
    await sleep(16);
  }
  await touchAt(cdp, sessionId, 'touchEnd', []);
  await sleep(120);
  return { from, to };
}

async function touchPress(cdp, sessionId, runJS, r, c, hold = 40) {
  const p = await runJS(`window.minishop.cellPoint(${r},${c})`);
  if (!p) return null;
  await touchAt(cdp, sessionId, 'touchStart', fingerAt(p.x, p.y));
  await sleep(hold);
  await touchAt(cdp, sessionId, 'touchEnd', []);
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
  // What the player actually put on the sea, compared cell by cell with the answer the
  // exhaustive counter proved unique. A board can pass validate() on clues alone and still be
  // a second solution; this is the assertion that says "you built *the* fleet".
  const seaMatchesSpec = () => {
    const sp = M.spec(), g = M.grid(), cols = sp.cols;
    const want = new Set();
    sp.ships.forEach((s) => {
      for (let k = 0; k < s.len; k++) want.add(s.r * cols + s.c + (s.axis === 'v' ? k * cols : k));
    });
    for (let i = 0; i < g.length; i++) if ((g[i] === 1) !== want.has(i)) return false;
    return true;
  };
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
  boot: `${PRELUDE}  (() => {
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
    rec('舰队条发出来的第一条船是横放的（默认 axis h）', M.ships()[0].axis === 'h', M.ships()[0]);
    rec('在船坞里旋转不花钱，转完变成竖的', M.rotate(0) === true && st().ops === 0 && st().steps === 0
      && M.ships()[0].axis === 'v', st());
    rec('placing hull 1 spends one operation and one placement step',
      M.place(0, 2, 0).ok === true && st().ops === 1 && st().steps === 1, st());
    rec('the board the view prints agrees with the rules',
      JSON.stringify(sea()) === JSON.stringify(['....', '....', '#...', '#...']), sea());
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
    M.reset();
    rec('reopening clears the board and keeps the record',
      st().ops === 0 && st().steps === 0 && st().done === false && M.store.record('harbour-01').solved === true, st());
    // 提示必须问在一张还没完成的海图上：完成的图没有可提示的东西，那条分支只会 say
    // 「没有可提示的了」并且不入账，于是"提示计费"这条断言在通关之后永远读不到 1。
    const want0 = M.spec().ships[0];
    while (M.ships()[0].axis !== want0.axis) M.rotate(0);
    M.place(0, want0.r, want0.c);
    const hinted = M.hintOnce();
    rec('a hint is billable and names a home', hinted.hints === 1 && hinted.line.includes('提示')
      && st().done === false, hinted);
    const sloppy = solve(true);
    rec('placing one hull twice is legal and scores worse',
      sloppy.done === true && sloppy.steps === sloppy.par + 1, sloppy);
    rec('落下去又拿起来的那一局评一星：勉强成军', text('stars') === '★☆☆' && text('verdict') === '勉强成军',
      { stars: text('stars'), verdict: text('verdict') });
    rec('the record still remembers the better run', M.store.record('harbour-01').bestSteps === 2, M.store.record('harbour-01'));
    click('again');
    rec('再来一次 puts the fleet back in the dock',
      st().ops === 0 && st().steps === 0 && st().curtain === false && sea().every((r) => /^\\.+$/.test(r)),
      { state: st(), sea: sea() });
    return { rows, save: M.store.record('harbour-01'), stats: M.store.stats };
  })()`,

  // The win path on the deep bands, which is where a shell bug hides: a 4-ship dock, a canvas
  // that has to fit 8x8 into the same box, and the 下一关 button that walks the ladder.
  win: `${PRELUDE}
  (() => {
    M.load('#/c/13');
    const p = solve(false);
    rec('patrol-01 通关：放置等于下限 3', p.done === true && p.steps === 3 && p.par === 3 && p.tier === 'patrol', p);
    rec('通关判据来自独立校验器，不是烘进来的答案', M.verify().solved === true, M.verify());
    rec('三颗星与 一子不差 是同一条判据的两种印法', text('stars') === '★★★' && text('verdict') === '一子不差',
      { stars: text('stars'), verdict: text('verdict') });
    const prog = M.progress();
    rec('线索条全绿：每一行每一列都被满足', prog.rows.every(Boolean) && prog.cols.every(Boolean), prog);
    const drawn = sea().join('|');
    rec('画布画的这支舰队逐格等于计数器证明的唯一解', seaMatchesSpec(), { drawn });
    click('next');
    rec('下一关 从 13 走到 14，还在巡航 band 里', st().index === 14 && st().id === 'patrol-02' && st().curtain === false, st());
    M.load('#/c/25');
    const c = st();
    rec('拐角 band 是 7x7、4 条船、推理深度 2',
      c.rows === 7 && c.cols === 7 && c.par === 4 && c.depth === 2 && c.tier === 'crossing', c);
    const cd = solve(false);
    rec('7x7 也能只放下限次就通关', cd.done === true && cd.steps === cd.par, cd);
    M.load('#/c/48');
    const l = st();
    rec('梯子最后一格是孤舰 band，深度 3', l.id === 'lone-12' && l.depth === 3 && l.rows === 8 && l.par === 4, l);
    const reachAll = (() => {
      const b = document.getElementById('sea').getBoundingClientRect();
      let outside = 0, belowFold = 0;
      for (let r = 0; r < 8; r++) {
        for (let q = 0; q < 8; q++) {
          const pt = M.cellPoint(r, q);
          if (!pt) { outside++; continue; }
          if (pt.x < b.left - 1 || pt.x > b.right + 1 || pt.y < b.top - 1 || pt.y > b.bottom + 1) outside++;
          if (pt.y > innerHeight) belowFold++;
        }
      }
      return { outside, belowFold, box: [Math.round(b.top), Math.round(b.bottom)], innerHeight: Math.round(innerHeight) };
    })();
    rec('最大的一张图 8x8：64 格全在画布盒子里，一格都不许掉在外面', reachAll.outside === 0, reachAll);
    const ld = solve(true);
    rec('多放一次也照样通关，只是评星降级', ld.done === true && ld.steps === ld.par + 1, ld);
    rec('降级的那一档印的是 勉强成军', text('stars') === '★☆☆' && text('verdict') === '勉强成军',
      { stars: text('stars'), verdict: text('verdict'), steps: ld.steps, par: ld.par });
    rec('幕布把两个计数和证明一起报出来', text('tally').includes('解数') && text('tally').includes('推理深度'), text('tally'));
    rec('最后一关不再给 下一关', document.getElementById('next').hidden === true, { hidden: document.getElementById('next').hidden });
    M.load('#/c/1');
    return { rows, patrol: p, crossing: cd, lone: ld };
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
    // 梯子每 band 12 关：1·13·25·37 才是四个 band 的第一张（写成 14 会读到 patrol-02，
    // 而它同样是 6x6，所以下面那条形如 ["patrol-01",6,6] 的期望才是唯一能发现它的地方）。
    const sizes = [1, 13, 25, 37].map((n) => { const s = one('#/c/' + n); return [s.id, s.rows, s.cols]; });
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
    // 「不能抬高记录」得先有一条记录可抬：上面那个干净的 2 步开在 harbour-01 上，而这里重放的
    // 是 harbour-02 —— 它自己还没有过干净成绩，bestSteps 从空里长出来正好等于 sloppy 的步数，
    // 于是这条断言当时比的其实是"第一份成绩有没有被写歪"。先在本关干净地过一次，再乱放一次。
    const tidy = solve(false);
    rec('harbour-02 先有一个干净成绩垫底（记录抬高的前提）',
      tidy.done === true && M.store.record(tidy.id).bestSteps === tidy.par, { tidy, best: M.store.record(tidy.id).bestSteps });
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

// Each suite above is PRELUDE + one expression, and it is evaluated straight into the page's
// global scope. Two suites then share a document (the core leg runs boot and routes in the
// page it opened), and a second `const rows` at top level is not a re-initialisation, it is a
// SyntaxError that kills the run. Wrapping in a function scope is what makes "same document,
// several suites" a supported thing rather than a leg ordering constraint.
function scenarioSource(name) {
  const src = SCENARIOS[name];
  if (!src.startsWith(PRELUDE)) throw new Error(`SCENARIOS.${name} no longer starts with PRELUDE — the wrapper would double it`);
  return `(() => {\n${PRELUDE}\nreturn (${src.slice(PRELUDE.length)});\n})()`;
}

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

// The same chart the mouse leg drives, driven by a finger. It exists because js/view.js binds
// pointer events: a mouse-only gate would never notice a handler that reads `ev.button` or
// waits for a release Chrome only synthesises for a mouse. The probe below is what makes this
// a touch claim rather than a re-run of the mouse leg — pointerType is read back from the
// handler the shipped view installed, on the document this gesture actually reached.
async function touchScenario(cdp, sessionId, runJS) {
  const rows = [];
  const rec = (test, pass, detail) => rows.push({ test, pass: !!pass, detail: detail === undefined ? null : detail });
  const S = async () => JSON.parse(await runJS('JSON.stringify(window.minishop.state)'));
  const B = async () => runJS('window.minishop.board().split("\\n")');
  const seaIs = async (lines) => JSON.stringify(await B()) === JSON.stringify(lines);

  await runJS('window.minishop.load("#/c/1"); window.minishop.reset(); 1');
  await runJS('document.getElementById("sea").scrollIntoView({block:"center"}); 1');
  await sleep(250);
  await runJS(`window.__ptypes = [];
    document.getElementById('sea').addEventListener('pointerdown', (e) => window.__ptypes.push(e.pointerType), true);
    document.getElementById('sea').addEventListener('pointerup', (e) => window.__ptypes.push('up:' + e.pointerType), true); 1`);

  const start = await S();
  const d1 = await touchDragTo(cdp, sessionId, runJS, 0, 2, 0);
  rec('the finger found the dock and the cell it wanted', !!d1, d1);
  const afterDrop = await S();
  rec('a touch drag costs exactly one operation and one placement',
    afterDrop.ops === start.ops + 1 && afterDrop.steps === start.steps + 1 && afterDrop.done === false, afterDrop);
  rec('the cell the finger lifted off is the cell that filled',
    (await seaIs(['....', '....', '##..', '....'])), await B());
  const seen = await runJS('window.__ptypes.join(",")');
  rec('the view really saw a touch, not a mouse', /touch/.test(seen) && !/mouse/.test(seen), seen);

  const p2 = await touchPress(cdp, sessionId, runJS, 0, 3);
  rec('a press and lift with no travel is a water mark', !!p2 && (await runJS('window.minishop.grid()[3]')) === 2, p2);
  const afterTap = await S();
  rec('the mark spent an operation and no placement',
    afterTap.ops === afterDrop.ops + 1 && afterTap.steps === afterDrop.steps, afterTap);
  await touchPress(cdp, sessionId, runJS, 0, 3);
  const afterClear = await S();
  rec('tapping the same cell again clears it and bills the same way',
    (await runJS('window.minishop.grid()[3]')) === 0 && afterClear.ops === afterTap.ops + 1, afterClear);

  // The dock hands out hull 0 flat, so the drag above laid it down horizontally. Turning it is
  // the rotate button's job in this leg rather than a double click: a programmatic button click
  // sends no pointer event, so the probe underneath still sees a touch-only leg.
  await runJS('window.minishop.rotate(0); 1');
  rec('转过去之后画布上是竖着的那条', await seaIs(['....', '....', '#...', '#...']), await B());
  const bad = await touchDragTo(cdp, sessionId, runJS, 1, 2, 1);
  const afterBad = await S();
  rec('手指把第二条船按在紧邻的格子上：弹回，一次都不记账',
    !!bad && afterBad.ops === afterClear.ops && afterBad.steps === afterClear.steps
      && await seaIs(['....', '....', '#...', '#...']), { afterBad, board: await B() });
  await touchDragTo(cdp, sessionId, runJS, 1, 2, 2);
  const finished = await S();
  rec('the last legal touch finished the chart with no mouse ever sent',
    finished.done === true && finished.steps === 2 && finished.curtain === true, finished);
  const stars = await runJS('document.getElementById("stars").textContent');
  rec('the curtain came up by itself', stars === '★★★', { stars });
  const ptypes = await runJS('window.__ptypes.join(",")');
  rec('every pointer the view handled in this leg came from the touch channel',
    !/mouse/.test(ptypes), ptypes);
  await runJS('window.minishop.click("again"); 1');
  await sleep(150);
  const afterAgain = await S();
  rec('再来一次 puts the fleet back in the dock for the finger too',
    afterAgain.ops === 0 && afterAgain.steps === 0 && await seaIs(['....', '....', '....', '....']), afterAgain);
  return { rows, ptypes };
}

// Real key events down the CDP input channel. This leg is the only place the window-level
// keydown handler in js/main.js is exercised — a mouse-only gate would let a typo in that
// switch ship silently. The delivery probe is not decoration: headless Chrome has been known
// to swallow key events, and without a count of what the page actually received a swallowed
// leg looks identical to a leg whose bindings were removed.
async function keysScenario(cdp, sessionId, runJS) {
  const rows = [];
  const rec = (test, pass, detail) => rows.push({ test, pass: !!pass, detail: detail === undefined ? null : detail });
  const S = async () => JSON.parse(await runJS('JSON.stringify(window.minishop.state)'));

  await runJS('window.minishop.load("#/c/1"); window.minishop.reset(); 1');
  await runJS(`window.__keys = [];
    window.addEventListener('keydown', (e) => window.__keys.push(e.key), true); 1`);
  const active = await runJS('document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : "null"');
  rec('the document has focus so a key has somewhere to go', active !== 'null', { active });

  await runJS('window.minishop.place(0, 2, 0); 1');
  // 选中是这条腿的前置，不是它的断言。main.js 的 R 走 el.rotate.click()，而那个处理器在
  // 谁都没选中的时候只会印「先点一条船（舰队条上的或海图上的），再旋转」——那是写明的约定，
  // 不是 bug。所以人和这条腿一样：先真真切切点一下那条船，R 才有对象。这一击不动账
  // （js/view.js 的 up()：moved < 5 就是"选中"），于是下面那条"不花钱"仍然只测键。
  const grab = await runJS('window.minishop.shipPoint(0)');
  rec('船已经在 (2,0) 上，指得到它才谈得上旋转', !!grab && grab.cell > 0, grab);
  await mouseAt(cdp, sessionId, 'mousePressed', grab.x, grab.y, 1, 1);
  await sleep(40);
  await mouseAt(cdp, sessionId, 'mouseReleased', grab.x, grab.y, 0, 1);
  await sleep(90);
  const axisBefore = await runJS('window.minishop.ships()[0].axis');
  await keyPress(cdp, sessionId, 'r');
  const axisAfter = await runJS('window.minishop.ships()[0].axis');
  const afterR = await S();
  rec('R 真的转了选中的那条船，而且不花钱',
    axisAfter !== axisBefore && afterR.ops === 1 && afterR.steps === 1, { axisBefore, axisAfter, afterR });

  await keyPress(cdp, sessionId, 'h');
  const afterH = await S();
  rec('H 按出了提示并计了费', afterH.hints === 1 && afterH.hintline.includes('提示'), { hints: afterH.hints, hintline: afterH.hintline });

  // 撤销的靶子必须是一步「没有把海图下完」的放置。harbour-01 只有两条船，第二条落进 (2,2)
  // 就是那个被穷举证明的唯一解，done 于是立刻关掉整个编辑面 —— js/core/game.js 的
  // place/retrieve/rotate/tapCell/hint 全按 done 拒，js/main.js 把 undo/rotate/hint 三个按钮
  // disabled 掉，mouse 腿的「a finished chart ignores the mouse entirely」与 logic 闸的
  // 「完成后一切都被拒」钉的都是这条规矩。原来的腿先落下收尾那一子、再要求 U 退还它，
  // 它数的其实一直是「done 之后按钮为什么点不动」，跟「撤销一步放置」没关系：那是证人的前置
  // 错了，不是规则错了。改的是这条腿怎么测：靶子换成 (0,0) —— 几何合法、但不是唯一解，
  // done 保持 false，U 才有真对象；而 done 之后按 U 不退账这件事在下面单独有人数着，
  // 于是这条腿不能靠「把 done 改成可编辑」来给自己变绿。
  await runJS('window.minishop.place(1, 0, 0); 1');
  const beforeU = await S();
  rec('这一步落得下去，但它不是收尾那一子',
    beforeU.steps === 2 && beforeU.ops === 2 && beforeU.done === false, beforeU);
  await keyPress(cdp, sessionId, 'u');
  const afterU = await S();
  rec('U 撤销了最后一步放置',
    afterU.steps === beforeU.steps - 1 && afterU.ops === beforeU.ops - 1, { beforeU, afterU });

  await runJS('window.minishop.place(1, 2, 2); 1');
  const afterFinish = await S();
  rec('第二条船回了位，海图当场判完成',
    afterFinish.done === true && afterFinish.curtain === true && afterFinish.steps === 2, afterFinish);
  await keyPress(cdp, sessionId, 'u');
  const afterFinishedU = await S();
  rec('完成之后再按 U 一个数都不退',
    afterFinishedU.steps === afterFinish.steps && afterFinishedU.ops === afterFinish.ops
    && afterFinishedU.curtain === true, { afterFinish, afterFinishedU });

  // 提示必须能在收尾那一屏留下痕迹。js/core/game.js 的 grade() 读的是 game.hints，
  // 而计费一度只写在壳自己的 app.hints 上：那一档「有人指路」因此永远不会出现，
  // 用过提示的盘照样判「一子不差」，而 tally 那行明明印着「提示 1」。
  // 这一条数的就是那一个数有没有走到评星眼里——逻辑闸看不见它，两个计数器都在壳里。
  rec('用过提示之后收尾，verdict 必须降级成「有人指路」',
    afterFinish.hints === 1 && afterFinish.steps === afterFinish.par && afterFinish.verdict === '有人指路',
    { hints: afterFinish.hints, steps: afterFinish.steps, par: afterFinish.par, verdict: afterFinish.verdict });

  await keyPress(cdp, sessionId, '0');
  const after0 = await S();
  rec('数字 0 重开了这一关', after0.ops === 0 && after0.steps === 0 && after0.done === false, after0);

  const hintsBefore = after0.hints;
  await keyPress(cdp, sessionId, 'h', { ctrl: true });
  const afterCtrlH = await S();
  rec('带 Ctrl 的组合键被这道闸挡在外面，没有当成 h',
    afterCtrlH.hints === hintsBefore, { hintsBefore, hints: afterCtrlH.hints });

  const before = await S();
  await keyPress(cdp, sessionId, 'x');
  const afterX = await S();
  rec('一个没有绑定的键什么都不做',
    afterX.ops === before.ops && afterX.steps === before.steps && afterX.hints === before.hints, afterX);
  rec('派发的每一只键都在页面上的 keydown 里数到了',
    await runJS('window.__keys.join(",")') === 'r,h,u,u,0,h,x', await runJS('window.__keys.join(",")'));

  await runJS(`(() => { const M = window.minishop; const want = M.spec().ships;
    want.forEach((w) => { while (M.ships()[want.indexOf(w)].axis !== w.axis) M.rotate(want.indexOf(w)); M.place(want.indexOf(w), w.r, w.c); });
    return 1; })()`);
  const done = await S();
  rec('键盘腿收尾时这一关是由规则判通关的', done.done === true && done.curtain === true, done);
  await keyPress(cdp, sessionId, 'Escape');
  const afterEsc = await S();
  rec('Escape 收起幕布，但不收起这局的成果',
    afterEsc.curtain === false && afterEsc.done === true, afterEsc);
  const keysNow = await runJS('window.__keys.join(",")');
  rec('每一只派发的键都在页面上的 keydown 里数到了（含收尾的 Escape）',
    keysNow === 'r,h,u,u,0,h,x,Escape', keysNow);
  return { rows, keys: keysNow };
}

// ---------------------------------------------------------------------------- reporting

// tools/verify.sh reads exactly one `RESULT` line per run and turns it into the pass/fail table
// it prints, so every leg — page-side scenario, node-side gesture, navigation control — is
// counted by the same code. There is no second aggregation path for a leg to slip through.
//
// GATE_SELFTEST=1 plants one failing row into that single path. It is not a per-scenario hook
// on purpose: a planted error that only some legs carry is a negative control that proves the
// planting, not the gate.
let REPORTED_FAILURES = 0;
function emit(value, tag) {
  const rows = (value && value.rows) || [];
  if (process.env.GATE_SELFTEST === '1') {
    rows.push({ test: `GATE_SELFTEST ${tag}：种下的错期望 1 === 2`, pass: false, detail: 'planted by tools/verify.sh' });
  }
  const bad = rows.filter((r) => !r.pass);
  const extra = {};
  for (const k of Object.keys(value || {})) if (k !== 'rows' && k !== 'fail') extra[k] = value[k];
  console.log('RESULT ' + JSON.stringify({ leg: tag, checks: rows.length, rows, fail: bad.length }));
  if (Object.keys(extra).length) console.log('EXTRA ' + JSON.stringify(extra));
  // 手工跑一条腿的人拿到的退码，必须和闸从 RESULT 里读到的数是同一件事：只印 RESULT
  // 而永远 exit 0，等于让"我跑过了"和"我跑绿了"长得一样。
  REPORTED_FAILURES += bad.length;
  return bad.length;
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

  // The document witness. `doc` is a token that only exists on the current JS global object:
  // a same-document (fragment) navigation keeps it, a real load wipes it. Reading it is the
  // only way the navigation legs can tell "the page reloaded" apart from "the hash changed",
  // and the save leg's resume assertions are worthless without that distinction.
  const DOCINFO = `(() => {
    if (!window.__gateDoc) window.__gateDoc = 'doc' + Math.floor(Math.random() * 1e9);
    return JSON.stringify({ url: location.href, timeOrigin: performance.timeOrigin,
      doc: window.__gateDoc, boot: !!(window.minishop && window.minishop.state && window.minishop.state.id) });
  })()`;
  const docInfo = async () => JSON.parse(await runJS(DOCINFO));

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
  } else if (cmd === 'nav' || cmd === 'reload') {
    // 证人由 node 在派发导航之前取走：这一条腿要比的是"导航前后是不是同一个文档"，
    // 而不是"我有没有按过一次刷新"。
    const before = await docInfo();
    const expect = cmd === 'reload' ? 'fresh' : (process.argv[4] || 'fresh');
    const target = cmd === 'reload' ? before.url.split('#')[0] : (process.argv[3] || BASE);
    await cdp.send(cmd === 'reload' ? 'Page.reload' : 'Page.navigate',
      cmd === 'reload' ? { ignoreCache: true } : { url: target }, sessionId);
    await sleep(expect === 'fresh' ? 500 : 300);
    await waitShell(0, expect === 'fresh' ? 12000 : 4000);
    const after = await docInfo();
    const nrows = [];
    const nrec = (test, pass, detail) => nrows.push({ test, pass: !!pass, detail: detail === undefined ? null : detail });
    nrec('导航之后还在这条 URL 形态上', new URL(after.url).pathname === new URL(target).pathname, { before: before.url, after: after.url });
    nrec('导航之后应用还在（window.minishop 起得来）', after.boot === true, after);
    if (expect === 'same') {
      nrec('片段导航不算重载：performance.timeOrigin 必须没变', after.timeOrigin === before.timeOrigin,
        { before: before.timeOrigin, after: after.timeOrigin });
      nrec('片段导航不算重载：文档身份哨兵必须没换', after.doc === before.doc, { before: before.doc, after: after.doc });
    } else {
      nrec('真重载：performance.timeOrigin 必须换了（这是新文档）', after.timeOrigin !== before.timeOrigin,
        { before: before.timeOrigin, after: after.timeOrigin });
      nrec('真重载：文档身份哨兵必须换了', after.doc !== before.doc, { before: before.doc, after: after.doc });
    }
    emit({ rows: nrows }, cmd === 'reload' ? 'reload' : 'frag');
    console.log('navigated\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'leg') {
    // node 侧的腿：真事件从 CDP 的 input 通道派发，页面只负责把它看到的东西数回来。
    const which = process.argv[3];
    if (which !== 'touch' && which !== 'keys') {
      console.log('unknown node-side leg ' + JSON.stringify(which) + ' — have touch, keys');
      process.exit(1);
    }
    await cdp.send('Page.navigate', { url: BASE }, sessionId);
    const booted = await waitShell(400);
    const value = booted
      ? (which === 'touch' ? await touchScenario(cdp, sessionId, runJS) : await keysScenario(cdp, sessionId, runJS))
      : { rows: [{ test: 'the page never booted for the ' + which + ' leg', pass: false, detail: BASE }] };
    emit(value, which);
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
          value = await runJS(scenarioSource(name));
        } catch (err) {
          const dumped = await runJS('JSON.stringify(window.__lastRows||[])').catch(() => '[]');
          value = { rows: JSON.parse(dumped) };
          value.rows.push({ test: `@${name} threw`, pass: false, detail: String(err.message).slice(0, 300) });
        }
      } else {
        console.log('unknown scenario ' + name + ' — have ' + Object.keys(SCENARIOS).join(', ') + ', pointer');
        process.exit(1);
      }
      emit(value, name);
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
    console.log('usage: node tools/playtest.mjs open|nav|reload|leg|eval|place|water|shot|logs ...');
    process.exit(2);
  }
  ws.close();
  process.exit(REPORTED_FAILURES ? 1 : 0);
}

main().catch((err) => {
  console.error('PLAYTEST FAILED: ' + ((err && err.stack) || err));
  process.exit(1);
});
