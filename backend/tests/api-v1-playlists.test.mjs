// /api/v1, third part: live streams, playlists (stored and on a server) and the OpenAPI description
// (docs/api/PROPOSAL-nnm-api-1.md §2.3). Real HTTP through the real router. The database models,
// WMSPanel and the agent on the server are in-memory stand-ins: the agent answers the tasks the
// panel's own deploy path sends, so a deploy through the API goes through every check the panel
// makes — not a copy of them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { ApiToken } from '../src/models/ApiToken.js';
import { NimbleServer } from '../src/models/NimbleServer.js';
import { Settings } from '../src/models/Settings.js';
import { Playlist } from '../src/models/Playlist.js';
import { PlaylistDeploy } from '../src/models/PlaylistDeploy.js';
import { AgentTask } from '../src/models/AgentTask.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { wmspanel } from '../src/services/wmspanelClient.js';
import { deliverResult } from '../src/services/agentBus.js';
import { configureEvents } from '../src/services/events.js';
import { generateToken } from '../src/services/apiTokens.js';

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

// ---- stand-ins ----
const tokens = new Map();
const issue = (permissions) => {
  const g = generateToken();
  tokens.set(g.tokenId, {
    name: 'ci', tokenId: g.tokenId, secretHash: g.secretHash, permissions, allowCidrs: [],
    expiresAt: null, revokedAt: null, ratePerMin: 600, save: async () => {},
  });
  return g.raw;
};
ApiToken.findOne = async ({ tokenId }) => tokens.get(tokenId) || null;

const SID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const SERVERS = {
  [SID]: { _id: SID, name: 'edge-1', host: '192.0.2.1', wmspanelServerId: 'wms1', tags: [], agent: { enabled: true } },
  cccccccccccccccccccccccc: { _id: 'cccccccccccccccccccccccc', name: 'no-agent', host: '192.0.2.3', wmspanelServerId: 'wms3', tags: [], agent: { enabled: false } },
};
NimbleServer.findById = async (id) => SERVERS[id] || null;
Settings.load = async () => ({ wmspanel: { clientId: 'c', apiKey: 'k' }, instanceId: '01TESTINSTANCE', instanceName: 'ci', save: async () => {} });
wmspanel.liveStreams = async (_c, sid) => ({ streams: [{ id: 's1', application: 'live', stream: 'a', server: sid, bandwidth: 1 }] });
AuditLog.create = async () => ({});

// Stored playlists.
const playlists = new Map();
let nextId = 1;
const doc = (fields) => {
  const p = { _id: `p${String(nextId++).padStart(23, '0')}`, createdAt: new Date(), updatedAt: new Date(), ...fields };
  p.save = async () => { p.updatedAt = new Date(); playlists.set(p._id, p); return p; };
  p.deleteOne = async () => { playlists.delete(p._id); };
  return p;
};
Playlist.findById = async (id) => playlists.get(String(id)) || null;
Playlist.find = () => ({ sort: async () => [...playlists.values()] });
Playlist.create = async (fields) => { const p = doc({ model: { _kind: 'root', SyncInterval: null, Tasks: [] }, ...fields }); playlists.set(p._id, p); return p; };

// Version history.
const versions = [];
const chain = (list) => ({ sort: () => chain(list), limit: () => chain(list), select: () => chain(list), lean: async () => list });
PlaylistDeploy.create = async (v) => { const d = { _id: `v${versions.length}`, createdAt: new Date(Date.now() + versions.length), ...v }; versions.unshift(d); return d; };
PlaylistDeploy.findOne = (q = {}) => ({ lean: async () => versions.find(v => !q.sha256 || v.sha256 === q.sha256) || null });
PlaylistDeploy.find = (q = {}) => chain(versions.filter(v => (!q.filename || typeof q.filename !== 'string' || v.filename === q.filename)));

// The agent on the server: a file system of one directory of configs and one of media.
const files = new Map();
const media = new Set(['a.mp4', 'b.mp4', 'clip.mov']);
const tasks = [];
const agent = ({ route, query, body }) => {
  if (route === 'GET /config') {
    return files.has(query.name) ? { content: files.get(query.name), mtime: 1 } : { exists: false, dir: '/etc/nimble' };
  }
  if (route === 'PUT /config') { files.set(query.name, body.content); return { ok: true, bytes: body.content.length }; }
  if (route === 'GET /config/list') return { files: [...files.keys()].map(name => ({ name })) };
  if (route === 'GET /media') return { dir: '/srv/media', files: [...media].map(name => ({ name })) };
  if (route === 'POST /media/stat') return { root: '/srv/media', results: body.paths.map(p => ({ path: p, ok: media.has(p.split('/').pop()), reason: 'missing', size: 1 })) };
  if (route === 'POST /media/probe') return { results: [] };
  throw new Error(`the stand-in agent does not know ${route}`);
};
AgentTask.create = async (t) => {
  const task = { _id: `t${tasks.length}`, ...t };
  tasks.push(task);
  setImmediate(() => {
    try { deliverResult(task._id, { result: agent(task) }); }
    catch (e) { deliverResult(task._id, { error: e.message, status: 502 }); }
  });
  return task;
};

