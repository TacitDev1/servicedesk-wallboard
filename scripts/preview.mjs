#!/usr/bin/env node
// Preview the GitHub Pages build exactly as it will be served: stages _site/
// and serves it under the repo's sub-path, so any absolute path shows up as a 404.
//
//   node scripts/preview.mjs        http://localhost:4399/servicedesk-wallboard/
//
// PORT and BASE (default /servicedesk-wallboard/) can be changed.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, '_site');
const PORT = Number(process.env.PORT) || 4399;
const BASE = (process.env.BASE || '/servicedesk-wallboard/').replace(/\/?$/, '/');
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8' };

execFileSync(process.execPath, [join(ROOT, 'scripts', 'stage-site.mjs')], { stdio: 'inherit' });

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/' || pathname === BASE.slice(0, -1)) {
    res.writeHead(302, { Location: BASE });
    return res.end();
  }
  if (!pathname.startsWith(BASE)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found (outside ' + BASE + ')');
  }
  let rel = decodeURIComponent(pathname.slice(BASE.length)) || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(SITE, rel));
  if (!file.startsWith(SITE + sep)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Preview: http://localhost:${PORT}${BASE}`));
