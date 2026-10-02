// 破坏试验台账：把每一类谎各写回代码里一遍，看闸会不会**点名**变红。
//
//   node tools/sabotage.mjs            跑下面全部刀（含四把浏览器刀，几分钟）
//   node tools/sabotage.mjs K1         只跑点名的那把（调试用）
//
// 为什么要有这个文件：一条全绿的断言只说明"这一轮没东西坏"，它没说**这条断言会不会红**。
// 2026-10-02 那次三条浏览器腿全红、99 条逻辑断言全绿（rotate 只改 axis、不改 grid/own），
// 缺的就是这一列：写这条断言的人必须当场证明它能被一把最小的刀打死。
//
// 五条规矩（照 z-biz-game-kurotto-cos/tools/sabotage.mjs 的机制，第 4 条按本仓的硬规矩改了）：
//   1. 工作树必须干净：刀打在定稿的那一份上，否则恢复那一步会把在写的东西抹掉。
//   2. 针必须唯一命中：0 次或 >1 次都是 ERROR —— "打不中却一声不响跑完"是台账最坏的失败。
//   3. rc != 0 **且**输出点名了它那一条断言才算红。语法炸了也是 rc != 0，但那不是闸红。
//   4. 每把刀只恢复它那一个文件，而且恢复用的是**跑之前读进内存的那份字节**（writeFileSync），
//      不是 git checkout / restore / reset —— 这个工作区是共享的，那条命令在本仓禁用。
//      恢复后立刻验工作树，脏了就停，不带脏树跑下一把。
//   5. rc 一列由脚本把真实退出码读回来，不能抄。全部刀都点名变红之后才回写这张表。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HERE = 'tools/sabotage.mjs';
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const die = (msg) => { console.log(`  ERROR ${msg}`); process.exit(2); };

