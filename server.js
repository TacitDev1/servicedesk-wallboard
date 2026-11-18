#!/usr/bin/env node
/**
 * Local server for the wallboard. Zero dependencies, Node 18+.
 *
 *   node server.js        then open  http://localhost:8642/            demo data
 *                                    http://localhost:8642/?mode=live  your own Jira
 *
 * It serves the page and data/ and runs netlify/functions/api.mjs at /api/*,
 * exactly as Netlify would. All Jira settings come from environment variables
 * or a .env file beside this script (see .env.example; .env is git-ignored).
 *
 * If JIRA_EMAIL and JIRA_API_TOKEN are set, this server signs every API call
 * in with them, so the page needs no sign-in. That is for your own machine
 * only: the server listens on 127.0.0.1. Never put a token into a public
 * deploy; there, each person signs in on the page with their own token.
 *
 * PORT changes the port (default 8642).
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = __dirname;

// ---------- .env (optional; real environment variables win) ----------

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const PORT = Number(process.env.PORT) || 8642;
const api = import(pathToFileURL(path.join(ROOT, 'netlify', 'functions', 'api.mjs')).href).then(m => m.default);

// A server-side sign-in, only when both are set (local use only, see above).
const serverAuth = process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN
  ? Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64')
  : null;

// ---------- HTTP ----------

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function handleApi(req, res, url) {
  const auth = req.headers['x-jira-auth'] || serverAuth;
  const headers = auth ? { 'x-jira-auth': auth } : {};
  const handler = await api;
  const response = await handler(new Request(url, { method: req.method, headers }), {});
  send(res, response.status, response.headers.get('content-type'), await response.text());
}

// Only the page and the demo data are ever served: never .env or the source.
function staticFile(pathname) {
  if (pathname === '/' || pathname === '/index.html') return path.join(ROOT, 'index.html');
  const m = pathname.match(/^\/data\/([a-z0-9-]+\.json)$/);
  return m ? path.join(ROOT, 'data', m[1]) : null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(() => send(res, 500, 'text/plain', 'Server error'));
    return;
  }
  const file = staticFile(url.pathname);
  if (!file) return send(res, 404, 'text/plain', 'Not found');
  fs.readFile(file, (err, body) => {
    if (err) return send(res, 404, 'text/plain', 'Not found');
    send(res, 200, TYPES[path.extname(file)] || 'application/octet-stream', body);
  });
});

server.on('error', err => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use.` : err);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Wallboard demo:      http://localhost:${PORT}/`);
  console.log(`Wallboard live Jira: http://localhost:${PORT}/?mode=live`);
  console.log(serverAuth
    ? 'Live mode signs in with JIRA_EMAIL / JIRA_API_TOKEN from the environment.'
    : 'Live mode: sign in on the page with a Jira email and API token.');
});
