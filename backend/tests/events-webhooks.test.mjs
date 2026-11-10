// Events (evt/1) and webhooks — eterix-contracts/evt-1.md rev.1, docs/api/PROPOSAL-nnm-api-1.md §3.
// Pure rules directly; delivery over real HTTP to a server of this test; the dispatcher with
// in-memory models; wiring read from the source.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import {
  ulid, maskSecrets, changedFields, envelope, signature, wants, nextAttemptAt, RETRY_DELAYS_MS, DISABLE_AFTER,
  ensureInstance, configureEvents, emit, isSecretKey, EVENT_TYPES,
} from '../src/services/events.js';
import { refusedAddress, checkUrl, resolveChecked, sendOnce, settle, dispatchOnce } from '../src/services/webhooks.js';
import { channelEventType, healthyCheck } from '../src/services/deliveryMonitor.js';
import { objectEventOf } from '../src/routes/wmspanelProxy.js';

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};
const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');

console.log('\nTHE ENVELOPE (evt/1 §2):');

await check('ULID: 26 Crockford base32 characters, ordered by time', () => {
  const a = ulid(1_700_000_000_000), b = ulid(1_700_000_000_001);
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(a < b);
});

await check('every field of the envelope, the type without the product, the product as its slug', () => {
  const e = envelope({
    type: 'stream_object.changed', subject: { kind: 'udp', id: 'u1', server_id: 's1', name: 'out' },
    actor: { kind: 'token', name: 'ci' }, instance: { id: 'I', name: 'panel' }, data: { x: 1 },
    now: new Date('2026-11-10T12:00:00.123Z'),
  });
  assert.deepEqual(Object.keys(e), ['schema_version', 'id', 'type', 'occurred_at', 'product', 'instance', 'subject', 'actor', 'data']);
  assert.equal(e.schema_version, 'evt/1');
  assert.equal(e.product, 'nnm-control');
  assert.equal(e.occurred_at, '2026-11-10T12:00:00Z');
  assert.deepEqual(e.actor, { kind: 'token', name: 'ci' });
  assert.ok(!e.type.includes('nnm'));
});

await check('a type outside <object>.<event>, or no subject kind, is refused', () => {
  assert.throws(() => envelope({ type: 'Changed', subject: { kind: 'x' } }));
  assert.throws(() => envelope({ type: 'nnm-control.changed', subject: { kind: 'x' } }));
  assert.throws(() => envelope({ type: 'a.b', subject: {} }));
  for (const t of EVENT_TYPES) envelope({ type: t, subject: { kind: 'x' } });
});

console.log('\nSECRETS (evt/1 §3):');

await check('secrets are masked; the shape and the fact of a change stay', () => {
  const m = maskSecrets({
    name: 'app', push_password: 'p4ss', stream_key: 'k', apiKey: 'a', keyframe_interval: 2,
    url: 'rtmp://user:pw@host/app', Source_AWS: { aws_secret_access_key: 's' }, nested: [{ token: 't' }], empty_pass: '',
  });
  assert.deepEqual(m, {
    name: 'app', push_password: '***', stream_key: '***', apiKey: '***', keyframe_interval: 2,
    url: 'rtmp://***@host/app', Source_AWS: '***', nested: [{ token: '***' }], empty_pass: '',
  });
  assert.deepEqual(changedFields({ a: 1, push_password: 'x' }, { a: 1, push_password: 'y', b: 2 }), ['b', 'push_password']);
});

await check('a secret is a word of the field name, not any substring', () => {
  for (const k of ['password', 'push_password', 'stream_key', 'aws_access_key_id', 'apiKey', 'authToken', 'credentials']) assert.ok(isSecretKey(k), k);
  for (const k of ['keyframe_interval', 'monkey', 'tokens_total', 'passthrough', 'name']) assert.ok(!isSecretKey(k), k);
});

await check('the envelope masks what it carries', () => {
  const e = envelope({ type: 'stream_object.changed', subject: { kind: 'apps' }, data: { after: { push_password: 'secret!' } } });
  assert.equal(e.data.after.push_password, '***');
  assert.ok(!JSON.stringify(e).includes('secret!'));
});

