// /api/v1 — the external API of NNM-Control (nnm-api/1, docs/api/PROPOSAL-nnm-api-1.md, HQ N-0114).
//
// Stable within v1: only additions. Programs authenticate with an API token (`Authorization: Bearer
// nnm_…`); a signed-in user's JWT works too, so the API can be tried from the panel's own session.
// Lives outside routes/ on purpose: route-audit there asks «does a button call this route», and the
// callers of this router are programs, not the frontend.
//
// Every mutation is in the audit log (services/audit.js auditMutations, mounted on /api): a token
// appears there as `token:<name>#<id>`, never as its secret.
import { Router } from 'express';
import { ApiToken } from '../models/ApiToken.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { Settings } from '../models/Settings.js';
import { requireAuth, hasPerm } from '../middleware/auth.js';
import { wmspanel } from '../services/wmspanelClient.js';
import { authenticate, rateLimiter } from '../services/apiTokens.js';
import { KINDS, itemsOf, etagOf, ifMatchOk } from './streamKinds.js';
import { Event } from '../models/Webhook.js';
import { emit, actorOf, changedFields } from '../services/events.js';
import { Playlist } from '../models/Playlist.js';
import { buildFromModel } from '../services/playlistBuild.js';
import { deployHandler, playlistState, playlistStop, playlistStart } from '../routes/agentProxy.js';
import { history } from '../services/playlistDeploy.js';
import { DEFAULT_PLAYLIST_FILE } from '../services/playlistFile.js';
import { openapiDocument } from './openapi.js';

export const v1Router = Router();

// {error, code, details} — the error shape of nnm-api/1 §2.1.
const fail = (res, status, code, error, details) =>
  res.status(status).json(details === undefined ? { error, code } : { error, code, details });

const limited = rateLimiter();

export function v1Auth({ find = (tokenId) => ApiToken.findOne({ tokenId }), jwt = requireAuth, limiter = limited } = {}) {
  return async (req, res, next) => {
    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!bearer.startsWith('nnm_')) {
      // A user's session: the same check the panel's own API uses.
      return jwt(req, res, () => {
        req.actor = { kind: 'user', name: req.user?.username || '' };
        next();
      });
    }
    try {
      const r = await authenticate(bearer, { find, ip: req.ip });
      if (!r.ok) return fail(res, 401, 'unauthorized', 'invalid, expired or revoked API token');
      const t = r.token;
      const wait = limiter(t.tokenId, t.ratePerMin || 600);
      if (wait !== null) {
        res.set('Retry-After', String(wait));
        return fail(res, 429, 'rate_limited', `too many requests for this token; retry in ${wait} s`);
      }
      // What the audit log and the rest of the stack read. Never the secret.
      req.user = { username: `token:${t.name}#${t.tokenId}`, roleType: 'api-token' };
      req.perms = t.permissions || [];
      req.actor = { kind: 'token', name: t.name, tokenId: t.tokenId };
      if (typeof t.save === 'function') {
        t.lastUsedAt = new Date(); t.lastUsedIp = req.ip || '';
        t.save().catch(() => {});
      }
      next();
    } catch (e) { next(e); }
  };
}

const perm = (key) => (req, res, next) =>
  (req.perms && hasPerm(req.perms, key) ? next() : fail(res, 403, 'forbidden', `missing permission: ${key}`));

const pubServer = (s) => ({
  id: String(s._id), name: s.name, host: s.host, purpose: s.purpose || 'nimble',
  wmspanelServerId: s.wmspanelServerId || null, tags: s.tags || [],
});

async function loadServer(req, res, next) {
  try {
    const s = await NimbleServer.findById(req.params.serverId).catch(() => null);
    if (!s) return fail(res, 404, 'not_found', 'server not found');
    req.srv = s;
    next();
  } catch (e) { next(e); }
}

function loadKind(req, res, next) {
  const k = KINDS[req.params.kind];
  if (!k) return fail(res, 404, 'unknown_kind', `unknown kind «${req.params.kind}»`, { kinds: Object.keys(KINDS) });
  req.kind = k;
  next();
}

// Kind-specific permission, after loadKind.
const kindPerm = (which) => (req, res, next) => perm(req.kind[which])(req, res, next);

// WMSPanel is where stream settings live; a server not mapped to it has none to offer.
async function upstream(req, res) {
  if (!req.srv.wmspanelServerId) {
    fail(res, 409, 'not_mapped', 'this server is not mapped to a WMSPanel server — set it in the panel');
    return null;
  }
  const s = await Settings.load();
  return { cfg: s.wmspanel, sid: req.srv.wmspanelServerId };
}

