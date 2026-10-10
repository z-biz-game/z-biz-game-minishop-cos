// README 里印出来的每一个"现值"都必须等于代码/脚本里的现在值：四档菜单表、六条判据原文、
// 四只键、评星三档、逻辑闸条数、浏览器每份报告的条数、端口那一对号、台账五把刀的 rc、
// 以及线上地址用的仓名。散文没有闸读，于是它会一直抄到代码改了字而文档还在引用上一个世界。
//
// 每张表都配一条"解析到几行"的反空转断言：正则一旦因为文档换了格式而一行都抓不到，
// 后面的比对就全成零次比较——那种绿比红更糟。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test, run, ok, eq } from '../tools/harness.mjs';
import { PUZZLES, TIERS_META } from '../js/data/puzzles.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const README = read('README.md');
const VERIFY = read('tools/verify.sh');
const SABO = read('tools/sabotage.mjs');
const CHECK = read('js/core/check.js');
const MAIN = read('js/main.js');
const GAME = read('js/core/game.js');
const PLAYTEST = read('tools/playtest.mjs');
const SERVER = read('server.cjs');

const bare = (s) => s.replace(/`/g, '').trim();

// README 里的 markdown 表：靠表头的几格认出是哪张表，往下吃到空行/非表行为止。
function table(sigCells) {
  const lines = README.split('\n');
  const head = lines.findIndex((l) => l.startsWith('|') && sigCells.every((c) => l.includes(c)));
  if (head < 0) throw new Error(`README 里找不到表头同时含 ${sigCells.join(' / ')} 的那张表`);
  const rows = [];
  for (let i = head + 2; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith('|')) break;
    rows.push(l.split('|').slice(1, -1).map((c) => c.trim()));
  }
  return rows;
}

// verify.sh 里的 `${VAR:-值}` 形态：值就是这份仓对外的口径，文档只能抄它。
function assign(name) {
  const line = new RegExp(`^${name}=(.*)$`, 'm').exec(VERIFY);
  ok(line, `tools/verify.sh 里找不到 ${name} 的钉表`);
  const inner = /^\$\{[A-Za-z_]+:?-?(.*)\}$/.exec(line[1].trim());
  ok(inner, `${name} 写法不是 \${NAME:-值}，文档无从抄起：${line[1]}`);
  return inner[1].replace(/^"(.*)"$/, '$1');
}
const kv = (s) => Object.fromEntries(s.trim().split(/\s+/).map((p) => p.split('=')));

// ---------------------------------------------------------------- 1. 菜单表
{
  const rows = table(['档', 'key', '图', '舰队', '题数']);
  test('菜单表反空转：解析到的行数恰好等于 TIERS_META 的档数', () => {
    eq([rows.length, TIERS_META.length], [4, 4], `菜单表解析 ${rows.length} 行 / TIERS_META ${TIERS_META.length} 档`);
  });
  test('菜单表每一行的图幅、舰队、题数、深度都等于数据里的现在值', () => {
    for (const [label, key, grid, fleet, count, depth] of rows) {
      const meta = TIERS_META.find((t) => t.key === key);
      ok(meta, `TIERS_META 里没有 ${key} 这一档`);
      eq(meta.label, label, `${key} 的中文档名`);
      eq(grid, `${meta.rows}×${meta.cols}`, `${key} 的图幅`);
      eq(fleet, meta.fleet.join(', '), `${key} 的舰队清单`);
      const inTier = PUZZLES.filter((p) => p.tier === key);
      eq(Number(count), inTier.length, `${key} 的题数`);
      const depths = [...new Set(inTier.map((p) => p.depth))];
      eq(depths, [Number(depth)], `${key} 这一档的 depth 必须只有一个值，且等于表里印的 ${depth}`);
    }
  });
  test('合计题数与每档题数一致', () => {
    const m = /合计 (\d+) 题/.exec(README);
    ok(m, 'README 里没有「合计 N 题」那一句');
    eq(Number(m[1]), PUZZLES.length, '合计题数');
  });
}

// ---------------------------------------------------------------- 2. 六条判据原文
{
  const rows = table(['#', '判据', '不成立时它说的话']);
  test('判据表反空转：恰好六条，不多不少', () => {
    eq(rows.length, 6, `判据表解析到 ${rows.length} 行`);
  });
  test('判据表里每一句报错原文都还在独立检查器里', () => {
    for (const [n, , quoted] of rows) {
      const needle = bare(quoted);
      ok(CHECK.includes(needle), `check.js 里找不到第 ${n} 条那句报错「${needle}」`);
    }
  });
  test('FREE 那句话等于 model.js 的现在值', () => {
    const m = /`FREE = (-?\d+)`/.exec(README);
    ok(m, 'README 里没有「`FREE = N`」那一句');
    eq(Number(m[1]), JSON.parse(/export const FREE = (-?\d+);/.exec(read('js/core/model.js'))[1]), 'FREE 的值');
  });
}

// ---------------------------------------------------------------- 3. 键位与计数
{
  const rows = table(['键', '做什麼', '计不计入']);
  test('键位表反空转：四只键', () => {
    eq(rows.length, 4, `键位表解析到 ${rows.length} 行`);
  });
  test('键位表里每只键都真的接在 main.js 的键处理上', () => {
    for (const [keyRaw] of rows) {
      const key = bare(keyRaw);
      ok(new RegExp(`k === '${key}'`).test(MAIN), `js/main.js 里没有处理键 '${key}'`);
    }
  });
  test('计数器的四句话在 game.js 里各自成立', () => {
    const fn = (name, until) => {
      const a = GAME.indexOf(`export function ${name}`);
      ok(a >= 0, `找不到 ${name}()`);
      const b = GAME.indexOf(until, a + 10);
      return GAME.slice(a, b > a ? b : a + 900);
    };
    const rot = fn('rotate', 'export function');
    ok(!/game\.ops\+\+/.test(rot), 'rotate() 里出现了 ops++，「转身免费」这句得改文档');
    ok(!/game\.steps\+\+/.test(rot), 'rotate() 里出现了 steps++');
    const place = fn('place', 'export function retrieve');
    ok(/game\.ops\+\+/.test(place) && /game\.steps\+\+/.test(place), 'place() 必须两个计数器都 +1');
    const back = fn('retrieve', 'export function');
    ok(/game\.ops\+\+/.test(back) && !/game\.steps\+\+/.test(back), 'retrieve() 只该花操作、不花放置步数');
    ok(/par: spec\.fleet\.length/.test(GAME), 'par 的定义不再是「舰队条数」');
    ok(/if \(game\.hints > 0\) return \{ key: 'aided'/.test(GAME), 'grade() 里那档 2 星不再看 game.hints');
    ok(/app\.game\.hints\+\+/.test(MAIN), '壳里的提示计费没写进 game.hints：那一档「有人指路」永远不会出现');
    ok(!/app\.hints/.test(MAIN.replace(/\/\/.*$/gm, '')), 'main.js 里还留着第二个提示计数器');
  });
}

// ---------------------------------------------------------------- 4. 评星三档
{
  const rows = table(['成绩', '条件', '标记']);
  test('评星表反空转：三档', () => {
    eq(rows.length, 3, `评星表解析到 ${rows.length} 行`);
  });
  test('评星表每档的星数与标记等于 grade() 里的现在值', () => {
    for (const [starsRaw, , labelRaw] of rows) {
      const n = Number(bare(starsRaw).replace(/星/g, '').trim());
      const label = bare(labelRaw);
      ok(GAME.includes(`label: '${label}', stars: ${n}`), `grade() 里没有 ${label} / ${n} 星这一行`);
    }
  });
}

// ---------------------------------------------------------------- 5. 逻辑闸条数
{
  const gates = assign('GATES').split(/\s+/);
  const pins = kv(assign('LOGIC_EXPECTS'));
  const naOk = assign('NA_OK').trim().split(/\s+/);
  const rows = table(['闸', '命令', '条数']);
  test('逻辑闸表反空转：行名单与 verify.sh 的 GATES 名单逐名相等', () => {
    eq(rows.map((r) => bare(r[0])).join(' '), gates.join(' '),
      `表里的闸名单与 verify.sh 的 GATES 名单不等（表 ${rows.length} 行 / 名单 ${gates.length} 道）`);
  });
  test('逻辑闸表里每道闸的条数等于钉表（NA 只许给不打印 rows: 的那道）', () => {
    for (const [gateRaw, , countRaw] of rows) {
      const gate = bare(gateRaw);
      if (naOk.includes(gate)) {
        ok(/^NA/.test(bare(countRaw)), `${gate} 属于 NA_OK，表里却印了条数 ${countRaw}`);
        ok(!pins[gate], `钉表里不该有 ${gate}（它不打印 rows:，钉不了条数）`);
        continue;
      }
      ok(pins[gate], `钉表 LOGIC_EXPECTS 里没有 ${gate}`);
      eq(bare(countRaw), pins[gate], `${gate} 的条数`);
    }
  });
  test('README 印的「合计 N 条断言」等于钉表里除 doctest 之外的和', () => {
    const sum = Object.entries(pins).filter(([k]) => k !== 'doctest').reduce((a, [, v]) => a + Number(v), 0);
    const m = /合计 (\d+) 条断言/.exec(README);
    ok(m, 'README 里没有「合计 N 条断言」那一句');
    eq(Number(m[1]), sum, `钉表里除 doctest 之外应有 ${sum} 条`);
  });
}

// ---------------------------------------------------------------- 6. 浏览器每份报告的条数
{
  const rows = table(['run', '腿', '条数', '在证什么']);
  const pins = kv(assign('BROWSER_EXPECTS'));
  const golden = Number(assign('GOLDEN_PER_SHAPE'));
  test('浏览器表反空转：行数 = golden 的每形态报告数 = 钉表条数', () => {
    eq([rows.length, golden, Object.keys(pins).length], [golden, golden, golden],
      `表里 ${rows.length} 行 / golden ${golden} 份 / 钉表 ${Object.keys(pins).length} 条`);
  });
  test('每份报告印的条数等于钉表，且 run 名确实挂在表里那条腿下', () => {
    for (const [runRaw, legRaw, countRaw] of rows) {
      const name = bare(runRaw);
      ok(pins[name], `钉表 BROWSER_EXPECTS 里没有 ${name}`);
      eq(bare(countRaw), pins[name], `${name} 的条数`);
      const leg = bare(legRaw);
      const plan = new RegExp(`${leg}\\)\\s+echo "([^"]+)"`).exec(VERIFY);
      ok(plan, `leg_plan 里找不到 ${leg} 这一腿`);
      ok(plan[1].split(/\s*\|\s*/).some((spec) => spec.split(' ')[0] === name),
        `腿计划里 ${leg} 这一腿并不产出 ${name} 这份报告（计划是 ${plan[1]}）`);
    }
  });
}

