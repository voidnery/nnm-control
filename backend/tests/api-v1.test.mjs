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
Settings.load = async () => ({ wmspanel: { clientId: 'c', apiKey: 'k' } });
let udp = [{ id: 'u1', name: 'out-1', ip: '239.0.0.1', port: 1234, source_streams: [{ app: 'live', stream: 'a' }], status: 'ok', bandwidth: 100 }];
const calls = [];
wmspanel.udpList = async () => ({ settings: udp });
wmspanel.udpUpdate = async (_c, sid, id, patch) => {
  calls.push(['udpUpdate', sid, id, patch]);
  udp = udp.map(o => (o.id === id ? { ...o, ...patch } : o));
  return { status: 'Ok' };
};
wmspanel.udpDelete = async (_c, sid, id) => { calls.push(['udpDelete', sid, id]); udp = udp.filter(o => o.id !== id); };
wmspanel.outgoingAction = async (_c, sid, id, a) => { calls.push(['outgoingAction', sid, id, a]); return { status: 'Ok' }; };
wmspanel.hotswapList = async () => { throw Object.assign(new Error('Error: server not found'), { data: { status: 'Error' } }); };

const { v1Router } = await import('../src/api/v1.js');
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

await check('a token appears in the audit log by name and id, never by its secret', () => {
  const src = readFileSync(new URL('../src/api/v1.js', import.meta.url), 'utf8');
  assert.match(src, /username: `token:\$\{t\.name\}#\$\{t\.tokenId\}`/);
});

srv.close();
console.log(failures ? `\n${failures} api/v1 check(s) failed` : '\nall api/v1 checks passed');
process.exit(failures ? 1 : 0);
