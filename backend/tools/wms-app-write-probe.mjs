#!/usr/bin/env node
//
// What does WMSPanel actually do when we write LL-HLS settings?
//
// Reading answered where the settings live. It cannot answer what happens on
// a write, and the whole fleet has LL-HLS off, so there is not one enabled
// application anywhere to look at. Six questions are open, and every one of
// them changes what the panel has to build:
//
//   1. Does `PUT` accept `alhls_enabled` at all on this version?
//   2. Does `hls_part_duration` come back once it is on?
//   3. Is the ceiling — half the chunk — enforced by the server, or must the
//      panel enforce it?
//   4. Is the floor enforced, and is it the 250 ms the reference claims?
//   5. If the chunk shrinks and leaves an existing part above the new ceiling,
//      does the server refuse, or does it leave an illegal pair behind? This
//      decides whether the panel may send chunk and part separately.
//   6. Does `alhls_enabled` disappear when HLS leaves `protocols`? Reading 103
//      applications says the field is conditional; only a write proves it.
//
// THE GUARD
//
// This script writes. It refuses to write to anything except an application
// named exactly `nnm-probe`, and the name is a constant here rather than an
// argument, because an argument is a thing that gets typed wrong once. The
// operator creates that application by hand and deletes it by hand; DELETE is
// never sent from here, as with every recon script in this project.
//
// Every write is followed by a read. HTTP 200 does not mean success against
// this API — the `status` field in the body is the answer — and a write is
// only believed once the value comes back.
//
// STANDALONE: no dependencies, no database, no repository around it. See
// docs/recon-scripts.md.
//
// Usage:
//
//     node wms-app-write-probe.mjs <client_id> <api_key> <server_id> --write
//
// Without `--write` it reads the application, prints the plan and sends
// nothing. `WMS_BASE=https://api.wmspanel.ru/v1` for the mirror.
//
const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const [CLIENT_ID, API_KEY, SERVER_ID] = argv.filter(a => !a.startsWith('--'));
const BASE = (process.env.WMS_BASE || 'https://api.wmspanel.com/v1').replace(/\/+$/, '');
const TIMEOUT_MS = 12000;

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT = path.join(HERE, `wms-write-probe-${new Date().toISOString().slice(0, 10)}.txt`);
const IS_MAIN = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

const out = [];
const line = (s = '') => { process.stdout.write(s + '\n'); out.push(s); };
function writeReport() {
  try { writeFileSync(REPORT, out.join('\n') + '\n'); process.stderr.write(`\nwritten: ${REPORT}\n`); }
  catch (e) { process.stderr.write(`\ncould not write ${REPORT}: ${e?.message || e}\n`); }
}

// The one application this script may touch. A constant, not an argument.
export const GUARD_NAME = 'nnm-probe';

// Kept in step with backend/src/services/llhls.js — see the note there. The
// first run of this probe is what produced the number: the reference says 250,
// the server said 500.
export const PART_MIN_MS = 500;
export const partCeilingMs = (chunkSeconds) => {
  const c = Number(chunkSeconds);
  return Number.isFinite(c) && c > 0 ? Math.floor(c * 1000 / 2) : null;
};

const SECRET_FIELDS = ['push_login', 'push_password'];
export function sanitise(app) {
  const c = { ...app };
  for (const f of SECRET_FIELDS) if (f in c) c[f] = c[f] ? `<set, ${String(c[f]).length} chars>` : '<empty>';
  return c;
}

