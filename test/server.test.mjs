// server.cjs 是本仓唯一一个"页面之外的代码也是产品"的文件：GitHub Pages 把我们挂在
// /z-biz-game-minishop-cos/ 下面，本地跑却在根上，两种形态必须是同一份字节 —— 否则浏览器闸
// 的第二种形态测的是另一个仓、或者一个仓里根本不存在的构建。
//
// 两条腿：
//  1. resolveFile() 的纯函数面（前缀剥离、目录兜底、越界收敛）。这里钉的是"字节的归属"，
//     只能对路径字符串本身断，所以期望全部手写。
//  2. 真起一个 server 在临时端口上，用 fetch 把两种形态各取一遍。异步的部分全部在 test()
//     之外跑完（tools/harness.mjs 的 test() 是同步的：给它一个 async fn 等于把一条注定没
//     跑完的断言记成 ok），test() 里只比已经拿到手的结果。
//
// 端口：本仓那一对是 HTTP 5275 / CDP 9375（撞号事故的解释写在 server.cjs 与
// tools/playtest.mjs 的头部）。这一条腿自己 listen(0)，不占那一对，跑多少遍都不会和
// verify.sh 的浏览器段抢端口。

import { test, run, ok, eq } from '../tools/harness.mjs';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createServer, resolveFile, PREFIX } = require('../server.cjs');

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const sha = (buf) => {
  let h = 0;
  const s = buf.toString('latin1');
  for (let i = 0; i < s.length; i++) h = ((h * 31 + s.charCodeAt(i)) >>> 0);
  return `${s.length}B/${h.toString(16)}`;
};

// ---------------------------------------------------------------- 1. resolveFile, pure
const cases = [
  ['/js/main.js', 'js/main.js'],
  ['/index.html', 'index.html'],
  ['/css/game.css', 'css/game.css'],
  ['/z-biz-game-minishop-cos/js/main.js', 'js/main.js'],
  ['/z-biz-game-minishop-cos/css/game.css', 'css/game.css'],
  ['/z-biz-game-minishop-cos/js/core/count.js', 'js/core/count.js'],
];
for (const [urlPath, rel] of cases) {
  test(`resolveFile(${urlPath}) 指向 ${rel}`, () => {
    eq(resolveFile(ROOT, urlPath), path.join(ROOT, rel));
  });
}

test('两种 URL 形态落到同一个文件：前缀形态不是为测试另写的一份服务器', () => {
  for (const rel of ['index.html', 'js/main.js', 'css/game.css', 'js/core/count.js', 'js/view.js']) {
    eq(resolveFile(ROOT, '/' + rel), resolveFile(ROOT, PREFIX + '/' + rel), `/${rel} 与 ${PREFIX}/${rel}`);
  }
});

// 目录形态：三种写法都必须落到 index.html，Pages 上少一条就是整站 404。
for (const [label, urlPath] of [['根', '/'], ['根斜杠', ''], ['前缀本身', PREFIX], ['前缀斜杠', PREFIX + '/']]) {
  test(`${label}形态（${JSON.stringify(urlPath)}）兜到 index.html`, () => {
    eq(resolveFile(ROOT, urlPath), path.join(ROOT, 'index.html'));
  });
}

// 前缀是"整段"才剥：/z-biz-game-minishop-cosx 这种同前缀的路径必须原样保留。
// 写成 p.startsWith(PREFIX) 也能让上面几条绿，但它会把 /z-biz-game-minishop-cosx/js/main.js
// 读成 js/main.js —— 于是"前缀形态"这四个字就没有对手了。
test('同前缀但不是我们的一律不剥', () => {
  eq(resolveFile(ROOT, '/z-biz-game-minishop-cosx/js/main.js'), path.join(ROOT, 'z-biz-game-minishop-cosx/js/main.js'));
  eq(resolveFile(ROOT, '/z-biz-game-minishop-cos-not-us.css'), path.join(ROOT, 'z-biz-game-minishop-cos-not-us.css'));
});

