#!/usr/bin/env node
//
// NNM Control — stats pipeline check, standalone.
//
// One file, no dependencies, nothing to install. It talks to the panel over
// the same HTTP API the browser uses, so it does not need to run inside any
// container, does not need the database, and does not care what the compose
// services are called.
//
// That last point is the reason it exists: the previous version lived in the
// API image and the instructions for running it were wrong twice over — the
// image did not carry it, and then the service was not named `api`. A
// diagnostic that is hard to launch is a diagnostic nobody runs.
//
//   node nnm-diag.mjs --url https://panel.example --user superadmin --pass '…'
//   node nnm-diag.mjs --url … --user … --pass … --server 6a1805ad73856944212d0793
//
// With no --server it lists them and stops. Reads only; nothing is changed.
// Addresses are reduced before printing.

const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const URL_ = (opt('url') || process.env.NNM_URL || '').replace(/\/+$/, '');
const USER = opt('user') || process.env.NNM_USER;
const PASS = opt('pass') || process.env.NNM_PASS;
const SERVER = opt('server');

if (!URL_ || !USER || !PASS) {
  console.error('usage: node nnm-diag.mjs --url https://panel --user NAME --pass SECRET [--server ID]');
  console.error('       (or set NNM_URL / NNM_USER / NNM_PASS)');
  process.exit(2);
}

const mask = (v) => String(v ?? '').replace(/(\d+\.\d+\.\d+)\.\d+/g, '$1.x');
const pad = (s, n) => String(s).padEnd(n);
const line = (label, text) => console.log(`  ${pad(label, 30)} ${text}`);

let token = null;
async function api(path) {
  const res = await fetch(`${URL_}/api${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// ── sign in ──────────────────────────────────────────────────────────────────
{
  const res = await fetch(`${URL_}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    // A panel with 2FA on this account cannot be used this way, and saying so
    // beats an opaque 401.
    console.error(`login failed (HTTP ${res.status}): ${JSON.stringify(data).slice(0, 200)}`);
    console.error('if this account has two-factor enabled, use one without it for diagnostics');
    process.exit(1);
  }
  token = data.token;
}

// ── which server ─────────────────────────────────────────────────────────────
const servers = await api('/servers');
if (!SERVER) {
  console.log('\nservers on this panel:\n');
  for (const s of servers) console.log(`  ${s.id || s._id}  ${pad(s.name, 28)} ${mask(s.host)}`);
  console.log('\nre-run with --server <id>\n');
  process.exit(0);
}
const server = servers.find(s => String(s.id || s._id) === SERVER);
if (!server) { console.error(`no server with id ${SERVER}`); process.exit(1); }

console.log(`\n${server.name} — ${mask(server.host)}\n`);

// ── 1. collection settings and the transport ────────────────────────────────
console.log('1. SETTINGS AND TRANSPORT');
const settings = await api('/settings').catch(() => null);
if (settings) {
  line('stats.enabled', settings.stats?.enabled ? 'on' : 'OFF — nothing is recorded for anything');
  line('stats.groups.srt', settings.stats?.groups?.srt !== false ? 'on' : 'OFF');
  line('interval', `${settings.stats?.intervalSec ?? 10}s`);
} else {
  line('settings', 'not readable with this account (needs settings.manage)');
}
const fleet = await api('/agent-fleet/overview').catch(() => null);
const mine = fleet?.servers?.find(s => s.id === SERVER);
line('agent', mine ? `v${mine.version || '?'}, ${mine.code}, seen ${Math.round((mine.sinceContactMs || 0) / 1000)}s ago` : 'unknown');
// The same rule the panel uses, not a proxy for it. Reading the diagnosis
// code instead reported "a direct call" for an agent that was serving every
// read perfectly well — the panel routes on freshness of contact, and a
// diagnosis is a different question.
const agentFresh = Boolean(mine && mine.enabled !== false && (mine.sinceContactMs ?? Infinity) < 90_000);
line('reads go via', agentFresh
  ? 'the agent (loopback on the server)'
  : 'a direct call, if the panel can route there');
if (mine && mine.code && mine.code !== 'healthy' && agentFresh) {
  // Worth saying, and worth not confusing with the transport.
  line('agent diagnosis', `${mine.code} — reads still go through it`);
}

// ── 2-3. what the join sees right now ───────────────────────────────────────
console.log('\n2. LIVE READINGS (what the panel gets from Nimble now)');
const live = {};
for (const kind of ['incoming', 'udp']) {
  try {
    const d = await api(`/nimble/${SERVER}/live-objects/${kind}`);
    live[kind] = d;
    if (d.available === false) { line(kind, `unavailable: ${d.reason}`); continue; }
    line(kind, `${d.entries} sockets · ${d.objects} objects · ${d.matched} matched (by ${d.strategy || '—'})`);
    const withRate = Object.values(d.live || {}).filter(v => v && v.bps > 0).length;
    line('', `${withRate} of the matched are carrying data`);
  } catch (e) {
    line(kind, `FAILED: ${e.message.slice(0, 140)}`);
  }
}

// ── 4. what is stored ───────────────────────────────────────────────────────
console.log('\n3. WHAT IS STORED');
const subjects = await api(`/stats/${SERVER}/subjects`).catch(() => ({ subjects: [] }));
const srt = (subjects.subjects || []).filter(s => s.group === 'srt');
line('srt subjects (last 15m)', String(srt.length));
const rich = srt.filter(s => (s.metrics || []).length > 1);
// "73 — the rest are disconnected" when 73 of 73 have data reads as though
// something is still wrong. The remainder is named only when there is one.
line('with more than retryCount', rich.length === srt.length
  ? `${rich.length} — all of them`
  : `${rich.length}; the other ${srt.length - rich.length} are disconnected sockets, which carry nothing else`);