// Events, to see that a deploy through the API is announced like one from the panel.
const events = [];
configureEvents({
  Settings, Event: { create: async (e) => events.push(e.envelope) },
  WebhookSubscription: { find: async () => [] }, WebhookDelivery: { insertMany: async () => [] },
});

const { v1Router } = await import('../src/api/v1.js');
const { openapiDocument } = await import('../src/api/openapi.js');
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

const viewer = issue(['playlist.view', 'streams.view']);
const editor = issue(['playlist.view', 'playlist.manage', 'streams.view']);
const MODEL = {
  _kind: 'root', SyncInterval: 1000,
  Tasks: [{ _kind: 'task', _id: 'x1', Stream: 'live/out', Blocks: [{ _kind: 'block', _id: 'x2', Id: null, MaxIterations: 0, Start: null,
    Streams: [{ _kind: 'stream', _id: 'x3', Type: 'vod', Source: '/srv/media/a.mp4', MaxIterations: null }] }] }],
};

console.log('\nLIVE STREAMS:');

await check('the live view of a server is a list, behind streams.view', async () => {
  const r = await call('GET', `/servers/${SID}/streams`, { token: viewer });
  assert.equal(r.status, 200);
  assert.equal(r.json.items[0].stream, 'a');
  assert.equal(r.json.next, null);
  const none = await call('GET', `/servers/${SID}/streams`, { token: issue(['servers.view']) });
  assert.equal(none.status, 403);
});

console.log('\nSTORED PLAYLISTS:');

let pid;
let etag;
await check('created with playlist.manage, read with its ETag; a viewer cannot create', async () => {
  assert.equal((await call('POST', '/playlists', { token: viewer, body: { name: 'x' } })).status, 403);
  assert.equal((await call('POST', '/playlists', { token: editor, body: {} })).json.code, 'name_required');
  const c = await call('POST', '/playlists', { token: editor, body: { name: 'Morning', model: MODEL } });
  assert.equal(c.status, 201);
  pid = c.json.id;
  const g = await call('GET', `/playlists/${pid}`, { token: viewer });
  assert.equal(g.status, 200);
  etag = g.headers.get('etag');
  assert.ok(etag && etag === g.json.etag);
  assert.equal(g.json.model.Tasks[0].Stream, 'live/out');
  const list = await call('GET', '/playlists', { token: viewer });
  assert.equal(list.json.items.length, 1);
  assert.equal(list.json.items[0].model, undefined, 'the list stays light');
});

await check('the Nimble build is the clean file: no editor keys, no nulls', async () => {
  const r = await call('GET', `/playlists/${pid}/nimble`, { token: viewer });
  assert.equal(r.status, 200);
  const text = JSON.stringify(r.json);
  assert.ok(!/_kind|_id|null/.test(text), text);
  assert.equal(r.json.Tasks[0].Blocks[0].Streams[0].Source, '/srv/media/a.mp4');
});