if (IS_MAIN && (!CLIENT_ID || !API_KEY || !SERVER_ID)) {
  line('usage: node wms-app-write-probe.mjs <client_id> <api_key> <server_id> --write');
  line('');
  line(`  Writes only to an application named exactly \`${GUARD_NAME}\`.`);
  line('  Create it in WMSPanel by hand first, and delete it by hand after.');
  line('  Without --write nothing is sent; the plan is printed instead.');
  line('');
  line('  WMS_BASE=https://api.wmspanel.ru/v1   to use the mirror');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The plan, derived from what the application currently is.
//
// Separate from the sending so it can be tested against fixtures, and so the
// dry run prints exactly what the real run would send.
// ---------------------------------------------------------------------------
export function buildSteps(before) {
  const chunk0 = Number(before.chunk_duration);
  const ceil0 = partCeilingMs(chunk0) ?? 3000;
  const part0 = Math.min(500, ceil0);
  const protos = Array.isArray(before.protocols) && before.protocols.length
    ? before.protocols : ['HLS', 'RTMP'];

  return [
    {
      id: 'enable',
      why: 'does PUT accept alhls_enabled, and does the part come back',
      body: { alhls_enabled: true, hls_part_duration: part0 },
      expect: 'accepted',
      verify: (a) => {
        if (a.alhls_enabled !== true) return 'alhls_enabled did not come back true';
        if (Number(a.hls_part_duration) !== part0) return `hls_part_duration came back ${a.hls_part_duration}, not ${part0}`;
        return null;
      },
    },
    {
      id: 'part-above-ceiling',
      why: `is the ceiling enforced (chunk ${chunk0}s → ${ceil0} ms)`,
      body: { hls_part_duration: ceil0 + 1000 },
      expect: 'refused',
      verify: (a) => Number(a.hls_part_duration) === ceil0 + 1000
        ? 'the illegal part was stored — the server does not enforce the ceiling' : null,
    },
    {
      id: 'part-below-floor',
      why: `is the floor enforced, and is it ${PART_MIN_MS} ms`,
      body: { hls_part_duration: 100 },
      expect: 'refused',
      verify: (a) => Number(a.hls_part_duration) === 100
        ? 'a 100 ms part was stored — the server does not enforce any floor' : null,
    },
    {
      id: 'shrink-together',
      why: 'chunk and part in one request, which is how the panel would do it',
      body: { chunk_duration: 2, hls_part_duration: 500 },
      expect: 'accepted',
      verify: (a) => (Number(a.chunk_duration) === 2 && Number(a.hls_part_duration) === 500)
        ? null : `came back chunk=${a.chunk_duration} part=${a.hls_part_duration}`,
    },
    {
      id: 'part-near-ceiling',
      why: 'set a part that is legal now and will not be after the next step',
      body: { hls_part_duration: 900 },
      expect: 'accepted',
      verify: (a) => Number(a.hls_part_duration) === 900 ? null : `part came back ${a.hls_part_duration}`,
    },
    {
      // The one that decides the form's ordering. No expectation is declared:
      // both answers are plausible and the point is to find out which.
      id: 'shrink-chunk-alone',
      why: 'chunk to 1s alone, leaving a 900 ms part above the new 500 ms ceiling',
      body: { chunk_duration: 1 },
      expect: 'unknown',
      verify: () => null,
      report: (a) => {
        const c = Number(a.chunk_duration), p = Number(a.hls_part_duration);
        if (c === 1 && p === 900) return 'ACCEPTED and left illegal: chunk 1s with a 900 ms part. The panel must send chunk and part together and validate itself.';
        if (c === 1 && p !== 900) return `accepted and adjusted the part to ${p} — the server repairs the pair itself`;
        if (c !== 1) return `refused the chunk change; chunk is still ${c}. The panel must lower the part first, then the chunk.`;
        return 'unclear';
      },
    },
    {
      id: 'drop-hls',
      why: 'does alhls_enabled vanish when HLS leaves protocols (103 reads say it should)',
      body: { protocols: ['RTMP'] },
      expect: 'accepted',
      report: (a) => 'alhls_enabled' in a
        ? `still present (${a.alhls_enabled}) with protocols ${(a.protocols || []).join(',')} — the field is NOT conditional on HLS`
        : 'gone, as 103 reads predicted — the field is conditional on an HLS protocol',
      verify: () => null,
    },
    {
      id: 'restore-hls',
      why: 'put the protocols back before restoring the rest',
      body: { protocols: protos },
      expect: 'accepted',
      verify: () => null,
    },
  ];
}

// What the panel should conclude, given how each step turned out. Kept apart
// from the printing so the test can assert on conclusions rather than on
// wording.
export function conclude(results) {
  const by = Object.fromEntries(results.map(r => [r.id, r]));
  const ok = (id) => by[id]?.outcome === 'accepted' && !by[id]?.complaint;
  const refused = (id) => by[id]?.outcome === 'refused';
  return {
    fieldWritable: ok('enable'),
    partReturned: ok('enable'),
    ceilingEnforcedByServer: refused('part-above-ceiling') && !by['part-above-ceiling']?.complaint,
    floorEnforcedByServer: refused('part-below-floor') && !by['part-below-floor']?.complaint,
    pairMustBeSentTogether: by['shrink-chunk-alone']?.note?.startsWith('ACCEPTED and left illegal') || false,
    fieldConditionalOnHls: (by['drop-hls']?.note || '').includes('conditional'),
  };
}

const auth = `client_id=${encodeURIComponent(CLIENT_ID)}&api_key=${encodeURIComponent(API_KEY)}`;
let calls = 0;

async function req(p, method = 'GET', body) {
  calls++;
  const url = `${BASE}${p}${p.includes('?') ? '&' : '?'}${auth}`;
  try {
    const r = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, text, json };
  } catch (e) {
    return { status: null, error: String(e?.message || e).slice(0, 200) };
  }
}

