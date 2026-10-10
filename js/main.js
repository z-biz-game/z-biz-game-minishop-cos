// The shell: hash routes in, canvas out, records in between. Nothing here knows the rules
// of the sea — those live in js/core — and nothing here draws — that is js/view.js.
//
// The panel prints two counts side by side because the game counts two things (see
// js/core/game.js): 操作数 (everything you touched, water marks included) and 放置步数
// (placements that stayed). It also prints 解数 = 1 和 推理深度 k, which is the whole
// thesis: the first is proved by exhaustive search, the second measured by a solver that is
// only allowed to reason locally. Both numbers are baked, and `node test/puzzles.test.mjs`
// re-proves them from the shipped bytes.

import { createGame, place, retrieve, rotate, tapCell, undo, reset, hint, grade, verify, progress } from './core/game.js';
import { store } from './core/storage.js';
import {
  TIERS, ALL, byId, levelAt, puzzlesIn, randomPuzzle, dailyPuzzle, tierByKey, stats as poolStats,
} from './core/library.js';
import { todayKey } from './core/rng.js';
import { draw } from './core/model.js';
import { createView } from './view.js';

const $ = (id) => document.getElementById(id);
const el = {
  modes: $('modes'), totals: $('totals'), crumbs: $('crumbs'), readout: $('readout'),
  shelf: $('shelf'), hintline: $('hintline'), curtain: $('curtain'), stars: $('stars'),
  verdict: $('verdict'), tally: $('tally'), undo: $('undo'), hint: $('hint'), rotate: $('rotate'),
  restart: $('restart'), share: $('share'), next: $('next'), again: $('again'),
  toast: $('toast'), canvas: $('sea'), wipe: $('wipe'),
};

const LEVELS = ALL.length;
const app = {
  mode: 'campaign',
  index: 1,
  route: null,
  puzzle: null,
  game: null,
  label: '',
  day: null,
};

function clampIndex(n) {
  return Math.min(LEVELS, Math.max(1, Number(n) || 1));
}

