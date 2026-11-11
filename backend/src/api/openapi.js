// OpenAPI 3.1 description of /api/v1 (nnm-api/1, docs/api/PROPOSAL-nnm-api-1.md §2), served at
// /api/v1/openapi.json and the source of the API section of the wiki.
//
// Written by hand next to the router rather than generated from it: the router knows paths, not
// meanings. tests/api-openapi.test.mjs holds the two together — every route of v1.js is described
// here and everything described here is a route.
import { readFileSync } from 'node:fs';
import { KINDS } from './streamKinds.js';
import { EVENT_TYPES } from '../services/events.js';
import { DEFAULT_PLAYLIST_FILE } from '../services/playlistFile.js';

const productVersion = () => {
  try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version; }
  catch { return ''; }
};

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema) => ({ 'application/json': { schema } });
const err = (description) => ({ description, content: json(ref('Error')) });
const ok = (description, schema, headers) => ({ description, ...(schema ? { content: json(schema) } : {}), ...(headers ? { headers } : {}) });
const page = (item) => ({
  type: 'object', required: ['items', 'next'],
  properties: { items: { type: 'array', items: item }, next: { type: ['string', 'null'], description: 'cursor of the next page; null — this is the last one' } },
});
const P = (name, description, extra = {}) => ({ name, in: 'path', required: true, description, schema: { type: 'string' }, ...extra });
const Q = (name, description, schema = { type: 'string' }) => ({ name, in: 'query', required: false, description, schema });
const etagHeader = { ETag: { description: 'version of the object; send it back in If-Match', schema: { type: 'string' } } };
const ifMatch = { name: 'If-Match', in: 'header', required: false, description: 'the ETag that was read; another one — 412 with the current version. Absent — no check; `*` — any.', schema: { type: 'string' } };

// Responses every authenticated operation can give.
const common = {
  401: err('no token, or the token is invalid, expired, revoked or used from an address it is not allowed from'),
  403: err('the token or user lacks the permission named in `x-permission`'),
  429: { ...err('too many requests for this token (600 a minute unless set otherwise)'), headers: { 'Retry-After': { schema: { type: 'integer' } } } },
};
const op = (o) => ({ ...o, responses: { ...o.responses, ...common } });

const upstreamErrors = {
  409: err('`not_mapped` — the server is not mapped to a WMSPanel server; `no_credentials` — WMSPanel API credentials are not set'),
  502: err('`upstream_failed` — WMSPanel refused or did not answer; `details.upstream` holds its answer'),
};
const agentErrors = {
  409: err('refused before anything was written: `media_missing` (details.missing), `unsupported_source` (not MP4/MP3, details.unsupported), `refused` (empty playlist, unreadable media list, stream already there or not there), `agent_disabled`'),
  502: err('`agent_failed` — the agent on the server answered with an error'),
  504: err('`agent_timeout` — the agent did not pick the task up or did not answer'),
};

