#!/usr/bin/env node
//
// What do the live applications on these machines actually look like?
//
// LL-HLS has two halves. This one is a WMSPanel object: the container, the
// "Enable Apple's Low-Latency HLS" checkbox and the part duration all live on
// a live application, and they are written with
// `PUT /server/<id>/live/app/<app_id>`.
//
// The route is published — docs/wmspanel-api-application.md holds the section
// verbatim — so this script is not looking for it. It is asking a different
// question: **what does this deployment return?** The published example is one
// server, on one version, at one date. A form built from it would be a form
// built from somebody else's machine.
//
// Three things are wanted, and each one changes what gets built:
//
//   1. `chunk_duration` per application. `hls_part_duration` may not exceed
//      half of it, and may not go under 500 ms, so a chunk under one second
//      leaves no legal part at all.
//   2. `protocols`. LL-HLS is only meaningful for HLS, HLS_MPEGTS and
//      HLS_FMP4, and HLS with HLS_MPEGTS is an illegal pair.
//   3. Whether `alhls_enabled` appears at all. If this WMSPanel is older than
//      the reference, the field may not exist here — and that is a fact about
//      the fleet, not about the documentation.
//
// STANDALONE: copied to a machine and run there. No dependencies, no database,
// no repository around it — see docs/recon-scripts.md.
//
// READ-ONLY: every request is a GET. There is no code path that sends POST,
// PUT or DELETE, and no flag that enables one. Testing a write is described at
// the end of the report as a manual procedure, on an application the operator
// creates for the purpose — never on one that belongs to a channel.
//
// Usage:
//
//     node wms-apps-recon.mjs <client_id> <api_key> [server_id ...]
//     node wms-apps-recon.mjs <client_id> <api_key> --full     # raw JSON too
//
// With no server ids it lists the servers and asks about all of them.
//
//     WMS_BASE=https://api.wmspanel.ru/v1   for the mirror
//
const argv = process.argv.slice(2);
const FULL = argv.includes('--full');
const [CLIENT_ID, API_KEY, ...SERVER_IDS] = argv.filter(a => !a.startsWith('--'));
const BASE = (process.env.WMS_BASE || 'https://api.wmspanel.com/v1').replace(/\/+$/, '');
const TIMEOUT_MS = 12000;

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Run only when run. The verdict logic below is imported by
// backend/tests/apps-recon.test.mjs, and an import that starts making requests
// — or exits because it found no credentials — is not importable.
const IS_MAIN = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT = path.join(HERE, `wms-apps-${new Date().toISOString().slice(0, 10)}.txt`);
const out = [];
const line = (s = '') => { process.stdout.write(s + '\n'); out.push(s); };

function writeReport() {
  try {
    writeFileSync(REPORT, out.join('\n') + '\n');
    process.stderr.write(`\nwritten: ${REPORT}\n`);
  } catch (e) {
    process.stderr.write(`\ncould not write ${REPORT}: ${e?.message || e}\n`);
  }
}

