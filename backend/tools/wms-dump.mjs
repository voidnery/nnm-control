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
// STANDALONE. This file is copied to a machine and run there. It imports
// nothing, needs no install, and writes its report next to itself — it must
// not assume a repository around it, because the machine it runs on does not
// have one. An earlier version told the operator to redirect output into
// `../docs/`, a path that exists only in a clone; the shell answered "No such
// file or directory" and the run was lost.
//
// Usage:
//
//   node wms-dump.mjs <client_id> <api_key> [--probe-writes] [--server <id>]
//
//   WMS_BASE=https://api.wmspanel.ru/v1   to use the mirror
//
// It writes wmspanel-api-<date>.md beside itself and says where. Copy that
// file into the repository as docs/wmspanel-api.md.
//
// Node's own modules only — present everywhere Node is, nothing to install.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const CLIENT_ID = args[0];
const API_KEY = args[1];
const PROBE_WRITES = args.includes('--probe-writes');
const serverArgIdx = args.indexOf('--server');
const ONE_SERVER = serverArgIdx >= 0 ? args[serverArgIdx + 1] : '';

const BASE = (process.env.WMS_BASE || 'https://api.wmspanel.com/v1').replace(/\/+$/, '');
// Beside this file, whatever directory it was run from. `process.cwd()` would
// put the report wherever the operator happened to be standing.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT = path.join(HERE, `wmspanel-api-${new Date().toISOString().slice(0, 10)}.md`);
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
// Derived from Softvelum's own reference, not guessed.
//
// The first version of this list was invented, and it produced a confident
// wrong answer: it tried `/settings` and never `/global`, so an entire family
// read as absent. The documented pattern is
//
//     /server/<id>/<protocol>/<object>
//
// where <object> is `global`, `applications`, `interfaces`, `live_pull` and so
// on — the RTSP control API article names exactly those, and `rtmp/republish`
// and `dvr` from this panel's own client fit the same shape.
//
// Sources, so the next person can check rather than trust:
//   wmspanel.com/api_info                       — stats, WMSAuth, Dispersa
//   blog.wmspanel.com/2015/06/rtsp-streaming-control-api.html
//   blog.wmspanel.com/2015/11/dvr-control-api-in-wmspanel.html
//   blog.wmspanel.com/2020/11/nimble-live-transcoder-api.html
//
// `{s}` is substituted with a server id.

// The per-protocol control families, crossed with the objects each may carry.
// Written as a product because the documentation states the pattern; every
// combination is still a named path, not a crawl.
const PROTOCOLS = ['rtmp', 'rtsp', 'mpegts', 'srt', 'rist', 'hls', 'dash',
                   'icecast', 'sldp', 'live', 'transmuxer', 'udp', 'ndi', 'whep'];
// Object names, widened.
//
// `live_pull` answered for rtmp, rtsp and icecast, so the pattern is right —
// but `global`, `applications` and `interfaces` all 404 even for RTSP, whose
// control API article names exactly those methods. The pattern is confirmed
// and the spelling is not, so the list carries every plausible form rather
// than the three I happened to try. Softvelum's own reference for this section
// could not be retrieved, and guessing narrowly is what produced the last
// wrong answer.
const OBJECTS = [
  'global', 'settings', 'global_settings', 'defaults',
  // `app` is the one that answers, and it was the one missing. The list had
  // the plural, the long form and the joined form — every shape but the
  // singular, which is the same letter that hid `interface` behind
  // "interfaces list". Singular forms come first now, on purpose.
  'app', 'apps', 'application', 'applications',
  'interface', 'interfaces',
  'live_pull', 'pull', 'republish', 'outgoing', 'incoming', 'streams',
];

const ROUTES = [
  // Account level, from the published reference.
  ['/server',                       'servers list — the control probe'],
  ['/server/{s}',                   'one server'],
  ['/streams',                      'streams (deep stats)'],
  ['/users',                        'users'],
  ['/data_slices',                  'data slices'],
  ['/routes',                       'routes'],
  ['/ip_ranges',                    'IP ranges'],
  ['/user_agent_groups',            'user agent groups'],
  ['/referer_groups',               'referer groups'],
  ['/wmsauth/groups',               'WMSAuth groups'],
  ['/dispersa/streams',             'Dispersa monitoring'],
  ['/push_settings',                'push API settings, global'],
  ['/transcoder_licenses',          'Transcoder licenses'],
  ['/addenda_licenses',             'Addenda licenses'],

  // Server level, named in the reference or already used by this panel.
  // Live applications. Published in docs/wmspanel-api-application.md, and in
  // this panel's own client since long before the probe went looking for it.
  ['/server/{s}/live/app',          'live applications — CRUD, carries alhls_enabled'],
  ['/server/{s}/rtmp/republish',    'republish rules'],
  ['/server/{s}/dvr',               'DVR settings'],
  ['/server/{s}/dvr/settings',      'DVR settings, nested'],
  ['/server/{s}/hotswap',           'hotswap'],
  ['/server/{s}/push_settings',     'push API settings, per server'],
  ['/server/{s}/transcoder/scenarios', 'transcoder scenarios'],
  ['/server/{s}/wmsauth',           'WMSAuth on this server'],

  // The pattern, applied.
  //
  // Eight spellings guessed from the section anchor `sb_nimble_liveapps` used
  // to sit here. They are gone because the section itself has since been read:
  // the route is `/server/{s}/live/app`, named above and published in
  // docs/wmspanel-api-application.md. Guesses are deleted once the answer
  // exists — keeping them would leave four hundred requests a run buying
  // nothing, and would suggest the question is still open.
  ...PROTOCOLS.flatMap(proto =>
    OBJECTS.map(obj => [`/server/{s}/${proto}/${obj}`, `${proto} ${obj}`])),
];


