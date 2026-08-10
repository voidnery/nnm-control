import { runTask } from './agentBus.js';
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

// Whether this server's agent can be asked instead of dialling the server.
//
// Preferred whenever the agent is alive, because it is the correct direction:
// the panel opens no connection to a server, which is the rule the whole
// transport was built on and the reason a studio-LAN server works at all. The
// direct call stays for servers without an agent.
function agentIsLive(server) {
  const a = server?.agent;
  if (!a?.enabled || !a?.lastContactAt) return false;
  // A poll is due every 25s; a minute and a half of silence means it is not
  // there, and waiting on a task it will never claim is worse than a direct
  // attempt that fails quickly.
  return Date.now() - new Date(a.lastContactAt).getTime() < 90_000;
}

async function viaAgent(server, path, extraQuery) {
  const auth = authQuery(server.token);
  const query = [extraQuery, auth].filter(Boolean).join('&');
  const out = await runTask(server, 'POST /nimble', {
    // The address the panel knows this server by, as a fallback for an agent
    // whose Nimble is not listening on loopback. It is still the same machine
    // — the agent runs on it — so this cannot reach a different Nimble.
    body: { path, query, baseUrl: buildUrl(server, '', null).split('?')[0].replace(/\/$/, '') },
    // Shorter than the collector's own interval, so a slow answer is dropped
    // rather than piling up behind the next cycle.
    timeoutMs: 12_000,
    createdBy: 'stats',
  });
  return out?.json ?? null;
}

// Whether a read went through the agent or dialled the server. Reported rather
// than assumed: the agent is preferred, but `call` falls back to a direct
// attempt when the agent cannot answer, so "there is an agent" and "the agent
// answered this" are different statements. A panel that shows a reading
// without saying which one it is asks the operator to trust a number whose
// provenance it knows and did not say.
export { agentIsLive };

async function call(server, path, { method = 'GET', body, extraQuery, meta } = {}) {
  // Reads go through the agent when there is one. Writes do not: they are
  // control, they are rarer, and routing them through a task queue would put a
  // long-poll cycle between an operator and a change they are watching for.
  if (method === 'GET' && !body && agentIsLive(server)) {
    try {
      const out = await viaAgent(server, path, extraQuery);
      if (meta) meta.transport = 'agent';
      return out;
    } catch (e) {
      // The agent being unable to answer does not mean the server is
      // unreachable — fall through and try directly, which is what a server on
      // a routable address would have done anyway.
      //
      // This used to list the failures worth falling back from, and missed the
      // one that matters most: an agent older than v10 has no `POST /nimble`
      // and answers "no handler for ...". That threw, so a fleet of older
      // agents would have lost native statistics entirely rather than falling
      // back to a direct call.
      //
      // Inverted deliberately. The fallback is harmless — a direct call either
      // works or fails quickly — so the default is to try it, and only a
      // failure that came from NIMBLE ITSELF is worth propagating, because
      // asking the same server the same question again would only repeat it.
      const msg = String(e?.message || '');
      // Answers that came from Nimble itself, whether directly or relayed by
      // the agent. Asking the same server the same question again would only
      // reproduce them, so they are the answer.
      const fromNimble = /^Nimble API HTTP/.test(msg) || /^nimble returned \d+ for /.test(msg);
      if (fromNimble) throw e;
    }
  }
  if (meta) meta.transport = 'direct';
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
  liveStreams:      (s, meta) => call(s, '/manage/live_streams_status', { meta }),
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
