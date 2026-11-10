// Delivering events to webhook subscriptions — eterix-contracts/evt-1.md §4, the NNM-Control part in
// docs/api/PROPOSAL-nnm-api-1.md §3.1.
//
// Where the panel does not send (evt/1 §4.4), checked AFTER DNS and on EVERY attempt, and the
// connection goes to the address that was checked — a name that resolves to 127.0.0.1 on the second
// lookup gets nothing: loopback, link-local, cloud metadata, unspecified, multicast and the panel's
// own addresses are refused; private networks are allowed (the operator's consumers live there);
// plain http only when the subscription says so; redirects are never followed.
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import { signature, nextAttemptAt, DISABLE_AFTER } from './events.js';

export const TIMEOUT_MS = 10_000;
const KEEP_RESPONSE = 2048;

const v4 = (ip) => ip.split('.').map(Number);
/** Why an address is refused, or null. `local` — the panel's own addresses. */
export function refusedAddress(ip, local = new Set()) {
  let a = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
  if (a.startsWith('::ffff:') && net.isIPv4(a.slice(7))) a = a.slice(7);
  if (local.has(a)) return 'the panel itself';
  if (net.isIPv4(a)) {
    const [x, y] = v4(a);
    if (x === 127) return 'loopback';
    if (x === 169 && y === 254) return a === '169.254.169.254' ? 'cloud metadata' : 'link-local';
    if (x === 0) return 'unspecified';
    if (x >= 224 && x <= 239) return 'multicast';
    if (x === 255) return 'broadcast';
    return null;
  }
  if (net.isIPv6(a)) {
    if (a === '::1') return 'loopback';
    if (a === '::') return 'unspecified';
    if (/^fe[89ab]/.test(a)) return 'link-local';
    if (a === 'fd00:ec2::254') return 'cloud metadata';
    if (/^ff/.test(a)) return 'multicast';
    return null;
  }
  return 'not an IP address';
}

export function localAddresses() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) out.add(String(i.address).toLowerCase());
  return out;
}

/** The URL as a subscription may hold it, or why not. */
export function checkUrl(raw, { allowHttp = false } = {}) {
  let u;
  try { u = new URL(String(raw)); } catch { return { ok: false, why: 'not a URL' }; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && allowHttp)) {
    return { ok: false, why: u.protocol === 'http:' ? 'http:// needs the explicit «allow http» mark' : 'only https:// (or marked http://)' };
  }
  if (u.username || u.password) return { ok: false, why: 'credentials in the URL — use the signing secret instead' };
  if (!u.hostname) return { ok: false, why: 'no host' };
  return { ok: true, url: u };
}

/**
 * Resolve and check every address the name has; refuse if ANY is forbidden (a name with one good
 * and one internal address must not be a coin toss). Returns the address to connect to.
 */
// `refuse` is replaceable only so a test can reach a server on its own loopback; production uses the default.
export async function resolveChecked(hostname, { lookup = (h) => dns.lookup(h, { all: true }), local = localAddresses(), refuse = refusedAddress } = {}) {
  const host = String(hostname).replace(/^\[|\]$/g, '');
  const list = net.isIP(host) ? [{ address: host, family: net.isIPv6(host) ? 6 : 4 }] : await lookup(host);
  if (!list?.length) return { ok: false, why: 'the name does not resolve' };
  for (const a of list) {
    const why = refuse(a.address, local);
    if (why) return { ok: false, why: `${hostname} → ${a.address}: ${why}` };
  }
  return { ok: true, address: list[0].address, family: list[0].family };
}

