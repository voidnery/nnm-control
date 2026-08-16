import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { StatSample } from '../models/StatSample.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { Settings } from '../models/Settings.js';
import { wmspanel } from '../services/wmspanelClient.js';
import { ApiUsage, utcDay, DAILY_LIMIT } from '../models/ApiUsage.js';
import { flushUsage } from '../services/wmspanelClient.js';
import { getCollectionHealth } from '../services/statsCollector.js';

export const statsRouter = Router();
statsRouter.use(requireAuth);

// What has been sampled for this server recently, and which metrics each
// subject carries — the catalog is derived from live data, not hardcoded, so
// counters that differ between Nimble builds still show up.
// serverId -> { at, map: settingId -> name }
const srtNameCache = new Map();
const SRT_NAME_TTL_MS = 120_000;

async function srtNames(serverId) {
  const hit = srtNameCache.get(serverId);
  if (hit && Date.now() - hit.at < SRT_NAME_TTL_MS) return hit.map;

  const map = new Map();
  try {
    const server = await NimbleServer.findById(serverId);
    if (server?.wmspanelServerId) {
      const cfg = (await Settings.load()).wmspanel;
      // Both families, because an SRT subject can come from either and the
      // object it names lives in one or the other.
      const lists = await Promise.allSettled([
        wmspanel.incomingList(cfg, server.wmspanelServerId),
        wmspanel.udpList(cfg, server.wmspanelServerId),
        wmspanel.outgoingList(cfg, server.wmspanelServerId),
      ]);
      for (const r of lists) {
        if (r.status !== 'fulfilled') continue;
        for (const o of (r.value?.settings || r.value?.streams || [])) {
          if (o?.id && o?.name) map.set(String(o.id).toLowerCase(), o.name);
        }
      }
    }
  } catch { /* a name is a nicety; its absence must not empty the list */ }

  srtNameCache.set(serverId, { at: Date.now(), map });
  return map;
}

async function decorateSrtLabels(serverId, rows) {
  const srt = rows.filter(r => r.group === 'srt' && /^srt-(receiver|sender):/.test(r.subject || ''));
  if (!srt.length) return;
  const names = await srtNames(serverId);
  for (const r of srt) {
    const id = r.subject.split(':').slice(1).join(':').toLowerCase();
    const name = names.get(id);
    // The id stays alongside: two objects can share a name, and the id is what
    // the diagnostics speak in.
    if (name) r.label = `${name} · ${r.subject.startsWith('srt-sender') ? 'out' : 'in'}`;
  }
}

statsRouter.get('/:serverId/subjects', requirePerm('streams.view'), async (req, res) => {
  const since = new Date(Date.now() - 15 * 60 * 1000);
  const rows = await StatSample.aggregate([
    { $match: { serverId: String(req.params.serverId), ts: { $gte: since } } },
    { $sort: { ts: -1 } },
    { $group: { _id: '$subject', group: { $first: '$group' }, label: { $first: '$label' },
                last: { $first: '$ts' }, metrics: { $first: { $objectToArray: '$metrics' } } } },
    { $project: { _id: 0, subject: '$_id', group: 1, label: 1, last: 1, metrics: '$metrics.k' } },
    { $sort: { group: 1, subject: 1 } },
  ]);

  // "srt-receiver 6a1963109aac8647b52d1448" is not a name anyone can act on.
  // The collector cannot resolve it — asking WMSPanel once per 10s sample
  // would spend the daily budget by lunchtime — so it is resolved here, on
  // read, and cached: this endpoint is opened by a person, not by a poller.
  await decorateSrtLabels(String(req.params.serverId), rows);

  res.json({ subjects: rows });
});

// Time series for one subject. Long ranges are bucketed server-side so the
// browser never has to chew through tens of thousands of raw points.
/**
 * One subject's series, thinned to about `targetPoints`.
 *
 * Shared by the per-subject endpoint and the fleet endpoint below, so the
 * dashboard and the graphs tab cannot disagree about what a bucket is — two
 * implementations of the same averaging would eventually draw two different
 * pictures of the same minute.
 */