// An upstream refusal is a 502 that says whose refusal it was.
const viaUpstream = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (e?.code === 'NO_CREDS') return fail(res, 409, 'no_credentials', e.message);
    return fail(res, 502, 'upstream_failed', `WMSPanel: ${e?.message || e}`, { upstream: e?.data ?? null });
  }
};

async function findObject(req, res) {
  const up = await upstream(req, res);
  if (!up) return null;
  const items = itemsOf(await wmspanel[req.kind.list](up.cfg, up.sid));
  const obj = items.find(o => String(o?.id) === String(req.params.objId));
  if (!obj) { fail(res, 404, 'not_found', `${req.params.kind} ${req.params.objId} not found on this server`); return null; }
  return { up, obj, etag: etagOf(obj) };
}

// evt/1: every change of stream settings through the API is an event (secrets masked in emit()).
const objectEvent = (req, type, objId, data) => emit({
  type, actor: actorOf(req), data,
  subject: { kind: req.params.kind, id: String(objId ?? ''), server_id: String(req.srv._id), name: data?.after?.name || data?.before?.name || '' },
});

// The description itself is open: it holds no data, only what the public repository already says, and
// tools (Swagger UI, code generators) fetch it before they have a token.
v1Router.get('/openapi.json', (_req, res) => res.json(openapiDocument()));

v1Router.use(v1Auth());

// ---- events (the same envelopes webhooks deliver) ----
v1Router.get('/events', perm('audit.view'), async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const q = {};
  if (req.query.type) q.type = String(req.query.type);
  if (req.query.since) {
    const d = new Date(String(req.query.since));
    if (Number.isNaN(d.getTime())) return fail(res, 400, 'bad_since', 'since is an RFC 3339 time');
    q.occurredAt = { $gte: d };
  }
  // Cursor — the id of the last event of the previous page; ULIDs sort by time.
  if (req.query.cursor) q.eventId = { $lt: String(req.query.cursor) };
  const list = await Event.find(q).sort({ eventId: -1 }).limit(limit + 1).lean();
  const page = list.slice(0, limit);
  res.json({ items: page.map(e => e.envelope), next: list.length > limit ? page.at(-1).eventId : null });
});

// ---- servers ----
v1Router.get('/servers', perm('servers.view'), async (_req, res) => {
  const list = await NimbleServer.find().sort({ order: 1, name: 1 });
  res.json({ items: list.map(pubServer), next: null });
});
v1Router.get('/servers/:serverId', perm('servers.view'), loadServer, (req, res) => res.json(pubServer(req.srv)));

// ---- stream settings ----
const base = '/servers/:serverId/stream-objects/:kind';

v1Router.get(base, loadKind, kindPerm('view'), loadServer, viaUpstream(async (req, res) => {
  const up = await upstream(req, res);
  if (!up) return;
  const items = itemsOf(await wmspanel[req.kind.list](up.cfg, up.sid));
  res.json({ items: items.map(o => ({ ...o, etag: etagOf(o) })), next: null });
}));

v1Router.get(`${base}/:objId`, loadKind, kindPerm('view'), loadServer, viaUpstream(async (req, res) => {
  const f = await findObject(req, res);
  if (!f) return;
  res.set('ETag', f.etag).json(f.obj);
}));

v1Router.post(base, loadKind, kindPerm('manage'), loadServer, viaUpstream(async (req, res) => {
  const up = await upstream(req, res);
  if (!up) return;
  const out = await wmspanel[req.kind.create](up.cfg, up.sid, req.body || {});
  objectEvent(req, 'stream_object.created', out?.id ?? out?.setting?.id ?? '', { after: req.body || {} });
  res.status(201).json(out);
}));

// PATCH — only the fields sent; PUT — the whole object. WMSPanel takes both as the same update call,
// so the difference is the caller's promise, recorded in the audit log by method.
for (const method of ['patch', 'put']) {
  v1Router[method](`${base}/:objId`, loadKind, kindPerm('manage'), loadServer, viaUpstream(async (req, res) => {
    const f = await findObject(req, res);
    if (!f) return;
    if (!ifMatchOk(req.headers['if-match'], f.etag)) {
      return fail(res, 412, 'precondition_failed', 'the object changed since it was read', { etag: f.etag, current: f.obj });
    }
    await wmspanel[req.kind.update](f.up.cfg, f.up.sid, req.params.objId, req.body || {});
    const after = await findObject(req, res);
    if (!after) return;
    objectEvent(req, 'stream_object.changed', req.params.objId,
      { before: f.obj, after: after.obj, changed: changedFields(f.obj, after.obj), via: 'api' });
    res.set('ETag', after.etag).json(after.obj);
  }));
}

