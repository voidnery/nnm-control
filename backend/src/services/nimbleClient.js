import crypto from 'node:crypto';

// Client for the Nimble Streamer NATIVE management API.
// Auth per official spec (softvelum.com/nimble/api): if management_token is
// set, each request carries ?salt=<rand>&hash=base64(md5_raw(salt + "/" + token)).
// If no token is configured on the server, requests go unsigned.

const TIMEOUT_MS = 8000;

function authQuery(token) {
  if (!token) return '';
  const salt = Math.floor(Math.random() * 1000000);
  const md5raw = crypto.createHash('md5').update(`${salt}/${token}`).digest();
  const hash = md5raw.toString('base64');
  return `salt=${salt}&hash=${encodeURIComponent(hash)}`;
}

function buildUrl(server, path, extraQuery = '') {
  const proto = server.useSsl ? 'https' : 'http';
  const auth = authQuery(server.token);
  const parts = [extraQuery, auth].filter(Boolean).join('&');
  const sep = path.includes('?') ? '&' : '?';
  return `${proto}://${server.host}:${server.port}${path}${parts ? sep + parts : ''}`;
}

async function call(server, path, { method = 'GET', body, extraQuery } = {}) {
  const url = buildUrl(server, path, extraQuery);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`Nimble API HTTP ${res.status}`);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export const nimble = {
  serverStatus:     (s) => call(s, '/manage/server_status'),
  liveStreams:      (s) => call(s, '/manage/live_streams_status'),
  sessions:         (s) => call(s, '/manage/sessions'),
  deleteSessions:   (s, ids) => call(s, '/manage/sessions/delete', { method: 'POST', body: ids }),
  rtmpSettings:     (s) => call(s, '/manage/rtmp_settings'),
  republishRules:   (s) => call(s, '/manage/rtmp/republish'),
  republishStats:   (s) => call(s, '/manage/rtmp/republish/stats'),
  republishCreate:  (s, rule) => call(s, '/manage/rtmp/republish', { method: 'POST', body: rule }),
  republishDelete:  (s, id) => call(s, `/manage/rtmp/republish/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  mpegtsStatus:     (s) => call(s, '/manage/mpeg2ts_status'),
  mpegtsSettings:   (s) => call(s, '/manage/mpeg2ts_settings'),
  srtSenderStats:   (s) => call(s, '/manage/srt_sender_stats'),
  srtReceiverStats: (s) => call(s, '/manage/srt_receiver_stats'),
  playlistStatus:   (s) => call(s, '/manage/server_playlist_status'),
  reloadConfig:     (s) => call(s, '/manage/reload_config', { method: 'POST' }),
  reloadSsl:        (s) => call(s, '/manage/reload_ssl_certificates', { method: 'POST' }),
  syncPanel:        (s) => call(s, '/manage/sync_panel_settings', { method: 'POST' }),
};
