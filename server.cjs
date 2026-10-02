// Zero-dependency static server for the browser build.
// CommonJS on purpose: package.json is "type": "module", and Electron's main process requires this file.
//
// It answers BOTH URL shapes the repo can be reached at: a local run serves at the root, while
// GitHub Pages serves us under /z-biz-game-minishop-cos/. One server answering both means the
// gate's prefix shape is a real second shape, not a second server written just for the test.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PREFIX = '/z-biz-game-minishop-cos';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function resolveFile(root, urlPath) {
  let p = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  // 前缀形态：/z-biz-game-minishop-cos/js/main.js 与 /js/main.js 指的是同一份字节。
  if (p === PREFIX || p.startsWith(PREFIX + path.sep)) p = p.slice(PREFIX.length) || '/';
  if (p === '' || p === '.' || p === '/' || p === path.sep) p = '/index.html';
  const file = path.join(root, p);
  return file.startsWith(root) ? file : null;
}

function createServer(root = __dirname) {
  return http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    const file = resolveFile(root, urlPath);
    if (!file) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
    });
  });
}

// 5275 / 9375 是本仓在 z-biz-game 端口表里占的那一对（CDP 号写在 tools/playtest.mjs 头部）。
// 历史上这里写过 5271：那是从 z-biz-game-battleship-cos 搬代码时带来的，5271 是它的号、
// 不是本仓的。撞号的绿比红更糟，所以换根端口这件事只写在这两个地方。
function startServer({ port = 5275, root = __dirname } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer(root);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { createServer, startServer, resolveFile, PREFIX };

if (require.main === module) {
  const port = Number(process.argv[2]) || Number(process.env.PORT) || 5275;
  startServer({ port })
    .then((server) => {
      console.log(`孤舰 Minishop served at http://127.0.0.1:${port}/  and  http://127.0.0.1:${port}${PREFIX}/  (ctrl+c to stop)`);
      process.on('SIGINT', () => server.close(() => process.exit(0)));
    })
    .catch((err) => {
      console.error('failed to start:', err.message);
      process.exit(1);
    });
}