v1Router.delete(`${base}/:objId`, loadKind, kindPerm('manage'), loadServer, viaUpstream(async (req, res) => {
  const f = await findObject(req, res);
  if (!f) return;
  if (!ifMatchOk(req.headers['if-match'], f.etag)) {
    return fail(res, 412, 'precondition_failed', 'the object changed since it was read', { etag: f.etag, current: f.obj });
  }
  await wmspanel[req.kind.remove](f.up.cfg, f.up.sid, req.params.objId);
  objectEvent(req, 'stream_object.deleted', req.params.objId, { before: f.obj, via: 'api' });
  res.status(204).end();
}));

v1Router.post(`${base}/:objId/actions/:action`, loadKind, kindPerm('manage'), loadServer, viaUpstream(async (req, res) => {
  const act = req.kind.actions[req.params.action];
  if (!act) {
    return fail(res, 404, 'unknown_action', `«${req.params.action}» is not an action of ${req.params.kind}`,
      { actions: Object.keys(req.kind.actions) });
  }
  const up = await upstream(req, res);
  if (!up) return;
  const out = await act(wmspanel, up.cfg, up.sid, req.params.objId);
  objectEvent(req, 'stream_object.action', req.params.objId, { action: req.params.action, via: 'api' });
  res.json(out ?? { ok: true });
}));

// ---- live streams (what is on the air now; WMSPanel's live view) ----
v1Router.get('/servers/:serverId/streams', perm('streams.view'), loadServer, viaUpstream(async (req, res) => {
  const up = await upstream(req, res);
  if (!up) return;
  const d = await wmspanel.liveStreams(up.cfg, up.sid);
  res.json({ items: itemsOf(d), next: null });
}));

// ---- playlists kept in the panel (the editor's model) ----
const playlistEtag = (p) => etagOf({ name: p.name, description: p.description, model: p.model });
const pubPlaylist = (p, withModel) => ({
  id: String(p._id), name: p.name, description: p.description || '',
  updatedBy: p.updatedBy || '', updatedAt: p.updatedAt || null, createdAt: p.createdAt || null,
  etag: playlistEtag(p), ...(withModel ? { model: p.model } : {}),
});

async function loadPlaylist(req, res, next) {
  try {
    const p = await Playlist.findById(req.params.playlistId).catch(() => null);
    if (!p) return fail(res, 404, 'not_found', 'playlist not found');
    req.playlist = p;
    next();
  } catch (e) { next(e); }
}
const playlistMatch = (req, res) => {
  const etag = playlistEtag(req.playlist);
  if (ifMatchOk(req.headers['if-match'], etag)) return true;
  fail(res, 412, 'precondition_failed', 'the playlist changed since it was read', { etag, current: pubPlaylist(req.playlist, true) });
  return false;
};

v1Router.get('/playlists', perm('playlist.view'), async (_req, res) => {
  const list = await Playlist.find().sort({ updatedAt: -1 });
  res.json({ items: list.map(p => pubPlaylist(p, false)), next: null });
});
v1Router.get('/playlists/:playlistId', perm('playlist.view'), loadPlaylist, (req, res) =>
  res.set('ETag', playlistEtag(req.playlist)).json(pubPlaylist(req.playlist, true)));
// The file Nimble would get: the clean build, before the per-server block Id renewal of a deploy.
v1Router.get('/playlists/:playlistId/nimble', perm('playlist.view'), loadPlaylist, (req, res) =>
  res.json(buildFromModel(req.playlist.model)));

