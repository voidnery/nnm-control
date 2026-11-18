// /api/v1 and API tokens (nnm-api/1, docs/api/PROPOSAL-nnm-api-1.md §2). Real HTTP through the real
// router; the database models and the WMSPanel client are replaced by in-memory stand-ins, so the
// test runs where CI runs — without MongoDB and without WMSPanel.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { ApiToken } from '../src/models/ApiToken.js';
import { NimbleServer } from '../src/models/NimbleServer.js';
import { Settings } from '../src/models/Settings.js';
import { wmspanel } from '../src/services/wmspanelClient.js';
import {
  generateToken, parseToken, grantable, cidrList, authenticate, rateLimiter, NEVER_FOR_TOKENS, publicToken, hashSecret,
} from '../src/services/apiTokens.js';
import { etagOf, ifMatchOk, itemsOf, KINDS } from '../src/api/streamKinds.js';
import { setStore, apiLimits, secondsToReset, remember, LIMIT_DEFAULTS } from '../src/services/apiBudget.js';
import { DAILY_LIMIT } from '../src/models/ApiUsage.js';

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

// ---- stand-ins ----
const tokens = new Map();
const issue = (over = {}) => {
  const g = generateToken();
  tokens.set(g.tokenId, {
    name: over.name || 'ci', tokenId: g.tokenId, secretHash: g.secretHash,
    permissions: ['servers.view', 'wmsobjects.view', 'wmsobjects.manage'], allowCidrs: [],
    expiresAt: null, revokedAt: null, ratePerMin: 600, save: async () => {}, ...over,
  });
  return g.raw;
};
ApiToken.findOne = async ({ tokenId }) => tokens.get(tokenId) || null;
const SERVERS = {
  aaaaaaaaaaaaaaaaaaaaaaaa: { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'edge-1', host: '192.0.2.1', wmspanelServerId: 'wms1', tags: [] },
  bbbbbbbbbbbbbbbbbbbbbbbb: { _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: 'loose', host: '192.0.2.2', wmspanelServerId: '', tags: [] },
};
NimbleServer.findById = async (id) => SERVERS[id] || null;
NimbleServer.find = () => ({ sort: async () => Object.values(SERVERS) });
let limits = {};
Settings.load = async () => ({ wmspanel: { clientId: 'c', apiKey: 'k' }, apiLimits: limits });
const UDP0 = { id: 'u1', name: 'out-1', ip: '239.0.0.1', port: 1234, source_streams: [{ app: 'live', stream: 'a' }], status: 'ok', bandwidth: 100 };
let udp = [UDP0];
const calls = [];
let listCalls = 0;
wmspanel.udpList = async () => { listCalls++; return { settings: udp }; };
// The panel's copies and its WMSPanel counts (services/apiBudget.js), in memory.
const mem = { copies: new Map(), calls: 0, apiCalls: 0 };
setStore({
  get: async (sid, list) => mem.copies.get(`${sid}/${list}`) || null,
  put: async (sid, list, items, fetchedAt = new Date()) => { mem.copies.set(`${sid}/${list}`, { items, fetchedAt }); },
  usage: async () => ({ calls: mem.calls, apiCalls: mem.apiCalls }),
  charge: async () => { mem.apiCalls++; },
});
wmspanel.liveStreams = async () => { throw new Error('the API must not ask WMSPanel for live streams'); };
wmspanel.udpUpdate = async (_c, sid, id, patch) => {
  calls.push(['udpUpdate', sid, id, patch]);
  udp = udp.map(o => (o.id === id ? { ...o, ...patch } : o));
  return { status: 'Ok' };
};
wmspanel.udpDelete = async (_c, sid, id) => { calls.push(['udpDelete', sid, id]); udp = udp.filter(o => o.id !== id); };
wmspanel.outgoingAction = async (_c, sid, id, a) => { calls.push(['outgoingAction', sid, id, a]); return { status: 'Ok' }; };
wmspanel.hotswapList = async () => { throw Object.assign(new Error('Error: server not found'), { data: { status: 'Error' } }); };

