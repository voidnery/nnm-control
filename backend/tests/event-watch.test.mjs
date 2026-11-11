// server.* / stream.* / certificate.expiring (services/eventWatch.js; docs/api/PROPOSAL-nnm-api-1.md
// §3.4). The rules are pure functions and are tested as such; the round over a fleet is tested with
// the servers' answers and the event sink injected — no Nimble, no MongoDB, no network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  liveNames, observe, newServerState, lookAt, watchOnce, certTargets, certEvent, certificatesOnce, watchSettings, DEFAULTS,
} from '../src/services/eventWatch.js';
import { EVENT_TYPES } from '../src/services/events.js';
import { WARN_DAYS } from '../src/services/certState.js';

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};
const set = (...a) => new Set(a);
const types = (evs) => evs.map(e => (e.stream ? `${e.type} ${e.stream}` : e.type));
// Run a sequence of observations; returns the events of each step.
const run = (steps, opts = {}) => {
  let st = newServerState();
  return steps.map((seen, i) => {
    const r = observe(st, seen, { downAfter: 2, now: new Date(Date.UTC(2026, 10, 11, 0, 0, i * 30)), ...opts });
    st = r.state;
    return types(r.events);
  });
};
const up = (...names) => ({ reachable: true, streams: set(...names) });
const DOWN = { reachable: false, streams: null, error: 'connect ECONNREFUSED' };

console.log('\nWHAT IS ON THE AIR:');

await check('Nimble\'s own answer — applications with their streams — is read', () => {
  // The shape of /manage/live_streams_status on a real server (tests/fixtures/nimble-probe.json).
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/nimble-probe.json', import.meta.url), 'utf8'));
  const shape = fixture.endpoints['/manage/live_streams_status'].shape;
  assert.deepEqual(shape.keys, ['app', 'streams']);
  assert.deepEqual([...liveNames([{ app: 'Sport_tv_obs', streams: [{ strm: 'feed5' }, { strm: 'feed6' }] }, { app: 'live', streams: [] }])],
    ['Sport_tv_obs/feed5', 'Sport_tv_obs/feed6']);
});

await check('and so is a flat list; nothing is invented from a nameless entry', () => {
  assert.deepEqual([...liveNames({ streams: [{ application: 'live', stream: 'a' }, { application: 'live' }] })], ['live/a']);
  assert.equal(liveNames(null).size, 0);
});

console.log('\nSTREAMS:');

await check('the first list is the baseline: a restart of the panel announces nothing', () => {
  assert.deepEqual(run([up('live/a', 'live/b')]), [[]]);
});

await check('a stream that appears is up at once', () => {
  assert.deepEqual(run([up('live/a'), up('live/a', 'live/b')])[1], ['stream.up live/b']);
});

await check('one missed answer is not down; two in a row are — once', () => {
  const r = run([up('live/a', 'live/b'), up('live/a'), up('live/a'), up('live/a')]);
  assert.deepEqual(r, [[], [], ['stream.down live/b'], []]);
});

await check('a stream that blinks back before that is neither down nor up again', () => {
  assert.deepEqual(run([up('live/a', 'live/b'), up('live/a'), up('live/a', 'live/b'), up('live/a')]), [[], [], [], []]);
});

await check('down after 1 means the first miss', () => {
  assert.deepEqual(run([up('live/a'), up()], { downAfter: 1 })[1], ['stream.down live/a']);
});

await check('a list that could not be read changes nothing', () => {
  assert.deepEqual(run([up('live/a'), { reachable: true, streams: null }, up('live/a')]), [[], [], []]);
});

console.log('\nSERVERS:');

await check('a server never seen answering is never «unreachable» — it is not set up', () => {
  assert.deepEqual(run([DOWN, DOWN, DOWN, DOWN]).flat(), []);
});

await check('answering, then two misses: unreachable once, on the second', () => {
  assert.deepEqual(run([up('live/a'), DOWN, DOWN, DOWN, DOWN]), [[], [], ['server.unreachable'], [], []]);
});

await check('its streams are not called down while nobody can see them', () => {
  const r = run([up('live/a', 'live/b'), DOWN, DOWN, DOWN]);
  assert.ok(!r.flat().some(t => t.startsWith('stream.down')));
});