const sh = (cmd, timeout) => {
  const r = spawnSync('bash', ['-c', cmd], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout });
  if (r.error && r.error.code === 'ETIMEDOUT') return { rc: -1, out: `${cmd}\n[超时被杀] ${r.error.message}` };
  return { rc: r.status === null ? -1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const git = (a) => sh(`git ${a}`, 30000).out.trim();

// 浏览器刀跑一次要起一台 Chrome、两个 URL 形态，所以只点 keys 那一条腿。
const KEYS = 'LEGS=keys BROWSER=1 bash tools/verify.sh';
const LOGIC = 'node test/game.test.mjs';

const KNIVES = [
  {
    id: 'K1', file: 'js/core/game.js', cmd: LOGIC, timeout: 120000,
    why: 'rotate 只改 axis、不改足迹 —— 2026-10-02 那三条红腿的根因本体',
    needle: `    const at = { r: ship.r, c: ship.c, len: ship.len, axis: ship.axis };
    paint(game, at, i, UNKNOWN); // clear first: the turned shape may share only its head cell
    ship.axis = axis;
    paint(game, { ...at, axis }, i, SHIP);`,
    repl: '    ship.axis = axis;',
    expect: 'the wake it left is open sea again',
    rc: '1',
  },
  {
    id: 'K2', file: 'js/main.js', cmd: KEYS, timeout: 900000,
    why: 'done 关掉编辑面这件事被摘掉：撤销按钮在完成之后又可点',
    needle: '  el.undo.disabled = !g.history.length || g.done;',
    repl: '  el.undo.disabled = !g.history.length;',
    expect: '完成之后再按 U 一个数都不退',
    rc: '1',
  },
  {
    id: 'K3', file: 'js/core/game.js', cmd: KEYS, timeout: 900000,
    why: '撤销一步放置不退放置步数 —— keys 腿那条靶子的反证',
    needle: `    game.ops--;
    game.steps--; // only a placement ever spent a step`,
    repl: '    game.ops--;',
    expect: 'U 撤销了最后一步放置',
    rc: '1',
  },
  {
    id: 'K4', file: 'js/core/game.js', cmd: KEYS, timeout: 900000,
    why: 'done 不再要独立检查器签名：随便一步放子都算收尾 —— keys 腿新靶子前置的反证',
    needle: '  return validate(game.spec, placementOf(game.ships)) === null;',
    repl: '  return game.ships.every((s) => s.onBoard);',
    expect: '这一步落得下去，但它不是收尾那一子',
    rc: '1',
  },
  {
    id: 'K5', file: 'tools/playtest.mjs', cmd: KEYS, timeout: 900000,
    why: '键的派发只发 char/keyUp、不发 keyDown：页面收不到键，而腿照样能"通过"',
    needle: `  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text }, sessionId);
  if (text) await cdp.send('Input.dispatchKeyEvent', { type: 'char', ...base, text }, sessionId);`,
    repl: `  if (text) await cdp.send('Input.dispatchKeyEvent', { type: 'char', ...base, text }, sessionId);`,
    expect: '派发的每一只键都在页面上的 keydown 里数到了',
    rc: '1',
  },
  {
    // 这一把刀打的是"两个计数器"那一类：壳自己记一份、core 的 grade() 读另一份，
    // 于是 2 星那一档永远不会出现。逻辑闸看不见它（它只测 core），只有收尾那一屏会说谎。
    id: 'K6', file: 'js/main.js', cmd: KEYS, timeout: 900000,
    why: '提示计费不写进 grade() 读的那一个：用过提示照样判「一子不差」',
    needle: '  app.game.hints++;',
    repl: '  app.game.hints = app.game.hints;',
    expect: 'verdict 必须降级成「有人指路」',
    rc: '1',
  },
];

const only = process.argv.slice(2);
if (only.length) {
  const picked = only.filter((id) => KNIVES.some((k) => k.id === id));
  if (picked.length !== only.length) die(`点名的刀有几把不在台账上：${only.filter((x) => !picked.includes(x)).join(' ')}`);
}
const picked = only.length ? KNIVES.filter((k) => only.includes(k.id)) : KNIVES;

// ---- 预检 ----
const dirty0 = git('status --porcelain');
if (dirty0) die(`工作树不干净，刀不能打在半成品上（先 commit 或先挪开）：\n${dirty0}`);
for (const k of picked) {
  let src;
  try { src = read(k.file); } catch { die(`${k.id} 的文件不存在：${k.file}`); }
  const hits = [...src.matchAll(new RegExp(k.needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].length;
  if (hits !== 1) die(`${k.id} 的针在 ${k.file} 命中 ${hits} 次（必须恰好 1 次：打不中或打多了都不许跑）`);
  if (k.repl === k.needle) die(`${k.id} 的「改成」与针相同，这一刀不会改变任何东西`);
  if (!read('tools/playtest.mjs').includes(k.expect) && !read('test/game.test.mjs').includes(k.expect)) {
    die(`${k.id} 期望点名的「${k.expect}」在 playtest.mjs 与 game.test.mjs 里都找不到（断言被改名或删掉了）`);
  }
  console.log(`  预检 ${k.id} · ${k.file} 针唯一命中 · 期望点名「${k.expect}」`);
}

const results = [];
for (const k of picked) {
  const before = read(k.file);
  console.log(`\n--- ${k.id} ${k.why}`);
  writeFileSync(join(ROOT, k.file), before.replace(k.needle, k.repl));
  const r = sh(k.cmd, k.timeout);
  // 只恢复这一个文件，用的是打刀之前读进内存的那份字节：本仓禁用 git checkout/restore/reset。
  writeFileSync(join(ROOT, k.file), before);
  const nowDirty = git('status --porcelain');
  const named = r.out.includes(k.expect);
  const red = r.rc !== 0 && named;
  console.log(`  ${k.id} rc=${r.rc} 点名=${named ? '是' : '否'} → ${red ? '红得对' : '这一刀没能把闸打红'}`);
  // 红也要把它点名的那一行留在日志里：只有 rc 和"点名=是"的话，
  // 一次起不动 Chrome 的崩溃也可能被读成"这条断言真的红了"。
  if (red) {
    const hit = r.out.split('\n').filter((l) => l.includes(k.expect)).slice(0, 2);
    if (!hit.length) die(`${k.id} 说点名了，却在输出里找不回那一行：证据没落进日志`);
    console.log(hit.map((l) => `    | ${l.trim().slice(0, 200)}`).join('\n'));
    console.log(`    | 腿的 checks=${/RESULT .*"checks":(\d+)/.exec(r.out)?.[1] ?? '无 RESULT 行（腿没跑到收尾）'}`);
  }
  if (!red) console.log(r.out.split('\n').filter((l) => /FAIL|RED |ERROR|error:/.test(l)).slice(0, 8).map((l) => `    | ${l}`).join('\n'));
  if (k.file !== HERE && nowDirty.includes(k.file)) die(`${k.id} 恢复之后 ${k.file} 还是脏的，不带脏树跑下一把`);
  results.push({ id: k.id, rc: r.rc, named, red });
}

const failed = results.filter((x) => !x.red);
console.log('\n=== 台账 ===');
for (const x of results) console.log(`  ${x.id} rc=${x.rc} 点名=${x.named} ${x.red ? 'RED-OK' : 'NOT-RED'}`);
if (failed.length) die(`${failed.map((f) => f.id).join(' ')} 没能把闸打红：那几条断言不许算被证明过`);

// 整跑（不带刀）一次逻辑闸，确认恢复之后一切照旧。
const clean = sh(LOGIC, 120000);
if (clean.rc !== 0) die(`全部刀恢复之后逻辑闸不绿：\n${clean.out.slice(-800)}`);
console.log('  恢复后逻辑闸 GATE_RC=0');

// 只有全部刀都点名变红、且恢复后一切照旧，才把真实退码写回这张表。
if (picked.length !== KNIVES.length) {
  console.log('  只跑了部分刀，不回写 rc 列（整跑全部才盖章）');
} else {
  let src = read(HERE);
  for (const k of KNIVES) {
    const mine = results.find((x) => x.id === k.id);
    // 三格都要认：'待跑' 占位、上一次盖下的 '1'、以及更早版本留下的裸 1。
    // 原来只认 '待跑'，于是第一次跑把占位换成实测值之后，第二遍就"找不到占位"而 die(rc=2)
    // —— 一把跑一次就自毁的闸不能被任何人复跑。归一化成带引号后同值重盖 ⇒ 字节不变，复跑不脏树。
    const row = new RegExp(`(id: '${k.id}'[\\s\\S]*?rc: )'?(\\d+|待跑)'?`);
    if (!row.test(src)) die(`回写时找不到 ${k.id} 的 rc 那一格`);
    src = src.replace(row, `$1'${mine.rc}'`);
  }
  writeFileSync(join(ROOT, HERE), src);
  console.log('  rc 列已回写进 tools/sabotage.mjs（真读回来的退码）');
}
console.log('\nledger: PASS');