await check('a stale If-Match is 412 with the current version; the right one changes it', async () => {
  const stale = await call('PATCH', `/playlists/${pid}`, { token: editor, body: { description: 'x' }, headers: { 'If-Match': '"nope"' } });
  assert.equal(stale.status, 412);
  assert.equal(stale.json.details.etag, etag);
  assert.equal(stale.json.details.current.name, 'Morning');
  const ok = await call('PATCH', `/playlists/${pid}`, { token: editor, body: { description: 'news' }, headers: { 'If-Match': etag } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.description, 'news');
  assert.equal(ok.json.name, 'Morning', 'PATCH keeps what was not sent');
  assert.notEqual(ok.headers.get('etag'), etag);
  const again = await call('PATCH', `/playlists/${pid}`, { token: editor, body: { description: 'y' }, headers: { 'If-Match': etag } });
  assert.equal(again.status, 412, 'the old ETag no longer matches');
  etag = ok.headers.get('etag');
});

await check('PUT replaces: a name is required and an absent description is cleared', async () => {
  assert.equal((await call('PUT', `/playlists/${pid}`, { token: editor, body: { model: MODEL } })).json.code, 'name_required');
  const r = await call('PUT', `/playlists/${pid}`, { token: editor, body: { name: 'Morning 2', model: MODEL }, headers: { 'If-Match': etag } });
  assert.equal(r.status, 200);
  assert.equal(r.json.description, '');
  etag = r.headers.get('etag');
});

console.log('\nTHE PLAYLIST ON A SERVER:');

await check('a server with no file says so, with what is there instead', async () => {
  files.set('other.json', '{"Tasks":[]}');
  const r = await call('GET', `/servers/${SID}/playlist`, { token: viewer });
  assert.equal(r.status, 200);
  assert.equal(r.json.exists, false);
  assert.deepEqual(r.json.alternatives, ['other.json']);
});

await check('deploying a stored playlist writes the clean build and records a version and an event', async () => {
  assert.equal((await call('POST', `/servers/${SID}/playlist`, { token: viewer, body: { playlistId: pid } })).status, 403);
  const r = await call('POST', `/servers/${SID}/playlist`, { token: editor, body: { playlistId: pid, note: 'from CI' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const written = JSON.parse(files.get('server-playlist.json'));
  assert.equal(written.Tasks[0].Stream, 'live/out');
  assert.match(written.Tasks[0].Blocks[0].Id, /^[0-9a-f]{8}$/, 'a block gets an Id');
  assert.ok(!files.get('server-playlist.json').includes('_kind'));
  assert.equal(versions[0].origin, 'panel');
  assert.equal(versions[0].note, 'from CI');
  assert.match(versions[0].by, /^token:ci#/);
  const ev = events.find(e => e.type === 'playlist.deployed');
  assert.ok(ev, 'playlist.deployed');
  assert.equal(ev.actor.kind, 'token');
  assert.equal(ev.subject.server_id, SID);
});

await check('the same checks as the panel: missing media and .mov are refused with codes; force passes', async () => {
  const doc1 = { Tasks: [{ Stream: 'live/two', Blocks: [{ Id: 'b1', MaxIterations: 0, Streams: [{ Type: 'vod', Source: '/srv/media/gone.mp4' }] }] }] };
  const miss = await call('POST', `/servers/${SID}/playlist`, { token: editor, body: { document: doc1, file: 'two.json' } });
  assert.equal(miss.status, 409);
  assert.equal(miss.json.code, 'media_missing');
  assert.deepEqual(miss.json.details.missing, ['/srv/media/gone.mp4']);
  const doc2 = { Tasks: [{ Stream: 'live/two', Blocks: [{ Id: 'b1', MaxIterations: 0, Streams: [{ Type: 'vod', Source: '/srv/media/clip.mov' }] }] }] };
  const mov = await call('POST', `/servers/${SID}/playlist`, { token: editor, body: { document: doc2, file: 'two.json' } });
  assert.equal(mov.status, 409);
  assert.equal(mov.json.code, 'unsupported_source');
  assert.equal(files.has('two.json'), false, 'nothing was written');
  const forced = await call('POST', `/servers/${SID}/playlist`, { token: editor, body: { document: doc2, file: 'two.json', force: true } });
  assert.equal(forced.status, 200);
  assert.equal(forced.json.forced, true);
  assert.deepEqual(forced.json.unsupported, ['/srv/media/clip.mov']);
});

await check('a malformed file is refused even with force', async () => {
  const r = await call('POST', `/servers/${SID}/playlist`, { token: editor, body: { content: '{not json', force: true } });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'bad_request');
});

await check('exactly one of playlistId, document, content', async () => {
  for (const body of [{}, { playlistId: pid, content: '{}' }]) {
    const r = await call('POST', `/servers/${SID}/playlist`, { token: editor, body });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /exactly one/);
  }
  assert.equal((await call('POST', `/servers/${SID}/playlist`, { token: editor, body: { playlistId: 'p'.repeat(24) } })).status, 404);
});

await check('stop removes the task, start brings it back from the history; both are deploys', async () => {
  const before = versions.length;
  const stop = await call('POST', `/servers/${SID}/playlist/streams/live/out/actions/stop`, { token: editor });
  assert.equal(stop.status, 200, JSON.stringify(stop.json));
  assert.equal(stop.json.stopped, 'live/out');
  assert.equal(JSON.parse(files.get('server-playlist.json')).Tasks.length, 0);
  const again = await call('POST', `/servers/${SID}/playlist/streams/live/out/actions/stop`, { token: editor });
  assert.equal(again.status, 409);
  assert.equal(again.json.code, 'refused');
  const start = await call('POST', `/servers/${SID}/playlist/streams/live/out/actions/start`, { token: editor });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  assert.equal(start.json.started, 'live/out');
  assert.equal(start.json.resumesFromStart, true);
  assert.equal(JSON.parse(files.get('server-playlist.json')).Tasks[0].Stream, 'live/out');
  assert.equal(versions.length, before + 2, 'each wrote a version');
  assert.ok(events.some(e => e.type === 'playlist.stream_stopped') && events.some(e => e.type === 'playlist.stream_started'));
  const bad = await call('POST', `/servers/${SID}/playlist/streams/live/out/actions/pause`, { token: editor });
  assert.equal(bad.status, 404);
  assert.equal(bad.json.code, 'unknown_action');
});

await check('the history lists versions without their content', async () => {
  const r = await call('GET', `/servers/${SID}/playlist/history?file=server-playlist.json`, { token: viewer });
  assert.equal(r.status, 200);
  assert.ok(r.json.items.length >= 3);
  assert.ok(r.json.items.every(v => typeof v.id === 'string' && v._id === undefined));
});

await check('a server whose agent is off answers with a code, not a timeout', async () => {
  const r = await call('GET', '/servers/cccccccccccccccccccccccc/playlist', { token: viewer });
  assert.equal(r.status, 200, 'state reports it in the body');
  assert.match(r.json.error, /agent is not enabled/);
  const d = await call('POST', '/servers/cccccccccccccccccccccccc/playlist', { token: editor, body: { playlistId: pid } });
  assert.equal(d.status, 409);
  assert.equal(d.json.code, 'agent_disabled');
});

await check('a stored playlist is deleted with If-Match', async () => {
  assert.equal((await call('DELETE', `/playlists/${pid}`, { token: editor, headers: { 'If-Match': '"old"' } })).status, 412);
  assert.equal((await call('DELETE', `/playlists/${pid}`, { token: editor, headers: { 'If-Match': etag } })).status, 204);
  assert.equal((await call('GET', `/playlists/${pid}`, { token: viewer })).status, 404);
});

console.log('\nOPENAPI:');

const spec = openapiDocument();

await check('served without a token, as OpenAPI 3.1', async () => {
  const r = await call('GET', '/openapi.json');
  assert.equal(r.status, 200);
  assert.equal(r.json.openapi, '3.1.0');
  assert.deepEqual(r.json.paths['/openapi.json'].get.security, []);
  assert.equal((await call('GET', '/servers')).status, 401, 'and only the description is open');
});

// Every route of the router, as `METHOD /path/{param}`.
const routes = new Set();
for (const layer of v1Router.stack) {
  if (!layer.route) continue;
  for (const m of Object.keys(layer.route.methods)) routes.add(`${m.toUpperCase()} ${layer.route.path.replace(/:(\w+)/g, '{$1}')}`);
}
const described = new Set();
for (const [p, ops] of Object.entries(spec.paths)) for (const m of Object.keys(ops)) described.add(`${m.toUpperCase()} ${p}`);

await check('every route is described, and everything described is a route', () => {
  assert.ok(routes.size >= 20, `${routes.size} routes`);
  assert.deepEqual([...routes].filter(r => !described.has(r)), [], 'routes without a description');
  assert.deepEqual([...described].filter(d => !routes.has(d)), [], 'descriptions without a route');
});

const ops = Object.entries(spec.paths).flatMap(([p, o]) => Object.entries(o).map(([m, x]) => ({ p, m, x })));

await check('operations: unique ids, every path parameter declared, a permission and 401 where a token is needed', () => {
  const ids = ops.map(o => o.x.operationId);
  assert.equal(new Set(ids).size, ids.length);
  for (const { p, m, x } of ops) {
    const inPath = [...p.matchAll(/\{(\w+)\}/g)].map(a => a[1]).sort();
    const declared = (x.parameters || []).filter(q => q.in === 'path').map(q => q.name).sort();
    assert.deepEqual(declared, inPath, `${m} ${p}`);
    if (p === '/openapi.json') continue;
    assert.ok(x['x-permission'], `${m} ${p}: x-permission`);
    assert.ok(x.responses[401] && x.responses[403], `${m} ${p}: 401/403`);
  }
});

await check('every $ref resolves', () => {
  const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)].map(a => a[1]);
  assert.ok(refs.length > 10);
  for (const r of new Set(refs)) assert.ok(spec.components.schemas[r], r);
});

await check('the permissions it names are the ones the routes check', () => {
  const src = readFileSync(new URL('../src/api/v1.js', import.meta.url), 'utf8');
  for (const { p, m, x } of ops) {
    const perm = x['x-permission'];
    if (!perm || perm === 'by kind') continue;
    const express = p.replace(/\{(\w+)\}/g, ':$1');
    const line = src.split('\n').find(l => l.includes(`'${express}'`) && l.includes(`perm('${perm}')`)
      && (l.includes(`.${m}(`) || l.includes('[method]')));
    assert.ok(line, `${m.toUpperCase()} ${p} checks ${perm}`);
  }
});

await check('every event type is offered as a webhook', () => {
  assert.ok(spec.webhooks['playlist.deployed'] && spec.webhooks['stream_object.changed']);
  assert.deepEqual(spec.components.schemas.EventEnvelope.properties.type.enum, Object.keys(spec.webhooks));
});

srv.close();
configureEvents(null);
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
