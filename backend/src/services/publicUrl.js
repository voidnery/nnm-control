// iter10 — the address the panel tells other people to use.
//
// Two things generate links that leave this process: the agent installer,
// which a server has to fetch, and a dashboard share link, which a person
// opens in a browser. Both were built from `req.get('host')`, and that is
// wrong more often than it looks.
//
// The Host header carries the port only if the client sent it AND the reverse
// proxy passed it through. nginx's `proxy_set_header Host $host` — the form in
// most published configs — strips it, because `$host` is the hostname without
// the port; `$http_host` keeps it. A panel served on :8095 behind such a proxy
// therefore hands out links to :443, where something else is listening.
//
// So: an operator-set public URL wins, because only they know how the panel is
// published. Failing that, the request is read as carefully as it can be —
// X-Forwarded-Host and X-Forwarded-Port before Host, and a non-default port
// re-attached when the proxy dropped it.
import { Settings } from '../models/Settings.js';

const DEFAULT_PORT = { 'http:': '80', 'https:': '443' };

export function fromRequest(req) {
  const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = xfProto || req.protocol || 'http';

  const xfHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  let host = xfHost || req.get('host') || '';
  const xfPort = String(req.headers['x-forwarded-port'] || '').split(',')[0].trim();

  // The proxy told us the port separately, and the host we got has none.
  if (xfPort && !/:\d+$/.test(host)) {
    const dflt = DEFAULT_PORT[`${proto}:`];
    if (xfPort !== dflt) host = `${host}:${xfPort}`;
  }
  return `${proto}://${host}`.replace(/\/+$/, '');
}

/**
 * The panel's public base URL.
 *
 * @param {object} req  used only as a fallback
 * @returns {Promise<{url: string, source: 'configured'|'request'}>}
 */
export async function publicUrl(req) {
  const s = await Settings.load();
  const configured = String(s.publicUrl || '').trim().replace(/\/+$/, '');
  if (configured) return { url: configured, source: 'configured' };
  return { url: fromRequest(req), source: 'request' };
}

// Does the address the panel derived look like it lost its port on the way
// through a proxy? Worth saying out loud, because the resulting link fails in
// a way that points at the wrong thing: it reaches whatever else answers on
// 443.
export function looksPortStripped(req, url) {
  try {
    const u = new URL(url);
    if (u.port) return false;
    const listening = String(process.env.PORT || 4000);
    const forwarded = String(req.headers['x-forwarded-port'] || '');
    // A forwarded port that is not the scheme default, yet no port in the URL.
    if (forwarded && forwarded !== DEFAULT_PORT[`${u.protocol}`]) return true;
    return listening !== '4000' && !u.port;
  } catch { return false; }
}