// Main fields of each kind as WMSPanel names them; WMSPanel's API reference has the full set and the
// panel passes every field through unchanged.
const KIND_FIELDS = {
  udp: { name: { type: 'string' }, ip: { type: 'string', description: 'destination address (multicast or unicast)' }, port: { type: 'integer' }, ttl: { type: 'integer' }, paused: { type: 'boolean' }, source_streams: { type: 'array', description: 'what is sent: `[{app, stream, pids?}]`', items: { type: 'object', properties: { app: { type: 'string' }, stream: { type: 'string' } } } } },
  'mpegts-in': { name: { type: 'string' }, description: { type: 'string' }, protocol: { type: 'string', description: 'udp, srt, http …' }, ip: { type: 'string' }, port: { type: 'integer' }, receive_mode: { type: 'string', description: 'listen or pull' }, parameters: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
  'mpegts-out': { name: { type: 'string' }, description: { type: 'string' }, protocol: { type: 'string' }, ip: { type: 'string' }, port: { type: 'integer' }, ttl: { type: 'integer' }, parameters: { type: 'string' } },
  republish: { src_app: { type: 'string' }, src_stream: { type: 'string' }, dest_addr: { type: 'string' }, dest_port: { type: 'integer' }, dest_app: { type: 'string' }, dest_stream: { type: 'string' }, dest_login: { type: 'string' }, dest_password: { type: 'string', description: 'masked as *** in events' } },
  livepull: { url: { type: 'string', description: 'where the stream is pulled from' }, app: { type: 'string' }, stream: { type: 'string' }, fallback_urls: { type: 'array', items: { type: 'string' }, description: 'reserve sources, tried in order' } },
  hotswap: {},
  apps: { app: { type: 'string' }, push_login: { type: 'string' }, push_password: { type: 'string', description: 'masked as *** in events' } },
  interfaces: { ip: { type: 'string' }, port: { type: 'integer' } },
};

export function openapiDocument() {
  const kinds = Object.keys(KINDS);
  const kindParam = P('kind', 'kind of stream settings', { schema: { type: 'string', enum: kinds } });
  const server = P('serverId', 'id of the server in the panel (GET /servers)');
  const objId = P('objId', 'id of the object in WMSPanel');
  const playlistId = P('playlistId', 'id of the stored playlist');
  const fileQ = Q('file', 'playlist file on the server; default `' + DEFAULT_PLAYLIST_FILE + '`');
  const kindDoc = kinds.map(k => `\`${k}\` — ${KINDS[k].view} / ${KINDS[k].manage}`).join('; ');

  const paths = {
    '/openapi.json': {
      get: { operationId: 'openapi', tags: ['meta'], summary: 'This description', security: [], responses: { 200: ok('OpenAPI 3.1 document', { type: 'object' }) } },
    },
    '/events': {
      get: op({
        operationId: 'listEvents', tags: ['events'], summary: 'The event log — the same envelopes webhooks deliver (evt/1)', 'x-permission': 'audit.view',
        parameters: [Q('type', 'only this type', { type: 'string', enum: EVENT_TYPES }), Q('since', 'RFC 3339 time', { type: 'string', format: 'date-time' }),
          Q('cursor', '`next` of the previous page'), Q('limit', '1…500, default 100', { type: 'integer', minimum: 1, maximum: 500 })],
        responses: { 200: ok('newest first', page(ref('EventEnvelope'))), 400: err('`bad_since`') },
      }),
    },
    '/servers': {
      get: op({ operationId: 'listServers', tags: ['servers'], summary: 'Servers of the panel', 'x-permission': 'servers.view', responses: { 200: ok('all servers', page(ref('Server'))) } }),
    },
    '/servers/{serverId}': {
      get: op({ operationId: 'getServer', tags: ['servers'], summary: 'One server', 'x-permission': 'servers.view', parameters: [server], responses: { 200: ok('the server', ref('Server')), 404: err('`not_found`') } }),
    },
    '/servers/{serverId}/streams': {
      get: op({
        operationId: 'listLiveStreams', tags: ['streams'], summary: 'Live streams on the server now (codecs, resolution, bandwidth, publisher, uptime)', 'x-permission': 'streams.view',
        parameters: [server], responses: { 200: ok('as WMSPanel reports them', page({ type: 'object', additionalProperties: true })), 404: err('`not_found`'), ...upstreamErrors },
      }),
    },
    '/servers/{serverId}/stream-objects/{kind}': {
      get: op({
        operationId: 'listStreamObjects', tags: ['stream settings'], summary: 'Stream settings of one kind', description: `Permissions by kind (view / change): ${kindDoc}.`, 'x-permission': 'by kind',
        parameters: [server, kindParam], responses: { 200: ok('each item carries its `etag`', page(ref('StreamObject'))), 404: err('`not_found`, `unknown_kind` (details.kinds)'), ...upstreamErrors },
      }),
      post: op({
        operationId: 'createStreamObject', tags: ['stream settings'], summary: 'Create', 'x-permission': 'by kind', 'x-event': 'stream_object.created',
        parameters: [server, kindParam], requestBody: { required: true, content: json(ref('StreamObject')) },
        responses: { 201: ok('WMSPanel\'s answer', { type: 'object' }), 404: err('`not_found`, `unknown_kind`'), ...upstreamErrors },
      }),
    },
    '/servers/{serverId}/stream-objects/{kind}/{objId}': {
      get: op({
        operationId: 'getStreamObject', tags: ['stream settings'], summary: 'One object', 'x-permission': 'by kind',
        parameters: [server, kindParam, objId], responses: { 200: ok('the object', ref('StreamObject'), etagHeader), 404: err('`not_found`, `unknown_kind`'), ...upstreamErrors },
      }),
      patch: op({
        operationId: 'patchStreamObject', tags: ['stream settings'], summary: 'Change only the fields sent', description: 'Example — replace the source of a UDP stream: read it, then send `{"source_streams":[{"app":"live","stream":"new"}]}` with `If-Match`.', 'x-permission': 'by kind', 'x-event': 'stream_object.changed',
        parameters: [server, kindParam, objId, ifMatch], requestBody: { required: true, content: json(ref('StreamObject')) },
        responses: { 200: ok('the object as it is now', ref('StreamObject'), etagHeader), 404: err('`not_found`, `unknown_kind`'), 412: err('`precondition_failed` — details.etag, details.current'), ...upstreamErrors },
      }),
      put: op({
        operationId: 'replaceStreamObject', tags: ['stream settings'], summary: 'Replace the whole object', 'x-permission': 'by kind', 'x-event': 'stream_object.changed',
        parameters: [server, kindParam, objId, ifMatch], requestBody: { required: true, content: json(ref('StreamObject')) },
        responses: { 200: ok('the object as it is now', ref('StreamObject'), etagHeader), 404: err('`not_found`, `unknown_kind`'), 412: err('`precondition_failed`'), ...upstreamErrors },
      }),
      delete: op({
        operationId: 'deleteStreamObject', tags: ['stream settings'], summary: 'Delete', 'x-permission': 'by kind', 'x-event': 'stream_object.deleted',
        parameters: [server, kindParam, objId, ifMatch], responses: { 204: ok('deleted'), 404: err('`not_found`, `unknown_kind`'), 412: err('`precondition_failed`'), ...upstreamErrors },
      }),
    },
    '/servers/{serverId}/stream-objects/{kind}/{objId}/actions/{action}': {
      post: op({
        operationId: 'streamObjectAction', tags: ['stream settings'], summary: 'Restart, pause, resume',
        description: `Actions by kind: ${kinds.filter(k => Object.keys(KINDS[k].actions).length).map(k => `\`${k}\` — ${Object.keys(KINDS[k].actions).join(', ')}`).join('; ')}.`,
        'x-permission': 'by kind', 'x-event': 'stream_object.action',
        parameters: [server, kindParam, objId, P('action', 'restart, pause or resume', { schema: { type: 'string', enum: ['restart', 'pause', 'resume'] } })],
        responses: { 200: ok('done', { type: 'object' }), 404: err('`not_found`, `unknown_kind`, `unknown_action` (details.actions)'), ...upstreamErrors },
      }),
    },
    '/playlists': {
      get: op({ operationId: 'listPlaylists', tags: ['playlists'], summary: 'Playlists kept in the panel (without the model)', 'x-permission': 'playlist.view', responses: { 200: ok('newest change first', page(ref('Playlist'))) } }),
      post: op({
        operationId: 'createPlaylist', tags: ['playlists'], summary: 'Create', 'x-permission': 'playlist.manage',
        requestBody: { required: true, content: json(ref('PlaylistInput')) }, responses: { 201: ok('created', ref('Playlist'), etagHeader), 400: err('`name_required`') },
      }),
    },
    '/playlists/{playlistId}': {
      get: op({ operationId: 'getPlaylist', tags: ['playlists'], summary: 'One playlist with its model', 'x-permission': 'playlist.view', parameters: [playlistId], responses: { 200: ok('the playlist', ref('Playlist'), etagHeader), 404: err('`not_found`') } }),
      patch: op({
        operationId: 'patchPlaylist', tags: ['playlists'], summary: 'Change only the fields sent', 'x-permission': 'playlist.manage', parameters: [playlistId, ifMatch],
        requestBody: { required: true, content: json(ref('PlaylistInput')) }, responses: { 200: ok('as it is now', ref('Playlist'), etagHeader), 404: err('`not_found`'), 412: err('`precondition_failed`') },
      }),
      put: op({
        operationId: 'replacePlaylist', tags: ['playlists'], summary: 'Replace name, description and model', 'x-permission': 'playlist.manage', parameters: [playlistId, ifMatch],
        requestBody: { required: true, content: json(ref('PlaylistInput')) }, responses: { 200: ok('as it is now', ref('Playlist'), etagHeader), 400: err('`name_required`'), 404: err('`not_found`'), 412: err('`precondition_failed`') },
      }),
      delete: op({ operationId: 'deletePlaylist', tags: ['playlists'], summary: 'Delete', 'x-permission': 'playlist.manage', parameters: [playlistId, ifMatch], responses: { 204: ok('deleted'), 404: err('`not_found`'), 412: err('`precondition_failed`') } }),
    },
    '/playlists/{playlistId}/nimble': {
      get: op({
        operationId: 'buildPlaylist', tags: ['playlists'], summary: 'The file Nimble would get', description: 'The clean build of the model. A deploy additionally renews the Id of every block whose content changed against the file on that server.',
        'x-permission': 'playlist.view', parameters: [playlistId], responses: { 200: ok('Nimble server playlist', ref('NimblePlaylist')), 404: err('`not_found`') },
      }),
    },
    '/servers/{serverId}/playlist': {
      get: op({
        operationId: 'getServerPlaylist', tags: ['server playlist'], summary: 'The playlist on the server now', description: '`exists: false` — no such file (with `alternatives` — the files that are there); `exists: null` — the agent could not be asked (`error`).',
        'x-permission': 'playlist.view', parameters: [server, fileQ, Q('playlistId', 'also compare with this stored playlist')],
        responses: { 200: ok('state of the file', ref('ServerPlaylistState')), 404: err('`not_found`'), ...agentErrors },
      }),
      post: op({
        operationId: 'deployPlaylist', tags: ['server playlist'], summary: 'Put a playlist on the server', 'x-permission': 'playlist.manage', 'x-event': 'playlist.deployed',
        description: 'The same checks as the panel: a malformed file is always refused; missing media, non-MP4/MP3 sources, an unreadable media list and an empty playlist are refused unless `force`. The replaced version is kept (GET …/playlist/history). Block Ids are renewed where the content changed, so Nimble picks the change up.',
        parameters: [server], requestBody: { required: true, content: json(ref('DeployRequest')) },
        responses: { 200: ok('written', ref('DeployResult')), 400: err('`bad_request` — malformed file, or not exactly one of playlistId/document/content'), 404: err('`not_found` — server or stored playlist'), ...agentErrors },
      }),
    },
    '/servers/{serverId}/playlist/streams/{app}/{stream}/actions/{action}': {
      post: op({
        operationId: 'playlistStreamAction', tags: ['server playlist'], summary: 'Stop or start one output stream of the playlist',
        description: 'Stop removes the task from the file; start puts it back from the version history. Both are deploys with the same checks. A started task plays from the top of its block unless `resume` is asked and possible.',
        'x-permission': 'playlist.manage', 'x-event': 'playlist.stream_stopped / playlist.stream_started',
        parameters: [server, P('app', 'application of the output stream'), P('stream', 'name of the output stream'), P('action', 'stop or start', { schema: { type: 'string', enum: ['stop', 'start'] } })],
        requestBody: { required: false, content: json({ type: 'object', properties: { file: { type: 'string' }, force: { type: 'boolean' }, resume: { type: 'boolean', description: 'start only: continue from where it was stopped, estimated' } } }) },
        responses: { 200: ok('written', ref('DeployResult')), 404: err('`not_found` — server, or no version holds this stream; `unknown_action`'), ...agentErrors },
      }),
    },
    '/servers/{serverId}/playlist/history': {
      get: op({
        operationId: 'playlistHistory', tags: ['server playlist'], summary: 'Versions written to the server, newest first (without content)', 'x-permission': 'playlist.view',
        parameters: [server, fileQ, Q('limit', '1…100, default 30', { type: 'integer', minimum: 1, maximum: 100 })],
        responses: { 200: ok('versions', page({ type: 'object', properties: { id: { type: 'string' }, filename: { type: 'string' }, sha256: { type: 'string' }, bytes: { type: 'integer' }, origin: { type: 'string' }, by: { type: 'string' }, forced: { type: 'boolean' }, note: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' } } })), 404: err('`not_found`') },
      }),
    },
  };

  const schemas = {
    Error: {
      type: 'object', required: ['error', 'code'],
      properties: { error: { type: 'string', description: 'for a person' }, code: { type: 'string', description: 'for a program; stable within v1' }, details: { type: 'object', additionalProperties: true } },
    },
    Server: {
      type: 'object', properties: {
        id: { type: 'string' }, name: { type: 'string' }, host: { type: 'string' }, purpose: { type: 'string' },
        wmspanelServerId: { type: ['string', 'null'], description: 'null — not mapped; stream settings are then unavailable' }, tags: { type: 'array', items: { type: 'string' } },
      },
    },
    StreamObject: {
      type: 'object', additionalProperties: true,
      description: 'Fields as WMSPanel names them, passed through unchanged. `etag` in lists is added by the panel. Telemetry (status, bandwidth …) does not change the ETag.',
      properties: { id: { type: 'string', readOnly: true }, etag: { type: 'string', readOnly: true } },
      'x-fields-by-kind': KIND_FIELDS,
    },
    Playlist: {
      type: 'object', properties: {
        id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, etag: { type: 'string' },
        updatedBy: { type: 'string' }, updatedAt: { type: 'string', format: 'date-time' }, createdAt: { type: 'string', format: 'date-time' },
        model: { type: 'object', additionalProperties: true, description: 'the editor model: `{SyncInterval, Tasks[]}` with the editor\'s own keys; only in single-playlist answers' },
      },
    },
    PlaylistInput: {
      type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, model: { type: 'object', additionalProperties: true } },
    },
    NimblePlaylist: {
      type: 'object', description: 'Nimble server playlist (softvelum.com/nimble/playout)', additionalProperties: true,
      properties: {
        SyncInterval: { type: 'integer' },
        Tasks: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {
          Stream: { type: 'string', description: '`app/stream` of the output' },
          Blocks: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {
            Id: { type: 'string', description: 'Nimble ignores a changed block that keeps its Id' },
            MaxIterations: { type: 'integer', description: '0 — endless; Nimble\'s default is 1' },
            Streams: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { Source: { type: 'string', description: 'MP4 or MP3 only' } } } },
          } } },
        } } },
      },
    },
    ServerPlaylistState: {
      type: 'object', additionalProperties: true, properties: {
        name: { type: 'string' }, exists: { type: ['boolean', 'null'] }, updatedAt: { type: ['string', 'number', 'null'] },
        parsed: { type: ['object', 'null'], additionalProperties: true }, media: { type: ['object', 'null'], additionalProperties: true, description: 'missing — not on the server; unverifiable — could not be checked' },
        compare: { type: ['object', 'null'], additionalProperties: true }, alternatives: { type: 'array', items: { type: 'string' } }, error: { type: 'string' },
      },
    },
    DeployRequest: {
      type: 'object', description: 'Exactly one of playlistId, document, content.',
      properties: {
        playlistId: { type: 'string', description: 'a stored playlist' }, document: ref('NimblePlaylist'), content: { type: 'string', description: 'the file as text' },
        file: { type: 'string', description: 'default `' + DEFAULT_PLAYLIST_FILE + '`' }, force: { type: 'boolean', description: 'deploy past the refusals that can be overridden' }, note: { type: 'string', maxLength: 200 },
      },
    },
    DeployResult: {
      type: 'object', additionalProperties: true, properties: {
        entries: { type: 'integer' }, missing: { type: 'array', items: { type: 'string' } }, forced: { type: 'boolean' },
        renewedIds: { type: 'array', items: { type: 'string' }, description: 'blocks that got a new Id because their content changed' },
        playsOnce: { type: 'array', items: { type: 'string' }, description: 'blocks without MaxIterations: Nimble plays them once' },
        unsupported: { type: 'array', items: { type: 'string' } }, stopped: { type: 'string' }, started: { type: 'string' },
        resumesFromStart: { type: 'boolean' }, resume: { type: ['object', 'null'], additionalProperties: true },
      },
    },
    EventEnvelope: {
      type: 'object', description: 'evt/1 (eterix-contracts/evt-1.md). Secrets in `data` are masked as ***.',
      required: ['schema_version', 'id', 'type', 'occurred_at', 'product', 'instance', 'subject', 'actor', 'data'],
      properties: {
        schema_version: { type: 'string', const: 'evt/1' }, id: { type: 'string', description: 'ULID; the receiver deduplicates by it' },
        type: { type: 'string', enum: EVENT_TYPES }, occurred_at: { type: 'string', format: 'date-time' }, product: { type: 'string', const: 'nnm-control' },
        instance: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
        subject: { type: 'object', additionalProperties: true, properties: { kind: { type: 'string' }, id: { type: 'string' }, server_id: { type: 'string' }, name: { type: 'string' } } },
        actor: { type: 'object', properties: { kind: { type: 'string', enum: ['user', 'token', 'system'] }, name: { type: 'string' } } },
        data: { type: 'object', additionalProperties: true },
      },
    },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'NNM-Control API', version: '1', 'x-product-version': productVersion(),
      description: 'nnm-api/1. Stable within v1: only additions. Errors are `{error, code, details}`. Changes take `If-Match` with the ETag that was read. Every change is in the audit log and is an event (evt/1), delivered to webhooks.',
    },
    servers: [{ url: '/api/v1' }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'nnm_<8 hex>_<43 base64url>', description: 'An API token (panel → Access → API tokens). A signed-in user\'s session token works too.' },
      },
      schemas,
    },
    tags: ['meta', 'events', 'servers', 'streams', 'stream settings', 'playlists', 'server playlist'].map(name => ({ name })),
    paths,
    webhooks: Object.fromEntries(EVENT_TYPES.map(t => [t, {
      post: {
        summary: t, description: 'Signed: `X-Eterix-Signature: v1=<hex HMAC-SHA256(secret, X-Eterix-Timestamp + "." + body)>`. Answer 2xx; anything else is retried (1 m … 12 h).',
        parameters: ['X-Eterix-Event', 'X-Eterix-Delivery', 'X-Eterix-Timestamp', 'X-Eterix-Signature'].map(name => ({ name, in: 'header', required: true, schema: { type: 'string' } })),
        requestBody: { required: true, content: json(ref('EventEnvelope')) },
        responses: { '2XX': { description: 'received' } },
      },
    }])),
  };
}
