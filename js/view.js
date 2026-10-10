// Canvas renderer and gesture recogniser. This file owns pixels and pointers and decides
// nothing about legality: on release it hands main.js a ship index and a head cell, and
// js/core/game.js — the same object the node tests drive — says yes or no. A rejected drop
// is painted red for a beat and nothing else changes, because "冲突回弹不计数" is a rule of
// the core, not a trick of the view.
//
// Everything is drawn programmatically: grid, hulls, water dots, clue digits. There is no
// image asset in this repo, so there is nothing to load and nothing to fail to load.
//
// GEOMETRY, because the browser suite presses real mouse buttons at it:
//   cellPoint(r, c)   client-space centre of a board cell
//   shipPoint(i)      client-space centre of a ship wherever it is (dock or board)
// Both run the same mapping down() reads, so a test that aims with them is aiming where a
// human aims.

import { SHIP, WATER, cellsOf } from './core/model.js';
import { conflict, progress } from './core/game.js';

const PAD = 14;
const GUTTER = 1.0; // one cell of room for the clue digits, top and left
const DOCK_LINES = 2; // two rows of the tallest possible fleet, so nothing has to shrink
const DOCK_LINE = 1.35; // line pitch, in cells

const SEA = '#0e1520';
const SEAL = '#16202e';
const GRID_LINE = 'rgba(150, 190, 225, 0.14)';
const HULL = ['#3d6a86', '#7a5a48', '#556b45', '#6b4f74', '#7d6a3f', '#3f7069'];
const HULL_DARK = 'rgba(8, 12, 18, 0.45)';
const DECK = 'rgba(206, 226, 244, 0.22)';
const MARK = 'rgba(126, 196, 232, 0.9)';
const GOOD = 'rgba(126, 224, 156, 0.95)';
const BAD = 'rgba(228, 92, 92, 0.95)';
const GOLD = 'rgba(230, 182, 86, 0.95)';

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function createView(canvas, { onPlace, onRetrieve, onTapCell, onRotate, onSelect } = {}) {
  const ctx = canvas.getContext('2d');
  let game = null;
  let geom = null;
  let drag = null; // { ship, from, x, y, moved, grabbed }
  let flash = null; // { cells, reason, until }
  let selected = -1;
  let raf = 0;
  // ---- 减弱动效（prefers-reduced-motion）----
  // 被拒的一次投放，仓里唯一的画面证据就是这 520ms 里由 0.55 淡出的那几块红格子。
  // 淡出是动效，**红是信号**——所以减弱动效下不动颜色、不缩短寿命，只把 alpha 钉在
  // 满值：红格子照样按原时长出现、照样告诉玩家"这一手不成立、原因是 reason"，
  // 少的只是"淡下去"这段过程。
  let reduceMotion = false;

  // ---------------------------------------------------------------- geometry

  function measure() {
    const box = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const W = Math.max(160, Math.round(box.width));
    const H = Math.max(160, Math.round(box.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!game) return;
    const ux = GUTTER + game.cols;
    const uy = GUTTER + game.rows + 0.4 + DOCK_LINES * DOCK_LINE;
    const cell = Math.max(16, Math.floor(Math.min((W - PAD * 2) / ux, (H - PAD * 2) / uy)));
    const boardW = cell * game.cols;
    const boardH = cell * game.rows;
    geom = {
      cell,
      ox: Math.round((W - boardW) / 2) + Math.round(cell * GUTTER / 2),
      oy: Math.round(((H - boardH) / 2)) + Math.round(cell * GUTTER / 2) - Math.round(cell * DOCK_LINES * DOCK_LINE / 2),
      boardW,
      boardH,
      dockY: 0,
      W,
      H,
    };
    geom.dockY = geom.oy + boardH + Math.round(cell * 0.4);
    draw();
  }

  // The dock: unplaced hulls, laid out left to right in up to two lines, each drawn at a
  // scale where the longest ship in the fleet still fits on one line.
  function dockSlots() {
    if (!game) return {};
    const { cell, ox, boardW, dockY } = geom;
    const ships = game.ships;
    const maxLen = Math.max(...ships.map((s) => s.len));
    const innerW = boardW - 8;
    const scale = Math.min(cell, innerW / (maxLen + 0.25));
    const gap = Math.max(6, Math.round(scale * 0.35));
    const slots = {};
    let x = ox + 4;
    let line = 0;
    for (const ship of ships) {
      if (ship.onBoard) continue;
      const w = Math.round(ship.len * scale);
      if (x + w > ox + boardW - 4 && line < DOCK_LINES - 1) {
        line++;
        x = ox + 4;
      }
      slots[ship.i] = { x, y: dockY + Math.round(line * DOCK_LINE * cell), w, h: Math.round(scale) };
      x += w + gap;
    }
    return slots;
  }

  function localPoint(ev) {
    const box = canvas.getBoundingClientRect();
    return { x: ev.clientX - box.left, y: ev.clientY - box.top };
  }

  function toClient(ux, uy) {
    const box = canvas.getBoundingClientRect();
    return {
      x: Math.round(box.left + ux),
      y: Math.round(box.top + uy),
      cell: geom ? geom.cell : 0,
    };
  }

  // Where the head cell of a hull held at local point (x, y) would land, in board cells.
  // cellPoint() / shipPoint() hand out the *centre* of a cell, and the pointer legs aim with
  // them so a test presses where a human presses. Mapping a centre back to a cell therefore
  // has to floor: with Math.round, the centre of (r,c) is r+0.5 and lands in (r+1,c+1) — every
  // drop, water mark and double click in the game shifted one row down and one column right,
  // and the last row/column fell off the board entirely (a tap there did nothing at all).
  function headAt(x, y) {
    const { cell, ox, oy } = geom;
    return { r: Math.floor((y - oy) / cell), c: Math.floor((x - ox) / cell) };
  }

  function shipAtPoint(p) {
    const { cell, ox, oy } = geom;
    if (!game) return -1;
    for (const ship of game.ships) {
      if (!ship.onBoard) continue;
      for (const cellIdx of cellsOf(ship, game.cols)) {
        const r = Math.floor(cellIdx / game.cols);
        const c = cellIdx % game.cols;
        if (p.x >= ox + c * cell && p.x < ox + (c + 1) * cell && p.y >= oy + r * cell && p.y < oy + (r + 1) * cell) {
          return ship.i;
        }
      }
    }
    return -1;
  }

  // ---------------------------------------------------------------- gestures

  function down(ev) {
    if (!game || game.done) return;
    const p = localPoint(ev);
    let index = shipAtPoint(p);
    if (index < 0) {
      const slots = dockSlots();
      for (const key of Object.keys(slots)) {
        const s = slots[key];
        if (p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h) index = Number(key);
      }
    }
    if (index >= 0) {
      const ship = game.ships[index];
      drag = { ship: index, from: { r: ship.r, c: ship.c, axis: ship.axis }, onBoard: ship.onBoard, x: p.x, y: p.y, moved: 0, grabbed: p };
      selected = index;
      if (onSelect) onSelect(index);
      if (flash && flash.ship === index) flash = null;
      try {
        if (canvas.setPointerCapture) canvas.setPointerCapture(ev.pointerId);
      } catch (err) {
        /* a browser that refuses capture still drags fine inside the canvas */
      }
      ev.preventDefault();
      draw();
      return;
    }
    // Not a hull: a tap on open water, decided on release so a drag never marks a cell.
    const h = headAt(p.x, p.y);
    drag = { tap: h, x: p.x, y: p.y, moved: 0, grabbed: p };
    ev.preventDefault();
  }

  function move(ev) {
    if (!drag) return;
    const p = localPoint(ev);
    drag.moved = Math.max(drag.moved, Math.abs(p.x - drag.grabbed.x) + Math.abs(p.y - drag.grabbed.y));
    drag.x = p.x;
    drag.y = p.y;
    if (drag.ship !== undefined) ev.preventDefault();
  }

  function up(ev) {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (ev) ev.preventDefault();
    if (d.ship === undefined) {
      // A click that never moved is a water mark; anything else was an abandoned drag.
      if (d.moved < 5 && d.tap && commitTap(d.tap)) return;
      draw();
      return;
    }
    const ship = game.ships[d.ship];
    if (d.moved < 5) {
      draw();
      return; // a click on a hull selects it; rotation is the button, the key, or a double click
    }
    const p = { x: d.x, y: d.y };
    const inside = p.x >= geom.ox - geom.cell && p.y >= geom.oy - geom.cell
      && p.x <= geom.ox + geom.boardW + geom.cell && p.y <= geom.oy + geom.boardH + geom.cell;
    if (!inside) {
      if (ship.onBoard && onRetrieve) onRetrieve(d.ship);
      else draw();
      return;
    }
    const h = headAt(p.x, p.y);
    if (h.r === ship.r && h.c === ship.c) {
      draw();
      return; // dropped back where it was: not an operation
    }
    const why = conflict(game, d.ship, { r: h.r, c: h.c, len: ship.len, axis: ship.axis });
    if (why) {
      flash = { ship: d.ship, cells: cellsOf({ r: h.r, c: h.c, len: ship.len, axis: ship.axis }, game.cols), reason: why, until: performance.now() + 520 };
      schedule();
      return; // rebound, uncounted
    }
    if (onPlace) onPlace(d.ship, h.r, h.c);
  }

  // A release with no movement over a cell that holds no hull: water mark, or clear one.
  // The view checks only whether the cell is *tappable*; whether the mark is a good idea is
  // nobody's business here, and the counter it costs lives in game.js.
  function commitTap(h) {
    if (!onTapCell) return false;
    if (h.r < 0 || h.c < 0 || h.r >= game.rows || h.c >= game.cols) return false;
    if (game.grid[h.r * game.cols + h.c] === SHIP) return false;
    return onTapCell(h.r, h.c);
  }

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('dblclick', (ev) => {
    if (!game || game.done) return;
    const p = localPoint(ev);
    const i = shipAtPoint(p);
    if (i >= 0 && onRotate) onRotate(i);
  });

  // ---------------------------------------------------------------- painting

  function drawHull(x, y, w, h, i, lifted) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = lifted ? 16 : 6;
    ctx.shadowOffsetY = lifted ? 7 : 2;
    ctx.fillStyle = HULL[i % HULL.length];
    roundRect(ctx, x, y, w, h, Math.round(Math.min(w, h) * 0.32));
    ctx.fill();
    ctx.restore();
    // Deck planking and a bridge block: a hull from above, with no art files.
    ctx.fillStyle = HULL_DARK;
    roundRect(ctx, x + 2, y + 2, w - 4, h - 4, Math.round(Math.min(w, h) * 0.26));
    ctx.fill();
    ctx.fillStyle = DECK;
    if (w >= h) {
      roundRect(ctx, x + w * 0.42, y + h * 0.28, w * 0.2, h * 0.44, 2);
      ctx.fill();
      roundRect(ctx, x + w * 0.1, y + h * 0.44, w * 0.22, h * 0.12, 2);
      ctx.fill();
    } else {
      roundRect(ctx, x + w * 0.28, y + h * 0.42, w * 0.44, h * 0.2, 2);
      ctx.fill();
      roundRect(ctx, x + w * 0.44, y + h * 0.1, w * 0.12, h * 0.22, 2);
      ctx.fill();
    }
    // Bow/stern cap so a length-1 hull still reads as a boat rather than a block.
    ctx.fillStyle = 'rgba(230, 240, 250, 0.25)';
    const cap = Math.max(2, Math.round(Math.min(w, h) * 0.18));
    if (w >= h) roundRect(ctx, x + w - cap - 2, y + h * 0.3, cap, h * 0.4, 2);
    else roundRect(ctx, x + w * 0.3, y + h - cap - 2, w * 0.4, cap, 2);
    ctx.fill();
  }

  function draw() {
    if (!geom) return;
    const { cell, ox, oy, W, H, boardW, boardH } = geom;
    ctx.clearRect(0, 0, W, H);
    if (!game) return;
    const rows = game.rows;
    const cols = game.cols;

    // Sea, then the grid.
    ctx.fillStyle = SEAL;
    roundRect(ctx, ox - 6, oy - 6, boardW + 12, boardH + 12, 10);
    ctx.fill();
    ctx.fillStyle = SEA;
    roundRect(ctx, ox, oy, boardW, boardH, 4);
    ctx.fill();
    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth = 1;
    for (let r = 1; r < rows; r++) {
      ctx.beginPath();
      ctx.moveTo(ox, oy + r * cell + 0.5);
      ctx.lineTo(ox + boardW, oy + r * cell + 0.5);
      ctx.stroke();
    }
    for (let c = 1; c < cols; c++) {
      ctx.beginPath();
      ctx.moveTo(ox + c * cell + 0.5, oy);
      ctx.lineTo(ox + c * cell + 0.5, oy + boardH);
      ctx.stroke();
    }

    const prog = progress(game);

    // Water marks.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (game.grid[r * cols + c] !== WATER) continue;
        ctx.fillStyle = MARK;
        ctx.beginPath();
        ctx.arc(ox + c * cell + cell / 2, oy + r * cell + cell / 2, Math.max(2, cell * 0.13), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Clue digits, green once that line is exactly full.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(cell * 0.55)}px ui-monospace, Menlo, monospace`;
    for (let r = 0; r < rows; r++) {
      const sat = prog && prog.rows[r];
      ctx.fillStyle = sat === null ? 'rgba(200,215,230,0.5)' : sat ? GOOD : 'rgba(214, 226, 240, 0.86)';
      ctx.fillText(String(game.spec.rowReq[r]), ox - cell * 0.5, oy + r * cell + cell / 2);
    }
    for (let c = 0; c < cols; c++) {
      const sat = prog && prog.cols[c];
      ctx.fillStyle = sat === null ? 'rgba(200,215,230,0.5)' : sat ? GOOD : 'rgba(214, 226, 240, 0.86)';
      ctx.fillText(String(game.spec.colReq[c]), ox + c * cell + cell / 2, oy - cell * 0.5);
    }

    // Hulls on the board.
    for (const ship of game.ships) {
      if (!ship.onBoard) continue;
      if (drag && drag.ship === ship.i) continue;
      const horizontal = ship.axis === 'h';
      const x = ox + ship.c * cell + 2;
      const y = oy + ship.r * cell + 2;
      const w = (horizontal ? ship.len : 1) * cell - 4;
      const h = (horizontal ? 1 : ship.len) * cell - 4;
      drawHull(x, y, w, h, ship.i, false);
      if (selected === ship.i && !game.done) {
        ctx.strokeStyle = GOLD;
        ctx.lineWidth = 2;
        roundRect(ctx, x - 2, y - 2, w + 4, h + 4, 6);
        ctx.stroke();
      }
    }

    // The dock.
    const slots = dockSlots();
    for (const key of Object.keys(slots)) {
      const i = Number(key);
      const s = slots[i];
      const inHand = drag && drag.ship === i;
      ctx.fillStyle = 'rgba(120, 160, 200, 0.07)';
      roundRect(ctx, s.x - 3, s.y - 3, s.w + 6, s.h + 6, 7);
      ctx.fill();
      if (!inHand) drawHull(s.x, s.y, s.w, s.h, i, false);
      if (selected === i && !game.done) {
        ctx.strokeStyle = GOLD;
        ctx.lineWidth = 2;
        roundRect(ctx, s.x - 2, s.y - 2, s.w + 4, s.h + 4, 6);
        ctx.stroke();
      }
    }

    // The hull in hand rides above everything, under the finger.
    if (drag && drag.ship !== undefined) {
      const ship = game.ships[drag.ship];
      const horizontal = ship.axis === 'h';
      const w = (horizontal ? ship.len : 1) * cell - 4;
      const h = (horizontal ? 1 : ship.len) * cell - 4;
      const ghost = headAt(drag.x, drag.y);
      const gx = ox + ghost.c * cell + 2;
      const gy = oy + ghost.r * cell + 2;
      const why = conflict(game, ship.i, { r: ghost.r, c: ghost.c, len: ship.len, axis: ship.axis });
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = why ? BAD : 'rgba(120, 220, 160, 1)';
      roundRect(ctx, gx, gy, w, h, 5);
      ctx.fill();
      ctx.globalAlpha = 1;
      drawHull(drag.x - w / 2, drag.y - h / 2, w, h, ship.i, true);
    }

    // A drop that was refused: the cells it would have covered, in red, briefly.
    if (flash) {
      const t = (flash.until - performance.now()) / 520;
      if (t <= 0) {
        flash = null;
      } else {
        ctx.globalAlpha = reduceMotion ? 0.55 : 0.55 * t;
        ctx.fillStyle = BAD;
        for (const cellIdx of flash.cells) {
          const r = Math.floor(cellIdx / cols);
          const c = cellIdx % cols;
          roundRect(ctx, ox + c * cell + 2, oy + r * cell + 2, cell - 4, cell - 4, 4);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }

    if (game.done) {
      ctx.strokeStyle = GOLD;
      ctx.lineWidth = 3;
      roundRect(ctx, ox - 6, oy - 6, boardW + 12, boardH + 12, 10);
      ctx.stroke();
    }
  }

  function frame(now) {
    raf = 0;
    draw();
    if (flash) raf = requestAnimationFrame(frame);
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  return {
    attach(next) {
      game = next;
      drag = null;
      flash = null;
      selected = -1;
      measure();
    },
    detach() {
      game = null;
      drag = null;
    },
    measure,
    redraw: draw,
    cellPoint(r, c) {
      const { cell, ox, oy } = geom;
      return toClient(ox + c * cell + cell / 2, oy + r * cell + cell / 2);
    },
    shipPoint(i) {
      if (!game || i < 0 || i >= game.ships.length) return null;
      const ship = game.ships[i];
      const { cell, ox, oy } = geom;
      if (ship.onBoard) {
        const horizontal = ship.axis === 'h';
        const w = horizontal ? ship.len : 1;
        const h = horizontal ? 1 : ship.len;
        return toClient(ox + (ship.c + w / 2) * cell, oy + (ship.r + h / 2) * cell);
      }
      const s = dockSlots()[i];
      return s ? toClient(s.x + s.w / 2, s.y + s.h / 2) : null;
    },
    selected() {
      return selected;
    },
    // The panel's hint ring: main.js names a hull, the view draws it. No rule is decided
    // here — which hull to name is game.js's business.
    select(i) {
      selected = Number.isInteger(i) ? i : -1;
      draw();
      return selected;
    },
    // Where a hull in hand would land if the pointer stopped right now, so the panel can
    // print the target cell before the player lets go.
    headUnder() {
      if (!drag || drag.ship === undefined) return null;
      return headAt(drag.x, drag.y);
    },
    flashReason() {
      return flash ? flash.reason : null;
    },
    // 幂等：切到当帧就重画，红格子停在半路而不是等它淡完。运行中改设置立刻生效。
    setReduceMotion(on) {
      reduceMotion = !!on;
      draw();
      return reduceMotion;
    },
    isReducedMotion() {
      return reduceMotion;
    },
  };
}
