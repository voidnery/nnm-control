import { Settings } from '../models/Settings.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { StatSample } from '../models/StatSample.js';
import { nimble } from './nimbleClient.js';

// Sampling runs against the NATIVE Nimble API on purpose: WMSPanel allows
// 15 000 calls/day per account, and a 10s poll of a single server would burn
// 8 640 of them. The native API is local to each box and has no such budget.

const MAX_DEPTH = 4;

// Flatten an arbitrary response into { 'a.b.c': number }. Booleans become 0/1 so
// states like "connected" can be charted next to bitrates.
export function flattenNumbers(obj, prefix = '', out = {}, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > MAX_DEPTH) return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'boolean') out[key] = v ? 1 : 0;
    else if (v && typeof v === 'object' && !Array.isArray(v)) flattenNumbers(v, key, out, depth + 1);
  }
  return out;
}

const asList = (d, ...keys) => {
  for (const k of keys) if (Array.isArray(d?.[k])) return d[k];
  return Array.isArray(d) ? d : [];
};

// Build the samples for one server. Exported for tests.
export async function collectServer(server, groups, ts = new Date()) {
  const samples = [];
  // Per-endpoint outcome. "empty" (the server genuinely has nothing of that
  // kind) must be distinguishable from "error" (we could not ask) — conflating
  // them is what made collection look randomly partial.
  const report = {};
  const add = (group, subject, label, metrics) => {
    if (metrics && Object.keys(metrics).length) {
      samples.push({ serverId: String(server._id), subject, group, label, ts, metrics });
    }
  };

  const jobs = [];
  if (groups.streams) jobs.push(['streams', nimble.liveStreams(server)]);
  if (groups.republish) jobs.push(['republish', nimble.republishStats(server)]);
  if (groups.srt) jobs.push(['srt-sender', nimble.srtSenderStats(server)]);
  if (groups.srt) jobs.push(['srt-receiver', nimble.srtReceiverStats(server)]);
  // SRT In / SRT Out / SRT in Nimble are MPEG-TS objects in this panel, so their
  // runtime lives here rather than in the srt_*_stats endpoints.
  if (groups.srt) jobs.push(['mpegts', nimble.mpegtsStatus(server)]);
  if (groups.server) jobs.push(['server', nimble.serverStatus(server)]);

  const settled = await Promise.allSettled(jobs.map(j => j[1]));

  settled.forEach((res, i) => {
    const kind = jobs[i][0];
    if (res.status !== 'fulfilled') {         // one dead endpoint must not lose the rest
      report[kind] = { status: 'error', error: String(res.reason?.message || res.reason).slice(0, 200) };
      return;
    }
    const before = samples.length;
    const d = res.value;

    if (kind === 'streams') {
      for (const st of asList(d, 'streams')) {
        const name = `${st.application || st.app || '?'}/${st.stream || st.name || '?'}`;
        add('streams', `stream:${name}`, name, flattenNumbers(st));
      }
    } else if (kind === 'republish') {
      for (const r of asList(d, 'stats', 'rules', 'republish')) {
        const id = r.id ?? r.rule_id ?? `${r.src_app}/${r.src_stream}`;
        const label = r.dest_addr ? `${r.src_app || ''}/${r.src_stream || ''} → ${r.dest_addr}` : String(id);
        const metrics = flattenNumbers(r);
        if (typeof r.state === 'string') metrics.connected = r.state === 'connected' ? 1 : 0;
        add('republish', `republish:${id}`, label, metrics);
      }
    } else if (kind === 'srt-sender' || kind === 'srt-receiver') {
      for (const so of asList(d, 'streams', 'sockets', 'stats')) {
        const id = so.id ?? so.socket_id ?? so.name ?? so.stream ?? 'unknown';
        add('srt', `${kind}:${id}`, `${kind} ${id}`, flattenNumbers(so));
      }
    } else if (kind === 'mpegts') {
      for (const key of ['incoming', 'outgoing', 'streams', 'udp']) {
        for (const o of asList(d?.[key])) {
          const id = o.id ?? o.name ?? `${o.application || ''}/${o.stream || ''}`;
          const label = o.name || `${o.application || ''}/${o.stream || ''}` || String(id);
          add('srt', `mpegts-${key}:${id}`, label, flattenNumbers(o));
        }
      }
    } else if (kind === 'server') {
      add('server', 'server', server.name, flattenNumbers(d));
    }
    const produced = samples.length - before;
    report[kind] = produced > 0
      ? { status: 'ok', count: produced }
      : { status: 'empty', hint: EMPTY_HINT[kind] || 'the server reported nothing of this kind' };
  });

  return { samples, report };
}