if (IS_MAIN && (!CLIENT_ID || !API_KEY)) {
  line('usage: node wms-apps-recon.mjs <client_id> <api_key> [server_id ...] [--full]');
  line('');
  line('  client_id / api_key — from WMSPanel, Settings → API');
  line('  server_id           — optional; without it every server is asked about');
  line('  --full              — include the sanitised JSON of every application');
  line('');
  line('  WMS_BASE=https://api.wmspanel.ru/v1   to use the mirror');
  line('');
  line('Read-only. Three GETs per server, plus one to list them.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Credentials in the payload
//
// A live application carries `push_login` and `push_password` in plain text,
// and this report is written to a file and pasted into chat. They are replaced
// before anything is printed — not hidden at print time, removed from the
// object, so no later addition to this script can leak them by accident.
// ---------------------------------------------------------------------------
const SECRET_FIELDS = ['push_login', 'push_password'];

export function sanitise(app) {
  const copy = { ...app };
  for (const f of SECRET_FIELDS) {
    if (f in copy) copy[f] = copy[f] ? `<set, ${String(copy[f]).length} chars>` : '<empty>';
  }
  return copy;
}

// The fields the published reference names, so the report can say which of
// them this deployment actually returns — and which it returns that the
// reference does not name, which is the more interesting direction.
// Source: docs/wmspanel-api-application.md, copied 2026-08-16.
const DOCUMENTED = [
  'id', 'application', 'chunk_duration', 'chunk_count', 'protocols',
  'push_login', 'push_password', 'empty_credentials', 'dash_template',
  'dvb_subs_to_webvtt', 'transcribe_audio_to_webvtt', 'generate_cea708_subtitles',
  'generate_webvtt_subtitles_from_cea708', 'cea708_mode', 'cea708_timeout',
  'cea708_style', 'cea708_row', 'cea708_underline',
  'ic_enabled', 'ic_min_delay_ms', 'ic_max_delay_ms', 'ic_max_queue_items',
  'gen_icecast_metadata', 'alhls_enabled', 'hls_part_duration',
  'mp4_thumbnails', 'mp4_thumbnails_interval', 'jpg_thumbnails',
  'jpg_thumbnails_interval', 'jpg_thumbnail_width', 'jpg_thumbnail_height',
  'tags',
];

const HLS_FAMILY = ['HLS', 'HLS_MPEGTS', 'HLS_FMP4'];

// Kept in step with backend/src/services/llhls.js, which is where these come
// from and where their sources are written down. This file cannot import it —
// it gets copied to machines with no repository around them — so
// backend/tests/llhls-rules.test.mjs fails if the two ever disagree.
export const PART_MIN_MS = 500;
export const partCeilingMs = (chunkSeconds) => {
  const c = Number(chunkSeconds);
  return Number.isFinite(c) && c > 0 ? Math.floor(c * 1000 / 2) : null;
};
export const holdBackMs = (partMs) => Number(partMs) * 3;

// ---------------------------------------------------------------------------
// The verdict for one application.
//
// Deliberately separate from the fetching, so it can be tested against
// fixtures without a network — see backend/tests/apps-recon.test.mjs.
// ---------------------------------------------------------------------------
export function assess(app) {
  const notes = [];
  const protocols = Array.isArray(app.protocols) ? app.protocols : [];
  const hls = protocols.filter(p => HLS_FAMILY.includes(p));
  const chunk = Number(app.chunk_duration);
  const ceiling = partCeilingMs(chunk);

  if (!hls.length) {
    notes.push(`no HLS protocol (${protocols.join(', ') || 'none'}) — LL-HLS does not apply`);
  }
  if (protocols.includes('HLS') && protocols.includes('HLS_MPEGTS')) {
    // The reference calls this pair illegal; if a server returns it, that is
    // worth seeing rather than smoothing over.
    notes.push('HLS and HLS_MPEGTS are both set, which the reference forbids');
  }
  if (ceiling === null) {
    notes.push('chunk_duration is missing or not a number — the part ceiling cannot be computed');
  } else if (ceiling < PART_MIN_MS) {
    notes.push(`chunk_duration ${chunk}s puts the part ceiling at ${ceiling} ms, below the ${PART_MIN_MS} ms floor — LL-HLS is impossible under a 1 s chunk`);
  }
  // The fleet is entirely on plain `HLS`, which the vendor describes as the
  // audio-optimised container. For video they recommend fMP4.
  if (hls.length && !hls.includes('HLS_FMP4')) {
    notes.push(`container is ${hls.join(', ')} — for video, Softvelum recommends adding HLS_FMP4`);
  }

  const hasField = 'alhls_enabled' in app;
  const enabled = app.alhls_enabled === true;
  const part = app.hls_part_duration;

  if (enabled && ceiling !== null && Number(part) > ceiling) {
    notes.push(`hls_part_duration ${part} ms exceeds the ceiling ${ceiling} ms — the server should have refused this`);
  }
  if (enabled && part == null) {
    notes.push('alhls_enabled is true but no hls_part_duration is returned');
  }
  // What this used to say — that a part over 1000 ms "is not low latency in
  // any useful sense" — fired on the vendor's own recommended setting of 2000
  // ms at a 6 s chunk. A check that complains about a correct configuration
  // gets replaced, not kept. The hold-back is reported instead, because it is
  // derived from Nimble's published playlists rather than from an opinion.
  if (enabled && Number.isFinite(Number(part))) {
    notes.push(`part ${part} ms → PART-HOLD-BACK ${holdBackMs(part) / 1000}s, which is the floor on what a viewer can see`);
  }

  let verdict;
  if (!hasField) verdict = 'field absent';
  else if (enabled) verdict = 'on';
  else if (!hls.length) verdict = 'n/a';
  else if (ceiling !== null && ceiling < PART_MIN_MS) verdict = 'blocked by chunk';
  else verdict = 'off, can be turned on';

  return { verdict, ceiling, hls, notes };
}

const auth = `client_id=${encodeURIComponent(CLIENT_ID)}&api_key=${encodeURIComponent(API_KEY)}`;
let calls = 0;

async function get(p) {
  calls++;
  const url = `${BASE}${p}${p.includes('?') ? '&' : '?'}${auth}`;
  const started = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: r.status, ms: Date.now() - started, text: await r.text() };
  } catch (e) {
    return { status: null, ms: Date.now() - started, error: String(e?.message || e).slice(0, 200) };
  }
}