await check('API token names reach events and the audit log, the token never does', () => {
  const v1 = src('api/v1.js');
  assert.match(v1, /req\.actor = \{ kind: 'token', name: t\.name, tokenId: t\.tokenId \}/);
  assert.ok(!/actor[^\n]*bearer|actor[^\n]*secret/i.test(v1));
});

console.log('\nSIGNATURE AND DELIVERY RULES (evt/1 §4):');

await check('v1 = HMAC-SHA256(secret, timestamp + "." + body), as a receiver computes it', () => {
  const body = '{"a":1}';
  const want = crypto.createHmac('sha256', 's3cret').update(`1700000000.${body}`).digest('hex');
  assert.equal(signature('s3cret', '1700000000', body), `v1=${want}`);
});

await check('a subscription takes all types, listed types, or a whole object with .*', () => {
  assert.equal(wants({ enabled: true, types: [] }, 'agent.offline'), true);
  assert.equal(wants({ enabled: true, types: ['agent.offline'] }, 'agent.online'), false);
  assert.equal(wants({ enabled: true, types: ['stream_object.*'] }, 'stream_object.deleted'), true);
  assert.equal(wants({ enabled: false, types: [] }, 'agent.offline'), false);
  assert.equal(wants({ enabled: true, types: [] }, 'webhook.test'), false, 'a test goes only where it was asked for');
});

await check('retries: 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, then given up', () => {
  const t0 = new Date(0);
  assert.deepEqual(RETRY_DELAYS_MS, [60e3, 300e3, 1800e3, 7200e3, 21600e3, 43200e3]);
  assert.equal(nextAttemptAt(1, t0).getTime(), 60e3);
  assert.equal(nextAttemptAt(7, t0), null);
});

await check('a delivery settles: ok resets the streak; failures retry, then give up; 50 in a row turn the subscription off', () => {
  const sub = { enabled: true, consecutiveFailures: 3 };
  const d = { attempts: 0 };
  settle(d, sub, { ok: true, code: 204 });
  assert.equal(d.status, 'ok'); assert.equal(sub.consecutiveFailures, 0);
  const d2 = { attempts: 0 };
  for (let i = 0; i < 6; i++) settle(d2, sub, { ok: false, code: 500, error: 'HTTP 500' });
  assert.equal(d2.status, 'failed');
  settle(d2, sub, { ok: false, code: 500, error: 'HTTP 500' });
  assert.equal(d2.status, 'given_up');
  sub.consecutiveFailures = DISABLE_AFTER - 1;
  settle({ attempts: 0 }, sub, { ok: false, error: 'x' });
  assert.equal(sub.enabled, false);
  assert.match(sub.disabledReason, /50/);
});

console.log('\nWHERE THE PANEL DOES NOT SEND (evt/1 §4.4):');

await check('loopback, link-local, metadata, unspecified, multicast and the panel itself are refused', () => {
  for (const ip of ['127.0.0.1', '127.9.9.9', '::1', '169.254.1.1', '169.254.169.254', 'fe80::1', 'fd00:ec2::254',
    '0.0.0.0', '::', '224.0.0.1', 'ff02::1', '::ffff:127.0.0.1']) assert.ok(refusedAddress(ip), ip);
  assert.equal(refusedAddress('192.0.2.50', new Set(['192.0.2.50'])), 'the panel itself');
});

await check('private networks and public addresses are allowed', () => {
  for (const ip of ['10.1.2.3', '172.16.0.5', '192.168.1.10', 'fd12:3456::1', '203.0.113.7', '2001:db8::5']) {
    assert.equal(refusedAddress(ip, new Set()), null, ip);
  }
});

await check('https by default; http only when marked; no credentials in the URL', () => {
  assert.equal(checkUrl('https://hook.example/x').ok, true);
  assert.equal(checkUrl('http://10.0.0.5/x').ok, false);
  assert.equal(checkUrl('http://10.0.0.5/x', { allowHttp: true }).ok, true);
  assert.equal(checkUrl('ftp://h/x').ok, false);
  assert.equal(checkUrl('https://u:p@h/x').ok, false);
});

await check('a name is refused if ANY of its addresses is forbidden, checked after DNS', async () => {
  const lookup = async () => [{ address: '203.0.113.7', family: 4 }, { address: '127.0.0.1', family: 4 }];
  const r = await resolveChecked('mixed.example', { lookup, local: new Set() });
  assert.equal(r.ok, false);
  assert.match(r.why, /127\.0\.0\.1: loopback/);
  const lit = await resolveChecked('169.254.169.254', { local: new Set() });
  assert.equal(lit.ok, false);
});

