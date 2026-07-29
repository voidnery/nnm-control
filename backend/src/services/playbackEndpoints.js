// iter9 m2 — where can a viewer actually watch this server's streams?
//
// Until now the panel only knew addresses an operator had typed in by hand,
// and nothing ever filled them in, so on an auto-synced fleet the answer was
// always "nowhere" and the playback UI simply hid itself.
//
// This resolves the question from data instead. Two facts are obtainable:
//   * the addresses WMSPanel itself associates with the server
//       GET /server/{sid}          -> custom_ips[] (operator-declared names)
//                                     ip[]         (detected addresses)
//   * the ports Nimble is really listening on for RTMP
//       GET /server/{sid}/rtmp/interface -> [{ ip, port, ssl }]
//
// One fact is NOT obtainable: the HTTP port serving HLS/DASH/SLDP/Icecast/
// WHEP. It lives in nimble.conf and no endpoint we have exposes it. So it is
// taken from the server record when the operator set it, and otherwise falls
// back to Nimble's documented default of 8081 — and every returned endpoint
// carries the provenance of each port, so the UI can show which number is a
// measurement and which is an assumption. A URL that silently does not play
// is worse than a URL labelled "assumed".
import { wmspanel } from './wmspanelClient.js';

export const DEFAULT_HTTP_PORT = 8081;
export const DEFAULT_RTMP_PORT = 1935;

// Two API calls per server is cheap once, expensive on every screen paint —
// the same trap the metric collector and the transcoder fleet view avoid. The
// shape of a fleet changes on the order of weeks, so a short-lived cache is
// enough to make repeated tab visits free.
const TTL_MS = 10 * 60 * 1000;
const cache = new Map();   // serverId -> { at, value }

export function invalidatePlaybackCache(serverId) {
  if (serverId) cache.delete(String(serverId));
  else cache.clear();
}

const isIpv4 = (s) => /^\d+\.\d+\.\d+\.\d+$/.test(String(s || ''));

// custom_ips are what the operator declared in WMSPanel (usually the public
// hostnames viewers actually use), so they come first; detected ip[] entries
// follow as a fallback. IPv6 is kept but ranked last: it is present on some
// boxes and unreachable from the office on others.
export function collectHosts(wsServer, fallbackHost) {
  const out = [];
  const push = (h) => {
    const v = String(h || '').trim();
    if (v && !out.includes(v)) out.push(v);
  };
  for (const h of (wsServer?.custom_ips || [])) push(h);
  for (const h of (wsServer?.ip || [])) if (isIpv4(h)) push(h);
  for (const h of (wsServer?.ip || [])) if (!isIpv4(h)) push(h);
  push(fallbackHost);
  return out;
}

// Nimble's RTMP interfaces are bindings, not addresses: a wildcard bind
// (0.0.0.0 / ::) tells us the port but nothing about the host, while a
// specific bind tells us both. We only need the port here — the host list is
// authoritative and comes from WMSPanel.
export function pickRtmpPort(interfaces) {
  const list = (Array.isArray(interfaces) ? interfaces : [])
    .map(i => ({ port: Number(i?.port), ssl: Boolean(i?.ssl), ip: String(i?.ip || '') }))
    .filter(i => i.port > 0);
  if (!list.length) return { port: DEFAULT_RTMP_PORT, origin: 'default', alternatives: [] };
  const plain = list.filter(i => !i.ssl);
  const chosen = (plain[0] || list[0]);
  const alternatives = list.filter(i => i.port !== chosen.port).map(i => i.port);
  return { port: chosen.port, origin: 'api', alternatives: [...new Set(alternatives)] };
}

export function resolveHttpPort(server) {
  const p = Number(server?.httpPort);
  return p > 0
    ? { port: p, origin: 'configured' }
    : { port: DEFAULT_HTTP_PORT, origin: 'default' };
}

// Manual entries always win: if an operator took the trouble to type an
// address, second-guessing it with a derived one would be worse than useless.
function fromManual(server) {
  return (server.playbackEndpoints || [])
    .filter(e => String(e.host || '').trim())
    .map(e => ({
      label: e.label || '',
      host: e.host,
      httpPort: Number(e.hlsPort) > 0 ? Number(e.hlsPort) : DEFAULT_HTTP_PORT,
      rtmpPort: Number(e.rtmpPort) > 0 ? Number(e.rtmpPort) : DEFAULT_RTMP_PORT,
      ssl: Boolean(e.ssl),
      origin: 'manual',
      httpPortOrigin: 'manual',
      rtmpPortOrigin: 'manual',
    }));
}

/**
 * @param {object} server            panel server document
 * @param {object|null} cfg          WMSPanel credentials, or null when the
 *                                   control plane is native / unconfigured
 * @returns {Promise<{endpoints:array, source:string, apiCalls:number, notes:string[]}>}
 */
export async function resolvePlaybackEndpoints(server, cfg, { fresh = false } = {}) {
  const key = String(server.id || server._id);
  if (!fresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return { ...hit.value, cached: true };
  }

  const manual = fromManual(server);
  if (manual.length) {
    const value = { endpoints: manual, source: 'manual', apiCalls: 0, notes: [] };
    cache.set(key, { at: Date.now(), value });
    return { ...value, cached: false };
  }

  const http = resolveHttpPort(server);
  const notes = [];
  if (http.origin === 'default') notes.push('httpPortAssumed');

  // Native control plane, missing credentials or an unmapped server: the
  // panel's own record is all we have. Still better than hiding the UI.
  if (!cfg || !server.wmspanelServerId) {
    if (!server.host) return { endpoints: [], source: 'none', apiCalls: 0, notes: ['noHost'], cached: false };
    const value = {
      endpoints: [{
        label: '', host: server.host, httpPort: http.port, rtmpPort: DEFAULT_RTMP_PORT, ssl: false,
        origin: 'panel', httpPortOrigin: http.origin, rtmpPortOrigin: 'default',
      }],
      source: 'panel',
      apiCalls: 0,
      notes: [...notes, 'rtmpPortAssumed'],
    };
    cache.set(key, { at: Date.now(), value });
    return { ...value, cached: false };
  }

  const sid = server.wmspanelServerId;
  let apiCalls = 0;
  // Either call may fail independently (quota, an unreachable box, a server
  // removed on the WMSPanel side). A partial answer is still useful, so each
  // is degraded on its own rather than failing the whole resolution.
  let wsServer = null, interfaces = null;
  try { wsServer = await wmspanel.getServer(cfg, sid); apiCalls++; }
  catch { notes.push('serverLookupFailed'); }
  try { const r = await wmspanel.rtmpInterfaceList(cfg, sid); interfaces = r?.interfaces || r; apiCalls++; }
  catch { notes.push('interfaceLookupFailed'); }

  const rtmp = pickRtmpPort(interfaces);
  if (rtmp.origin === 'default') notes.push('rtmpPortAssumed');
  if (rtmp.alternatives.length) notes.push('rtmpMultiplePorts');

  const hosts = collectHosts(wsServer?.server || wsServer, server.host);
  if (!hosts.length) return { endpoints: [], source: 'none', apiCalls, notes: [...notes, 'noHost'], cached: false };

  const value = {
    endpoints: hosts.map(h => ({
      label: '', host: h, httpPort: http.port, rtmpPort: rtmp.port, ssl: false,
      origin: 'wmspanel', httpPortOrigin: http.origin, rtmpPortOrigin: rtmp.origin,
    })),
    source: 'wmspanel',
    apiCalls,
    notes,
    rtmpAlternatives: rtmp.alternatives,
  };
  cache.set(key, { at: Date.now(), value });
  return { ...value, cached: false };
}