await check('back: reachable, with how long it was gone; what went missing meanwhile is down', () => {
  let st = newServerState();
  const at = (s) => new Date(Date.UTC(2026, 10, 11, 0, 0, s));
  const evs = [];
  for (const [seen, s] of [[up('live/a', 'live/b'), 0], [DOWN, 30], [DOWN, 60], [up('live/a'), 150], [up('live/a'), 180]]) {
    const r = observe(st, seen, { downAfter: 2, now: at(s) });
    st = r.state;
    evs.push(r.events);
  }
  assert.deepEqual(types(evs[3]), ['server.reachable']);
  assert.equal(evs[3][0].data.down_for_s, 90);
  assert.deepEqual(types(evs[4]), ['stream.down live/b']);
});

await check('a single missed answer between good ones is nothing', () => {
  assert.deepEqual(run([up('live/a'), DOWN, up('live/a'), DOWN, up('live/a')]).flat(), []);
});

await check('asking: no answer to either question is unreachable; one answer is enough', async () => {
  const fail = async () => { throw new Error('connect ETIMEDOUT'); };
  const ok = async () => [{ app: 'live', streams: [{ strm: 'a' }] }];
  const both = await lookAt({}, { client: { serverStatus: fail, liveStreams: fail } });
  assert.equal(both.reachable, false);
  assert.match(both.error, /ETIMEDOUT/);
  const half = await lookAt({}, { client: { serverStatus: fail, liveStreams: ok } });
  assert.deepEqual([half.reachable, [...half.streams]], [true, ['live/a']]);
  const noList = await lookAt({}, { client: { serverStatus: ok, liveStreams: fail } });
  assert.deepEqual([noList.reachable, noList.streams], [true, null]);
});

await check('a round over the fleet: evt/1 subjects, the system as actor, a removed server forgotten', async () => {
  const memory = new Map();
  const sent = [];
  const fleet = [{ _id: 's1', name: 'edge-1' }, { _id: 's2', name: 'edge-2' }];
  const answers = { s1: [up('live/a'), up('live/a', 'live/b'), DOWN, DOWN], s2: [up(), up(), up(), up()] };
  for (let i = 0; i < 4; i++) {
    await watchOnce({ servers: fleet, look: async (s) => answers[s._id][i], send: (e) => sent.push(e), memory, now: new Date(Date.UTC(2026, 10, 11, 0, 0, i * 30)) });
  }
  assert.deepEqual(sent.map(e => e.type), ['stream.up', 'server.unreachable']);
  assert.deepEqual(sent[0].subject, { kind: 'stream', id: 'live/b', server_id: 's1', name: 'live/b' });
  assert.deepEqual(sent[1].subject, { kind: 'server', id: 's1', server_id: 's1', name: 'edge-1' });
  assert.deepEqual(sent[1].actor, { kind: 'system', name: 'nnm-control' });
  assert.equal(sent[1].data.server, 'edge-1');
  await watchOnce({ servers: [fleet[1]], look: async () => up(), send: () => {}, memory });
  assert.deepEqual([...memory.keys()], ['s2']);
});

await check('a server whose look throws is a server that did not answer, not a stopped round', async () => {
  const memory = new Map([['s1', { reachable: true, fails: 1, downSince: null, streams: new Map() }]]);
  const sent = [];
  await watchOnce({ servers: [{ _id: 's1', name: 'x' }, { _id: 's2', name: 'y' }], memory, send: (e) => sent.push(e),
    look: async (s) => { if (s._id === 's1') throw new Error('boom'); return up(); } });
  assert.deepEqual(sent.map(e => e.type), ['server.unreachable']);
});

console.log('\nCERTIFICATES:');

const NOW = new Date('2026-11-11T00:00:00Z');
const inDays = (d) => new Date(NOW.getTime() + d * 86400000 + 3600000).toISOString();
const srv = { _id: 's1', name: 'edge-1', httpsPort: 0, gateway: { domain: 'gw.example.net' },
  playbackEndpoints: [{ host: 'cdn.example.net', ssl: true }, { host: '203.0.113.5', ssl: true }, { host: 'plain.example.net', ssl: false }] };