// DELETE is not in this list and must not be: see the item-path section.
const METHODS = PROBE_WRITES ? ['GET', 'POST', 'PUT'] : ['GET'];
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
      // Thrown, not exited: `process.exit` here skipped the report entirely,
      // so a run that failed at the first request left nothing behind — not
      // even the record of why.
      throw new Error('could not list servers');
    }
    try {
      const j = JSON.parse(r.text);
      const servers = j.servers || j.data || (Array.isArray(j) ? j : []);
      sid = servers[0]?.id;
      say(`Asked about server \`${servers[0]?.name}\` (${sid}); the API surface is the same for all.`);
      say('');
    } catch { say('The server list did not parse.'); throw new Error('unparseable server list'); }
  }

  // The account has a documented ceiling of 15000 calls a day. Said before the
  // run rather than discovered by exhausting it — a reconnaissance tool that
  // uses up somebody's quota without warning is one they cannot afford to run
  // twice.
  const planned = ROUTES.length * METHODS.length;
  say(`${ROUTES.length} routes × ${METHODS.length} method(s) = ${planned} calls.`);
  say('The account limit is 15000 per day, reset at 0:00 UTC.');
  say('');

  say('| route | GET | POST | PUT | DELETE | what it is |');
  say('|---|---|---|---|---|---|');

  // Anything that looks like an id in a collection response, so PUT and DELETE
  // can be asked where they actually live.
  //
  // The documented shape is `PUT /ip_ranges/[id]`, `DELETE
  // /user_agent_groups/[id]` — item paths. The previous run asked PUT and
  // DELETE on the *collections* and recorded 404 for almost all of them, which
  // means nothing at all: a collection is supposed to refuse them. Every
  // write column in that report was noise.
  const firstId = (text) => {
    try {
      const j = JSON.parse(text);
      for (const v of Object.values(j)) {
        if (Array.isArray(v) && v[0]?.id) return String(v[0].id);
        if (v && typeof v === 'object' && v.id) return String(v.id);
      }
    } catch { /* not JSON */ }
    return null;
  };

  const bodies = new Map();
  const itemRows = [];
  for (const [tmpl, what] of ROUTES) {
    const path = tmpl.replace('{s}', sid);
    const cells = {};
    let id = null;
    for (const method of METHODS) {
      // On a collection, ask only what a collection can answer. PUT and DELETE
      // are asked below, on an item.
      if ((method === 'PUT' || method === 'DELETE')) { cells[method] = '·'; continue; }
      const r = await ask(path, method);
      cells[method] = r.status ?? 'ERR';
      if (method === 'GET' && r.status === 200 && r.text) {
        bodies.set(path, r.text);
        id = firstId(r.text);
      }
    }
    say(`| \`${tmpl}\` | ${cells.GET ?? ''} | ${cells.POST ?? '·'} | · | · | ${what} |`);

    // An item to ask the write methods of. Only when the collection gave one:
    // inventing an id would produce a 404 that says nothing.
    if (id && PROBE_WRITES) {
      const itemPath = `${path}/${encodeURIComponent(id)}`;
      // PUT with an empty body: the API rejects it, and a 400 proves the
      // method is accepted as surely as a 200 would.
      const put = await ask(itemPath, 'PUT');
      const get = await ask(itemPath, 'GET');

      // DELETE is never sent.
      //
      // There is no body that makes a DELETE harmless. Against a real id it
      // either fails or removes somebody's WMSAuth group — and a
      // reconnaissance script that deletes things is one nobody may run. Read
      // from the documentation instead: every family here that accepts POST
      // and PUT documents a DELETE beside them.
      itemRows.push(`| \`${tmpl}/{id}\` | ${get.status ?? 'ERR'} | · | ${put.status ?? 'ERR'} | not asked | one ${what} |`);
    }
  }

  if (itemRows.length) {
    say('');
    say('### Item paths');
    say('');
    say('Where a collection returned an id, the write methods were asked of the');
    say('item — which is where the documentation puts them.');
    say('');
    say('**DELETE is never sent.** No body makes it harmless: against a real id it');
    say('either fails or removes something real. Where PUT is accepted, the');
    say("documentation lists a DELETE beside it — read that rather than test it.");
    say('');
    say('| route | GET | POST | PUT | DELETE | what it is |');
    say('|---|---|---|---|---|---|');
    for (const row of itemRows) say(row);
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

// Written whichever way the run ended. A crawl that dies halfway has still
// learned something about every route it reached, and losing that because of
// the last one would mean running the whole thing again.
function writeReport() {
  try {
    writeFileSync(REPORT, out.join('\n') + '\n');
    process.stderr.write(`\nwritten: ${REPORT}\n`);
    process.stderr.write('Copy it into the repository as docs/wmspanel-api.md\n');
  } catch (e) {
    process.stderr.write(`\ncould not write ${REPORT}: ${e?.message || e}\n`);
    process.stderr.write('The report is above; save it by hand.\n');
  }
}

main()
  .then(writeReport)
  .catch((e) => {
    say('');
    say(`failed: ${e?.message || e}`);
    writeReport();
    process.exit(1);
  });
