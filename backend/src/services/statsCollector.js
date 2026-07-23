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
  if (groups.server) jobs.push(['server', nimble.serverStatus(server)]);

  const settled = await Promise.allSettled(jobs.map(j => j[1]));

  settled.forEach((res, i) => {
    if (res.status !== 'fulfilled') return;   // one dead endpoint must not lose the rest
    const kind = jobs[i][0];
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
    } else if (kind === 'server') {
      add('server', 'server', server.name, flattenNumbers(d));
    }
  });

  return samples;
}

let timer = null;
let running = false;

async function tick() {
  if (running) return;                 // a slow round must not overlap the next
  running = true;
  try {
    const s = await Settings.load();
    if (!s.stats?.enabled) return;
    const servers = await NimbleServer.find();
    const ts = new Date();
    const batches = await Promise.allSettled(
      servers.map(sv => collectServer(sv, s.stats.groups || {}, ts).catch(() => []))
    );
    const docs = batches.flatMap(b => (b.status === 'fulfilled' ? b.value : []));
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
