/**
 * Optional live mode: the wallboard's only server-side code, one Netlify
 * function at /api/*. The demo (GitHub Pages) never calls it.
 *
 * It is a stateless pass-through to Jira Cloud. The browser sends the user's
 * own Jira sign-in (base64 of "email:token", in an X-Jira-Auth header) with
 * every request. It has its own header so it can never be mixed up with a
 * password lock in front of the site. This function forwards it to one fixed
 * Jira site as Basic authorization, runs one of three fixed requests and
 * answers with compact records. It stores nothing, logs nothing and has no
 * secrets of its own.
 *
 *   GET /api/me                  { ok, name }                           is the sign-in good?
 *   GET /api/live                { site, generatedAt, build, tickets }  every open ticket
 *   GET /api/stats?project=KEY   { tickets, cursor }                    every ticket ever, in chunks:
 *       &cursor=<last answer's>     ask again with the cursor until it comes back null
 *       &changed=<minutes>          only tickets changed in the last N minutes, or still open
 *
 * Settings come from environment variables only (see .env.example):
 *   JIRA_SITE                      https://<your-site>.atlassian.net
 *   JIRA_PROJECTS                  the two project keys, comma separated (match CONFIG.clients in index.html)
 *   JIRA_FIELD_SLA_RESOLUTION      custom field ID of "Time to resolution"
 *   JIRA_FIELD_SLA_FIRST_RESPONSE  custom field ID of "Time to first response"
 *   JIRA_FIELD_REQUEST_TYPE        custom field ID of "Request Type" (optional)
 *   STATS_BUDGET_MS                time budget per stats call (optional, default 4000)
 *
 * Zero dependencies, Node 18+. server.js runs the same handler for local dev.
 */

const OPEN = 'statusCategory != Done';
const LIVE_MAX_PAGES = 10;        // 100 tickets a page
const JIRA_TIMEOUT_MS = 5000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- settings (read on every call, so tests can change them) ----------

const env = name => (process.env[name] || '').trim();

function settings() {
  const site = env('JIRA_SITE').replace(/\/+$/, '');
  const projects = env('JIRA_PROJECTS').split(',').map(s => s.trim()).filter(Boolean);
  const slaResolution = env('JIRA_FIELD_SLA_RESOLUTION');
  const slaFirstResponse = env('JIRA_FIELD_SLA_FIRST_RESPONSE');
  const missing = [
    !/^https:\/\/[^/\s]+$/.test(site) && 'JIRA_SITE',
    !projects.length && 'JIRA_PROJECTS',
    !slaResolution && 'JIRA_FIELD_SLA_RESOLUTION',
    !slaFirstResponse && 'JIRA_FIELD_SLA_FIRST_RESPONSE',
  ].filter(Boolean);
  if (missing.length) throw new HttpError(500, 'Server not configured: set ' + missing.join(', '));
  if (projects.some(p => !/^[A-Z][A-Z0-9_]+$/.test(p))) throw new HttpError(500, 'JIRA_PROJECTS must be project keys');
  return {
    site,
    projects,
    slaResolution,
    slaFirstResponse,
    requestType: env('JIRA_FIELD_REQUEST_TYPE') || null,
    statsBudgetMs: Number(env('STATS_BUDGET_MS') || 4000),
  };
}

// ---------- talking to Jira ----------

