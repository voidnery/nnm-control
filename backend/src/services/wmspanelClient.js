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
    const res = await fetch(buildUrl(cfg, path), {
      method,
      signal: ctrl.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
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
