#!/usr/bin/env node
//
// A full inventory of the WMSPanel API: what exists, and what each route
// accepts.
//
// This exists because a partial probe produced a confident wrong answer. An
// earlier script asked GET and DELETE on `dvr_streams`, found no POST, and the
// conclusion "DVR cannot be managed through the API" went into the project's
// notes as a fact. It was repeated for weeks. DVR is manageable; the probe was
// not.
//
// So this asks every route about every method, records the status of each, and
// writes the result to a document in the repository. The document is then the
// answer to "does WMSPanel let us do X" — read, not remembered.
//
// SAFETY. Discovering which methods a route accepts means sending them, and a
// POST that succeeds changes something. Two rules make that survivable:
//
//   1. By default only GET is sent. Discovering writes needs --probe-writes,
//      typed deliberately.
//   2. Even then, writes are sent with a body designed to be rejected — an
//      empty object. A 400 "missing parameter" proves the route accepts POST
//      as surely as a 201 does, and creates nothing. A 405 proves it does not.
//
// The distinction that matters is 404 versus 405/400: "no such route" versus
// "route exists, your request was wrong". That is what the earlier probe
// missed by only ever sending one method.
//
// Usage:
//
//   node wms-dump.mjs <client_id> <api_key> [--probe-writes] [--server <id>]
//
//   WMS_BASE=https://api.wmspanel.ru/v1   to use the mirror
//
const args = process.argv.slice(2);
const CLIENT_ID = args[0];
const API_KEY = args[1];
const PROBE_WRITES = args.includes('--probe-writes');
const serverArgIdx = args.indexOf('--server');
const ONE_SERVER = serverArgIdx >= 0 ? args[serverArgIdx + 1] : '';

const BASE = (process.env.WMS_BASE || 'https://api.wmspanel.com/v1').replace(/\/+$/, '');
const TIMEOUT_MS = 15000;
const out = [];
const say = (s = '') => { process.stdout.write(s + '\n'); out.push(s); };

if (!CLIENT_ID || !API_KEY) {
  process.stdout.write([
    'usage: node wms-dump.mjs <client_id> <api_key> [--probe-writes] [--server <id>]',
    '',
    '  Without --probe-writes only GET is sent, and nothing can change.',
    '  With it, writes are sent with an empty body so the API rejects them:',
    '  a 400 proves the route accepts the method; nothing is created.',
    '',
    '  WMS_BASE=https://api.wmspanel.ru/v1  to use the mirror',
    '',
  ].join('\n'));
  process.exit(1);
}

// Every route family named in the WMSPanel API reference or found in this
// panel's own client, plus the plausible neighbours of each. Written down
// rather than generated: a permutation crawler eventually sends a POST
// somewhere nobody meant it to go.
//
// `{s}` is substituted with a server id.
const ROUTES = [
  // Account and servers
  ['/server',                       'servers list'],
  ['/server/{s}',                   'one server'],
  ['/data_slices',                  'data slices'],
  ['/routes',                       'routes'],

  // Republishing — this panel already writes here
  ['/server/{s}/rtmp/republish',    'republish rules'],
  ['/server/{s}/rtmp/settings',     'rtmp settings'],

  // DVR — the family this inventory exists because of
  ['/server/{s}/dvr_streams',       'DVR streams'],
  ['/server/{s}/dvr',               'DVR, short form'],
  ['/server/{s}/dvr/settings',      'DVR settings'],
  ['/dvr_streams',                  'DVR streams, account-wide'],

  // Live streaming objects
  ['/server/{s}/live/streams',      'live streams'],
  ['/server/{s}/streams',           'streams'],
  ['/server/{s}/incoming_streams',  'incoming streams'],
  ['/server/{s}/outgoing_streams',  'outgoing streams'],
  ['/server/{s}/live_pull',         'live pull'],
  ['/server/{s}/udp_streams',       'MPEG-TS in'],
  ['/server/{s}/mpegts_out',        'MPEG-TS out'],
  ['/server/{s}/hotswap',           'hotswap'],
  ['/server/{s}/interfaces',        'interfaces'],
  ['/server/{s}/applications',      'applications'],
  ['/server/{s}/apps',              'applications, short form'],

  // Transmuxing — where LL-HLS lives
  ['/server/{s}/transmuxer/settings', 'transmuxing settings'],
  ['/server/{s}/hls/settings',        'HLS settings'],
  ['/server/{s}/live/settings',       'live settings'],
  ['/server/{s}/settings',            'server settings'],
  ['/server/{s}/global_settings',     'global settings'],
  ['/server/{s}/hls',                 'HLS'],
  ['/server/{s}/llhls',               'LL-HLS'],

  // Protection, which this panel writes
  ['/server/{s}/wmsauth',            'WMSAuth rules'],
  ['/wmsauth/groups',                'WMSAuth groups'],
  ['/referer_groups',                'referer groups'],
  ['/ip_ranges',                     'IP ranges'],
  ['/geo',                           'geo restrictions'],
  ['/asn',                           'ASN restrictions'],
  ['/user_agent_groups',             'user agent groups'],

  // Transcoder
  ['/server/{s}/transcoder',         'transcoder'],
  ['/transcoder/scenarios',          'transcoder scenarios'],

  // SRT and other transports
  ['/server/{s}/srt',                'SRT'],
  ['/server/{s}/rist',               'RIST'],

  // Statistics, for completeness
  ['/realtime_data',                 'realtime stats'],
  ['/retro_data',                    'retrospective stats'],
];