console.log('\nDELIVERY OVER HTTP:');

const got = [];
let answer = 204;
const hook = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    got.push({ headers: req.headers, body });
    if (answer === 302) { res.writeHead(302, { Location: 'http://127.0.0.1:1/' }); return res.end(); }
    res.writeHead(answer); res.end('fine');
  });
});
await new Promise(r => hook.listen(0, '127.0.0.1', r));
const port = hook.address().port;
// The name resolves to this test's loopback server; the loopback refusal is lifted for the test only.
const deps = { lookup: async () => [{ address: '127.0.0.1', family: 4 }], local: new Set(), refuse: () => null };
const env = envelope({ type: 'agent.offline', subject: { kind: 'agent', id: 'a1' }, instance: { id: 'I', name: 'p' } });

await check('the request carries X-Eterix-* headers and a signature the receiver can verify', async () => {
  const r = await sendOnce({ url: `http://hook.example:${port}/in`, allowHttp: true, secret: 'abc', envelope: env, deps });
  assert.equal(r.ok, true);
  const h = got.at(-1).headers;
  assert.equal(h['x-eterix-event'], 'agent.offline');
  assert.equal(h['x-eterix-delivery'], env.id);
  assert.equal(h['content-type'], 'application/json');
  const expect = signature('abc', h['x-eterix-timestamp'], got.at(-1).body);
  assert.equal(h['x-eterix-signature'], expect);
  assert.ok(Math.abs(Number(h['x-eterix-timestamp']) - Date.now() / 1000) < 60);
  assert.deepEqual(JSON.parse(got.at(-1).body), env);
});

await check('the connection goes to the checked address, not wherever the name resolves later', () => {
  assert.match(src('services/webhooks.js'), /lookup: \(_h, opts, cb\) => \(opts\?\.all \? cb\(null, \[\{ address: r\.address, family: r\.family \}\]\) : cb\(null, r\.address, r\.family\)\)/);
});

await check('a redirect is a failure and is not followed', async () => {
  answer = 302;
  const n = got.length;
  const r = await sendOnce({ url: `http://hook.example:${port}/in`, allowHttp: true, secret: 'abc', envelope: env, deps });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'redirects are not followed');
  assert.equal(got.length, n + 1, 'one request only — the redirect was not followed');
  answer = 204;
});

await check('without deps the panel refuses its own loopback before sending anything', async () => {
  const n = got.length;
  const r = await sendOnce({ url: `http://127.0.0.1:${port}/in`, allowHttp: true, secret: 'abc', envelope: env });
  assert.equal(r.refused, true);
  assert.equal(got.length, n);
});

console.log('\nTHE DISPATCHER:');

await check('a due delivery is sent once and settled; an off subscription is skipped', async () => {
  const saved = [];
  const mk = (o) => ({ ...o, save: async function () { saved.push(this); } });
  const subOn = mk({ _id: 's1', enabled: true, url: 'https://x/in', secret: 's', allowHttp: false, consecutiveFailures: 0 });
  const subOff = mk({ _id: 's2', enabled: false, url: 'https://x/in', secret: 's', allowHttp: false });
  const d1 = mk({ subscriptionId: 's1', eventId: env.id, type: env.type, attempts: 0, status: 'pending' });
  const d2 = mk({ subscriptionId: 's2', eventId: env.id, type: env.type, attempts: 0, status: 'pending' });
  const models = {
    WebhookDelivery: { find: () => ({ sort: () => ({ limit: async () => [d1, d2] }) }) },
    WebhookSubscription: { findById: async (id) => (id === 's1' ? subOn : subOff) },
    Event: { findOne: async () => ({ envelope: env }) },
  };
  const sent = [];
  const out = await dispatchOnce({ ...models, send: async (a) => { sent.push(a.url); return { ok: true, code: 200 }; } });
  assert.deepEqual(out, { sent: 1, ok: 1, failed: 0 });
  assert.equal(d1.status, 'ok');
  assert.equal(d2.status, 'skipped');
  assert.deepEqual(sent, ['https://x/in']);
});

