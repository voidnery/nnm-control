// The kinds of stream settings /api/v1 exposes (docs/api/PROPOSAL-nnm-api-1.md §2.3), mapped onto the
// WMSPanel client calls the panel's own screens already use — the API opens proven operations, it
// does not reimplement them. Field names are WMSPanel's, unchanged.
import crypto from 'node:crypto';

const W = { view: 'wmsobjects.view', manage: 'wmsobjects.manage' };

export const KINDS = {
  udp: { ...W, list: 'udpList', create: 'udpCreate', update: 'udpUpdate', remove: 'udpDelete', actions: {} },
  'mpegts-in': { ...W, list: 'incomingList', create: 'incomingCreate', update: 'incomingUpdate', remove: 'incomingDelete', actions: {} },
  'mpegts-out': {
    ...W, list: 'outgoingList', create: 'outgoingCreate', update: 'outgoingUpdate', remove: 'outgoingDelete',
    actions: Object.fromEntries(['pause', 'resume', 'restart'].map(a => [a, (c, cfg, sid, id) => c.outgoingAction(cfg, sid, id, a)])),
  },
  republish: {
    view: 'republish.view', manage: 'republish.manage',
    list: 'republishList', create: 'republishCreate', update: 'republishUpdate', remove: 'republishDelete',
    actions: { restart: (c, cfg, sid, id) => c.republishRestart(cfg, sid, id) },
  },
  livepull: {
    ...W, list: 'livePullList', create: 'livePullCreate', update: 'livePullUpdate', remove: 'livePullDelete',
    actions: { restart: (c, cfg, sid, id) => c.livePullRestart(cfg, sid, id) },
  },
  hotswap: { ...W, list: 'hotswapList', create: 'hotswapCreate', update: 'hotswapUpdate', remove: 'hotswapDelete', actions: {} },
  apps: { ...W, list: 'liveAppList', create: 'liveAppCreate', update: 'liveAppUpdate', remove: 'liveAppDelete', actions: {} },
  interfaces: {
    ...W, list: 'rtmpInterfaceList', create: 'rtmpInterfaceCreate', update: 'rtmpInterfaceUpdate',
    remove: 'rtmpInterfaceDelete', actions: {},
  },
};

// WMSPanel names its list differently per kind (settings, streams, applications, interfaces, rules).
const LIST_KEYS = ['settings', 'streams', 'applications', 'interfaces', 'rules', 'items'];
export function itemsOf(resp) {
  if (Array.isArray(resp)) return resp;
  for (const k of LIST_KEYS) if (Array.isArray(resp?.[k])) return resp[k];
  const first = resp && typeof resp === 'object' ? Object.values(resp).find(Array.isArray) : null;
  return first || [];
}

// Telemetry is not configuration: a bitrate that moved must not fail somebody's If-Match.
const VOLATILE = /^(status|state|bandwidth|bitrate|uptime|traffic|last_.*|.*_at|updated|connections?)$/i;
const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter(k => !VOLATILE.test(k)).sort()
      .map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};
/** Strong ETag of an object's configuration. */
export const etagOf = (obj) => `"${crypto.createHash('sha256').update(canonical(obj)).digest('hex').slice(0, 20)}"`;

/** If-Match: absent — allowed; `*` — any existing object; otherwise one of the listed tags. */
export function ifMatchOk(header, etag) {
  if (header === undefined || header === null || header === '') return true;
  const tags = String(header).split(',').map(s => s.trim().replace(/^W\//, ''));
  return tags.includes('*') || tags.includes(etag);
}