// ---------------------------------------------------------------- 7. 端口那一对号
{
  test('README 里那对端口号与脚本的默认值同源', () => {
    const m = /端口 \*\*(\d+) \/ (\d+)\*\*/.exec(README);
    ok(m, 'README 里没有「端口 **A / B**」那一句');
    const http = assign('HTTP'), cdp = assign('PORT');
    eq([m[1], m[2]], [http, cdp], `README 印的端口对 ≠ verify.sh 默认（HTTP=${http} CDP=${cdp}）`);
    ok(PLAYTEST.includes(`process.env.CDP_PORT || ${cdp}`), `playtest.mjs 的默认 CDP 端口不是 ${cdp}`);
    ok(new RegExp(`port = ${http}`).test(SERVER), `server.cjs 的默认 HTTP 端口不是 ${http}`);
    // 5271/9371 在本仓的**注释**里是有的——那几行讲的正是"这两个号是从 battleship/euclid 搬
    // 代码时带过来的遗产"。要挡的是把它们当默认值绑上的那一类，所以只扫非注释行。
    const codeOnly = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|#)/.test(l)).join('\n');
    ok(!/5271|9371/.test(codeOnly(`${VERIFY}${PLAYTEST}${SERVER}${README}`)), '5271/9371 是 battleship/euclid 的号，本仓的代码行里一处都不该绑');
  });
  test('两种 URL 形态与线上地址用的是同一个仓名', () => {
    const slug = /github\.io\/([a-z0-9-]+)/.exec(README)[1];
    ok(VERIFY.includes(`$HTTP/${slug}/`), `verify.sh 的第二种 URL 形态不是 /${slug}/`);
    ok(VERIFY.includes('miniship') && VERIFY.includes('孤舰'), 'slug 预检要 grep 题材 MINISHIP/孤舰，而不是仓名');
  });
}