if (rich.length) line('example', `${rich[0].label || rich[0].subject} → ${rich[0].metrics.length} metrics`);

// ── 5. do the live sockets and the stored subjects agree? ───────────────────
//
// The link that has broken most often: two answers to "which stream is this",
// in two id spaces. A socket that is live now with no series behind it means
// the collector and the reader are not speaking about the same thing.
console.log('\n4. LIVE SOCKETS vs STORED SERIES');
const storedSubjects = new Set(srt.map(s => s.subject));
let checked = 0;
let missing = [];
for (const d of Object.values(live)) {
  for (const [objId, v] of Object.entries(d?.live || {})) {
    if (!v?.subject) continue;
    checked++;
    if (!storedSubjects.has(v.subject)) missing.push(`${v.subject}${v.bps > 0 ? ' (carrying data)' : ''}`);
  }
}
line('live sockets with a subject', String(checked));
line('of those, none stored', String(missing.length));
if (missing.length) {
  for (const m of missing.slice(0, 5)) line('', m);
  line('VERDICT', 'the collector is not recording sockets the reader can see — link 3 or 4');
}

// ── 6. one carrying socket, end to end ──────────────────────────────────────
console.log('\n5. A CARRYING SOCKET, END TO END');
// A socket carrying MEDIA, not merely bytes. An idle SRT socket still costs a
// few tens of kbit/s in handshake traffic, and picking one of those meant
// following a stream that has nothing to draw and then reporting on it as
// though it did. Same threshold the panel uses.
const NO_MEDIA_BPS = 200_000;
let subject = null;
for (const d of Object.values(live)) {
  for (const v of Object.values(d?.live || {})) {
    if (v?.subject && v.bps > NO_MEDIA_BPS) { subject = v.subject; break; }
  }
  if (subject) break;
}
if (!subject) {
  line('', 'no matched socket is carrying data right now — nothing to follow through');
} else {
  line('subject', subject);

  // The metric names are not hardcoded here. They were once — with dots, from
  // before the collector had to stop using them — and the tool then reported
  // "no rate in any point" against a panel that was storing rates perfectly
  // well. A diagnostic that can be wrong about the thing it is diagnosing is
  // worse than none, so it asks what this subject actually holds.
  const held = (srt.find(x => x.subject === subject)?.metrics) || [];
  const rateKeys = held.filter(k => /rate|bitrate|bandwidth/i.test(k) && !/max/i.test(k));
  line('metrics on record', held.length ? `${held.length} — ${held.slice(0, 4).join(', ')}${held.length > 4 ? ' …' : ''}` : 'none');
  if (held.length && !rateKeys.length) {
    line('note', 'none of them looks like a rate — the shape Nimble returns may have changed');
  }

  // No fallback to "whatever is there". Counting points where retryCount is
  // present and calling the result "with a rate" is how this tool reported
  // "end to end is intact" about a socket that had no rate at all.
  const wanted = rateKeys.slice(0, 4);
  const series = wanted.length
    ? await api(`/stats/${SERVER}/series?subject=${encodeURIComponent(subject)}` +
        `&metrics=${wanted.join(',')}&minutes=15`).catch(e => ({ error: e.message }))
    : null;
  if (!series) {
    line('VERDICT', 'this subject holds no rate metric at all — the socket is up but carries no media, '
      + 'or the shape Nimble returns for it changed');
  } else if (series.error) { line('series', `FAILED: ${series.error.slice(0, 140)}`); }
  else {
    const pts = series.points || [];
    const withRate = pts.filter(p => p.v.some(x => x != null)).length;
    line('points in 15m', String(pts.length));
    line('of those, with a rate', String(withRate));
    line('VERDICT', pts.length === 0
      ? 'live now and nothing stored — the collector is not seeing what the reader sees'
      : withRate === 0
        ? `stored, but ${wanted.join('/')} is null in every point — the shape Nimble returns changed`
        : 'end to end is intact');
  }
}

// ── playlists ────────────────────────────────────────────────────────────────
//
// Added because "the panel cannot see the playlist" has at least four causes
// and they look alike from a screen: the agent is not answering, it is looking
// in the wrong directory, the file is not there, or it is there and will not
// parse.
console.log('\n6. PLAYLIST');
try {
  const st = await api(`/servers/${SERVER}/agent/playlist-state`);
  line('file', st.name);
  line('agent looked in', st.confDir || '— not reported (agent older than v16) —');
  if (st.exists === null) {
    line('VERDICT', `the agent could not answer: ${st.error}`);
  } else if (st.exists === false) {
    line('VERDICT', 'the agent looked and the file is not there — check the directory above');
  } else if (!st.parsed?.ok) {
    line('parsed', `no — ${st.parsed?.reason}`);
    line('VERDICT', 'the file is there and could not be read as a Nimble playlist');
  } else {
    const entries = st.parsed.tasks.reduce((a, t) => a + t.count, 0);
    line('tasks', String(st.parsed.tasks.length));
    line('entries', `${entries} (${st.parsed.sources.length} distinct files)`);
    for (const t of st.parsed.tasks.slice(0, 5)) line('', `${t.stream} — ${t.count} entries`);
    line('sources missing', String(st.media?.missing?.length ?? '— not checked —'));
    line('VERDICT', 'the panel can see the playlist');
  }
} catch (e) {
  line('VERDICT', `the request itself failed: ${e.message.slice(0, 140)}`);
}

console.log('');