// HTTP 200 with `{"status":"Error"}` is a refusal here. That has cost this
// project a day before, so it is decided in one place.
function outcomeOf(r) {
  if (r.status === 200 && (!r.json || r.json.status === 'Ok')) return 'accepted';
  return 'refused';
}
function reasonOf(r) {
  if (r.error) return r.error;
  const d = r.json?.description || r.json?.error || r.json?.message;
  return d ? String(d).slice(0, 200) : String(r.text || '').slice(0, 200).replace(/\s+/g, ' ');
}

async function main() {
  line(`WMSPanel: ${BASE}`);
  line(`Date: ${new Date().toISOString()}`);
  line(`Server: ${SERVER_ID}`);
  line(`Guard: writes only to an application named \`${GUARD_NAME}\`. DELETE is never sent.`);
  line(WRITE ? 'Mode: WRITE' : 'Mode: dry run — the plan is printed and nothing is sent');
  line('');

  const sid = encodeURIComponent(SERVER_ID);

  const ctl = await req(`/server/${sid}`);
  line(`${String(ctl.status ?? 'ERR').padEnd(4)} /server/{id}   — control probe`);
  if (ctl.status !== 200) {
    line('Control probe failed. Nothing below would have been evidence.');
    throw new Error('control probe failed');
  }

  const list = await req(`/server/${sid}/live/app`);
  if (list.status !== 200 || !list.json) {
    line(`Could not read applications: ${list.status ?? list.error}`);
    throw new Error('could not list applications');
  }
  const apps = list.json.applications || [];
  const matches = apps.filter(a => a.application === GUARD_NAME);

  if (matches.length === 0) {
    line(`No application named \`${GUARD_NAME}\` on this server.`);
    line('');
    line(`Create it in WMSPanel — Nimble Streamer / Live streams settings →`);
    line(`this server → Applications → add \`${GUARD_NAME}\` — and run this again.`);
    line('It needs no particular settings; this script sets what it needs.');
    line('');
    line(`Applications that are here: ${apps.map(a => a.application).join(', ') || 'none'}`);
    throw new Error('no probe application');
  }
  if (matches.length > 1) {
    line(`${matches.length} applications are named \`${GUARD_NAME}\`. Refusing to guess.`);
    throw new Error('ambiguous probe application');
  }

  const before = matches[0];
  const appId = encodeURIComponent(before.id);
  line(`Found \`${GUARD_NAME}\` (${before.id}).`);
  line('');
  line('Before:');
  line(JSON.stringify(sanitise(before), null, 2).split('\n').map(l => '  ' + l).join('\n'));
  line('');

  const steps = buildSteps(before);

  if (!WRITE) {
    line('Plan — each of these is a PUT followed by a GET:');
    line('');
    for (const s of steps) {
      line(`  ${s.id.padEnd(22)} ${JSON.stringify(s.body)}`);
      line(`  ${' '.repeat(22)} ${s.why}  [expect: ${s.expect}]`);
    }
    line('');
    line('Add --write to send them.');
    return;
  }

  const results = [];
  for (const s of steps) {
    const w = await req(`/server/${sid}/live/app/${appId}`, 'PUT', s.body);
    // The write is not believed until it is read back.
    const back = await req(`/server/${sid}/live/app/${appId}`);
    const after = back.json?.application || back.json || {};
    const outcome = outcomeOf(w);
    const complaint = outcome === 'accepted' && s.verify ? s.verify(after) : null;
    const note = s.report ? s.report(after) : null;

    const agrees = s.expect === 'unknown' ? '?' : (outcome === s.expect && !complaint ? '✓' : '✗');
    line(`${agrees} ${s.id}`);
    line(`    ${s.why}`);
    line(`    sent    ${JSON.stringify(s.body)}`);
    line(`    got     HTTP ${w.status ?? 'ERR'}  status=${w.json?.status ?? '—'}  ${outcome}`);
    if (outcome === 'refused') line(`    reason  ${reasonOf(w)}`);
    line(`    read    chunk=${after.chunk_duration} part=${after.hls_part_duration ?? '—'} alhls=${'alhls_enabled' in after ? after.alhls_enabled : '<absent>'} protocols=${(after.protocols || []).join(',')}`);
    if (complaint) line(`    !       ${complaint}`);
    if (note) line(`    →       ${note}`);
    line('');

    results.push({ id: s.id, outcome, complaint, note, expect: s.expect });
  }

  // Restore what was there. Best effort, and said plainly either way — this is
  // `nnm-probe`, but a script that quietly leaves a machine changed is a habit
  // that eventually meets a machine that matters.
  const restore = {
    chunk_duration: before.chunk_duration,
    protocols: before.protocols,
    alhls_enabled: before.alhls_enabled ?? false,
  };
  if (before.hls_part_duration != null) restore.hls_part_duration = before.hls_part_duration;
  const rr = await req(`/server/${sid}/live/app/${appId}`, 'PUT', restore);
  line(`Restore: ${outcomeOf(rr)} — ${JSON.stringify(restore)}`);
  if (outcomeOf(rr) === 'refused') line(`  ${reasonOf(rr)}`);
  line('');

  const c = conclude(results);
  line('=== What the panel must do about it');
  line('');
  line(`  alhls_enabled is writable here          ${c.fieldWritable ? 'YES' : 'NO'}`);
  line(`  hls_part_duration returns once enabled  ${c.partReturned ? 'YES' : 'NO'}`);
  line(`  the server enforces the ceiling         ${c.ceilingEnforcedByServer ? 'YES' : 'NO — the panel must'}`);
  line(`  the server enforces a part floor        ${c.floorEnforcedByServer ? `YES (${PART_MIN_MS} ms, not the 250 the reference claims)` : 'NO — the panel must'}`);
  line(c.pairMustBeSentTogether
    ? '  lowering the chunk alone                LEAVES AN ILLEGAL PAIR — the panel must send both and validate itself'
    : '  lowering the chunk alone                is refused — no illegal pair can be reached, so either order works');
  line(`  the field is conditional on HLS         ${c.fieldConditionalOnHls ? 'YES' : 'NO'}`);
  line('');
  line(`Delete \`${GUARD_NAME}\` in WMSPanel by hand. This script does not send DELETE.`);
  line(`Requests sent: ${calls}.`);
}

if (IS_MAIN) {
  main().then(writeReport)
    .catch((e) => { line(`failed: ${e?.message || e}`); writeReport(); process.exit(1); });
}