async function jiraGet(cfg, auth, path, params) {
  let res;
  try {
    res = await fetch(cfg.site + path + (params ? '?' + new URLSearchParams(params) : ''), {
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(502, 'Jira did not answer');
  }
  if (res.status === 401 || res.status === 403) throw new HttpError(401, 'Jira rejected the sign-in');
  if (!res.ok) throw new HttpError(502, `Jira responded ${res.status}`);
  return res.json();
}

const whoAmI = (cfg, auth) => jiraGet(cfg, auth, '/rest/api/3/myself');

// One page of a JQL search: { issues, cursor } (cursor is null on the last page).
async function searchPage(cfg, auth, jql, fields, cursor) {
  const params = { jql, fields, maxResults: '100' };
  if (cursor) params.nextPageToken = cursor;
  const data = await jiraGet(cfg, auth, '/rest/api/3/search/jql', params);
  return { issues: data.issues || [], cursor: data.isLast ? null : data.nextPageToken || null };
}

// ---------- reducing issues to compact records ----------

// Live board: where the SLA clock stands right now.
function slaCycle(field) {
  if (!field || typeof field !== 'object') return null;
  const ongoing = field.ongoingCycle;
  const completed = field.completedCycles || [];
  if (ongoing) {
    return {
      state: 'ongoing',
      breachAt: ongoing.breachTime ? ongoing.breachTime.epochMillis : null,
      breached: !!ongoing.breached,
      paused: !!ongoing.paused,
      goalFriendly: ongoing.goalDuration ? ongoing.goalDuration.friendly : null,
    };
  }
  if (completed.length) {
    const last = completed[completed.length - 1];
    return { state: 'done', breached: !!last.breached };
  }
  return null;
}

// All-time stats: same definitions as Jira's SLA JQL functions, so the
// drill-down lists match the counts: missed = everBreached(), met =
// completed() and never breached.
function slaOutcome(field) {
  if (!field || typeof field !== 'object') return null;
  const cycles = field.completedCycles || [];
  const ongoing = field.ongoingCycle;
  if (cycles.some(c => c.breached) || (ongoing && ongoing.breached)) return 'missed';
  if (cycles.length) return 'met';
  return null;
}

// One open ticket on the live board.
function reduceIssue(cfg, issue) {
  const f = issue.fields || {};
  return {
    key: issue.key,
    url: `${cfg.site}/browse/${issue.key}`,
    client: f.project?.key ?? null,
    summary: f.summary,
    status: f.status?.name ?? null,
    statusCategory: f.status?.statusCategory?.key ?? null,
    type: f.issuetype?.name ?? null,
    requestType: (cfg.requestType && f[cfg.requestType]?.requestType?.name?.trim()) || null,
    priority: f.priority?.name ?? null,
    assignee: f.assignee?.displayName ?? null,
    assigneeId: f.assignee?.accountId ?? null, // for drill-down JQL links
    reporter: f.reporter?.displayName ?? null,
    created: f.created,
    updated: f.updated,
    sla: slaCycle(f[cfg.slaResolution]),
    firstResponse: slaCycle(f[cfg.slaFirstResponse]),
  };
}

// One ticket in the all-time stats (all issue types, matching what the Jira
// drill-down searches return).
function reduceStat(cfg, issue) {
  const f = issue.fields || {};
  return {
    key: issue.key,
    client: f.project?.key ?? null,
    summary: f.summary || null,
    status: f.status?.name ?? null,
    created: f.created ? Date.parse(f.created) : null,
    resolved: f.resolutiondate ? Date.parse(f.resolutiondate) : null,
    assignee: f.assignee?.displayName ?? null,
    assigneeId: f.assignee?.accountId ?? null,
    ttr: slaOutcome(f[cfg.slaResolution]),
    frt: slaOutcome(f[cfg.slaFirstResponse]),
  };
}

// ---------- the three requests ----------

async function live(cfg, auth, context) {
  const fields = [
    'summary', 'status', 'issuetype', 'priority', 'assignee', 'reporter', 'created', 'updated', 'project',
    cfg.slaResolution, cfg.slaFirstResponse, cfg.requestType,
  ].filter(Boolean).join(',');
  const jql = `project in (${cfg.projects.join(', ')}) AND ${OPEN} ORDER BY updated DESC`;
  const tickets = [];
  let cursor = null;
  for (let page = 0; page < LIVE_MAX_PAGES; page++) {
    const result = await searchPage(cfg, auth, jql, fields, cursor);
    for (const issue of result.issues) {
      if (!issue.fields?.issuetype?.subtask) tickets.push(reduceIssue(cfg, issue));
    }
    cursor = result.cursor;
    if (!cursor) break;
  }
  // Jira answers a search that carries a bad token as an anonymous visitor:
  // 200 and no issues. Ask who we are, so that shows up as a rejected sign-in.
  if (!tickets.length) await whoAmI(cfg, auth);
  return { site: cfg.site, generatedAt: Date.now(), build: context?.deploy?.id ?? null, tickets };
}

async function stats(cfg, auth, query) {
  const project = query.get('project');
  if (!cfg.projects.includes(project)) throw new HttpError(400, 'Unknown project');
  let where = `project = ${project}`;
  if (query.has('changed')) {
    // Open tickets are always included: an SLA can breach without the ticket
    // being touched, so "updated" alone would miss it.
    const minutes = Number(query.get('changed'));
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 500000) throw new HttpError(400, 'Bad "changed"');
    where += ` AND (updated >= -${minutes}m OR ${OPEN})`;
  }
  const jql = `${where} ORDER BY created ASC`;
  const fields = ['project', 'summary', 'status', 'created', 'resolutiondate', 'assignee',
    cfg.slaResolution, cfg.slaFirstResponse].join(',');

  const started = Date.now();
  const tickets = [];
  let cursor = query.get('cursor') || null;
  do {
    const result = await searchPage(cfg, auth, jql, fields, cursor);
    for (const issue of result.issues) tickets.push(reduceStat(cfg, issue));
    cursor = result.cursor;
    // A function call must finish well inside Netlify's 10 s limit, so a stats
    // call stops starting new pages after the budget and hands back a cursor.
  } while (cursor && Date.now() - started < cfg.statsBudgetMs);
  return { tickets, cursor };
}

// ---------- the function ----------

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export default async function handler(req, context) {
  try {
    const url = new URL(req.url);
    const route = url.pathname.replace(/\/+$/, '');
    if (req.method !== 'GET') throw new HttpError(405, 'GET only');
    const cfg = settings();
    const signIn = req.headers.get('x-jira-auth') || '';
    if (!/^[A-Za-z0-9+/=]+$/.test(signIn)) throw new HttpError(401, 'Sign in first');
    const auth = 'Basic ' + signIn;

    if (route === '/api/me') return json(200, { ok: true, name: (await whoAmI(cfg, auth)).displayName ?? null });
    if (route === '/api/live') return json(200, await live(cfg, auth, context));
    if (route === '/api/stats') return json(200, await stats(cfg, auth, url.searchParams));
    throw new HttpError(404, 'Not found');
  } catch (err) {
    // Never echo Jira's answer or the request back: only our own short messages.
    if (err instanceof HttpError) return json(err.status, { error: err.message });
    return json(500, { error: 'Something went wrong' });
  }
}

export const config = { path: '/api/*' };