// 越界：不论输入怎么写，交回的路径只能在 root 里面（或 null）。
const nasty = [
  '/../package.json', '/../../etc/passwd', '/js/../../server.cjs', '/./index.html',
  '//js//main.js', '/js/main.js/../../view.js', '/%2e%2e/package.json', '/a/../../../b',
  PREFIX + '/../js/main.js', PREFIX + '/../../etc/hosts',
];
test('十条越界写法没有一条能逃出 root', () => {
  for (const u of nasty) {
    const f = resolveFile(ROOT, u);
    ok(f === null || f === ROOT || f.startsWith(ROOT + path.sep), `${u} -> ${f} 跑到了 root 外面`);
  }
});
test('越界收敛之后仍然落在仓内：/js/../../server.cjs 读到的是仓里的 server.cjs', () => {
  eq(resolveFile(ROOT, '/js/../../server.cjs'), path.join(ROOT, 'server.cjs'));
  eq(resolveFile(ROOT, PREFIX + '/../js/main.js'), path.join(ROOT, 'js/main.js'));
});
// startsWith(root) 这道锁在当前调用链里摘不下钥匙（p 以 / 开头，path.join 就把结果按回 root），
// 但它是唯一的越界防线，所以钉住"永远不返回 null"这件事，而不是让它悄悄死掉。
test('resolveFile 的 null 分支目前不可达：它一旦可达必须是被改动引入的', () => {
  for (const u of [...nasty, ...cases.map((c) => c[0])]) ok(resolveFile(ROOT, u) !== null, `${u} 返回了 null`);
});

// ---------------------------------------------------------------- 2. the same bytes, served
const server = createServer(ROOT);
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const PORT = server.address().port;
const grab = async (p) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
  return { status: r.status, type: r.headers.get('content-type'), digest: sha(Buffer.from(await r.arrayBuffer())) };
};
const WANTED = ['/', '/index.html', '/js/main.js', '/js/core/count.js', '/css/game.css'];
const pairs = [];
for (const p of WANTED) pairs.push([p, await grab(p), await grab(PREFIX + p)]);
const misses = [];
for (const p of ['/nope/nothing.js', PREFIX + '/nope/nothing.js', '/js/main.js/x/../../nope']) misses.push([p, await grab(p)]);
const types = {};
for (const p of ['/js/main.js', '/css/game.css', '/index.html', '/js/core/count.js']) types[p] = await grab(p);
server.close();

for (const [p, rootShape, prefixShape] of pairs) {
  test(`两种形态取回同一份字节且都 200：${p}`, () => {
    ok(rootShape.status === 200, `根形态 ${p} -> ${rootShape.status}`);
    ok(prefixShape.status === 200, `前缀形态 ${p} -> ${prefixShape.status}`);
    eq(rootShape.digest, prefixShape.digest, `${p} 两种形态字节不同`);
    eq(rootShape.type, prefixShape.type, `${p} 两种形态 content-type 不同`);
  });
}

test('缺文件是 404 而不是把 root 里的 index.html 兜出来', () => {
  for (const [p, got] of misses) ok(got.status === 404, `${p} -> ${got.status}，期望 404`);
});

test('content-type 是按真扩展名给的', () => {
  eq(types['/js/main.js'].type, 'text/javascript; charset=utf-8');
  eq(types['/css/game.css'].type, 'text/css; charset=utf-8');
  eq(types['/index.html'].type, 'text/html; charset=utf-8');
});

// 端口预检在 verify.sh 里靠 grep 断言"served 的字节就是本仓的应用"，这几条是它的数据面。
test('served 的 index.html 里有 孤舰 与 js/main.js，served 的 js/main.js 导出 window.minishop', () => {
  const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok(html.includes('孤舰'), 'index.html 里没有 孤舰');
  ok(html.includes('js/main.js'), 'index.html 里没有 js/main.js 引用');
  ok(readFileSync(path.join(ROOT, 'js/main.js'), 'utf8').includes('window.minishop'), 'js/main.js 不导出 window.minishop');
});

// ---------------------------------------------------------------- 3. the port pair is ours
test('HTTP 默认端口是 5275，CDP 默认是 9375，撞号的 5271/9371 不再出现在默认值里', () => {
  const srv = readFileSync(path.join(ROOT, 'server.cjs'), 'utf8');
  const play = readFileSync(path.join(ROOT, 'tools/playtest.mjs'), 'utf8');
  ok(/port = 5275/.test(srv) && /PORT\) \|\| 5275/.test(srv), 'server.cjs 的默认端口不是 5275');
  ok(/CDP_PORT \|\| 9375/.test(play) && /127\.0\.0\.1:5275/.test(play), 'playtest.mjs 的默认端口对不是 5275/9375');
  ok(!/5271|9371/.test(srv.match(/port = \d+|PORT\) \|\| \d+/g).join('')), 'server.cjs 的默认值里还写着别人的端口');
});

run();
