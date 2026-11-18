#!/usr/bin/env node
// Leak scan: fails (exit 1) when a tracked-looking file contains something that
// should never be public. Zero dependencies. Run: node scripts/leak-scan.mjs
//
// Two layers:
//  1. Generic patterns, built in: IP addresses, email addresses, Jira/SAP cloud
//     hosts, webhook URLs, key-looking strings.
//  2. A private denylist of names (clients, people, companies). It is NOT kept in
//     the repo, because the list itself would be a leak. It is read from the
//     LEAK_DENYLIST env var (comma or newline separated; a GitHub Actions secret
//     in CI) or from the file named by LEAK_DENYLIST_FILE.
//
// Allowed exceptions go in .leak-allow at the repo root, one per line:
//     file:path/to/file        skip a whole file
//     any other line           a regex; a finding whose matched text fits it is ignored
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.astro', '.venv', 'venv', '__pycache__', '.cache']);
const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf',
  '.mp4', '.webm', '.mp3', '.wav', '.pdf', '.zip', '.gz', '.exe', '.onnx', '.bin']);
const MAX_BYTES = 5 * 1024 * 1024;

const GENERIC = [
  ['ip-address', /\b(?!(?:127\.0\.0\.1|0\.0\.0\.0|255\.255\.255\.\d+)\b)(?:\d{1,3}\.){3}\d{1,3}\b/g],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['jira-cloud-host', /[a-z0-9-]+\.atlassian\.net/gi],
  ['jira-custom-field', /customfield_\d{4,}/g],
  ['sap-cloud-host', /[a-z0-9.-]+\.hana\.ondemand\.com/gi],
  ['workflow-webhook', /https?:\/\/[^\s"']*(?:logic\.azure\.com|powerautomate\.com|webhook\.office\.com|powerplatform\.com)[^\s"']*/gi],
  ['sharepoint-host', /[a-z0-9-]+\.sharepoint\.com/gi],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['token-like', /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|ATATT[A-Za-z0-9_=-]{20,}|xox[bpa]-[A-Za-z0-9-]{20,})\b/g],
];
// Things the generic patterns may match that are fine to publish.
const BUILTIN_ALLOW = [
  /@(?:[a-z0-9-]+\.)*example(?:\.(?:com|org|net))?$/i, /\.example$/i, /^noreply@anthropic\.com$/i, /^git@github\.com$/i,
  /@users\.noreply\.github\.com$/i, /^[\w.-]+@\d+x\.(?:png|jpg|webp)$/i, /^[a-z0-9-]+@[\d.^~x*-]+$/i,
];

function loadList(text) {
  return (text || '').split(/[\n,]/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
}
const denyTerms = [
  ...loadList(process.env.LEAK_DENYLIST),
  ...(process.env.LEAK_DENYLIST_FILE && existsSync(process.env.LEAK_DENYLIST_FILE)
    ? loadList(readFileSync(process.env.LEAK_DENYLIST_FILE, 'utf8')) : []),
];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A term wrapped in /slashes/ is a regex; a plain term matches as a substring
// unless it is 3 letters or fewer, when it must stand alone as a word.
const DENY = denyTerms.map((t) => {
  if (t.length > 2 && t.startsWith('/') && t.endsWith('/')) return [t, new RegExp(t.slice(1, -1), 'gi')];
  return [t, new RegExp(t.length <= 3 ? `(?<![A-Za-z0-9])${esc(t)}(?![A-Za-z0-9])` : esc(t), 'gi')];
});

const allowFiles = new Set();
const allowRes = [...BUILTIN_ALLOW];
if (existsSync(join(ROOT, '.leak-allow'))) {
  for (const line of loadList(readFileSync(join(ROOT, '.leak-allow'), 'utf8'))) {
    if (line.startsWith('file:')) allowFiles.add(line.slice(5).trim().replace(/\\/g, '/'));
    else allowRes.push(new RegExp(line, 'i'));
  }
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (!BINARY.has(extname(name).toLowerCase()) && st.size <= MAX_BYTES) yield p;
  }
}

const findings = [];
let scanned = 0;
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (allowFiles.has(rel) || rel === '.leak-allow') continue;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  scanned++;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 20000) continue; // minified blobs: checked by name hits only
    for (const [label, re] of [...GENERIC, ...DENY.map(([t, re]) => [`denylist`, re, t])]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        const hit = m[0];
        if (!allowRes.some((a) => a.test(hit))) {
          findings.push(`${rel}:${i + 1}  [${label}]  ${hit.slice(0, 80)}`);
        }
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
  }
}

if (!DENY.length) {
  console.warn('leak-scan: no private denylist loaded (LEAK_DENYLIST / LEAK_DENYLIST_FILE). Generic patterns only.');
}
if (findings.length) {
  console.error(`leak-scan: ${findings.length} finding(s) in ${scanned} files:\n` + findings.join('\n'));
  process.exit(1);
}
console.log(`leak-scan: clean (${scanned} files, ${DENY.length} denylist terms).`);