async function seriesFor({ serverId, subject, metrics, from, minutes, targetPoints = 600 }) {
  const raw = await StatSample.countDocuments({ serverId, subject, ts: { $gte: from } });
  const bucketMs = raw > targetPoints ? Math.ceil((minutes * 60 * 1000) / targetPoints) : 0;

  if (!bucketMs) {
    const project = { ts: 1 };
    metrics.forEach(m => { project[`metrics.${m}`] = 1; });
    const docs = await StatSample.find({ serverId, subject, ts: { $gte: from } }, project).sort({ ts: 1 }).lean();
    return { bucketMs, points: docs.map(d => ({ ts: d.ts, v: metrics.map(m => d.metrics?.[m] ?? null) })) };
  }

  const group = { _id: { $toDate: { $subtract: [{ $toLong: '$ts' }, { $mod: [{ $toLong: '$ts' }, bucketMs] }] } } };
  metrics.forEach((m, i) => { group[`m${i}`] = { $avg: `$metrics.${m}` }; });
  const docs = await StatSample.aggregate([
    { $match: { serverId, subject, ts: { $gte: from } } },
    { $group: group },
    { $sort: { _id: 1 } },
  ]);
  return { bucketMs, points: docs.map(d => ({ ts: d._id, v: metrics.map((_, i) => (d[`m${i}`] ?? null)) })) };
}

// iter15 m3 — host series for the whole fleet in one request.
//
// Thirteen servers on one screen is thirteen round trips if each card asks for
// itself, and the page would paint in thirteen jerks. Fewer points per card
// than the graphs tab, because a card is a fraction of its width and drawing
// six hundred points into three hundred pixels is work nobody can see.
// What is left of the WMSPanel daily budget, as far as this panel can know.
statsRouter.get('/api-quota', requirePerm('streams.view'), async (_req, res) => {
  const settings = await Settings.load();
  // Off means off: the dashboard asks for nothing to render, rather than
  // being handed a number it then has to decide to ignore.
  if (settings.apiQuota?.enabled === false) return res.json({ enabled: false });

  await flushUsage().catch(() => {});          // so the answer includes this minute
  const day = utcDay();
  const doc = await ApiUsage.findOne({ day }).lean();
  const used = doc?.calls || 0;
  // The account's plan, as the operator entered it; the environment variable
  // remains the fallback for a deployment that prefers to fix it there.
  const limit = Number(settings.apiQuota?.dailyLimit) || DAILY_LIMIT;

  const now = new Date();
  const endOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const msLeft = endOfDay - now.getTime();
  const elapsedH = 24 - msLeft / 3_600_000;

  // Where the day ends at this rate. Useful precisely because it answers the
  // question an operator is really asking — "will I run out?" — instead of
  // only the one the number answers.
  const projected = elapsedH > 0.25 ? Math.round((used / elapsedH) * 24) : null;

  const top = Object.entries(doc?.byPath || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([path, calls]) => ({ path: path.replace(/·/g, '.'), calls }));

  res.json({
    enabled: true,
    day, used, limit,
    remaining: Math.max(0, limit - used),
    pctUsed: limit ? Math.min(100, (100 * used) / limit) : 0,
    resetsInMs: msLeft,
    projected,
    top,
    // Said in the payload, not only in the UI: whoever reads this number next
    // needs to know it is a floor.
    note: 'panel-only',
  });
});

statsRouter.get('/host', requirePerm('streams.view'), async (req, res) => {
  const minutes = Math.min(4320, Math.max(1, Number(req.query.minutes) || 30));
  const from = new Date(Date.now() - minutes * 60 * 1000);
  const metrics = String(req.query.metrics || '')
    .split(',').map(m => m.trim()).filter(m => /^[a-z0-9_]{1,64}$/i.test(m));
  if (!metrics.length) return res.status(400).json({ error: 'metrics are required' });

  const servers = await NimbleServer.find({}, { name: 1, host: 1, agent: 1 }).sort({ order: 1, name: 1 }).lean();
  const out = [];
  for (const s of servers) {
    const id = String(s._id);
    // A server with no agent has no host series and never will; saying so is
    // more useful than an empty chart that looks like an outage.
    const enabled = Boolean(s.agent?.enabled);
    const { points, bucketMs } = enabled
      ? await seriesFor({ serverId: id, subject: 'host', metrics, from, minutes, targetPoints: 240 })
      : { points: [], bucketMs: 0 };
    out.push({
      id, name: s.name, host: s.host || '',
      agent: enabled,
      lastContactAt: s.agent?.lastContactAt || null,
      bucketMs,
      points,
      latest: points.length ? points[points.length - 1].v : null,
    });
  }
  res.json({ minutes, metrics, servers: out });
});

