// Client for WMSPanel Control API (api.wmspanel.com/v1 or api.wmspanel.ru/v1).
// Auth: client_id + api_key as query params on every request (per official
// reference). Requirements on the WMSPanel side: API enabled in
// Control -> API setup -> Pull API, panel host IP whitelisted.
// Daily account limit: 15000 calls — we call WMSPanel only for WRITE
// operations and lists; all polling/verification uses the free native API.
//
// NOTE on republish endpoints: the /v1/server/{id}/rtmp/republish/{rule}/restart
// path is confirmed by Softvelum support answers; list/create/update/delete are
// modeled on the same family. Exact field names get pinned on first live call
// (raw upstream responses are passed through to the UI for that reason).

// Usage is accumulated in memory and flushed on a timer, because incrementing
// a document per API call would add a database write to every call the panel
// makes — solving a budget problem by spending a different budget.
import { ApiUsage, utcDay } from '../models/ApiUsage.js';

const pending = { day: null, calls: 0, byPath: {} };
let flushTimer = null;

function countCall(path) {
  const day = utcDay();
  if (pending.day && pending.day !== day) flushUsage().catch(() => {});
  pending.day = day;
  pending.calls += 1;
  // The endpoint, without ids, so paths group instead of fragmenting.
  const key = String(path).split('?')[0].replace(/\/[0-9a-f]{16,}/gi, '/:id').slice(0, 80);
  pending.byPath[key] = (pending.byPath[key] || 0) + 1;
  if (!flushTimer) {
    flushTimer = setTimeout(() => { flushTimer = null; flushUsage().catch(() => {}); }, 10_000);
    if (flushTimer.unref) flushTimer.unref();
  }
}

export async function flushUsage() {
  if (!pending.day || !pending.calls) return;
  const { day, calls, byPath } = pending;
  pending.calls = 0;
  pending.byPath = {};
  const inc = { calls };
  for (const [k, v] of Object.entries(byPath)) inc[`byPath.${k.replace(/\./g, '·')}`] = v;
  await ApiUsage.updateOne(
    { day },
    { $inc: inc, $set: { lastAt: new Date() }, $setOnInsert: { firstAt: new Date() } },
    { upsert: true },
  );
}

const TIMEOUT_MS = 12000;

function buildUrl(cfg, path, extraQuery = '') {
  const base = (cfg.baseUrl || 'https://api.wmspanel.com/v1').replace(/\/+$/, '');
  const auth = `client_id=${encodeURIComponent(cfg.clientId)}&api_key=${encodeURIComponent(cfg.apiKey)}`;
  const sep = path.includes('?') ? '&' : '?';
  return `${base}${path}${sep}${auth}${extraQuery ? '&' + extraQuery : ''}`;
}