// ---------------------------------------------------------------- 8. 台账五把刀
{
  const rows = table(['刀', '打在哪', '改坏什么', 'rc']);
  const ids = [...SABO.matchAll(/id: '(K\d)', file: '([^']+)'/g)].map((m) => ({ id: m[1], file: m[2] }));
  const rcs = Object.fromEntries([...SABO.matchAll(/id: '(K\d)'[\s\S]*?rc: '?(\d+|待跑)'?,/g)].map((m) => [m[1], m[2]]));
  test('台账表反空转：README 行数与 sabotage.mjs 的刀数相等且不为零', () => {
    ok(ids.length >= 1, 'sabotage.mjs 里一把刀都没解析到——这条正则空转了');
    eq(rows.length, ids.length, `台账表 ${rows.length} 行 / KNIVES ${ids.length} 把`);
  });
  test('每把刀的靶文件与 rc 等于 sabotage.mjs 里盖章的那格', () => {
    for (const [idRaw, fileRaw, , rcRaw] of rows) {
      const id = bare(idRaw);
      const k = ids.find((x) => x.id === id);
      ok(k, `KNIVES 里没有 ${id}`);
      eq(bare(fileRaw), k.file, `${id} 打在哪个文件`);
      ok(rcs[id] !== undefined, `${id} 的 rc 那一格没被解析到`);
      ok(rcs[id] !== '待跑', `${id} 的 rc 还写着「待跑」：这张表没被真跑过一次就上线了`);
      eq(bare(rcRaw), rcs[id], `${id} 的 rc（跑一次就自毁的章不许带着上线）`);
    }
  });
}

// ---------------------------------------------------------------- 9. 零依赖与路径引用
{
  test('「零运行时依赖」这句话在 package.json 里成立', () => {
    const pkg = JSON.parse(read('package.json'));
    eq([Object.keys(pkg.dependencies || { a: 1 }).length, Object.keys(pkg.devDependencies || { a: 1 }).length], [0, 0],
      'README 承诺 dependencies 与 devDependencies 都是空对象');
  });
  test('README 引用的每个代码路径都还在树上', () => {
    const refs = [...new Set([...README.matchAll(/`((?:js|tools|test)\/[A-Za-z0-9_./-]+\.[A-Za-z][A-Za-z0-9]{0,11})`/g)].map((m) => m[1]))];
    ok(refs.length >= 10, `只抓到 ${refs.length} 个代码路径引用，解析八成空了`);
    for (const p of refs) readFileSync(join(ROOT, p), 'utf8');
  });
}

run();