const EMPTY_HINT = {
  streams: 'no live streams are being published to this server right now',
  republish: 'no RTMP Push rules are running on this server',
  'srt-sender': 'no outgoing SRT sockets on this server',
  'srt-receiver': 'no incoming SRT sockets on this server',
  mpegts: 'no MPEG-TS/SRT inputs or outputs are active on this server',
  server: 'the server status endpoint returned no numeric counters',
};

let timer = null;
let running = false;
const lastRun = new Map();   // serverId -> { at, name, ok, samples, report, error }

export function getCollectionHealth() {
  return [...lastRun.entries()].map(([serverId, v]) => ({ serverId, ...v }));
}

async function tick() {
  if (running) return;                 // a slow round must not overlap the next
  running = true;
  try {
    const s = await Settings.load();
    if (!s.stats?.enabled) return;
    const servers = await NimbleServer.find();
    const ts = new Date();
    const batches = await Promise.allSettled(
      servers.map(sv => collectServer(sv, s.stats.groups || {}, ts))
    );
    const docs = [];
    batches.forEach((b, i) => {
      const sv = servers[i];
      if (b.status === 'fulfilled') {
        docs.push(...b.value.samples);
        lastRun.set(String(sv._id), {
          at: ts, name: sv.name, ok: true,
          samples: b.value.samples.length, report: b.value.report,
        });
      } else {
        // Whole-server failure: usually an unreachable management address or a
        // missing/invalid management token, which used to vanish silently.
        lastRun.set(String(sv._id), {
          at: ts, name: sv.name, ok: false, samples: 0, report: {},
          error: String(b.reason?.message || b.reason).slice(0, 300),
        });
      }
    });
    if (docs.length) await StatSample.insertMany(docs, { ordered: false });
  } catch (e) {
    console.error('[stats] collection failed:', e.message);
  } finally {
    running = false;
  }
}

// Mongo owns retention; keep the TTL index in step with the configured value.
async function syncRetention(days) {
  const seconds = Math.max(1, Math.round(days * 24 * 3600));
  const coll = StatSample.collection;
  try {
    const idx = await coll.indexes();
    const ttl = idx.find(i => i.name === 'ts_ttl');
    if (ttl && ttl.expireAfterSeconds !== seconds) {
      await coll.dropIndex('ts_ttl');
      await coll.createIndex({ ts: 1 }, { expireAfterSeconds: seconds, name: 'ts_ttl' });
      console.log(`[stats] retention set to ${days} day(s)`);
    }
  } catch (e) { console.error('[stats] could not sync retention:', e.message); }
}

export async function startStatsCollector() {
  const s = await Settings.load();
  await syncRetention(s.stats?.retentionDays ?? 3);
  const intervalMs = Math.max(5, s.stats?.intervalSec ?? 10) * 1000;
  if (timer) clearInterval(timer);
  timer = setInterval(tick, intervalMs);
  console.log(`[stats] collector ready (every ${intervalMs / 1000}s, ${s.stats?.enabled ? 'enabled' : 'disabled'})`);
}

// Called after settings change so interval/retention take effect immediately.
export async function restartStatsCollector() { await startStatsCollector(); }
