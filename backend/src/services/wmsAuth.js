import crypto from 'node:crypto';

// Signing a playback URL so Nimble will serve it.
//
// This is the part that makes token protection worth having in the panel at
// all. Creating a WMSAuth rule is easy; producing a link that satisfies it is
// where the work is, and a link signed even slightly wrong does not fail
// loudly — the server simply refuses, and the operator concludes the stream is
// broken.
//
// The scheme, from Softvelum's own samples and consistent across four of them:
//
//   str2hash  = ip + key + server_time + validminutes
//   hash      = base64( md5(str2hash, raw binary) )
//   signature = base64( "server_time=…&hash_value=…&validminutes=…" )
//   url       = <playback url> + "?wmsAuthSign=" + signature
//
// Three details are easy to get wrong and each produces a 403 rather than an
// error message:
//
//   1. `server_time` is UTC in PHP's `n/j/Y g:i:s A` — no leading zeros on the
//      month, day or hour, a 12-hour clock, and an uppercase AM/PM. Producing
//      `05/04/2012 08:33:05 AM` instead of `5/4/2012 8:33:05 AM` changes the
//      hashed string and therefore the hash.
//   2. The MD5 is hashed to raw bytes and *then* base64'd. Base64 of the hex
//      digest is a different string of the right length, which is the worst
//      kind of wrong.
//   3. The viewer's IP is part of the hash. A signed link is bound to one
//      address unless the rule is configured otherwise — so the panel cannot
//      hand out a universal signed link, and says so rather than issuing one
//      that works only for whoever generated it.

// PHP's `n/j/Y g:i:s A`, in UTC. Written out rather than assembled from
// toLocaleString: locale formatting varies by environment and would produce a
// string that differs on someone else's machine.
export function serverTime(d = new Date()) {
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const h24 = d.getUTCHours();
  const hour = h24 % 12 === 0 ? 12 : h24 % 12;
  const pad = (n) => String(n).padStart(2, '0');
  return `${month}/${day}/${d.getUTCFullYear()} ${hour}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${h24 < 12 ? 'AM' : 'PM'}`;
}

export function signUrl(url, {
  key,
  ip = '',
  validMinutes = 20,
  // Pay-per-view: a viewer identifier folded into the hash, which lets the
  // same rule distinguish one customer from another.
  id = '',
  checkIp = false,
  at = new Date(),
} = {}) {
  if (!key) throw new Error('a signing key is required');
  const time = serverTime(at);
  // `id` sits between the ip and the key, per the pay-per-view sample. Order
  // matters and is not guessable from the field names.
  const str2hash = `${ip}${id}${key}${time}${validMinutes}`;
  const hash = crypto.createHash('md5').update(str2hash, 'utf8').digest('base64');

  const parts = [`server_time=${time}`, `hash_value=${hash}`, `validminutes=${validMinutes}`];
  if (id) parts.push(`id=${id}`);
  if (checkIp) parts.push('checkip=true');

  const sign = Buffer.from(parts.join('&'), 'utf8').toString('base64');
  return {
    url: `${url}${url.includes('?') ? '&' : '?'}wmsAuthSign=${sign}`,
    sign,
    // Returned so the panel can show what it signed rather than only the
    // result — the difference between "this does not work" and "this does not
    // work and here is the string the server will hash".
    serverTime: time,
    validMinutes,
    boundToIp: ip || null,
    expiresAt: new Date(at.getTime() + validMinutes * 60_000).toISOString(),
  };
}

// The inverse, for showing an operator what a link they were given contains.
// Useful when a link fails and nobody knows whose it is or when it expired.
export function readSignature(url) {
  const m = String(url).match(/[?&]wmsAuthSign=([^&]+)/);
  if (!m) return null;
  let decoded;
  try { decoded = Buffer.from(decodeURIComponent(m[1]), 'base64').toString('utf8'); }
  catch { return null; }
  if (!/server_time=/.test(decoded)) return null;
  const out = {};
  for (const pair of decoded.split('&')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

// Whether this channel can be protected this way at all.
//
// From Softvelum's own paywall FAQ: an application listed under HTTP origin
// applications is not protected by a WMSAuth signature. It is the same
// interaction as the cache — HTTP Origin mode quietly disables something the
// operator believes is on — and it deserves the same blocking treatment
// rather than a note nobody reads.
export function tokenPreconditions({ application, originApps = [], edges = [] }) {
  const blocking = [];
  const app = String(application || '').replace(/^\/+|\/+$/g, '');
  const onOrigin = originApps.some(oa => String(oa.application) === app);
  if (onOrigin) blocking.push('http-origin-defeats-token');
  // Clock skew: the rule carries a tolerance and the server compares its own
  // time against the signature's. Worth stating where it can be acted on.
  if (edges.some(e => e.clockSkewSeconds != null && Math.abs(e.clockSkewSeconds) > 60)) {
    blocking.push('clock-skew');
  }
  return blocking;
}