// #/c/12 · #/daily · #/random/lone/4kq2 · #/lot/harbour-03
// The puzzle id is in the URL, so a shared link resolves to the same chart on another
// device without the receiver needing the sender's save file.
function parseHash(hash = location.hash) {
  const p = String(hash).replace(/^#\/?/, '').split('/').filter(Boolean);
  if (p[0] === 'daily') return { mode: 'daily' };
  if (p[0] === 'random') return { mode: 'random', tier: p[1] || TIERS[0].key, key: p[2] || null };
  if (p[0] === 'lot') return { mode: 'lot', id: p[1] };
  const n = p[0] === 'c' || p[0] === 'campaign' ? Number(p[1]) : Number(p[0]);
  // `asked` is kept so apply() can tell a clamped route from a written one: 999 has to become
  // #/c/48 in the address bar too, or a reload — and everyone you shared it with — is told a
  // different story than the panel printed.
  return { mode: 'campaign', index: clampIndex(n), asked: n };
}

function linkFor(rt) {
  if (rt.mode === 'daily') return '#/daily';
  if (rt.mode === 'random') return `#/random/${rt.tier}/${rt.key}`;
  if (rt.mode === 'lot') return `#/lot/${rt.id}`;
  return `#/c/${rt.index}`;
}

function resolve(rt) {
  if (rt.mode === 'daily') {
    const day = todayKey();
    return { puzzle: dailyPuzzle(day), label: `每日孤舰 · ${day}`, note: day, day };
  }
  if (rt.mode === 'random') {
    const tier = tierByKey(rt.tier);
    return { puzzle: randomPuzzle(`${tier.key}|${rt.key}`, tier.key), label: `随机 · ${tier.label}`, note: tier.blurb };
  }
  if (rt.mode === 'lot') {
    const puzzle = byId(rt.id) || ALL[0];
    return { puzzle, label: `关卡 ${puzzle.id}`, note: tierByKey(puzzle.tier).blurb };
  }
  const puzzle = levelAt(rt.index - 1);
  return { puzzle, label: `第 ${rt.index} 关`, note: `共 ${LEVELS} 关 · ${tierByKey(puzzle.tier).label}` };
}

const view = createView(el.canvas, {
  onPlace: (i, r, c) => commitPlace(i, r, c),
  onRetrieve: (i) => commitRetrieve(i),
  onTapCell: (r, c) => commitTap(r, c),
  onRotate: (i) => commitRotate(i),
  onSelect: () => view.redraw(),
});

function setGame(puzzle, label) {
  app.puzzle = puzzle;
  app.label = label || app.label;
  app.game = createGame(puzzle);
  view.attach(app.game);
  el.curtain.hidden = true;
  say('');
}

function say(html) {
  el.hintline.innerHTML = html;
}

function stars(n) {
  return '★'.repeat(n) + '☆'.repeat(3 - n);
}

function field(label, value, note, cls = '') {
  return `<div class="${cls}"><dt>${label}</dt><dd>${value}</dd><dt><small>${note}</small></dt></div>`;
}

function renderCrumbs() {
  const tier = tierByKey(app.puzzle.tier);
  const g = app.game;
  const rec = store.record(app.puzzle.id);
  el.crumbs.innerHTML = `${app.label}<b>${tier.label}<span class="band"> ${tier.blurb}</span></b>`;
  el.readout.innerHTML = [
    field('操作数', g.ops, '含点水'),
    field('放置步数', g.steps, `下限 ${g.par} · 每条船一次`, 'par'),
    field('解数', 1, '穷举已证明', 'proof'),
    field('推理深度', g.depth, `需猜 ${g.depth} 层`),
    field('尺寸', `${g.rows}×${g.cols}`, `${g.spec.fleet.join('+')} · ${g.spec.fleet.length} 条船`),
    field('最佳', rec ? `${rec.bestSteps}/${rec.bestOps}` : '—', '放置 / 操作', 'best'),
  ].join('');
  el.undo.disabled = !g.history.length || g.done;
  el.rotate.disabled = g.done;
  el.hint.disabled = g.done;
}

function renderTotals() {
  const done = Object.values(store.records).filter((r) => r.solved).length;
  const perfect = Object.values(store.records).filter((r) => r.perfect).length;
  el.totals.innerHTML = `已通 <b>${done}</b>/${LEVELS} · 一子不差 <b>${perfect}</b> · 提示 <b>${store.stats.hints}</b>`;
}

function renderShelf() {
  if (app.mode === 'campaign') {
    const unlocked = store.unlocked;
    let html = '';
    for (const tier of TIERS) {
      html += `<p class="tier">${tier.label} · ${tier.blurb}</p>`;
      for (const puzzle of puzzlesIn(tier.key)) {
        const n = ALL.indexOf(puzzle) + 1;
        const rec = store.record(puzzle.id);
        const cls = [
          n === app.index ? 'here' : '',
          rec && rec.perfect ? 'perfect' : rec && rec.solved ? 'done' : '',
        ].filter(Boolean).join(' ');
        html += `<button type="button" data-index="${n}" class="${cls}" ${n > unlocked ? 'disabled' : ''}>${n}</button>`;
      }
    }
    el.shelf.innerHTML = html;
    el.shelf.querySelectorAll('button[data-index]').forEach((b) => {
      b.addEventListener('click', () => go(`#/c/${b.dataset.index}`));
    });
    return;
  }
  if (app.mode === 'random') {
    let html = '<p class="tier">选一片海</p>';
    for (const tier of TIERS) {
      const on = tier.key === app.route.tier ? 'here' : '';
      html += `<button type="button" class="${on}" data-tier="${tier.key}">${tier.label}<br><small>${tier.blurb}</small></button>`;
    }
    html += '<button type="button" class="wide" data-reroll="1">换一张海图</button>';
    el.shelf.innerHTML = html;
    el.shelf.querySelectorAll('button[data-tier]').forEach((b) => {
      b.addEventListener('click', () => go(`#/random/${b.dataset.tier}/${token()}`));
    });
    el.shelf.querySelector('[data-reroll]').addEventListener('click', () => go(`#/random/${app.route.tier}/${token()}`));
    return;
  }
  if (app.mode === 'daily') {
    const done = app.day && store.dailyDone(app.day);
    el.shelf.innerHTML = `<p class="tier">今天这一张对所有人相同${done ? ' · 已通过' : ''}</p>`
      + `<button type="button" class="wide" data-back="1">回到战役 第 ${store.unlocked} 关</button>`;
  } else {
    el.shelf.innerHTML = `<p class="tier">分享的关卡 · #/lot/${app.puzzle.id}</p>`;
  }
  const back = el.shelf.querySelector('[data-back]');
  if (back) back.addEventListener('click', () => go(`#/c/${store.unlocked}`));
}

function token() {
  return Math.random().toString(36).slice(2, 8);
}

function render() {
  el.modes.querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-current', String(b.dataset.mode === app.mode));
  });
  renderCrumbs();
  renderTotals();
  renderShelf();
}

