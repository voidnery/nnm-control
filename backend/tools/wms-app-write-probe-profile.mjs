#!/usr/bin/env node
// What WMSPanel accepts and stores for an application's output profile.
//
// The panel is about to write these fields for real — protocols, container,
// chunk duration, LL-HLS and its part duration, interleaving compensation — so
// this asks the server what it does with them first. Every number the panel
// puts in a form has to come from somewhere, and the last time one came from
// the vendor's reference instead of a measurement it was wrong by half: the
// published minimum part duration is 250 ms and the server refuses anything
// below 500.
//
// SCOPE. This answers what WMSPanel *stores*. It does not answer what Nimble
// then does with it — that needs an input restart and a measurement on the
// wire, which is `llhls-check.mjs`. Two different questions, and conflating
// them is how two runs once produced opposite verdicts about one server.
//
// GUARDED. Every write targets an application named exactly `nnm-probe`, on a
// server given by id. It refuses anything else, it never sends DELETE, and it
// restores what it read at the start — from the readback, not from a constant.
//
// COST. Read-only run: 2 calls. With --write: about 20. The account ceiling is
// 15000 a day.
//
// SOURCE for the field list and the one documented illegal pair:
// docs/wmspanel-api-application.md, copied by hand from
// https://wmspanel.com/api_info — Live applications.
//
//   node wms-app-write-probe-profile.mjs --client-id=… --api-key=… --server=<wmspanel server id>
//   node wms-app-write-probe-profile.mjs … --write        # sends the writes
//   node wms-app-write-probe-profile.mjs … --write --restore-only
//
// The report is written beside this file, whichever way the run ends.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = 'nnm-probe';

// ---- the questions ----------------------------------------------------------
//
// Written down, not generated. Each step says what it is asking, what would
// count as either answer, and what it costs if the server takes it literally.
//
// Ordered so that the readings which need an untouched application come first,
// and so that every change is undone by the step after it or by the restore.
export const STEPS = [
  {
    id: 'defaults-on-enable',
    ask: 'Enabling interleaving compensation without naming the other three: what does the server store?',
    body: { ic_enabled: true },
    // The published example shows 1000 / 3000 / 250. If those come back, they
    // are defaults and the panel need not send them; if the fields are absent,
    // the panel must send them or leave the feature half configured.
    reads: ['ic_enabled', 'ic_min_delay_ms', 'ic_max_delay_ms', 'ic_max_queue_items'],
  },
  {
    id: 'min-zero',
    ask: 'Is a minimum delay of zero accepted, or clamped?',
    // Softvelum recommends exactly this for video+audio at low latency. A
    // clamp that comes back as 1000 while reporting success is the shape that
    // matters: the panel would show a setting the server never took.
    body: { ic_min_delay_ms: 0 },
    reads: ['ic_min_delay_ms'],
  },
  {
    id: 'min-negative',
    ask: 'Does the server validate this field at all?',
    // Without this, a zero that is accepted proves nothing: it could be that
    // the field is stored unchecked. Refusal here is the good answer.
    body: { ic_min_delay_ms: -1 },
    expectRefusal: true,
    reads: ['ic_min_delay_ms'],
  },
  {
    id: 'part-below-floor',
    ask: 'Is the part-duration floor 500, as measured, or 250, as published?',
    // Re-asked because the panel is about to offer this field on a new screen
    // and the number in the reference is wrong. If the refusal message names a
    // bound, that bound goes in the code with this run beside it.
    body: { hls_part_duration: 250 },
    expectRefusal: true,
    reads: ['hls_part_duration'],
  },
  {
    id: 'part-above-half-chunk',
    ask: 'Is the ceiling really half the chunk?',
    // The panel enforces it in the browser. If the server does not, the panel
    // is inventing a limit; if it does, the message is worth quoting.
    body: { hls_part_duration: 999999 },
    expectRefusal: true,
    reads: ['hls_part_duration'],
  },
  {
    id: 'illegal-pair',
    ask: 'Are HLS and HLS_MPEGTS refused together, as documented?',
    // The one combination the reference calls illegal. If it is accepted
    // silently, the panel must refuse it itself rather than trusting the API.
    body: { protocols: ['HLS', 'HLS_MPEGTS'] },
    expectRefusal: true,
    reads: ['protocols'],
  },
  {
    id: 'fmp4-displaces-hls',
    ask: 'Does adding HLS_FMP4 drop plain HLS, as it did on 2026-08-17?',
    // Measured once, on one server, and the panel encodes it as a rule
    // (`CONTAINER_REPLACES`). A rule from a single reading is a hypothesis
    // until it is asked again.
    body: { protocols: ['HLS', 'DASH', 'SLDP', 'HLS_FMP4'] },
    reads: ['protocols'],
  },
  {
    id: 'partial-write',
    ask: 'Does a body naming one field leave the others alone?',
    // The whole plan/apply envelope assumes it. If a PUT resets unnamed
    // fields, the panel must send the complete object every time.
    body: { chunk_duration: 6 },
    reads: ['protocols', 'chunk_duration', 'alhls_enabled', 'hls_part_duration'],
  },
];