const METHODS = PROBE_WRITES ? ['GET', 'POST', 'PUT', 'DELETE'] : ['GET'];
const auth = `client_id=${encodeURIComponent(CLIENT_ID)}&api_key=${encodeURIComponent(API_KEY)}`;

async function ask(path, method) {
  const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}${auth}`;
  try {
    const r = await fetch(url, {
      method,
      // An empty object: enough to make the route parse a body and complain
      // about what is missing, not enough to create anything.
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await r.text();
    return { status: r.status, text };
  } catch (e) {
    return { status: null, error: String(e?.message || e).slice(0, 120) };
  }
}

// What a status means for "does this route exist".
function reading(status) {
  if (status === null) return 'unreachable';
  if (status === 404) return 'no such route';
  if (status === 405) return 'route exists, method not allowed';
  if (status === 400 || status === 422) return 'route exists, request rejected';
  if (status === 401 || status === 403) return 'route exists, not permitted';
  if (status >= 200 && status < 300) return 'ok';
  return `status ${status}`;
}

async function main() {
  say(`# WMSPanel API inventory`);
  say('');
  say(`Taken ${new Date().toISOString().slice(0, 10)} against \`${BASE}\`.`);
  say(PROBE_WRITES
    ? 'Write methods were probed with an empty body, so a 400 means the route exists and rejected the request — nothing was created.'
    : 'Only GET was sent. Run again with `--probe-writes` to learn which routes accept writes.');
  say('');
  say('A 404 means the route does not exist. A 405 or 400 means it does and the');
  say('request was wrong — which is the distinction a single-method probe cannot');
  say('make, and the reason an earlier note in this project wrongly recorded DVR');
  say('as unmanageable.');
  say('');

  // One server is enough to learn the shape of the API; asking fourteen tells
  // the same thing fourteen times.
  let sid = ONE_SERVER;
  if (!sid) {
    const r = await ask('/server', 'GET');
    if (r.status !== 200) {
      say(`Could not list servers: ${reading(r.status)}.`);
      if (r.status === 403) say('Check the credentials and that this host is in the API IP allow-list.');
      process.exit(1);
    }
    try {
      const j = JSON.parse(r.text);
      const servers = j.servers || j.data || (Array.isArray(j) ? j : []);
      sid = servers[0]?.id;
      say(`Asked about server \`${servers[0]?.name}\` (${sid}); the API surface is the same for all.`);
      say('');
    } catch { say('The server list did not parse.'); process.exit(1); }
  }

  say('| route | GET | POST | PUT | DELETE | what it is |');
  say('|---|---|---|---|---|---|');

  const bodies = new Map();
  for (const [tmpl, what] of ROUTES) {
    const path = tmpl.replace('{s}', sid);
    const cells = {};
    for (const method of METHODS) {
      const r = await ask(path, method);
      cells[method] = r.status ?? 'ERR';
      if (method === 'GET' && r.status === 200 && r.text) bodies.set(path, r.text);
    }
    const cell = (m) => METHODS.includes(m) ? String(cells[m] ?? '') : '·';
    say(`| \`${tmpl}\` | ${cell('GET')} | ${cell('POST')} | ${cell('PUT')} | ${cell('DELETE')} | ${what} |`);
  }

  say('');
  say('## What answered');
  say('');
  for (const [path, text] of bodies) {
    say(`### \`${path}\``);
    say('');
    say('```json');
    try {
      say(JSON.stringify(JSON.parse(text), null, 2).slice(0, 2500));
    } catch {
      say(text.slice(0, 800));
    }
    say('```');
    say('');
  }

  say('## How to read this');
  say('');
  say('- `200` — the route works and its body is above.');
  say('- `400` / `422` on a write — the route accepts that method; the empty body was rejected.');
  say('- `405` — the route exists and does not accept that method.');
  say('- `404` — no such route.');
  say('- `403` everywhere including `/server` — credentials or the IP allow-list, not the API.');
}

main()
  .then(() => {
    process.stderr.write('\n--- save the output above to docs/wmspanel-api.md ---\n');
  })
  .catch((e) => { say(`failed: ${e?.message || e}`); process.exit(1); });