v1Router.post('/playlists', perm('playlist.manage'), async (req, res) => {
  const { name, description, model } = req.body || {};
  if (!String(name || '').trim()) return fail(res, 400, 'name_required', 'name required');
  const p = await Playlist.create({
    name: String(name).trim(), description: String(description || ''), model: model || undefined,
    updatedBy: req.user.username,
  });
  res.status(201).set('ETag', playlistEtag(p)).json(pubPlaylist(p, true));
});
// PATCH — only the fields sent; PUT — the whole playlist (name required, description cleared if absent).
for (const method of ['patch', 'put']) {
  v1Router[method]('/playlists/:playlistId', perm('playlist.manage'), loadPlaylist, async (req, res) => {
    const { name, description, model } = req.body || {};
    if (method === 'put' && !String(name || '').trim()) return fail(res, 400, 'name_required', 'PUT replaces the playlist: name required');
    if (!playlistMatch(req, res)) return;
    const p = req.playlist;
    if (name !== undefined) p.name = String(name).trim() || p.name;
    if (description !== undefined || method === 'put') p.description = String(description || '');
    if (model !== undefined) p.model = model;
    p.updatedBy = req.user.username;
    await p.save();
    res.set('ETag', playlistEtag(p)).json(pubPlaylist(p, true));
  });
}
v1Router.delete('/playlists/:playlistId', perm('playlist.manage'), loadPlaylist, async (req, res) => {
  if (!playlistMatch(req, res)) return;
  await req.playlist.deleteOne();
  res.status(204).end();
});

// ---- the playlist on a server (through its agent) ----
// The same handlers as the panel's own screens (routes/agentProxy.js): the same checks, the same
// version history, the same events. A second implementation would be one that skips a check.
const AGENT_CODES = { 400: 'bad_request', 404: 'not_found', 504: 'agent_timeout' };
export function agentError(e) {
  const status = e?.status || 502;
  const details = {};
  for (const k of ['missing', 'unsupported']) if (e?.[k]) details[k] = e[k];
  const code = (typeof e?.code === 'string' && e.code.replace(/-/g, '_'))
    || (e?.missing ? 'media_missing' : e?.unsupported ? 'unsupported_source' : AGENT_CODES[status])
    || (status === 409 ? 'refused' : 'agent_failed');
  return { status, code, error: String(e?.message || e), details: Object.keys(details).length ? details : undefined };
}
const viaAgent = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) { const a = agentError(e); fail(res, a.status, a.code, a.error, a.details); }
};
const fileOf = (v) => String(v || DEFAULT_PLAYLIST_FILE);

v1Router.get('/servers/:serverId/playlist', perm('playlist.view'), loadServer, viaAgent(async (req) => {
  req.query = { ...req.query, name: fileOf(req.query.file) };
  return playlistState(req);
}));

// Body: exactly one of `playlistId` (a stored playlist), `document` (a Nimble playlist as JSON) or
// `content` (the file as text); `file`, `force`, `note` as in the panel.
v1Router.post('/servers/:serverId/playlist', perm('playlist.manage'), loadServer, viaAgent(async (req) => {
  const b = req.body || {};
  const given = ['playlistId', 'document', 'content'].filter(k => b[k] !== undefined);
  if (given.length !== 1) {
    throw Object.assign(new Error('send exactly one of playlistId, document, content'), { status: 400 });
  }
  req.body = {
    filename: fileOf(b.file), force: b.force === true, note: String(b.note || ''),
    ...(b.playlistId !== undefined ? { playlistId: String(b.playlistId) } : {}),
    ...(b.document !== undefined ? { content: JSON.stringify(b.document) } : {}),
    ...(b.content !== undefined ? { content: String(b.content) } : {}),
  };
  return deployHandler(req);
}));

// Nimble names an output stream `app/stream` — the Task's `Stream`.
v1Router.post('/servers/:serverId/playlist/streams/:app/:stream/actions/:action', perm('playlist.manage'), loadServer,
  viaAgent(async (req) => {
    const run = { stop: playlistStop, start: playlistStart }[req.params.action];
    if (!run) {
      throw Object.assign(new Error(`«${req.params.action}» is not an action of a playlist stream`),
        { status: 404, code: 'unknown_action' });
    }
    const b = req.body || {};
    req.body = { filename: fileOf(b.file), stream: `${req.params.app}/${req.params.stream}`, force: b.force === true, resume: b.resume === true };
    return run(req);
  }));

v1Router.get('/servers/:serverId/playlist/history', perm('playlist.view'), loadServer, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const list = await history(req.srv._id, req.query.file ? String(req.query.file) : '', limit);
  res.json({ items: list.map(({ _id, ...v }) => ({ id: String(_id), ...v })), next: null });
});

v1Router.use((_req, res) => fail(res, 404, 'not_found', 'no such endpoint in /api/v1'));
// eslint-disable-next-line no-unused-vars
v1Router.use((err, _req, res, _next) => {
  console.error('[api/v1]', err);
  fail(res, 500, 'internal', 'internal error');
});