await check('the names a viewer reaches it by over TLS — not addresses, not plain http', () => {
  assert.deepEqual(certTargets(srv), [{ host: 'gw.example.net', port: 443 }, { host: 'cdn.example.net', port: 443 }]);
  assert.deepEqual(certTargets({ ...srv, httpsPort: 8443, gateway: {} }), [{ host: 'cdn.example.net', port: 8443 }]);
});

await check(`warned from ${WARN_DAYS} days left, not before; expired says so`, () => {
  const t = { host: 'cdn.example.net', port: 443 };
  assert.equal(certEvent(srv, t, { tls: true, certExpiresAt: inDays(WARN_DAYS + 1) }, NOW), null);
  const ev = certEvent(srv, t, { tls: true, certExpiresAt: inDays(WARN_DAYS), certTrusted: true }, NOW);
  assert.equal(ev.type, 'certificate.expiring');
  assert.equal(ev.data.days_left, WARN_DAYS);
  assert.deepEqual(ev.subject, { kind: 'certificate', id: 'cdn.example.net:443', server_id: 's1', name: 'cdn.example.net' });
  const gone = certEvent(srv, t, { tls: true, certExpiresAt: inDays(-3) }, NOW);
  assert.equal(gone.data.expired, true);
  assert.equal(gone.data.trusted, false);
});

await check('nothing read from the wire is not «expiring»', () => {
  assert.equal(certEvent(srv, { host: 'h', port: 443 }, { ok: false, tls: false, reason: 'timeout' }, NOW), null);
  assert.equal(certEvent(srv, { host: 'h', port: 443 }, null, NOW), null);
});

await check('once a day per name, asked of the event log so a restart does not repeat it', async () => {
  const said = new Map();
  const sent = [];
  const probe = async (host) => ({ tls: true, certExpiresAt: host === 'gw.example.net' ? inDays(5) : inDays(90) });
  const saidSince = async (id, since) => (said.get(id) || 0) >= since.getTime();
  const send = async (e) => { sent.push(e); said.set(e.subject.id, NOW.getTime()); };
  await certificatesOnce({ servers: [srv], probe, send, now: NOW, saidSince });
  await certificatesOnce({ servers: [srv], probe, send, now: new Date(NOW.getTime() + 3600000), saidSince });
  assert.deepEqual(sent.map(e => e.subject.id), ['gw.example.net:443']);
  await certificatesOnce({ servers: [srv], probe, send, now: new Date(NOW.getTime() + 24 * 3600000), saidSince });
  assert.equal(sent.length, 2, 'the next day it is said again');
  const unprobed = [];
  await certificatesOnce({ servers: [srv], probe: async () => { throw new Error('x'); }, send: (e) => unprobed.push(e), now: NOW, saidSince: async () => false });
  assert.equal(unprobed.length, 0, 'a probe that failed is not a certificate');
});

console.log('\nWIRING:');

await check('the settings are clamped and default to on, every 30 s, down after 2', () => {
  assert.deepEqual(watchSettings({}), { ...DEFAULTS });
  assert.deepEqual(watchSettings({ eventWatch: { enabled: false, intervalSec: 1, downAfter: 99 } }), { enabled: false, intervalSec: 10, downAfter: 10 });
});

await check('the five types are offered to subscriptions and started with the panel', () => {
  for (const t of ['server.unreachable', 'server.reachable', 'stream.up', 'stream.down', 'certificate.expiring']) assert.ok(EVENT_TYPES.includes(t), t);
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.ok(index.indexOf('startEventWatch()') > index.indexOf('configureEvents('), 'after events can be written');
  const route = readFileSync(new URL('../src/routes/webhooks.js', import.meta.url), 'utf8');
  assert.ok(route.includes("webhooksRouter.put('/watch'") && route.includes('await startEventWatch()'), 'a change takes effect at once');
  const page = readFileSync(new URL('../../frontend/src/pages/WebhooksPage.jsx', import.meta.url), 'utf8');
  assert.ok(page.includes("api('/webhooks/watch'") && page.includes('<WatchPanel />'), 'and the operator can reach it');
});

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