const { v1Router, setLiveSource, liveItems } = await import('../src/api/v1.js');
const app = express();
app.use(express.json());
app.use('/api/v1', v1Router);
const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}/api/v1`;
const call = async (method, path, { token, body, headers = {} } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, json, headers: res.headers };
};
const U = '/servers/aaaaaaaaaaaaaaaaaaaaaaaa/stream-objects/udp';

console.log('\nTOKENS:');

await check('a token is nnm_<8 hex>_<43 base64url>, and parses back', () => {
  const g = generateToken();
  assert.match(g.raw, /^nnm_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(parseToken(g.raw), { tokenId: g.tokenId, secret: g.secret });
  assert.equal(parseToken('nnm_xyz'), null);
  assert.equal(g.secretHash, hashSecret(g.secret));
});

await check('only the hash is kept; what the panel shows has neither secret nor hash', () => {
  const g = generateToken();
  const shown = publicToken({ _id: 'x', name: 'n', tokenId: g.tokenId, secretHash: g.secretHash, permissions: [] });
  const text = JSON.stringify(shown);
  assert.ok(!text.includes(g.secret) && !text.includes(g.secretHash));
  assert.equal(shown.prefix, `nnm_${g.tokenId}_…`);
});

await check('a token gets only the issuer\'s rights, and never the right to make rights', () => {
  assert.deepEqual(grantable(['streams.view'], ['streams.view']), { ok: true, permissions: ['streams.view'] });
  assert.equal(grantable(['wmsobjects.manage'], ['streams.view']).ok, false);
  // Named here, not read from the module: a list that loses an entry must fail this, not shrink it.
  for (const k of ['users.manage', 'roles.manage', 'apitokens.manage', 'webhooks.manage']) {
    assert.deepEqual(grantable([k], ['*']).refused, [k], k);
    assert.ok(NEVER_FOR_TOKENS.includes(k), k);
  }
  assert.equal(grantable(['no.such'], ['*']).ok, false);
  assert.equal(grantable([], ['*']).ok, false);
});

await check('CIDR lists: empty allows all, a list allows only its ranges, bad entries are named', () => {
  assert.equal(cidrList([]).allows('203.0.113.9'), true);
  const c = cidrList(['10.0.0.0/8', '2001:db8::/32']);
  assert.equal(c.allows('10.2.3.4'), true);
  assert.equal(c.allows('::ffff:10.2.3.4'), true);
  assert.equal(c.allows('2001:db8::1'), true);
  assert.equal(c.allows('192.168.1.1'), false);
  assert.deepEqual(cidrList(['10.0.0.0/33', 'host']).bad, ['10.0.0.0/33', 'host']);
});

await check('a wrong secret, a revoked, an expired or an off-range token is refused', async () => {
  const g = generateToken();
  const rec = { tokenId: g.tokenId, secretHash: g.secretHash, allowCidrs: [] };
  const find = async () => rec;
  assert.equal((await authenticate(g.raw, { find })).ok, true);
  assert.equal((await authenticate(`nnm_${g.tokenId}_${'A'.repeat(43)}`, { find })).why, 'secret');
  assert.equal((await authenticate(g.raw, { find: async () => ({ ...rec, revokedAt: new Date() }) })).why, 'revoked');
  assert.equal((await authenticate(g.raw, { find: async () => ({ ...rec, expiresAt: new Date(0) }) })).why, 'expired');
  assert.equal((await authenticate(g.raw, { find: async () => ({ ...rec, allowCidrs: ['10.0.0.0/8'] }), ip: '192.0.2.1' })).why, 'address');
});

await check('the rate limit counts per token per minute', () => {
  const lim = rateLimiter();
  const t0 = 60000 * 1000;
  assert.equal(lim('a', 2, t0), null);
  assert.equal(lim('a', 2, t0 + 1), null);
  assert.equal(lim('a', 2, t0 + 2), 60);
  assert.equal(lim('b', 2, t0 + 3), null, 'another token shares the window');
  assert.equal(lim('a', 2, t0 + 60000), null, 'the next minute starts afresh');
});

console.log('\nAUTHENTICATION OVER HTTP:');

await check('no token and a bad token are 401 in the API\'s error shape', async () => {
  assert.equal((await call('GET', '/servers')).status, 401);
  const bad = await call('GET', '/servers', { token: `nnm_00000000_${'A'.repeat(43)}` });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.code, 'unauthorized');
});

await check('a valid token reads the servers', async () => {
  const r = await call('GET', '/servers', { token: issue() });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items.map(s => s.name), ['edge-1', 'loose']);
  assert.equal(r.json.next, null);
});

await check('a missing permission is 403 with its name', async () => {
  const r = await call('GET', U, { token: issue({ permissions: ['servers.view'] }) });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'forbidden');
  assert.match(r.json.error, /wmsobjects\.view/);
});

await check('over the rate limit: 429 with Retry-After', async () => {
  const t = issue({ ratePerMin: 2 });
  await call('GET', '/servers', { token: t });
  await call('GET', '/servers', { token: t });
  const r = await call('GET', '/servers', { token: t });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
});

console.log('\nSTREAM SETTINGS:');
const tok = issue();

await check('a kind is listed with an ETag per object', async () => {
  const r = await call('GET', U, { token: tok });
  assert.equal(r.status, 200);
  assert.equal(r.json.items[0].id, 'u1');
  assert.equal(r.json.items[0].etag, etagOf(udp[0]));
});

await check('one object: its fields as WMSPanel names them, and an ETag header', async () => {
  const r = await call('GET', `${U}/u1`, { token: tok });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.source_streams, [{ app: 'live', stream: 'a' }]);
  assert.equal(r.headers.get('etag'), etagOf(udp[0]));
});

await check('the source of a UDP stream is replaced with PATCH and If-Match', async () => {
  const before = await call('GET', `${U}/u1`, { token: tok });
  const r = await call('PATCH', `${U}/u1`, {
    token: tok, headers: { 'If-Match': before.headers.get('etag') },
    body: { source_streams: [{ app: 'live', stream: 'b' }] },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.source_streams, [{ app: 'live', stream: 'b' }]);
  assert.deepEqual(calls.at(-1), ['udpUpdate', 'wms1', 'u1', { source_streams: [{ app: 'live', stream: 'b' }] }]);
  assert.notEqual(r.headers.get('etag'), before.headers.get('etag'));
});

await check('a stale If-Match is 412 with the current object, and nothing is written', async () => {
  const n = calls.length;
  const r = await call('PATCH', `${U}/u1`, { token: tok, headers: { 'If-Match': '"stale"' }, body: { port: 1 } });
  assert.equal(r.status, 412);
  assert.equal(r.json.code, 'precondition_failed');
  assert.equal(r.json.details.current.id, 'u1');
  assert.equal(calls.length, n);
});

await check('telemetry does not change the ETag; configuration does', () => {
  const o = { id: 'x', port: 1, status: 'ok', bandwidth: 5 };
  assert.equal(etagOf(o), etagOf({ ...o, status: 'down', bandwidth: 9 }));
  assert.notEqual(etagOf(o), etagOf({ ...o, port: 2 }));
  assert.equal(ifMatchOk(undefined, '"a"'), true);
  assert.equal(ifMatchOk('*', '"a"'), true);
  assert.equal(ifMatchOk('W/"a", "b"', '"a"'), true);
  assert.equal(ifMatchOk('"b"', '"a"'), false);
});

await check('an action of a kind runs; an unknown action or kind is 404 naming what exists', async () => {
  const o = await call('POST', '/servers/aaaaaaaaaaaaaaaaaaaaaaaa/stream-objects/mpegts-out/x1/actions/restart', { token: tok });
  assert.equal(o.status, 200);
  assert.deepEqual(calls.at(-1), ['outgoingAction', 'wms1', 'x1', 'restart']);
  const a = await call('POST', `${U}/u1/actions/explode`, { token: tok });
  assert.equal(a.status, 404);
  assert.equal(a.json.code, 'unknown_action');
  const k = await call('GET', '/servers/aaaaaaaaaaaaaaaaaaaaaaaa/stream-objects/nope', { token: tok });
  assert.equal(k.status, 404);
  assert.ok(k.json.details.kinds.includes('udp'));
});

await check('DELETE removes the object; an unknown object is 404', async () => {
  const etag = (await call('GET', `${U}/u1`, { token: tok })).headers.get('etag');
  const r = await call('DELETE', `${U}/u1`, { token: tok, headers: { 'If-Match': etag } });
  assert.equal(r.status, 204);
  assert.deepEqual(calls.at(-1), ['udpDelete', 'wms1', 'u1']);
  assert.equal((await call('GET', `${U}/u1`, { token: tok })).status, 404);
});

await check('a server not mapped to WMSPanel is 409; a WMSPanel refusal is 502 saying so', async () => {
  const m = await call('GET', '/servers/bbbbbbbbbbbbbbbbbbbbbbbb/stream-objects/udp', { token: tok });
  assert.equal(m.status, 409);
  assert.equal(m.json.code, 'not_mapped');
  const u = await call('GET', '/servers/aaaaaaaaaaaaaaaaaaaaaaaa/stream-objects/hotswap', { token: tok });
  assert.equal(u.status, 502);
  assert.equal(u.json.code, 'upstream_failed');
  assert.match(u.json.error, /^WMSPanel: /);
});

await check('an unknown path is a JSON 404, not the panel', async () => {
  const r = await call('GET', '/nothing', { token: tok });
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'not_found');
});

console.log('\nTHE WMSPANEL BUDGET (an API token must not be able to spend the panel\'s):');
const fresh = () => { udp = [{ ...UDP0 }]; mem.copies.clear(); mem.calls = 0; mem.apiCalls = 0; listCalls = 0; limits = {}; };
const expire = () => { for (const c of mem.copies.values()) c.fetchedAt = new Date(0); };

await check('reads come from the panel\'s copy: a hundred reads cost WMSPanel one call', async () => {
  fresh();
  for (let i = 0; i < 100; i++) assert.equal((await call('GET', U, { token: tok })).status, 200);
  await Promise.all([1, 2, 3].map(() => call('GET', `${U}/u1`, { token: tok })));
  assert.equal(listCalls, 1);
  assert.equal(mem.apiCalls, 1);
});

await check('a list the panel already read for its own screens costs the API nothing', async () => {
  fresh();
  await remember('wms1', 'udpList', { settings: udp });
  const r = await call('GET', U, { token: tok });
  assert.equal(r.status, 200);
  assert.equal(r.json.items[0].id, 'u1');
  assert.equal(r.json.stale, false);
  assert.ok(r.headers.get('x-data-fetched-at'));
  assert.equal(listCalls, 0);
});

await check('a PATCH is exactly one WMSPanel call, and the copy shows the change', async () => {
  fresh();
  const etag = (await call('GET', `${U}/u1`, { token: tok })).headers.get('etag');
  const before = listCalls;
  const r = await call('PATCH', `${U}/u1`, { token: tok, headers: { 'If-Match': etag }, body: { port: 5000 } });
  assert.equal(r.status, 200);
  assert.equal(listCalls, before, 'not read back');
  assert.equal(mem.apiCalls, 2, 'one read, one write');
  assert.equal((await call('GET', `${U}/u1`, { token: tok })).json.port, 5000);
  assert.equal(listCalls, before);
});

await check('the copy is refreshed once it is older than refreshSec', async () => {
  fresh();
  await call('GET', U, { token: tok });
  expire();
  await call('GET', U, { token: tok });
  assert.equal(listCalls, 2);
});

await check('out of the API\'s allowance: reads answer from the copy, saying so; writes are 429 until the day turns', async () => {
  fresh();
  await call('GET', U, { token: tok });
  mem.apiCalls = LIMIT_DEFAULTS.dailyCalls;
  expire();
  const r = await call('GET', U, { token: tok });
  assert.equal(r.status, 200);
  assert.equal(r.json.stale, true);
  assert.equal(r.headers.get('x-data-stale'), 'wmspanel_budget');
  assert.equal(listCalls, 1, 'WMSPanel not asked');
  const n = calls.length;
  const w = await call('PATCH', `${U}/u1`, { token: tok, body: { port: 1 } });
  assert.equal(w.status, 429);
  assert.equal(w.json.code, 'wmspanel_budget');
  assert.equal(w.json.details.reason, 'api_allowance');
  assert.ok(Number(w.headers.get('retry-after')) > 0);
  assert.equal(calls.length, n, 'nothing written');
});

await check('the panel\'s reserve holds even when the API has allowance left', async () => {
  fresh();
  mem.calls = Math.floor(DAILY_LIMIT * 0.8);
  const r = await call('GET', U, { token: tok });
  assert.equal(r.status, 429, 'no copy and no budget');
  assert.equal(r.json.details.reason, 'panel_reserve');
  assert.equal(listCalls, 0);
  const a = await call('POST', '/servers/aaaaaaaaaaaaaaaaaaaaaaaa/stream-objects/mpegts-out/x1/actions/restart', { token: tok });
  assert.equal(a.status, 429);
});

await check('WMSPanel failing with a copy at hand: the copy, marked stale', async () => {
  fresh();
  await call('GET', U, { token: tok });
  expire();
  const keep = wmspanel.udpList;
  wmspanel.udpList = async () => { throw new Error('down'); };
  const r = await call('GET', U, { token: tok });
  wmspanel.udpList = keep;
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-data-stale'), 'upstream_failed');
});

await check('the limits are held to a sane range; the day turns at UTC midnight', () => {
  assert.deepEqual(apiLimits({}), LIMIT_DEFAULTS);
  assert.deepEqual(apiLimits({ apiLimits: { dailyCalls: 10 ** 9, refreshSec: 1, reservePct: 100 } }),
    { dailyCalls: DAILY_LIMIT, refreshSec: 60, reservePct: 90 });
  assert.equal(secondsToReset(new Date('2026-11-18T23:59:00Z')), 60);
});

await check('the panel\'s own screens keep the copy for every kind', () => {
  const src = readFileSync(new URL('../src/routes/wmspanelProxy.js', import.meta.url), 'utf8');
  for (const [k, v] of Object.entries(KINDS)) assert.ok(src.includes(`listed('${v.list}', rq)`), k);
});

console.log('\nLIVE STREAMS (Nimble\'s own API, never WMSPanel):');

await check('each stream of each application is one item', async () => {
  setLiveSource(async () => [{ app: 'live', streams: [{ strm: 'a', bandwidth: 10 }, { strm: 'b' }] }, { app: 'vod', streams: [] }]);
  const r = await call('GET', '/servers/aaaaaaaaaaaaaaaaaaaaaaaa/streams', { token: issue({ permissions: ['streams.view'] }) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items.map(s => `${s.app}/${s.stream}`), ['live/a', 'live/b']);
  assert.equal(r.json.items[0].bandwidth, 10);
  assert.deepEqual(liveItems({ streams: [{ application: 'x', stream: 'y' }] }).map(s => `${s.app}/${s.stream}`), ['x/y']);
});

await check('a server Nimble does not answer for is a 502 saying so', async () => {
  setLiveSource(async () => { throw new Error('ECONNREFUSED'); });
  const r = await call('GET', '/servers/bbbbbbbbbbbbbbbbbbbbbbbb/streams', { token: issue({ permissions: ['streams.view'] }) });
  assert.equal(r.status, 502);
  assert.equal(r.json.code, 'nimble_failed');
  setLiveSource(null);
});

console.log('\nWIRING:');

await check('every kind names list/create/update/remove and its rights', () => {
  for (const [k, v] of Object.entries(KINDS)) {
    for (const f of ['list', 'create', 'update', 'remove']) assert.equal(typeof wmspanel[v[f]], 'function', `${k}.${f}`);
    assert.ok(v.view && v.manage, k);
  }
  assert.deepEqual(itemsOf({ applications: [1] }), [1]);
  assert.deepEqual(itemsOf({ other: [2] }), [2]);
});

await check('the API is mounted, after the audit middleware, and the token routes too', () => {
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const audit = index.indexOf("app.use('/api', auditMutations)");
  const v1 = index.indexOf("app.use('/api/v1', v1Router)");
  assert.ok(audit >= 0 && v1 > audit, 'v1 is not mounted after auditMutations');
  assert.match(index, /app\.use\('\/api\/api-tokens', apiTokensRouter\)/);
});

await check('and before every router mounted on the whole of /api', () => {
  // geoipRouter is mounted on '/api' and runs requireAuth on whatever reaches it. With /api/v1 mounted
  // after it, every v1 call met a JWT check first: the open description answered 401 and no `nnm_` token
  // worked — the checks here mount v1 alone and could not see it; the eterix-lab run of 1.32.0 did.
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const v1 = index.indexOf("app.use('/api/v1', v1Router)");
  const catchAll = [...index.matchAll(/app\.use\('\/api', (\w+)\)/g)].filter(m => m[1] !== 'auditMutations');
  assert.ok(catchAll.length > 0, 'no router on /api found — the check would pass vacuously');
  for (const m of catchAll) assert.ok(m.index > v1, `${m[1]} is mounted on /api before /api/v1`);
});

await check('a token appears in the audit log by name and id, never by its secret', () => {
  const src = readFileSync(new URL('../src/api/v1.js', import.meta.url), 'utf8');
  assert.match(src, /username: `token:\$\{t\.name\}#\$\{t\.tokenId\}`/);
});

srv.close();
console.log(failures ? `\n${failures} api/v1 check(s) failed` : '\nall api/v1 checks passed');
process.exit(failures ? 1 : 0);