// The one place a placement happens: the drop from the view, the button, and a test link all
// arrive here, so the counters the panel prints are the counters the rules spent.
const REASONS = {
  out: '出界了 —— 船身压在海岸线外',
  water: '那一格你标了水 —— 先撤销水点',
  overlap: '与另一艘船重叠',
  touch: '与另一艘船相邻（斜角也算）—— 回弹，不计数',
  done: '这张海图已经完成了',
  nope: '没有这艘船',
};

function commitPlace(i, r, c) {
  const res = place(app.game, i, r, c);
  if (!res.ok) {
    view.redraw();
    say(`落子被拒：${REASONS[res.reason] || res.reason}`);
    return res;
  }
  after(`放下第 ${i + 1} 条船 · 操作 ${app.game.ops} · 放置 ${app.game.steps}`);
  return res;
}

function commitRetrieve(i) {
  if (!retrieve(app.game, i)) {
    view.redraw();
    return false;
  }
  after(`取回第 ${i + 1} 条船 · 操作 ${app.game.ops}（放置步数不减：${app.game.steps}）`);
  return true;
}

function commitRotate(i) {
  const before = app.game.ops;
  if (!rotate(app.game, i)) {
    view.redraw();
    say('这一艘原地转不开 —— 旋转被拒');
    return false;
  }
  view.redraw();
  renderCrumbs();
  say(`旋转第 ${i + 1} 条船 · 免费：操作仍是 ${app.game.ops}，放置仍是 ${app.game.steps}`);
  return true;
}

function commitTap(r, c) {
  const what = tapCell(app.game, r, c);
  if (!what) {
    view.redraw();
    return false;
  }
  const prog = progress(app.game);
  after(`${what === 'water' ? `(${r},${c}) 标水` : `(${r},${c}) 擦掉水点`} · 操作 ${app.game.ops} · 放置步数不变 ${app.game.steps}`
    + ` · 已放 ${prog.placed}/${prog.fleet}`);
  return true;
}

function after(line) {
  if (app.game.done) finish();
  else {
    view.redraw();
    renderCrumbs();
    say(line);
  }
}

function finish() {
  const puzzle = app.puzzle;
  const g = app.game;
  const rec = store.solve(puzzle.id, { ops: g.ops, steps: g.steps, par: g.par, hints: g.hints });
  if (app.day) store.markDaily(app.day, puzzle.id);
  let nextIndex = 0;
  if (app.mode === 'campaign') {
    store.unlock(Math.max(store.unlocked, app.index + 1));
    nextIndex = app.index < LEVELS ? app.index + 1 : 0;
  }
  const gr = grade(g);
  el.stars.textContent = stars(gr.stars);
  el.verdict.textContent = gr.label;
  el.tally.innerHTML = `操作 <b>${g.ops}</b> · 放置 <b>${g.steps}</b>（下限 ${g.par}）· 提示 <b>${g.hints}</b>`
    + `<br>解数 <b>1</b> 已由穷举证明 · 推理深度 <b>${g.depth}</b>`
    + (rec.bestSteps === g.steps ? '<br>这是这一关的最好成绩' : '');
  el.next.hidden = !nextIndex;
  el.curtain.hidden = false;
  view.redraw();
  render();
}

