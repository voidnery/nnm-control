// iter10 m3 — searching the log warehouse.
//
// The shape of the data decides the shape of this module. Measured from the
// real dump: 98 records/second per server, and **99.3% of all errors are one
// repeated line** — 15,237 occurrences of the same srtpull failure in 31
// minutes. A viewer that renders rows as they come would show fifteen thousand
// identical lines during exactly the incident someone opened it for.
//
// So grouping is not a nicety here, it is the thing that makes the view work
// at all: 163,628 records collapse to 142 templates.
import mongoose from 'mongoose';
import { LogRecord } from '../models/LogRecord.js';
import { NimbleServer } from '../models/NimbleServer.js';

// Records store a server id; an operator reads server names. Resolved here so
// every view labels them the same way and the browser is not left joining ids
// against a list it fetched separately.
let nameCache = { at: 0, map: new Map() };
async function serverNames() {
  if (Date.now() - nameCache.at < 60_000) return nameCache.map;
  const rows = await NimbleServer.find({}, { name: 1 }).lean();
  nameCache = { at: Date.now(), map: new Map(rows.map(r => [String(r._id), r.name])) };
  return nameCache.map;
}
export function invalidateServerNames() { nameCache = { at: 0, map: new Map() }; }

// How a message becomes a template.
//
// Two strategies were measured against the real file. Collapsing every
// bracketed span gave 2 error templates; collapsing only brackets that contain
// a digit gave 4 — and the extra two matter, because they are the difference
// between "SRT connection closed 15,237 times" and knowing it was
// "Connection does not exist" (8,661), "Invalid socket ID" (5,432) and
// "Connection was broken" (1,144). Addresses and socket numbers are noise;
// the reason in the same brackets is the diagnosis. So: digits collapse,
// words survive.
export function templateOf(msg) {
  return String(msg || '')
    .replace(/0x[0-9a-fA-F]+/g, 'H')
    .replace(/\[[^\]]*\]/g, (s) => (/\d/.test(s) ? '[#]' : s))
    .replace(/'[^']*'/g, "'S'")
    .replace(/\b\d+(\.\d+)?\b/g, 'N')
    .slice(0, 300);
}