const pad = (s, n) => String(s ?? '').padEnd(n);

async function main() {
  line(`WMSPanel: ${BASE}`);
  line(`Date: ${new Date().toISOString()}`);
  line('Every request is a GET. Nothing is written, and DELETE is never sent.');
  line('');

  let servers = SERVER_IDS.map(id => ({ id, name: id }));
  if (!servers.length) {
    const r = await get('/server');
    if (r.status !== 200) {
      line(`Could not list servers: ${r.status ?? r.error}`);
      line('A 403 here is credentials or the API IP allow-list, and nothing');
      line('further in this report would have meant anything.');
      throw new Error('could not list servers');
    }
    try {
      const j = JSON.parse(r.text);
      const list = j.servers || j.data || (Array.isArray(j) ? j : []);
      servers = list.map(s => ({ id: s.id, name: s.name || s.id })).filter(s => s.id);
    } catch {
      line('The server list did not parse as JSON; pass server ids explicitly.');
      throw new Error('unparseable server list');
    }
  }

  // Two per server, plus the server list and one item route asked once for
  // the whole run. The first version said three per server and then sent 30
  // where it had promised 43 — an estimate that errs safe is still an estimate
  // that was not checked against the code beside it.
  line(`${servers.length} server(s); about ${servers.length * 2 + 2} requests, against a daily ceiling of 15000.`);
  line('');

  const fieldsSeen = new Map();   // field -> how many applications carry it
  const rows = [];
  let appsTotal = 0;
  let itemRouteConfirmed = null;

  for (const srv of servers) {
    const sid = encodeURIComponent(srv.id);
    line(`=== ${srv.name}  (${srv.id})`);

    // Control probe first. Without it a blanket failure below is
    // indistinguishable from a missing feature.
    const ctl = await get(`/server/${sid}`);
    line(`  ${pad(ctl.status ?? 'ERR', 4)} /server/{id}                 — control probe (${ctl.ms} ms)`);
    if (ctl.status !== 200) {
      line('       control failed: nothing below this line is evidence about applications.');
      line('');
      continue;
    }

    const r = await get(`/server/${sid}/live/app`);
    line(`  ${pad(r.status ?? 'ERR', 4)} /server/{id}/live/app        — the applications (${r.ms} ms)`);

    if (r.status === 404) {
      line('       404 with a working control probe means this route is not on this');
      line('       deployment — worth knowing, since the reference publishes it.');
      line('');
      continue;
    }
    if (r.status !== 200) {
      line(`       ${(r.text || r.error || '').slice(0, 300).replace(/\s+/g, ' ')}`);
      line('');
      continue;
    }

    let apps = [];
    try {
      const j = JSON.parse(r.text);
      apps = j.applications || j.data || (Array.isArray(j) ? j : []);
      if (j.status && j.status !== 'Ok') {
        // HTTP 200 does not mean success here; the body's status field is the
        // answer. That has cost this project a day before.
        line(`       body says status=${j.status}: ${String(j.description || '').slice(0, 200)}`);
      }
    } catch {
      line('       the body did not parse as JSON');
      line('');
      continue;
    }

    if (!apps.length) {
      line('       no applications on this server');
      line('');
      continue;
    }

    // The item route, once. It is what a write would use, and confirming it
    // reads is cheaper than discovering it during a PUT.
    if (itemRouteConfirmed === null && apps[0]?.id) {
      const one = await get(`/server/${sid}/live/app/${encodeURIComponent(apps[0].id)}`);
      itemRouteConfirmed = one.status;
      line(`  ${pad(one.status ?? 'ERR', 4)} /server/{id}/live/app/{app}  — the item route, read (${one.ms} ms)`);
    }

    line('');
    line(`       ${pad('application', 22)} ${pad('chunk', 7)} ${pad('part', 7)} ${pad('LL-HLS', 20)} protocols`);
    for (const app of apps) {
      appsTotal++;
      for (const k of Object.keys(app)) fieldsSeen.set(k, (fieldsSeen.get(k) || 0) + 1);
      const a = assess(app);
      line(`       ${pad(app.application, 22)} ${pad(app.chunk_duration ?? '—', 7)} ${pad(app.hls_part_duration ?? '—', 7)} ${pad(a.verdict, 20)} ${(app.protocols || []).join(',')}`);
      for (const n of a.notes) line(`         ! ${n}`);
      rows.push({ server: srv.name, app: app.application, ...a });
      if (FULL) {
        line(JSON.stringify(sanitise(app), null, 2).split('\n').map(l => '         ' + l).join('\n'));
      }
    }
    line('');
  }

  // -------------------------------------------------------------------------
  line('=== Field census');
  line('');
  line(`${appsTotal} application(s) read.`);
  line('');
  const missing = DOCUMENTED.filter(f => !fieldsSeen.has(f));
  const extra = [...fieldsSeen.keys()].filter(f => !DOCUMENTED.includes(f)).sort();

  line('Documented and never returned here:');
  line(missing.length ? '  ' + missing.join(', ') : '  none — every documented field appeared');
  line('');
  line('  A field absent from every GET is not proof the API rejects it on PUT.');
  line('  Some are conditional by design: gen_icecast_metadata only with Icecast,');
  line('  hls_part_duration only when alhls_enabled is true.');
  line('');
  line('Returned here and not in the reference copy:');
  line(extra.length ? '  ' + extra.join(', ') : '  none');
  line('');
  line('  Anything here means this WMSPanel is newer than');
  line('  docs/wmspanel-api-application.md, and that file needs another copy.');
  line('');

  const alhls = fieldsSeen.get('alhls_enabled') || 0;
  line(`alhls_enabled present on ${alhls} of ${appsTotal} application(s).`);
  if (alhls === 0 && appsTotal > 0) {
    line('  Absent everywhere. Two explanations, and this script cannot tell them');
    line('  apart: the field is genuinely not in this version, or it is omitted');
    line('  when false. Only a write settles it — see below.');
  }
  line('');

  line(`Item route (GET /server/{id}/live/app/{app_id}): ${itemRouteConfirmed ?? 'not reached'}`);
  line('');

  const counts = rows.reduce((m, r) => (m[r.verdict] = (m[r.verdict] || 0) + 1, m), {});
  line('Verdicts: ' + (Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'));
  line('');

  line('=== If a write has to be tested');
  line('');
  line('This script does not write, and adding a flag to it would be the wrong');
  line('fix: a PUT with {} returned 200 here once, which means it executed.');
  line('');
  line('  1. In WMSPanel, create an application named `nnm-probe` by hand.');
  line('  2. PUT to it — never to an application a channel uses:');
  line('       curl -X PUT -H "Content-Type: application/json" \\');
  line('            -d \'{"chunk_duration":2,"alhls_enabled":true,"hls_part_duration":500}\' \\');
  line('            "<base>/server/<server_id>/live/app/<app_id>?client_id=…&api_key=…"');
  line('  3. GET it back. If alhls_enabled comes back true, the field exists.');
  line('     If the PUT is refused, the error names the reason.');
  line('  4. Delete `nnm-probe` by hand.');
  line('');
  line(`Requests sent: ${calls}.`);
}

if (IS_MAIN) {
  main()
    .then(writeReport)
    .catch((e) => { line(`failed: ${e?.message || e}`); writeReport(); process.exit(1); });
}