function go(hash) {
  // apply() runs on this turn, not on the queued hashchange. Without it, anything that asks
  // the router and then reads the board on the same turn — the browser suites, and a user who
  // clicks 下一关 and looks at the panel before the event loop comes back — is looking at the
  // *previous* chart while the URL already says the new one. The hashchange listener stays:
  // it is what serves back/forward, where nothing called go().
  if (location.hash === hash) apply();
  else { location.hash = hash; apply(); }
}

function apply() {
  let rt = parseHash();
  if (rt.mode === 'random' && !rt.key) {
    // A bare #/random/lone would mean a different chart on every visit and an
    // unreproducible link, so the token is minted once and written back into the URL.
    const key = token();
    location.replace(`${location.pathname}${location.search}#/random/${rt.tier}/${key}`);
    // The minted route is carried on `rt` rather than resolved by re-entering apply().
    // location.replace is a navigation: it fires no hashchange, and anything that refuses
    // to move location.hash (a denied navigation, a sandboxed frame, the load probe) left
    // the router re-reading the same bare hash forever — the stack blew up inside
    // parseHash's String.replace and the page never finished loading. Same URL, same chart,
    // no recursion.
    rt = { mode: 'random', tier: rt.tier, key };
  }
  if (rt.mode === 'campaign' && String(rt.asked) !== String(rt.index)) {
    // 越界关号被夹到梯子两端之后，URL 也得跟着夹。规范化同样落在 rt 上：夹完的关号就是这一趟
    // 该用的值，不该回头重读一个未必动过的 location.hash。
    location.replace(`${location.pathname}${location.search}#/c/${rt.index}`);
    rt = { mode: 'campaign', index: rt.index, asked: rt.index };
  }
  app.route = rt;
  app.mode = rt.mode;
  const r = resolve(rt);
  if (!r.puzzle) {
    say('这一档还没有烤好的海图');
    return;
  }
  app.day = r.day || null;
  app.index = rt.mode === 'campaign' ? rt.index : ALL.indexOf(r.puzzle) + 1;
  setGame(r.puzzle, r.label);
  render();
}

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 1800);
}

function shareLink() {
  const url = `${location.origin}${location.pathname}#/lot/${app.puzzle.id}`;
  const done = () => toast('链接已复制');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done, () => toast(url));
  } else {
    toast(url);
  }
}

el.modes.addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-mode]');
  if (!b) return;
  if (b.dataset.mode === 'campaign') go(`#/c/${clampIndex(store.unlocked)}`);
  else if (b.dataset.mode === 'daily') go('#/daily');
  else go(`#/random/${TIERS[0].key}/${token()}`);
});

el.undo.addEventListener('click', () => {
  if (undo(app.game)) {
    el.curtain.hidden = true;
    view.redraw();
    renderCrumbs();
    say(app.game.history.length ? `撤销一步 · 操作 ${app.game.ops} · 放置 ${app.game.steps}` : '回到起点');
  }
});

el.rotate.addEventListener('click', () => {
  const i = view.selected();
  if (i < 0) {
    say('先点一条船（舰队条上的或海图上的），再旋转');
    return;
  }
  commitRotate(i);
});

el.hint.addEventListener('click', () => {
  const h = hint(app.game);
  if (!h) {
    say('没有可提示的了 —— 这张海图已经完成');
    return;
  }
  app.game.hints++; // 计费写在 grade() 读的那一个计数器上：另立一个 app.hints 会让「用过提示」这件事在评星眼里从没发生过
  if (h.kind === 'ship') {
    // Highlight the hull that belongs there: the one already sitting somewhere else with
    // that length, or the one already nailed to the right cells.
    const ships = app.game.ships;
    const wrong = ships.find((s) => s.len === h.ship.len && !(s.r === h.ship.r && s.c === h.ship.c && s.axis === h.ship.axis));
    const i = wrong ? wrong.i : ships.findIndex((s) => s.len === h.ship.len);
    if (i >= 0) view.select(i);
    const axis = h.ship.axis === 'h' ? '横向' : '纵向';
    say(`提示：一条 ${h.ship.len} 格${axis}的船属于 (${h.ship.r},${h.ship.c})`
      + (h.blocked ? ` —— 那里现在${REASONS[h.blocked]}，先腾开` : ''));
  } else {
    say(`提示：(${h.r},${h.c}) 只能是水 —— 点它`);
  }
  renderCrumbs();
});