async function call(cfg, path, { method = 'GET', body } = {}) {
  if (!cfg.clientId || !cfg.apiKey) {
    const e = new Error('WMSPanel API credentials are not configured');
    e.code = 'NO_CREDS';
    throw e;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // Counted before the attempt, not after: a call that failed still left the
    // account. Counting successes would quietly under-report exactly when
    // something is going wrong and being retried.
    countCall(path);
    let res;
    try {
      res = await fetch(buildUrl(cfg, path), {
        method,
        signal: ctrl.signal,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      // Node reports every transport failure as `TypeError: fetch failed` and
      // hides the reason in `cause`. Shown to an operator, that string says
      // nothing and points at nothing — it could be DNS, a firewall, an
      // unreachable route or a timeout, and those have different fixes.
      if (e?.name === 'AbortError') {
        throw Object.assign(new Error(`WMSPanel API: no answer within ${TIMEOUT_MS / 1000}s (${path})`), { status: 504 });
      }
      const cause = e?.cause;
      const detail = [cause?.code, cause?.message, cause?.errors?.map(x => x.code || x.message).join(', ')]
        .filter(Boolean).join(' — ') || e?.message || 'unknown transport error';
      throw Object.assign(
        new Error(`WMSPanel API is unreachable: ${detail} (${path})`),
        { status: 502, transport: cause?.code || 'unknown' },
      );
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (res.status === 403) {
      const e = new Error('WMSPanel API: 403 — check client_id/api_key and the IP whitelist (panel host IP must be whitelisted in API setup)');
      e.status = 403; e.data = data;
      throw e;
    }
    if (!res.ok || (data && data.status && data.status !== 'Ok')) {
      const e = new Error(`WMSPanel API error: HTTP ${res.status}${data?.status ? `, status=${data.status}` : ''}`);
      e.status = res.status; e.data = data;
      throw e;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export const wmspanel = {
  // Confirmed by official reference: GET /v1/server
  listServers: (cfg) => call(cfg, '/server'),
  getServer: (cfg, sid) => call(cfg, `/server/${encodeURIComponent(sid)}`),
  // WMSPanel "Server" tag: update display name, custom IPs/domains, and tags.
  serverUpdate: (cfg, sid, patch) => call(cfg, `/server/${encodeURIComponent(sid)}`, { method: 'PUT', body: patch }),
  // Republish family (persistent rules, unlike native API):
  republishList:    (cfg, sid) => call(cfg, `/server/${sid}/rtmp/republish`),
  republishCreate:  (cfg, sid, rule) => call(cfg, `/server/${sid}/rtmp/republish`, { method: 'POST', body: rule }),
  republishUpdate:  (cfg, sid, ruleId, patch) => call(cfg, `/server/${sid}/rtmp/republish/${ruleId}`, { method: 'PUT', body: patch }),
  republishDelete:  (cfg, sid, ruleId) => call(cfg, `/server/${sid}/rtmp/republish/${ruleId}`, { method: 'DELETE' }),
  republishRestart: (cfg, sid, ruleId) => call(cfg, `/server/${sid}/rtmp/republish/${ruleId}/restart`),
  // Streams helpers (for source pickers). Streams API needs Deep stats
  // enabled on the account; callers must handle failure and fall back.
  dataSlices: (cfg) => call(cfg, '/data_slices'),
  // Live streams — confirmed section "Live streams": full per-server live
  // view (all protocols) with codecs, resolution, bandwidth, publisher_ip,
  // publish_time; also supports delete.
  liveStreams: (cfg, sid) => call(cfg, `/server/${sid}/live/streams`),
  liveStreamDelete: (cfg, sid, id) => call(cfg, `/server/${sid}/live/streams/${id}`, { method: 'DELETE' }),
  streamsQuery: (cfg, sliceId, sid, kind) =>
    call(cfg, `/streams?data_slice=${encodeURIComponent(sliceId)}&server=${encodeURIComponent(sid)}&server_kind=nimble${kind ? `&kind=${encodeURIComponent(kind)}` : ''}`),
  // UDP streaming settings (SRT/UDP outputs) — confirmed: /server/{id}/mpegts/udp
  udpList:   (cfg, sid) => call(cfg, `/server/${sid}/mpegts/udp`),
  udpGet:    (cfg, sid, id) => call(cfg, `/server/${sid}/mpegts/udp/${id}`),
  udpUpdate: (cfg, sid, id, patch) => call(cfg, `/server/${sid}/mpegts/udp/${id}`, { method: 'PUT', body: patch }),
  udpCreate: (cfg, sid, body) => call(cfg, `/server/${sid}/mpegts/udp`, { method: 'POST', body }),
  udpDelete: (cfg, sid, id) => call(cfg, `/server/${sid}/mpegts/udp/${id}`, { method: 'DELETE' }),
  // MPEGTS outgoing streams — confirmed: /server/{id}/mpegts/outgoing (+ pause/resume/restart)
  outgoingList:   (cfg, sid) => call(cfg, `/server/${sid}/mpegts/outgoing`),
  outgoingGet:    (cfg, sid, id) => call(cfg, `/server/${sid}/mpegts/outgoing/${id}`),
  outgoingUpdate: (cfg, sid, id, patch) => call(cfg, `/server/${sid}/mpegts/outgoing/${id}`, { method: 'PUT', body: patch }),
  outgoingAction: (cfg, sid, id, action) => call(cfg, `/server/${sid}/mpegts/outgoing/${id}/${action}`),
  outgoingCreate: (cfg, sid, body) => call(cfg, `/server/${sid}/mpegts/outgoing`, { method: 'POST', body }),
  outgoingDelete: (cfg, sid, id) => call(cfg, `/server/${sid}/mpegts/outgoing/${id}`, { method: 'DELETE' }),
  // MPEGTS incoming streams — /server/{id}/mpegts/incoming (schema pinned
  // from live dump; CRUD family-consistent with udp/outgoing)
  incomingList:   (cfg, sid) => call(cfg, `/server/${sid}/mpegts/incoming`),
  incomingCreate: (cfg, sid, body) => call(cfg, `/server/${sid}/mpegts/incoming`, { method: 'POST', body }),
  incomingUpdate: (cfg, sid, id, patch) => call(cfg, `/server/${sid}/mpegts/incoming/${id}`, { method: 'PUT', body: patch }),
  incomingDelete: (cfg, sid, id) => call(cfg, `/server/${sid}/mpegts/incoming/${id}`, { method: 'DELETE' }),
  // RTMP live pull (pull feeds with fallback_urls) — schema from inventory
  livePullList:    (cfg, sid) => call(cfg, `/server/${sid}/rtmp/live_pull`),
  livePullCreate:  (cfg, sid, body) => call(cfg, `/server/${sid}/rtmp/live_pull`, { method: 'POST', body }),
  livePullUpdate:  (cfg, sid, id, patch) => call(cfg, `/server/${sid}/rtmp/live_pull/${id}`, { method: 'PUT', body: patch }),
  livePullDelete:  (cfg, sid, id) => call(cfg, `/server/${sid}/rtmp/live_pull/${id}`, { method: 'DELETE' }),
  livePullRestart: (cfg, sid, id) => call(cfg, `/server/${sid}/rtmp/live_pull/${id}/restart`),
  // Live applications (settings incl. push credentials) — /server/{id}/live/app
  liveAppList:   (cfg, sid) => call(cfg, `/server/${sid}/live/app`),
  liveAppCreate: (cfg, sid, body) => call(cfg, `/server/${sid}/live/app`, { method: 'POST', body }),
  liveAppUpdate: (cfg, sid, id, patch) => call(cfg, `/server/${sid}/live/app/${id}`, { method: 'PUT', body: patch }),
  liveAppDelete: (cfg, sid, id) => call(cfg, `/server/${sid}/live/app/${id}`, { method: 'DELETE' }),
  // Transcoders — ACCOUNT-level (server_id is an attribute). The _sid
  // parameter is accepted but unused, keeping the KIND_OPS call shape uniform.
  transcoderList:   (cfg, _sid) => call(cfg, `/transcoder`),
  transcoderGet:    (cfg, id) => call(cfg, `/transcoder/${id}?details=true`),
  // Pipeline sub-objects (kind = 'video'|'audio', io = 'input'|'filter'|'output').
  pipelineGet:      (cfg, id, kind, pid) => call(cfg, `/transcoder/${id}/pipeline/${kind}/${pid}`),
  pipelineDelete:   (cfg, id, kind, pid) => call(cfg, `/transcoder/${id}/pipeline/${kind}/${pid}`, { method: 'DELETE' }),
  pipelineIoUpdate: (cfg, id, kind, pid, io, ioId, body) => call(cfg, `/transcoder/${id}/pipeline/${kind}/${pid}/${io}/${ioId}`, { method: 'PUT', body }),
  pipelineIoDelete: (cfg, id, kind, pid, io, ioId) => call(cfg, `/transcoder/${id}/pipeline/${kind}/${pid}/${io}/${ioId}`, { method: 'DELETE' }),
  transcoderUpdate: (cfg, _sid, id, patch) => call(cfg, `/transcoder/${id}`, { method: 'PUT', body: patch }),
  transcoderPause:  (cfg, id) => call(cfg, `/transcoder/${id}/pause`),
  transcoderResume: (cfg, id) => call(cfg, `/transcoder/${id}/resume`),
  transcoderClone:  (cfg, id) => call(cfg, `/transcoder/${id}/clone`),
  transcoderDelete: (cfg, id) => call(cfg, `/transcoder/${id}`, { method: 'DELETE' }),
  transcoderLicenses: (cfg) => call(cfg, `/licenses/transcoder`),
  // ABR (account-level): rendition ladder -> single ABR stream
  abrList:   (cfg, _sid) => call(cfg, `/abr`),
  abrCreate: (cfg, body) => call(cfg, `/abr`, { method: 'POST', body }),
  abrUpdate: (cfg, _sid, id, patch) => call(cfg, `/abr/${id}`, { method: 'PUT', body: patch }),
  abrDelete: (cfg, id) => call(cfg, `/abr/${id}`, { method: 'DELETE' }),
  // Application aliases (account-level)
  aliasList:   (cfg, _sid) => call(cfg, `/aliases`),
  aliasCreate: (cfg, body) => call(cfg, `/aliases`, { method: 'POST', body }),
  aliasUpdate: (cfg, _sid, id, patch) => call(cfg, `/aliases/${id}`, { method: 'PUT', body: patch }),
  aliasDelete: (cfg, id) => call(cfg, `/aliases/${id}`, { method: 'DELETE' }),
  // Origin applications (account-level)
  originAppList:   (cfg) => call(cfg, `/origin_apps`),
  originAppCreate: (cfg, body) => call(cfg, `/origin_apps`, { method: 'POST', body }),
  originAppUpdate: (cfg, id, patch) => call(cfg, `/origin_apps/${id}`, { method: 'PUT', body: patch }),
  originAppDelete: (cfg, id) => call(cfg, `/origin_apps/${id}`, { method: 'DELETE' }),
  // Nimble routes (account-level, iter20 m2).
  //
  // Paths confirmed against the official reference, not remembered: the
  // trailing slash on the collection is what the documented examples use, and
  // the fleet's own account returned {"status":"Ok","routes":[]} on GET — an
  // empty list, so no live example of a populated route exists yet. Field
  // shapes below come from the reference; the first apply is the first real
  // proof, which is why the deployment plan verifies by reading back.
  routeList:   (cfg) => call(cfg, `/routes/`),
  routeGet:    (cfg, id) => call(cfg, `/routes/${id}`),
  routeCreate: (cfg, body) => call(cfg, `/routes/`, { method: 'POST', body }),
  routeUpdate: (cfg, id, patch) => call(cfg, `/routes/${id}`, { method: 'PUT', body: patch }),
  routeDelete: (cfg, id) => call(cfg, `/routes/${id}`, { method: 'DELETE' }),
  // WMSAuth: groups carry servers, rules live inside a group.
  //
  // Paths from the reference; the account has none of these objects, so every
  // shape below is documented rather than observed — the same position we were
  // in with routes, where `to` turned out not to be a URL. The apply path
  // reads back after writing for exactly that reason.
  authGroupList:   (cfg) => call(cfg, `/wmsauth/groups`),
  authGroupCreate: (cfg, body) => call(cfg, `/wmsauth/groups`, { method: 'POST', body }),
  authGroupUpdate: (cfg, id, patch) => call(cfg, `/wmsauth/groups/${id}`, { method: 'PUT', body: patch }),
  authGroupDelete: (cfg, id) => call(cfg, `/wmsauth/groups/${id}`, { method: 'DELETE' }),
  authRuleList:    (cfg, gid) => call(cfg, `/wmsauth/groups/${gid}/rules`),
  authRuleCreate:  (cfg, gid, body) => call(cfg, `/wmsauth/groups/${gid}/rules`, { method: 'POST', body }),
  authRuleUpdate:  (cfg, gid, id, patch) => call(cfg, `/wmsauth/groups/${gid}/rules/${id}`, { method: 'PUT', body: patch }),
  authRuleDelete:  (cfg, gid, id) => call(cfg, `/wmsauth/groups/${gid}/rules/${id}`, { method: 'DELETE' }),
  // Hotlink, geo and network restrictions — separate families, same shape.
  refererGroupList:   (cfg) => call(cfg, `/referer_groups`),
  refererGroupGet:    (cfg, id) => call(cfg, `/referer_groups/${id}`),
  refererGroupCreate: (cfg, body) => call(cfg, `/referer_groups`, { method: 'POST', body }),
  refererGroupUpdate: (cfg, id, patch) => call(cfg, `/referer_groups/${id}`, { method: 'PUT', body: patch }),
  refererGroupDelete: (cfg, id) => call(cfg, `/referer_groups/${id}`, { method: 'DELETE' }),

  // IP ranges are two objects, not one: a group, and the CIDRs assigned to it.
  // Creating the group leaves it empty and permitting nothing, so the assign
  // call is not an optional second step — it is half of creating the thing.
  ipRangeList:   (cfg) => call(cfg, `/ip_ranges`),
  ipRangeCreate: (cfg, body) => call(cfg, `/ip_ranges`, { method: 'POST', body }),
  ipRangeUpdate: (cfg, id, patch) => call(cfg, `/ip_ranges/${id}`, { method: 'PUT', body: patch }),
  ipRangeDelete: (cfg, id) => call(cfg, `/ip_ranges/${id}`, { method: 'DELETE' }),
  ipRangeCidrs:  (cfg, id) => call(cfg, `/ip_ranges/${id}/cidrs`),
  ipRangeAssign: (cfg, id, body) => call(cfg, `/ip_ranges/${id}/cidrs/assign`, { method: 'PUT', body }),
  ipRangeRevoke: (cfg, id, body) => call(cfg, `/ip_ranges/${id}/cidrs/revoke`, { method: 'PUT', body }),

  // Reference data, and read-only: the account's countries and networks as
  // WMSPanel knows them. There is no POST for either — which is why a country
  // restriction cannot be written as an object of its own.
  // DVR: what is recorded, and removing a recording. There is no POST — the
  // recording itself is set up on WMSPanel's own DVR settings page, so the
  // panel reads and offers playback rather than pretending it can configure.
  dvrStreamList:   (cfg) => call(cfg, `/dvr_streams/`),
  dvrStreamDelete: (cfg, id) => call(cfg, `/dvr_streams/${id}`, { method: 'DELETE' }),

  geoList: (cfg) => call(cfg, `/geo`),
  asnList: (cfg) => call(cfg, `/asn`),
  // RTMP interfaces (view)
  rtmpInterfaceList: (cfg, sid) => call(cfg, `/server/${sid}/rtmp/interface`),
  rtmpInterfaceCreate: (cfg, sid, body) => call(cfg, `/server/${sid}/rtmp/interface`, { method: 'POST', body }),
  rtmpInterfaceUpdate: (cfg, sid, id, patch) => call(cfg, `/server/${sid}/rtmp/interface/${id}`, { method: 'PUT', body: patch }),
  rtmpInterfaceDelete: (cfg, sid, id) => call(cfg, `/server/${sid}/rtmp/interface/${id}`, { method: 'DELETE' }),
  // Hot swap settings — confirmed: /server/{id}/hotswap (Transcoder feature)
  hotswapList:   (cfg, sid) => call(cfg, `/server/${sid}/hotswap`),
  hotswapGet:    (cfg, sid, id) => call(cfg, `/server/${sid}/hotswap/${id}`),
  hotswapUpdate: (cfg, sid, id, patch) => call(cfg, `/server/${sid}/hotswap/${id}`, { method: 'PUT', body: patch }),
  hotswapCreate: (cfg, sid, body) => call(cfg, `/server/${sid}/hotswap`, { method: 'POST', body }),
  hotswapDelete: (cfg, sid, id) => call(cfg, `/server/${sid}/hotswap/${id}`, { method: 'DELETE' }),
};
