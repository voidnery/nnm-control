#!/usr/bin/env node
//
// The stats pipeline, one link at a time.
//
// Written after a session where each guess about "why is there no history"
// was plausible and several were wrong. There are six links between a socket
// on a Nimble box and a point on a chart, and a break in any of them looks
// identical from the browser: an empty graph. This walks them in order and
// says which one is short.
//
//   docker compose exec api node tools/pipeline-check.mjs <serverId>
//
// Reads only. Addresses are reduced before printing.
import mongoose from 'mongoose';
import { config } from '../src/config.js';
import { Settings } from '../src/models/Settings.js';
import { NimbleServer } from '../src/models/NimbleServer.js';
import { StatSample } from '../src/models/StatSample.js';
import { nimble } from '../src/services/nimbleClient.js';
import { entryList, entryIdentity, liveSummary } from '../src/services/streamJoin.js';

const [serverId] = process.argv.slice(2);
if (!serverId) {
  console.error('usage: node tools/pipeline-check.mjs <serverId>');
  process.exit(2);
}

const maskIp = (v) => String(v ?? '').replace(/(\d+\.\d+\.\d+)\.\d+/g, '$1.x');
const line = (label, text) => console.log(`  ${label.padEnd(30)} ${text}`);

await mongoose.connect(config.mongoUrl);
const server = await NimbleServer.findById(serverId);
if (!server) { console.error('server not found'); process.exit(1); }
const settings = await Settings.load();

console.log(`\n${server.name} — ${maskIp(server.host)}:${server.port}\n`);

// ── 1. Is collection even on, and is the agent the path? ─────────────────────
console.log('1. SETTINGS AND TRANSPORT');
line('stats.enabled', settings.stats?.enabled ? 'on' : 'OFF — nothing is recorded for anything');
line('stats.groups.srt', settings.stats?.groups?.srt !== false ? 'on' : 'OFF');
line('interval', `${settings.stats?.intervalSec ?? 10}s`);
const a = server.agent || {};
const agentAge = a.lastContactAt ? Math.round((Date.now() - new Date(a.lastContactAt).getTime()) / 1000) : null;
line('agent', a.enabled ? `v${a.version || '?'}, last seen ${agentAge ?? '—'}s ago` : 'not enabled');
line('reads go via', a.enabled && agentAge != null && agentAge < 90 ? 'the agent (loopback)' : 'a direct call to the host');

// ── 2. What Nimble returns, right now ────────────────────────────────────────
console.log('\n2. WHAT NIMBLE RETURNS');
const endpoints = { 'srt-receiver': 'srtReceiverStats', 'srt-sender': 'srtSenderStats' };
const fresh = {};
for (const [series, fn] of Object.entries(endpoints)) {
  try {
    const list = entryList(await nimble[fn](server));
    fresh[series] = list;
    const connected = list.filter(e => String(e.state).toLowerCase() === 'connected');
    const carrying = connected.filter(e => (e.stats?.recv?.mbpsRate ?? e.stats?.send?.mbpsRate ?? 0) > 0);
    line(fn, `${list.length} entries · ${connected.length} connected · ${carrying.length} carrying data`);
  } catch (e) {
    fresh[series] = [];
    line(fn, `FAILED: ${String(e.message).slice(0, 120)}`);
  }
}

// ── 3. Does each entry yield an identity the series can be keyed on? ─────────
console.log('\n3. IDENTITY (what the series is keyed on)');
for (const [series, list] of Object.entries(fresh)) {
  if (!list.length) continue;
  const withId = list.filter(e => entryIdentity(e));
  line(series, `${withId.length} of ${list.length} yield an identity`);
  const sample = list.slice(0, 3).map(e => `${entryIdentity(e) || '∅'}(${e.state || '?'})`);
  line('', sample.join('  '));
}

// ── 4. What is actually stored, and how recently ─────────────────────────────
console.log('\n4. WHAT IS STORED');
const since = new Date(Date.now() - 15 * 60 * 1000);
const stored = await StatSample.aggregate([
  { $match: { serverId: String(server._id), group: 'srt', ts: { $gte: since } } },
  { $sort: { ts: -1 } },
  { $group: { _id: '$subject', last: { $first: '$ts' }, n: { $sum: 1 },
              keys: { $first: { $objectToArray: '$metrics' } } } },
]);
line('subjects in last 15m', String(stored.length));
const rich = stored.filter(s => s.keys.length > 1);
line('with more than retryCount', `${rich.length} — the rest are disconnected sockets, which have nothing else`);
if (rich.length) line('example', `${rich[0]._id} → ${rich[0].keys.length} metrics`);

// ── 5. Do the live entries and the stored subjects agree? ────────────────────
//
// This is the link that has broken most often: two answers to "which stream is
// this", in two id spaces. If a socket is live now and its subject is absent
// here, the collector and the reader are not speaking about the same thing.
console.log('\n5. LIVE ENTRIES vs STORED SUBJECTS');
const storedIds = new Set(stored.map(s => s._id));
for (const [series, list] of Object.entries(fresh)) {
  if (!list.length) continue;
  const expected = list.map(e => `${series}:${entryIdentity(e)}`).filter(s => !s.endsWith(':'));
  const missing = expected.filter(s => !storedIds.has(s));
  line(series, `${expected.length - missing.length} of ${expected.length} live sockets have a stored series`);
  if (missing.length) line('missing (first 3)', missing.slice(0, 3).join('  '));
}

// ── 6. For a carrying socket, is there anything to draw? ─────────────────────
console.log('\n6. A CARRYING SOCKET, END TO END');
const carrying = Object.entries(fresh)
  .flatMap(([series, list]) => list.map(e => ({ series, e })))
  .find(({ e }) => (e.stats?.recv?.mbpsRate ?? e.stats?.send?.mbpsRate ?? 0) > 0);
if (!carrying) {
  line('', 'no socket is carrying data right now — nothing to check end to end');
} else {
  const subject = `${carrying.series}:${entryIdentity(carrying.e)}`;
  const s = liveSummary(carrying.e);
  line('subject', subject);
  line('live reading', `${((s.bps || 0) / 1e6).toFixed(2)} Mbps, rtt ${s.rtt ?? '—'}`);
  const points = await StatSample.countDocuments({ serverId: String(server._id), subject, ts: { $gte: since } });
  line('points stored in 15m', String(points));
  if (!points) {
    line('VERDICT', 'the socket is live and nothing is being stored for it — link 4 or 5 is broken');
  } else {
    const withRate = await StatSample.countDocuments({
      serverId: String(server._id), subject, ts: { $gte: since },
      $or: [{ 'metrics.stats.recv.mbpsRate': { $exists: true } }, { 'metrics.stats.send.mbpsRate': { $exists: true } }],
    });
    line('of those, with a rate', String(withRate));
    line('VERDICT', withRate ? 'end to end is intact' : 'stored, but without the rate — the flattener or the shape changed');
  }
}

console.log('');
await mongoose.disconnect();
