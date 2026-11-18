#!/usr/bin/env node
// Builds data/live.json (the open tickets on the live board) from the open
// tickets in data/stats.json, so both tabs tell the same story.
//
// Everything is invented. The output has the same shape as the /api/live
// answer from netlify/functions/api.mjs. Timestamps are relative to
// stats.generatedAt; the page shifts them to "now" when it loads, so SLA
// countdowns always look current.
//
// Deterministic: same input, same output. Run: node scripts/build-live-demo.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const stats = JSON.parse(readFileSync(join(ROOT, 'data', 'stats.json'), 'utf8'));
const BASE = stats.generatedAt;
const SITE = stats.site;
const H = 3600e3, D = 24 * H, M = 60e3;

// seeded random numbers, one stream per ticket key
function rng(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
const between = (r, lo, hi) => lo + r() * (hi - lo);
function weighted(r, table) {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of table) if ((x -= w) < 0) return v;
  return table[table.length - 1][0];
}

const REQUEST_TYPES = [['Report an incident', 5], ['Request a change', 2], ['Ask a question', 2], ['Request access', 1]];
const PRIORITIES = [['Highest', 1], ['High', 3], ['Medium', 5], ['Low', 2]];
const REPORTERS = {
  BRW: ['Brackenfield dispatch', 'Brackenfield billing team', 'Brackenfield yard office', 'Brackenfield finance'],
  OSU: ['Osterby customer care', 'Osterby metering team', 'Osterby billing team', 'Osterby field services'],
};

// the resolution SLA clock: breached, close to breach, today, or comfortable
function resolutionSla(r, status) {
  if (status === 'Waiting for customer') {
    const breached = r() < 0.1;
    return {
      state: 'ongoing', paused: true, breached,
      breachAt: Math.round(breached ? BASE - between(r, 2 * H, 3 * D) : BASE + between(r, 3 * H, 6 * D)),
      goalFriendly: '40h',
    };
  }
  const bucket = weighted(r, [['breached', 13], ['minutes', 7], ['soon', 10], ['today', 20], ['later', 50]]);
  const offset = {
    breached: -between(r, 20 * M, 3 * D),
    minutes: between(r, 6 * M, 50 * M),
    soon: between(r, 1 * H, 4 * H),
    today: between(r, 4 * H, 24 * H),
    later: between(r, 1 * D, 9 * D),
  }[bucket];
  return {
    state: 'ongoing', paused: false, breached: offset < 0,
    breachAt: Math.round(BASE + offset), goalFriendly: pick(r, ['8h', '16h', '40h']),
  };
}

function firstResponseSla(r, t) {
  if (t.status !== 'Waiting for support') return { state: 'done', breached: r() < 0.08 };
  // untouched tickets: the first-response clock is still running
  const breachAt = Math.round(t.created + between(r, 2 * H, 4 * H));
  return { state: 'ongoing', paused: false, breached: breachAt < BASE, breachAt, goalFriendly: '4h' };
}

// last update: some tickets go quiet long enough to be flagged stale / chase
function lastUpdate(r, t) {
  if (t.status === 'Waiting for support') return t.created;
  const quiet = t.status === 'Waiting for customer'
    ? (r() < 0.3 ? between(r, 8 * D, 20 * D) : between(r, 1 * H, 6 * D))
    : (r() < 0.2 ? between(r, 6 * D, 15 * D) : between(r, 20 * M, 4 * D));
  return Math.round(Math.max(t.created, BASE - quiet));
}

const iso = ms => new Date(ms).toISOString();

const tickets = stats.tickets.filter(t => !t.resolved).map(t => {
  const r = rng(t.key);
  const requestType = weighted(r, REQUEST_TYPES);
  return {
    key: t.key,
    url: `${SITE}/browse/${t.key}`,
    client: t.client,
    summary: t.summary,
    status: t.status,
    statusCategory: t.status === 'Waiting for support' ? 'new' : 'indeterminate',
    type: requestType === 'Report an incident' ? 'Incident' : 'Service request',
    requestType,
    priority: weighted(r, PRIORITIES),
    assignee: t.assignee,
    assigneeId: null,
    reporter: pick(r, REPORTERS[t.client]),
    created: iso(t.created),
    updated: iso(lastUpdate(r, t)),
    sla: resolutionSla(r, t.status),
    firstResponse: firstResponseSla(r, t),
  };
}).sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));

const head = JSON.stringify({
  note: 'Invented demo data. Built by scripts/build-live-demo.mjs from data/stats.json.',
  site: SITE,
  generatedAt: BASE,
});
writeFileSync(join(ROOT, 'data', 'live.json'),
  head.slice(0, -1) + ',\n"tickets":[\n' + tickets.map(t => JSON.stringify(t)).join(',\n') + '\n]}\n');
console.log(`${tickets.length} open tickets -> data/live.json`);