// Nimble logs publish URLs, and a Nimble publish URL carries the stream key.
// The warehouse stores what the server wrote — rewriting it would be lying
// about the log — but a template is a summary shown wide, often on a screen
// someone else can see, so keys are masked there.
export function maskSecrets(s) {
  return String(s || '').replace(/([?&](?:key|password|token|auth)=)[^\s&"']+/gi, '$1***');
}

// iter10 m4 — which subsystem belongs to which functional window.
//
// Derived from the real dump, where these seven cover 100% of 163,628 records.
// That does not make the list complete: this one sample has no WebRTC, no DVR
// variants and only one transcoder mode, so anything unrecognised falls into
// `other` and stays visible. A subsystem that quietly belonged to no window
// would be a log nobody ever reads.
export const CATEGORIES = [
  { key: 'srt',        subs: ['srtpull', 'srtlisten', 'm2ts_srt_sender', 'm2ts_srt_srv'] },
  { key: 'rtmp',       subs: ['rtmp', 'rtmp_sender'] },
  { key: 'transcoder', subs: ['remtranmgmt'] },
  { key: 'playback',   subs: ['work'] },
  { key: 'ingest',     subs: ['livepull'] },
  { key: 'dvr',        subs: ['dvrmain'] },
  { key: 'core',       subs: ['util', 'sync', 'list'] },
  { key: 'other',      subs: [] },        // everything the list above misses
];

const KNOWN = new Set(CATEGORIES.flatMap(c => c.subs));
export const categoryOf = (sub) =>
  (CATEGORIES.find(c => c.subs.includes(sub)) || { key: 'other' }).key;

/** Turn a category into the subsystem constraint it stands for. */
export function subsForCategory(key) {
  if (!key || key === 'all') return null;
  const cat = CATEGORIES.find(c => c.key === key);
  if (!cat) return null;
  // `other` is defined by exclusion, so it needs a $nin rather than an $in —
  // that is what makes an unrecognised subsystem show up instead of vanishing.
  if (key === 'other') return { $nin: [...KNOWN] };
  return { $in: cat.subs };
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g;
const literal = (s) => String(s).replace(ESCAPE, '\\$&');

/**
 * Build the Mongo filter for a set of UI controls.
 *
 * Everything except free text lands on an indexed field. Free text is a regex
 * over `msg`, which is a scan — bounded by whatever the other filters and the
 * time window already narrowed things to. That is a deliberate trade: a text
 * index cannot answer "contains this substring", which is what an operator
 * chasing a stream name actually types.
 */
// Mongoose casts a string to ObjectId inside find(), but NOT inside an
// aggregation pipeline: there, `$match: { serverId: '65f…' }` compares a string
// against an ObjectId and matches nothing. Grouped view, facets and the
// category counts are all aggregations, so picking a server emptied the whole
// page while "all servers" — which has no serverId in the filter at all —
// worked. Cast once, here, where every query gets its filter.
function asObjectId(v) {
  if (!v) return null;
  if (v instanceof mongoose.Types.ObjectId) return v;
  return mongoose.Types.ObjectId.isValid(String(v)) ? new mongoose.Types.ObjectId(String(v)) : null;
}

export function buildFilter({ serverId, file, levels, subs, category, from, to, q, tag, pid } = {}) {
  const f = {};
  if (serverId) {
    const oid = asObjectId(serverId);
    // An id that is not an ObjectId cannot match anything; say so with an
    // impossible filter rather than silently widening to the whole fleet.
    f.serverId = oid || new mongoose.Types.ObjectId('000000000000000000000000');
  }
  if (file) f.file = file;
  if (Array.isArray(levels) && levels.length) f.level = { $in: levels };
  // An explicit subsystem selection is the operator narrowing within a window,
  // so it wins over the window's own category.
  if (Array.isArray(subs) && subs.length) f.sub = { $in: subs };
  else {
    const c = subsForCategory(category);
    if (c) f.sub = c;
  }
  if (tag) f.tag = tag;
  if (Number(pid)) f.pid = Number(pid);
  if (from || to) {
    f.ts = {};
    if (from) f.ts.$gte = new Date(from);
    if (to) f.ts.$lte = new Date(to);
  }
  if (q && String(q).trim()) {
    const rx = new RegExp(literal(String(q).trim()), 'i');
    // The HTTP dump attached to a record is part of what the operator is
    // looking at, so it is part of what they can search.
    f.$or = [{ msg: rx }, { cont: rx }];
  }
  return f;
}

// A scan has to end somewhere. Rather than let one query walk a 512 MB
// collection, the aggregation is capped and the answer says whether it was —
// a truncated count that admits it is worth more than an exact one that
// arrives after the incident.
//
// The cap used to be 200,000 with no sort in front of it, and both halves of
// that were wrong. A capped collection returns natural order, which is
// INSERTION order, so `$limit` took the OLDEST matching records: the grouped
// view was summarising the start of the window rather than the present. And at
// the measured 98 records/second per server, an hour of one server is ~350,000
// records, so every query on a fleet view hit the cap and scanned it in full —
// five such pipelines per page load is how a request outlives the proxy and
// comes back as 504.
const SCAN_CAP = Number(process.env.NNM_LOG_SCAN_CAP || 60_000);
// Nothing here is worth more than a few seconds. Failing with a message that
// says "narrow the range" beats a gateway timeout that says nothing.
const MAX_TIME_MS = Number(process.env.NNM_LOG_MAX_TIME_MS || 8_000);

// Newest first, then cut. The `{ ts: -1 }` index makes this the cheap way to
// bound the work AND the only way to bound it at the end an operator cares
// about.
const NEWEST_FIRST = [{ $sort: { ts: -1 } }, { $limit: SCAN_CAP }];

function run(pipeline) {
  return LogRecord.aggregate(pipeline).option({ allowDiskUse: true, maxTimeMS: MAX_TIME_MS });
}

// A pipeline that ran out of time is not an error to hide behind a 500 — it is
// a filter that is too wide, and the operator can fix it in one click.
export function tooWide(e) {
  return /maxTimeMS|operation exceeded time limit|MaxTimeMSExpired/i.test(String(e?.message || e));
}

/** Rows, newest first, ordered by offset within a generation. */
export async function searchLogs(opts = {}) {
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 200));
  const filter = buildFilter(opts);
  // `before` is an opaque cursor: the offset of the oldest row already shown.
  if (opts.before) filter.offset = { ...(filter.offset || {}), $lt: Number(opts.before) };
  // Within one server, byte offset is the true order — Nimble's timestamps
  // have one-second resolution at ~98 lines/s. Across servers, offsets are not
  // comparable and only time is, and it is the indexed path besides.
  const sort = opts.serverId ? { gen: -1, offset: -1 } : { ts: -1 };
  const rows = await LogRecord.find(filter).sort(sort).limit(limit)
    .maxTimeMS(MAX_TIME_MS).lean();
  const names = await serverNames();
  return {
    rows: rows.map(r => ({
      id: String(r._id), serverId: String(r.serverId),
      serverName: names.get(String(r.serverId)) || String(r.serverId).slice(-6),
      file: r.file, offset: r.offset,
      ts: r.ts, raw: r.raw, pid: r.pid, tid: r.tid, tag: r.tag, sub: r.sub,
      level: r.level, msg: r.msg, cont: r.cont || '', contLines: r.contLines || 0,
    })),
    nextBefore: rows.length === limit ? rows[rows.length - 1].offset : null,
  };
}

/**
 * The same result set, collapsed by template.
 *
 * This is the default view for a reason: on the measured data it turns 163,628
 * rows into 142, and the one thing an operator needs first — "what is actually
 * happening on this box" — is legible in one screen instead of buried under a
 * single line repeated eight times a second.
 */
export async function groupLogs(opts = {}) {
  const filter = buildFilter(opts);
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
  const agg = await run([
    { $match: filter },
    ...NEWEST_FIRST,
    { $project: { sub: 1, level: 1, msg: 1, ts: 1, offset: 1, serverId: 1, tag: 1 } },
    { $group: {
      _id: { sub: '$sub', level: '$level', msg: '$msg' },
      count: { $sum: 1 },
      first: { $min: '$ts' },
      last: { $max: '$ts' },
      servers: { $addToSet: '$serverId' },
      sample: { $first: '$msg' },
      lastOffset: { $max: '$offset' },
    } },
  ]);

  // Templating happens here rather than in the pipeline: the regexes that
  // decide what is noise are the measured part of this design, and Mongo's
  // expression language cannot express them without becoming unreadable.
  const byTemplate = new Map();
  let scanned = 0;
  for (const g of agg) {
    scanned += g.count;
    const key = `${g._id.sub}|${g._id.level}|${templateOf(g._id.msg)}`;
    const cur = byTemplate.get(key);
    if (cur) {
      cur.count += g.count;
      if (g.first < cur.first) cur.first = g.first;
      if (g.last > cur.last) { cur.last = g.last; cur.sample = g.sample; }
      for (const s of g.servers) cur.servers.add(String(s));
      if (g.lastOffset > cur.lastOffset) cur.lastOffset = g.lastOffset;
    } else {
      byTemplate.set(key, {
        sub: g._id.sub, level: g._id.level, template: templateOf(g._id.msg),
        count: g.count, first: g.first, last: g.last,
        servers: new Set(g.servers.map(String)),
        sample: g.sample, lastOffset: g.lastOffset,
      });
    }
  }

  const names = await serverNames();
  const groups = [...byTemplate.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map(g => ({
      ...g,
      template: maskSecrets(g.template),
      sample: maskSecrets(g.sample),
      servers: g.servers.size,
      // Named, and capped at a handful: a template seen on every box in the
      // fleet should say "13 servers", not print thirteen names into a row.
      serverNames: [...g.servers].map(id => names.get(id) || id.slice(-6)).sort().slice(0, 4),
    }));

  return { groups, distinct: byTemplate.size, scanned, capped: scanned >= SCAN_CAP };
}

/**
 * Counts by level and subsystem for the current filter.
 *
 * Shown above the results so the shape is visible before anything is read.
 * With one template accounting for 93% of a box's output, "what is the mix"
 * is a more useful first question than "what is the newest line".
 */
/**
 * One line per functional window: how much is in it and how much of that is
 * bad. Shown as the overview above the windows themselves, so an operator can
 * see which part of Nimble is unhappy before opening anything.
 */
export async function categoryCounts(opts = {}) {
  const base = buildFilter({ ...opts, category: undefined, subs: undefined });
  const rows = await run([
    { $match: base },
    ...NEWEST_FIRST,
    { $group: { _id: { sub: '$sub', level: '$level' }, n: { $sum: 1 }, last: { $max: '$ts' } } },
  ]);
  const out = new Map(CATEGORIES.map(c => [c.key, { key: c.key, total: 0, errors: 0, subs: new Set(), last: null }]));
  for (const r of rows) {
    const cat = out.get(categoryOf(r._id.sub)) || out.get('other');
    cat.total += r.n;
    if (r._id.level === 'E' || r._id.level === 'W') cat.errors += r.n;
    cat.subs.add(r._id.sub);
    if (r.last && (!cat.last || r.last > cat.last)) cat.last = r.last;
  }
  return [...out.values()].map(c => ({ ...c, subs: [...c.subs].sort() }));
}

export async function logFacets(opts = {}) {
  const filter = buildFilter(opts);
  // One pass, three groupings. Three separate pipelines meant scanning the
  // same records three times for one screen.
  const [out] = await run([
    { $match: filter },
    ...NEWEST_FIRST,
    { $project: { level: 1, sub: 1, serverId: 1 } },
    { $facet: {
      byLevel: [{ $group: { _id: '$level', n: { $sum: 1 } } }],
      bySub: [{ $group: { _id: '$sub', n: { $sum: 1 } } }],
      byServer: [{ $group: { _id: '$serverId', n: { $sum: 1 } } }],
    } },
  ]);
  const { byLevel = [], bySub = [], byServer = [] } = out || {};
  const asMap = (rows) => rows
    .filter(r => r._id !== null && r._id !== undefined)
    .sort((a, b) => b.n - a.n)
    .map(r => ({ key: String(r._id), n: r.n }));
  return { levels: asMap(byLevel), subs: asMap(bySub), servers: asMap(byServer) };
}
