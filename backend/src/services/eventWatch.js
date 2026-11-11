// The events that need someone to look: server.reachable / .unreachable, stream.up / .down and
// certificate.expiring (docs/api/PROPOSAL-nnm-api-1.md §3.4).
//
// Servers and streams are read from the NATIVE Nimble API (directly or through the agent), like the
// statistics: WMSPanel allows 15 000 calls a day per account, and a 30 s poll of a fleet would spend
// them on this alone.
//
// Only CHANGES are events, and the first look at a server is not a change: after a restart of the
// panel nothing is announced until something actually moves. A server that has never answered is
// never «unreachable» — it is a server whose management address is not set up, and that is a
// different problem with a different place to be shown.
//
// One missed answer is not an outage: a server must miss `downAfter` polls in a row to be
// unreachable, a stream must be absent from `downAfter` answers in a row to be down. A stream that
// appears is up at once — the delay is there against noise, and an appearance is not noise.
import { NimbleServer } from '../models/NimbleServer.js';
import { Settings } from '../models/Settings.js';
import { Event } from '../models/Webhook.js';
import { nimble } from './nimbleClient.js';
import { probeTls } from './tlsProbe.js';
import { WARN_DAYS } from './certState.js';
import { emit } from './events.js';

export const DEFAULTS = Object.freeze({ enabled: true, intervalSec: 30, downAfter: 2 });

export function watchSettings(s) {
  const w = s?.eventWatch || {};
  return {
    enabled: w.enabled !== false,
    intervalSec: Math.min(600, Math.max(10, Number(w.intervalSec) || DEFAULTS.intervalSec)),
    downAfter: Math.min(10, Math.max(1, Number(w.downAfter) || DEFAULTS.downAfter)),
  };
}

/**
 * `app/stream` of every live stream in a native answer. Nimble lists applications, each with its
 * streams (`[{app, streams: [{strm}]}]`); a flat list of `{application, stream}` is read too.
 */
export function liveNames(d) {
  const out = new Set();
  const list = Array.isArray(d) ? d : (Array.isArray(d?.streams) ? d.streams : []);
  for (const x of list) {
    if (Array.isArray(x?.streams)) {
      for (const s of x.streams) {
        const name = s?.strm ?? s?.stream ?? s?.name;
        if (x.app && name) out.add(`${x.app}/${name}`);
      }
    } else {
      const app = x?.application ?? x?.app;
      const name = x?.stream ?? x?.strm ?? x?.name;
      if (app && name) out.add(`${app}/${name}`);
    }
  }
  return out;
}

export const newServerState = () => ({ reachable: null, fails: 0, downSince: null, streams: null });

/**
 * One poll of one server. Pure: takes the state and what was seen, returns the next state and the
 * events — `{type, data, stream?}` — so every rule above is testable without a fleet.
 * `seen`: `{reachable, streams: Set|null, error}`; streams null — the list could not be read.
 */
export function observe(state, seen, { downAfter = DEFAULTS.downAfter, now = new Date() } = {}) {
  const st = { ...state, streams: state.streams ? new Map(state.streams) : null };
  const events = [];

  if (!seen.reachable) {
    st.fails += 1;
    if (st.fails >= downAfter && st.reachable !== false) {
      // From «answering» to «not» is an event; from «never seen» it is only a fact.
      if (st.reachable === true) {
        events.push({ type: 'server.unreachable', data: { failed_polls: st.fails, error: String(seen.error || '').slice(0, 300) } });
      }
      st.reachable = false;
      st.downSince = now.toISOString();
    }
    // Nothing is known about the streams of a server that does not answer: not a reason to call
    // every one of them down.
    return { state: st, events };
  }

  if (st.reachable === false && st.downSince) {
    events.push({ type: 'server.reachable', data: { down_since: st.downSince, down_for_s: Math.round((now - new Date(st.downSince)) / 1000) } });
  }
  st.reachable = true;
  st.fails = 0;
  st.downSince = null;

  if (!seen.streams) return { state: st, events };
  if (!st.streams) {
    // The first list is the baseline.
    st.streams = new Map([...seen.streams].map(n => [n, 0]));
    return { state: st, events };
  }
  for (const name of seen.streams) {
    if (!st.streams.has(name)) events.push({ type: 'stream.up', stream: name, data: {} });
    st.streams.set(name, 0);
  }
  for (const [name, missed] of st.streams) {
    if (seen.streams.has(name)) continue;
    if (missed + 1 >= downAfter) {
      events.push({ type: 'stream.down', stream: name, data: { missed_polls: missed + 1 } });
      st.streams.delete(name);
    } else st.streams.set(name, missed + 1);
  }
  return { state: st, events };
}