// ---- pure logic, testable without a network ---------------------------------

export const SENSITIVE = ['push_login', 'push_password'];

// Credentials are removed from the object, not hidden at the point of
// printing: the report is a file and the file gets pasted into a chat.
export function scrub(app) {
  if (!app || typeof app !== 'object') return app;
  const out = { ...app };
  for (const k of SENSITIVE) {
    if (!(k in out)) continue;
    const v = out[k];
    out[k] = v ? `<set, ${String(v).length} chars>` : '<empty>';
  }
  return out;
}

// What a single step learned. Kept apart from sending it so the verdicts —
// the part that gets believed — can be checked against fixtures.
export function verdict(step, { status, payload, before, after }) {
  const refused = status !== 200 || payload?.status === 'Error' || Boolean(payload?.error);
  const message = payload?.description || payload?.error || payload?.message || null;

  const changed = {};
  for (const field of step.reads) {
    const b = before ? before[field] : undefined;
    const a = after ? after[field] : undefined;
    if (JSON.stringify(b) !== JSON.stringify(a)) changed[field] = { from: b ?? null, to: a ?? null };
  }

  // Asked for and got, asked for and did not get, or was refused. The middle
  // one is the interesting case and the one a bare status code hides: a 200
  // that stored something else is a silent clamp, and the panel would show a
  // value the server never took.
  const asked = Object.keys(step.body);
  const clamped = [];
  if (!refused && after) {
    for (const field of asked) {
      if (!step.reads.includes(field)) continue;
      if (JSON.stringify(after[field]) !== JSON.stringify(step.body[field])) {
        clamped.push({ field, sent: step.body[field], stored: after[field] ?? null });
      }
    }
  }

  return {
    id: step.id,
    ask: step.ask,
    status,
    refused,
    message,
    // A step that expected a refusal and got one has confirmed a bound; one
    // that expected a refusal and was obeyed has found the panel enforcing
    // something the server does not.
    outcome: step.expectRefusal
      ? (refused ? 'bound-confirmed' : 'accepted-though-expected-refusal')
      : (refused ? 'refused' : clamped.length ? 'stored-something-else' : 'stored-as-sent'),
    clamped,
    changed,
  };
}

// Fields the run must put back, computed from what was read at the start
// rather than from a constant. A restore built from a default would write
// somebody's application into a shape it never had.
export function restoreBody(before, touched) {
  const body = {};
  for (const field of touched) {
    if (before && field in before) body[field] = before[field];
  }
  return body;
}

// Every field any step touches, so the restore covers all of them even when a
// run stops early.
export const TOUCHED = [...new Set(STEPS.flatMap(s => Object.keys(s.body)))];