// iter15 m4 — the streams on each server, for the dashboard.
//
// The metric name cannot be hardcoded. `flattenNumbers` stores whatever
// numeric fields Nimble reported, and those differ between builds — which is
// the whole reason StatSample keeps a free-form map. So the rate metric is
// DISCOVERED per subject, by the same pattern the graphs tab already uses, and
// a subject with no such field is reported as having none rather than being
// silently dropped.
const RATE_RE = /bandwidth|bitrate|bps/i;

function pickRateMetric(keys) {
  const rate = keys.filter(k => RATE_RE.test(k));
  if (!rate.length) return '';
  // Prefer the plainest name: "bandwidth" over "stats.output.bandwidth_avg".
  return rate.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

statsRouter.get('/streams', requirePerm('streams.view'), async (req, res) => {
  const minutes = Math.min(4320, Math.max(1, Number(req.query.minutes) || 60));
  const from = new Date(Date.now() - minutes * 60 * 1000);
  // How many per server. A box with two hundred streams would otherwise draw
  // two hundred charts on a page nobody can read.
  const perServer = Math.min(24, Math.max(1, Number(req.query.limit) || 6));

  // One pass for the whole fleet: which stream subjects reported recently,
  // what their latest values were, and which numeric fields they carry.
  const rows = await StatSample.aggregate([
    { $match: { group: 'streams', ts: { $gte: from } } },
    { $sort: { ts: -1 } },
    { $group: {
      _id: { serverId: '$serverId', subject: '$subject' },
      label: { $first: '$label' },
      last: { $first: '$ts' },
      metrics: { $first: { $objectToArray: '$metrics' } },
    } },
  ]).option({ maxTimeMS: 8000 });

  const byServer = new Map();
  for (const r of rows) {
    const keys = r.metrics.map(m => m.k);
    const metric = pickRateMetric(keys);
    const latest = metric ? (r.metrics.find(m => m.k === metric)?.v ?? null) : null;
    const list = byServer.get(r._id.serverId) || [];
    list.push({ subject: r._id.subject, label: r.label || r._id.subject, metric, latest, last: r.last });
    byServer.set(r._id.serverId, list);
  }

  const servers = await NimbleServer.find({}, { name: 1 }).sort({ order: 1, name: 1 }).lean();
  const out = [];
  for (const s of servers) {
    const id = String(s._id);
    const all = byServer.get(id) || [];
    // Busiest first: on a server with more streams than fit, the ones moving
    // the most traffic are the ones worth the space.
    all.sort((a, b) => (b.latest ?? -1) - (a.latest ?? -1));
    const shown = all.slice(0, perServer);

    for (const st of shown) {
      if (!st.metric) { st.points = []; continue; }
      const { points } = await seriesFor({
        serverId: id, subject: st.subject, metrics: [st.metric], from, minutes, targetPoints: 120,
      });
      st.points = points;
    }
    out.push({ id, name: s.name, total: all.length, shown: shown.length, streams: shown });
  }

  res.json({ minutes, servers: out });
});

// iter16 m3 — many subjects in one request.
//
// The summary draws every stream on a server at once. Asking per subject would
// be forty round trips on open and forty more on every refresh, and the browser
// would paint them in forty jerks. One request, one pass over the same
// bucketing the single-subject endpoint uses.
statsRouter.get('/:serverId/multi', requirePerm('streams.view'), async (req, res) => {
  const serverId = String(req.params.serverId);
  const minutes = Math.min(4320, Math.max(1, Number(req.query.minutes) || 60));
  const from = new Date(Date.now() - minutes * 60 * 1000);
  const metrics = String(req.query.metrics || '')
    .split(',').map(m => m.trim()).filter(m => /^[a-z0-9_]{1,64}$/i.test(m));
  const subjects = String(req.query.subjects || '')
    .split(',').map(x => x.trim()).filter(Boolean)
    // A summary of two hundred streams is not a summary; the caller picks
    // which, and the cap is here so one request cannot become a hundred
    // aggregations.
    .slice(0, 60);
  if (!metrics.length || !subjects.length) {
    return res.status(400).json({ error: 'subjects and metrics are both required' });
  }

  // Fewer points than a full-width chart: these are drawn small, and six
  // hundred points in two hundred pixels is work nobody can see.
  const out = [];
  for (const subject of subjects) {
    const { points, bucketMs } = await seriesFor({
      serverId, subject, metrics, from, minutes, targetPoints: 120,
    });
    out.push({
      subject, bucketMs, points,
      latest: points.length ? points[points.length - 1].v : null,
    });
  }
  // It writes `label` onto the objects it is given, so it has to be given the
  // ones being returned — a mapped copy takes the labels with it.
  for (const o of out) o.group = 'srt';
  await decorateSrtLabels(serverId, out).catch(() => {});
  res.json({ minutes, metrics, series: out });
});

statsRouter.get('/:serverId/series', requirePerm('streams.view'), async (req, res) => {
  const { serverId } = req.params;
  const subject = String(req.query.subject || '');
  const metrics = String(req.query.metrics || '').split(',').map(m => m.trim()).filter(Boolean);
  if (!subject || !metrics.length) return res.status(400).json({ error: 'subject and metrics are required' });

  const minutes = Math.min(4320, Math.max(1, Number(req.query.minutes) || 30));  // cap at the 3-day retention
  const from = new Date(Date.now() - minutes * 60 * 1000);
  const { bucketMs, points } = await seriesFor({ serverId, subject, metrics, from, minutes });

  // An empty series has several causes and they need different actions:
  // collection switched off, a stream added minutes ago, a stream that has
  // never reported. Listing them all and letting the operator guess is the
  // thing worth avoiding — the panel knows which one it is.
  let collection;
  if (points.length === 0) {
    const settings = await Settings.load();
    const [newest, everForSubject] = await Promise.all([
      StatSample.findOne({ serverId }, { ts: 1 }).sort({ ts: -1 }).lean(),
      StatSample.findOne({ serverId, subject }, { ts: 1 }).sort({ ts: -1 }).lean(),
    ]);
    collection = {
      enabled: Boolean(settings.stats?.enabled),
      // The server is reporting something, so the pipeline works and the gap
      // is this subject's alone.
      serverLastSampleAt: newest?.ts || null,
      subjectLastSampleAt: everForSubject?.ts || null,
    };
  }

  res.json({ subject, metrics, bucketMs, points, collection });
});

// Why a server has little or no data: per-endpoint outcome of the last run.
// "empty" means the server genuinely has nothing of that kind; "error" means we
// could not ask — without this the two look identical in the charts.
statsRouter.get('/_health', requirePerm('streams.view'), (_req, res) => {
  res.json({ servers: getCollectionHealth() });
});

// Rough storage cost, so enabling collection is an informed decision.
statsRouter.get('/_usage', requirePerm('settings.manage'), async (_req, res) => {
  try {
    // Through the aggregation stage. `connection.db.command()` does not exist
    // in Mongoose 8 — the call threw and the catch below reported zeroes with
    // the TypeError tucked into a field nobody reads, so this page has been
    // showing "no storage used" for as long as that has been true.
    const [row] = await StatSample.collection
      .aggregate([{ $collStats: { storageStats: {} } }]).toArray();
    const st = row?.storageStats || {};
    res.json({ docs: st.count || 0, sizeBytes: st.size || 0, storageBytes: st.storageSize || 0 });
  } catch (e) { res.json({ docs: 0, sizeBytes: 0, storageBytes: 0, error: e.message }); }
});