/** What a server answers right now. Never throws. */
export async function lookAt(server, { client = nimble } = {}) {
  const [status, live] = await Promise.allSettled([client.serverStatus(server), client.liveStreams(server)]);
  if (status.status !== 'fulfilled' && live.status !== 'fulfilled') {
    return { reachable: false, streams: null, error: String(status.reason?.message || status.reason) };
  }
  return { reachable: true, streams: live.status === 'fulfilled' ? liveNames(live.value) : null };
}

const subjectOf = (server, ev) => (ev.stream
  ? { kind: 'stream', id: ev.stream, server_id: String(server._id), name: ev.stream }
  : { kind: 'server', id: String(server._id), server_id: String(server._id), name: server.name });

const states = new Map();   // serverId → state

/** One round over the fleet. Dependencies injected for the test; returns the events emitted. */
export async function watchOnce({
  servers, look = lookAt, send = emit, downAfter = DEFAULTS.downAfter, now = new Date(), memory = states,
} = {}) {
  const out = [];
  const seen = await Promise.all(servers.map(s => look(s).catch(e => ({ reachable: false, streams: null, error: e?.message }))));
  const alive = new Set();
  servers.forEach((server, i) => {
    const id = String(server._id);
    alive.add(id);
    const r = observe(memory.get(id) || newServerState(), seen[i], { downAfter, now });
    memory.set(id, r.state);
    for (const ev of r.events) {
      const e = { type: ev.type, subject: subjectOf(server, ev), actor: { kind: 'system', name: 'nnm-control' }, data: { server: server.name, ...ev.data } };
      out.push(e);
      send(e);
    }
  });
  for (const id of memory.keys()) if (!alive.has(id)) memory.delete(id);   // a removed server
  return out;
}

// ---- certificates ----

/** The names a viewer reaches this server by over TLS: what its certificate has to cover. */
export function certTargets(server) {
  const names = new Set();
  const isIp = (h) => /^[\d.]+$/.test(h) || h.includes(':');
  if (server.gateway?.domain) names.add(server.gateway.domain);
  for (const e of server.playbackEndpoints || []) if (e.ssl && e.host && !isIp(e.host)) names.add(e.host);
  const port = server.httpsPort || 443;
  return [...names].map(host => ({ host, port }));
}

/** An answer of probeTls → the event to send, or null if there is nothing to say. */
export function certEvent(server, target, tls, now = new Date()) {
  if (!tls?.tls || !tls.certExpiresAt) return null;
  const daysLeft = Math.floor((new Date(tls.certExpiresAt) - now) / 86400000);
  if (daysLeft > WARN_DAYS) return null;
  return {
    type: 'certificate.expiring',
    subject: { kind: 'certificate', id: `${target.host}:${target.port}`, server_id: String(server._id), name: target.host },
    actor: { kind: 'system', name: 'nnm-control' },
    data: { server: server.name, host: target.host, port: target.port, valid_to: tls.certExpiresAt, days_left: daysLeft, expired: daysLeft < 0, trusted: tls.certTrusted === true },
  };
}

/**
 * Once a day per name. «Already said today» is asked of the event log, not of memory, so a restart
 * of the panel does not say it twice.
 */
export async function certificatesOnce({
  servers, probe = probeTls, send = emit, now = new Date(),
  saidSince = async (id, since) => Boolean(await Event.findOne({ type: 'certificate.expiring', 'envelope.subject.id': id, occurredAt: { $gte: since } }).lean()),
} = {}) {
  const out = [];
  const since = new Date(now.getTime() - 23 * 3600 * 1000);
  for (const server of servers) {
    for (const t of certTargets(server)) {
      const ev = certEvent(server, t, await probe(t.host, t.port).catch(() => null), now);
      if (!ev || await saidSince(ev.subject.id, since)) continue;
      out.push(ev);
      await send(ev);
    }
  }
  return out;
}

// ---- schedule ----
let timer = null;
let certTimer = null;
let running = false;

export async function startEventWatch() {
  const w = watchSettings(await Settings.load());
  if (timer) clearInterval(timer);
  if (certTimer) clearInterval(certTimer);
  timer = null; certTimer = null;
  if (!w.enabled) { console.log('[watch] off'); return; }
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await watchOnce({ servers: await NimbleServer.find(), downAfter: w.downAfter }); }
    catch (e) { console.error('[watch]', e?.message || e); }
    finally { running = false; }
  }, w.intervalSec * 1000);
  const certs = async () => {
    try { await certificatesOnce({ servers: await NimbleServer.find() }); }
    catch (e) { console.error('[watch] certificates:', e?.message || e); }
  };
  // Hourly, with the once-a-day rule above: a panel that restarts every few hours still checks.
  certTimer = setInterval(certs, 3600 * 1000);
  setTimeout(certs, 60 * 1000).unref?.();
  console.log(`[watch] servers and streams every ${w.intervalSec} s, down after ${w.downAfter} missed`);
}
