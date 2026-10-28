// Dev server for the workspace app.
//
// It serves ONLY the files in this folder. Everything else - the HTTP API, the
// vendored crypto libraries, and the tested signer modules - is proxied to the
// existing console server, which this workspace never modifies.
//
//   node serve.mjs            -> http://localhost:4181
//   PORT=4199 node serve.mjs  -> pick another port
//   UPSTREAM=http://127.0.0.1:4173 (default)
//
// No CSP header is set here on purpose: this is a local dev server, and the
// wallet extensions need to inject into the page. The production console
// (permission-core/web/server.mjs) keeps its own strict nonce CSP, and this
// app's HTML carries the same nonce placeholders so it works under both.

import { createServer, request as upstreamRequest } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = realpathSync(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT ?? 4181);
const UPSTREAM = process.env.UPSTREAM ?? 'http://127.0.0.1:4173';

// Paths that belong to the tested console server, never to this folder.
const PROXY_PREFIXES = ['/api/', '/vendor/'];
const PROXY_FILES = ['/signer.js', '/signers.js', '/wallet.js', '/tx-signer.js', '/typed-data.js'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function isProxied(pathname) {
  return PROXY_PREFIXES.some((p) => pathname.startsWith(p)) || PROXY_FILES.includes(pathname);
}

function proxy(req, res) {
  const target = new URL(req.url, UPSTREAM);
  const headers = { ...req.headers, host: target.host };
  const up = upstreamRequest(target, { method: req.method, headers }, (ures) => {
    res.writeHead(ures.statusCode ?? 502, ures.headers);
    ures.pipe(res);
  });
  up.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error: `the console server at ${UPSTREAM} did not answer: ${e.message}. ` +
        'Start it first: cd permission-core && node web/server.mjs',
    }));
  });
  req.pipe(up);
}

function serveLocal(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end('malformed path');
  }
  if (rel.includes('\0')) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end('malformed path');
  }
  if (rel === '/') rel = '/index.html';

  const filePath = resolve(HERE, rel.replace(/^\/+/, ''));
  if (filePath !== HERE && !filePath.startsWith(HERE + sep)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('path escapes the workspace');
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end(`not found: ${rel}`);
  }

  const ext = extname(filePath).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  res.end(readFileSync(filePath));
}

createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  if (isProxied(pathname)) return proxy(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain' });
    return res.end('method not allowed');
  }
  return serveLocal(req, res, pathname);
}).listen(PORT, () => {
  console.log(`mandate workspace app -> http://localhost:${PORT}`);
  console.log(`api + signer modules proxied to ${UPSTREAM} (untouched)`);
});