function restart() {
  reset(app.game);
  el.curtain.hidden = true;
  view.attach(app.game); // clears the selection and the rebound flash along with the hulls
  render();
  say('回到起点');
}

el.restart.addEventListener('click', restart);
el.share.addEventListener('click', shareLink);
el.again.addEventListener('click', restart);
el.next.addEventListener('click', () => go(`#/c/${Math.min(LEVELS, app.index + 1)}`));

// Wiping the save is the one destructive thing this game can do, so it asks twice instead
// of firing on a stray click.
let wipeArmed = false;
el.wipe.addEventListener('click', () => {
  if (!wipeArmed) {
    wipeArmed = true;
    toast('再点一次会清空本机全部成绩');
    setTimeout(() => { wipeArmed = false; }, 4000);
    return;
  }
  store.reset();
  wipeArmed = false;
  toast('存档已清空');
  apply();
});

window.addEventListener('hashchange', apply);
window.addEventListener('resize', () => view.measure());
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key.toLowerCase();
  if (k === 'escape' && !el.curtain.hidden) el.curtain.hidden = true;
  else if (k === 'u') el.undo.click();
  else if (k === 'h') el.hint.click();
  else if (k === 'r') el.rotate.click();
  else if (k === '0') el.restart.click();
});

view.measure();
apply();

// ---- 减弱动效（prefers-reduced-motion）----
// 跟随系统设置，并且**运行中改设置立刻生效**：加 addEventListener('change')，老 Safari
// 只有 addListener，故两条都挂（同一 query 的两个 API 指向同一个 MediaQueryList）。
(function wireReducedMotion() {
  if (typeof matchMedia !== 'function') return;
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  const applyFlag = () => view.setReduceMotion(mq.matches);
  if (mq.addEventListener) mq.addEventListener('change', applyFlag);
  else if (mq.addListener) mq.addListener(applyFlag);
  applyFlag();
})();

// The test hook. Everything a browser assertion needs, and nothing the game depends on:
// the panel is driven by the same commit* functions these call, so a test that presses a
// button and a test that reads state are looking at one set of counters.
window.minishop = {
  version: 1,
  get state() {
    const g = app.game;
    return {
      mode: app.mode,
      label: app.label,
      id: g && g.id,
      tier: g && g.tier,
      index: app.index,
      ops: g && g.ops,
      steps: g && g.steps,
      par: g && g.par,
      depth: g && g.depth,
      hints: g ? g.hints : 0,
      done: !!(g && g.done),
      history: g ? g.history.length : 0,
      unlocked: store.unlocked,
      solved: Object.values(store.records).filter((r) => r.solved).length,
      curtain: !el.curtain.hidden,
      rows: g && g.rows,
      cols: g && g.cols,
      readout: el.readout.textContent,
      crumbs: el.crumbs.textContent,
      hintline: el.hintline.textContent,
      verdict: el.verdict.textContent,
      tally: el.tally.textContent,
    };
  },
  get pool() { return poolStats(); },
  get tiers() { return TIERS; },
  load(hash) { go(hash); return app.puzzle && app.puzzle.id; },
  route(hash) { return linkFor(parseHash(hash || location.hash)); },
  // Where the mouse has to go to touch a cell or a hull, in client pixels.
  cellPoint(r, c) { return view.cellPoint(r, c); },
  shipPoint(i) { return view.shipPoint(i); },
  spec() { return app.puzzle ? app.puzzle.spec : null; },
  grid() { return app.game ? Array.from(app.game.grid) : null; },
  ships() { return app.game ? app.game.ships.map((s) => ({ ...s })) : null; },
  progress() { return app.game ? progress(app.game) : null; },
  board() {
    if (!app.game) return null;
    const g = app.game;
    const marks = [];
    for (let cell = 0; cell < g.grid.length; cell++) {
      if (g.grid[cell] === 2) marks.push({ r: Math.floor(cell / g.cols), c: cell % g.cols });
    }
    return draw(g.spec, g.ships.filter((s) => s.onBoard), marks);
  },
  verify() { return app.game ? verify(app.game) : null; },
  // Drive the same commits a finger uses, for the non-pointer suites.
  place(i, r, c) { return commitPlace(i, r, c); },
  retrieve(i) { return commitRetrieve(i); },
  rotate(i) { return commitRotate(i === undefined ? view.selected() : i); },
  tap(r, c) { return commitTap(r, c); },
  undo() { el.undo.click(); return app.game ? { ops: app.game.ops, steps: app.game.steps } : null; },
  reset() { restart(); },
  hintOnce() { el.hint.click(); return { hints: app.game.hints, line: el.hintline.textContent }; },
  click(id) { el[id].click(); return true; },
  store,
};

