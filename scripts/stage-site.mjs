#!/usr/bin/env node
// Copies the static site (the page and its demo data, nothing else) into _site/.
// Used by the GitHub Pages workflow, by Netlify's build, and by scripts/preview.mjs.
// Publishing _site/ rather than the repo root means a local .env or the
// function source can never end up on the web.
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '_site');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'data'), { recursive: true });
cpSync(join(ROOT, 'index.html'), join(OUT, 'index.html'));
for (const f of readdirSync(join(ROOT, 'data'))) {
  if (f.endsWith('.json')) cpSync(join(ROOT, 'data', f), join(OUT, 'data', f));
}
writeFileSync(join(OUT, '.nojekyll'), '');
console.log('Staged the static site in _site/');