/** One attempt. Resolves to {ok, code, response, error}; never throws. */
export async function sendOnce({ url, secret, envelope, allowHttp, now = new Date(), userAgent = 'nnm-control evt/1', deps = {} }) {
  const chk = checkUrl(url, { allowHttp });
  if (!chk.ok) return { ok: false, code: 0, error: chk.why, refused: true };
  const r = await resolveChecked(chk.url.hostname, deps).catch(e => ({ ok: false, why: `DNS: ${e.message}` }));
  if (!r.ok) return { ok: false, code: 0, error: r.why, refused: true };

  const body = JSON.stringify(envelope);
  const ts = String(Math.floor(now.getTime() / 1000));
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'User-Agent': userAgent,
    'X-Eterix-Event': envelope.type,
    'X-Eterix-Delivery': envelope.id,
    'X-Eterix-Timestamp': ts,
    'X-Eterix-Signature': signature(secret, ts, body),
  };
  const mod = chk.url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = mod.request(chk.url, {
      method: 'POST', headers, timeout: TIMEOUT_MS,
      // Connect to the address that was checked, whatever the resolver says now.
      lookup: (_h, opts, cb) => (opts?.all ? cb(null, [{ address: r.address, family: r.family }]) : cb(null, r.address, r.family)),
      servername: net.isIP(chk.url.hostname) ? undefined : chk.url.hostname,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (buf.length < KEEP_RESPONSE) buf += c; });
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        resolve({ ok, code: res.statusCode, response: buf.slice(0, KEEP_RESPONSE),
          error: ok ? '' : (res.statusCode >= 300 && res.statusCode < 400 ? 'redirects are not followed' : `HTTP ${res.statusCode}`) });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`no answer in ${TIMEOUT_MS / 1000} s`)));
    req.on('error', (e) => resolve({ ok: false, code: 0, error: e.message }));
    req.end(body);
  });
}

/** Apply the result of one attempt to a delivery and its subscription (mutates both). */
export function settle(delivery, sub, result, now = new Date()) {
  delivery.attempts += 1;
  delivery.lastAt = now;
  delivery.lastCode = result.code || 0;
  delivery.lastError = result.error || '';
  delivery.response = result.response || '';
  if (result.ok) {
    delivery.status = 'ok';
    sub.consecutiveFailures = 0;
    return;
  }
  sub.consecutiveFailures = (sub.consecutiveFailures || 0) + 1;
  const next = nextAttemptAt(delivery.attempts, now);
  if (next) { delivery.status = 'failed'; delivery.nextAt = next; } else delivery.status = 'given_up';
  if (sub.consecutiveFailures >= DISABLE_AFTER && sub.enabled) {
    sub.enabled = false;
    sub.disabledReason = `turned off after ${DISABLE_AFTER} failed deliveries in a row (last: ${delivery.lastError})`;
  }
}

/** One pass over due deliveries. Models injected; returns counts. */
export async function dispatchOnce({ Event, WebhookSubscription, WebhookDelivery, now = new Date(), limit = 50, send = sendOnce }) {
  const due = await WebhookDelivery.find({ status: { $in: ['pending', 'failed'] }, nextAt: { $lte: now } })
    .sort({ nextAt: 1 }).limit(limit);
  const out = { sent: 0, ok: 0, failed: 0 };
  for (const d of due) {
    const sub = await WebhookSubscription.findById(d.subscriptionId);
    const ev = await Event.findOne({ eventId: d.eventId });
    if (!sub || !ev) { d.status = 'given_up'; d.lastError = !sub ? 'subscription deleted' : 'event expired'; await d.save(); continue; }
    if (!sub.enabled && d.type !== 'webhook.test') { d.status = 'skipped'; d.lastError = 'subscription is off'; await d.save(); continue; }
    const result = await send({ url: sub.url, secret: sub.secret, envelope: ev.envelope, allowHttp: sub.allowHttp, now });
    settle(d, sub, result, now);
    await d.save();
    await sub.save();
    out.sent++; if (result.ok) out.ok++; else out.failed++;
  }
  return out;
}

export function startWebhookDispatcher(models, { intervalMs = 15_000 } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await dispatchOnce(models); }
    catch (e) { console.error('[webhooks]', e?.message || e); }
    finally { running = false; }
  };
  return setInterval(tick, intervalMs);
}