// ---- 全屏开关（#btn-fullscreen）----
// 绑的是本页侧栏 .controls 里真实存在的那颗按钮。同容器五颗邻居都没有 class
// （样式是 .controls button 统一给的），所以这颗也不加 class：硬塞一个 primary 会
// 让它在一排灰按钮里跳出来，那是外来视觉语言，不是这仓的。
// 全屏最常见的假实现就是引用一个并不存在的 id：点下去什么也不会发生，量具却算它"已实现"。
// 所以这里找不到按钮就直接不装，宁可没有这功能，也不要留一根死线。
(function bindFullscreen() {
  const btn = document.getElementById('btn-fullscreen');
  if (!btn) return;
  const root = document.documentElement;
  // 只做特性检测，不嗅探 UA：iOS Safari 是 webkitRequestFullscreen，老 Edge 是 ms 前缀，
  // 而 UA 字符串随时会改。"有没有这个能力"是查出来的，不是猜出来的。
  const req = root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  const current = () => document.fullscreenElement || document.webkitFullscreenElement
    || document.msFullscreenElement || null;
  // 一格只有 ~44px，12px 中文放得下两字：和 旋转/撤销/提示/重开/分享 一样是两字动词。
  const ON = '退出';
  const OFF = '全屏';

  // 不支持也要给个说法：只把按钮灰掉而不解释，玩家会以为这功能没做完。
  // supported 这枚标记不能省：下面 sync() 每次都会重写 title，不挡住的话，装的时候刚写
  // 进去的人话原因会被随后的 sync() 立刻抹成"全屏 (F)"——禁用就变成一句没有理由的禁用。
  let supported = !!req;
  const unsupported = () => {
    supported = false;
    btn.disabled = true;
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」独立打开）';
  };
  if (!req) unsupported();

  // fullscreen 返回 Promise，被拒时必须吃掉：iOS Safari 对多数非 video 元素直接拒绝，
  // 让这个 rejection 冒泡出去会变成一条未捕获错误，整局游戏跟着挂。
  const settle = (p) => { if (p && p.catch) p.catch(unsupported); };

  // 进出都能走：已经全屏时这次调用是退出，不是"再进一次"。
  function toggle() {
    try {
      if (current()) {
        if (exit) settle(exit.call(document));
      } else if (req) {
        settle(req.call(root));
      } else {
        unsupported();
      }
    } catch (e) {
      unsupported();
    }
  }

  // Esc 和系统手势退出都不经过我们的代码，按钮状态只能靠 fullscreenchange 回写，
  // 否则玩家已经退出、侧栏还停在"退出"，下一次点击反而会重新进全屏。
  function sync() {
    const on = !!current();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? ON : OFF;
    if (supported) btn.title = (on ? '退出全屏' : '全屏') + ' (F)';
    const body = document.body;
    if (body && body.classList) body.classList.toggle('fullscreen', on);
  }

  btn.addEventListener('click', toggle);
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'f' && ev.key !== 'F') return;
    const t = ev.target;
    // 输入框里打字不能触发全屏：将来若有分享/输入框，玩家输到一半屏幕没了。
    if (t && /input|textarea|select/i.test(t.tagName || '')) return;
    if (ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    ev.preventDefault();
    toggle();
  });
  window.addEventListener('fullscreenchange', sync);
  window.addEventListener('webkitfullscreenchange', sync);
  window.addEventListener('MSFullscreenChange', sync);
  sync();
})();