console.log('\nEMITTING:');

await check('the instance id is created once and kept', async () => {
  const doc = { instanceId: '', instanceName: '', publicUrl: 'https://panel.example', save: async () => {} };
  const S = { load: async () => doc };
  const a = await ensureInstance(S);
  assert.match(a.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(a.name, 'panel.example');
  assert.equal((await ensureInstance(S)).id, a.id);
});

await check('emit writes the event and a delivery per subscription that wants it', async () => {
  const events = [], deliveries = [];
  configureEvents({
    Settings: { load: async () => ({ instanceId: 'X', publicUrl: '', save: async () => {} }) },
    Event: { create: async (d) => events.push(d) },
    WebhookSubscription: { find: async () => [{ _id: 'a', enabled: true, types: [] }, { _id: 'b', enabled: true, types: ['playlist.*'] }] },
    WebhookDelivery: { insertMany: async (l) => deliveries.push(...l) },
  });
  const e = await emit({ type: 'agent.online', subject: { kind: 'agent', id: '1' }, data: { token: 'zzz' } });
  assert.equal(events.length, 1);
  assert.equal(events[0].envelope.data.token, '***');
  assert.deepEqual(deliveries.map(d => d.subscriptionId), ['a']);
  assert.equal(deliveries[0].eventId, e.id);
  configureEvents(null);
});

await check('emit never throws into the action that caused it', async () => {
  configureEvents({ Settings: { load: async () => { throw new Error('db down'); } } });
  assert.equal(await emit({ type: 'agent.online', subject: { kind: 'agent' } }), null);
  configureEvents(null);
});

await check('a channel changing health is an event; staying the same, or first seen healthy, is not', () => {
  assert.equal(channelEventType(undefined, true), null);
  assert.equal(channelEventType(undefined, false), 'channel.unhealthy');
  assert.equal(channelEventType(true, false), 'channel.unhealthy');
  assert.equal(channelEventType(false, true), 'channel.healthy');
  assert.equal(channelEventType(true, true), null);
  assert.equal(healthyCheck({ ok: 0, total: 0 }), false);
});

await check('a change from the panel\'s screens is the same kind of event', () => {
  assert.equal(objectEventOf('PUT', '/server/s/udp/u1', {}).type, 'stream_object.changed');
  assert.equal(objectEventOf('POST', '/server/s/incoming', {}).subject.kind, 'mpegts-in');
  assert.equal(objectEventOf('DELETE', '/server/s/apps/a1', {}).type, 'stream_object.deleted');
  assert.equal(objectEventOf('POST', '/server/s/livepull/l1/restart', {}).data.action, 'restart');
  assert.equal(objectEventOf('GET', '/server/s/udp', null), null);
  assert.equal(objectEventOf('POST', '/sync', {}), null);
});

await check('every source emits: API, panel, playlists, watchdog, delivery monitor', () => {
  assert.match(src('api/v1.js'), /'stream_object\.changed', req\.params\.objId,\s*\{ before: f\.obj, after: after\.obj/);
  assert.match(src('routes/wmspanelProxy.js'), /if \(res\.statusCode < 400\) emit\(/);
  for (const t of ['playlist.deployed', 'playlist.stream_stopped', 'playlist.stream_started']) assert.ok(src('routes/agentProxy.js').includes(`'${t}'`), t);
  assert.match(src('services/agentWatchdog.js'), /healthy \? 'agent\.online' : 'agent\.offline'/);
  assert.match(src('services/deliveryMonitor.js'), /channelEventType\(before, nowHealthy\)/);
});

await check('started at boot: instance, events, dispatcher; TTL on events and deliveries', () => {
  const index = src('index.js');
  assert.match(index, /await ensureInstance\(Settings\)/);
  assert.match(index, /configureEvents\(\{ Settings, Event, WebhookSubscription, WebhookDelivery \}\)/);
  assert.match(index, /startWebhookDispatcher\(/);
  assert.match(index, /reconcileTtl\(\[[^\]]*Event, WebhookDelivery\]\)/);
  assert.match(src('models/Settings.js'), /instanceId: \{ type: String/);
});

hook.close();
console.log(failures ? `\n${failures} events/webhooks check(s) failed` : '\nall events/webhooks checks passed');
process.exit(failures ? 1 : 0);