// ---- the run ----------------------------------------------------------------

const arg = (name, dflt = null) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

async function call(cfg, route, { method = 'GET', body = null } = {}) {
  const url = new URL(`https://api.wmspanel.com/v1${route}`);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('api_key', cfg.apiKey);
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try { payload = JSON.parse(await res.text()); } catch { /* keep null */ }
  return { status: res.status, payload };
}

async function main() {
  const cfg = { clientId: arg('client-id'), apiKey: arg('api-key') };
  const serverId = arg('server');
  const write = flag('write');
  const report = { at: new Date().toISOString(), serverId, write, steps: [], notes: [] };

  const finish = (code) => {
    const file = path.join(HERE, `wms-profile-probe-${report.at.replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`\nreport: ${file}`);
    process.exitCode = code;
  };

  if (!cfg.clientId || !cfg.apiKey || !serverId) {
    console.log('usage: --client-id=… --api-key=… --server=<wmspanel server id> [--write] [--restore-only]');
    report.notes.push('missing arguments');
    return finish(2);
  }

  console.log(write
    ? `about 20 API calls, all writes aimed at the application named "${GUARD}"`
    : '2 API calls, read-only. Add --write to send anything.');

  // Control probe. Without it a blanket failure reads as a missing feature.
  const control = await call(cfg, '/server');
  report.notes.push({ control: control.status });
  if (control.status !== 200) {
    console.log(`control probe failed with ${control.status} — nothing below would mean anything`);
    return finish(1);
  }
  console.log('control probe: ok');

  const list = await call(cfg, `/server/${serverId}/live/app`);
  const apps = list.payload?.applications || [];
  const app = apps.find(a => a.application === GUARD);
  if (!app) {
    console.log(`no application named "${GUARD}" on server ${serverId} — refusing to touch anything else`);
    report.notes.push({ guard: 'absent', found: apps.map(a => a.application) });
    return finish(1);
  }
  report.baseline = scrub(app);
  console.log(`baseline read: ${GUARD} (id ${app.id})`);
  console.log(JSON.stringify(scrub(app), null, 2));

  if (!write) {
    console.log('\nread-only. The steps that would run:');
    for (const s of STEPS) console.log(`  ${s.id.padEnd(24)} ${s.ask}`);
    return finish(0);
  }

  const put = (body) => call(cfg, `/server/${serverId}/live/app/${app.id}`, { method: 'PUT', body });
  const read = async () => (await call(cfg, `/server/${serverId}/live/app`))
    .payload?.applications?.find(a => a.application === GUARD) || null;

  if (flag('restore-only')) {
    const r = await put(restoreBody(app, TOUCHED));
    report.notes.push({ restoreOnly: r.status });
    console.log(`restore: ${r.status}`);
    return finish(r.status === 200 ? 0 : 1);
  }

  let before = app;
  for (const step of STEPS) {
    const sent = await put(step.body);
    const after = await read();
    const v = verdict(step, { status: sent.status, payload: sent.payload, before, after });
    report.steps.push(v);
    console.log(`  ${step.id.padEnd(24)} ${v.outcome}${v.message ? ` — ${v.message}` : ''}`);
    before = after || before;
  }

  // Back to what was read at the start. Reported as its own step because a
  // restore that failed silently would leave the probe application in a shape
  // the next run would read as a baseline.
  const restore = await put(restoreBody(app, TOUCHED));
  const final = await read();
  const residue = TOUCHED.filter(f =>
    JSON.stringify(final?.[f]) !== JSON.stringify(app[f]));
  report.restore = { status: restore.status, residue, final: scrub(final) };
  console.log(residue.length
    ? `restore left ${residue.join(', ')} different from the baseline`
    : 'restored to the baseline');

  return finish(residue.length ? 1 : 0);
}

// Behind a check, so the file can be imported by its tests. An earlier draft
// exited on its usage line during the import and took the test file with it.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
