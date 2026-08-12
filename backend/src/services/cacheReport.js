import { amplification } from './cacheAmplification.js';
// What Nimble says about its own cache.
//
// The cache is the heart of a delivery network: request coalescing is what
// turns a thousand viewers into one fetch upstream, and without it an edge is
// a proxy that multiplies load rather than absorbing it. So the number matters
// more than almost anything else the panel shows.
//
// WMSPanel does not report it. Softvelum's own Zabbix templates do, through
// `/manage/server_status` — the same endpoint this panel has been calling for
// metrics since iter7 — and they say plainly that it yields figures "not even
// available in WMSPanel, like RAM cache status".
//
// What this does NOT do is assume field names. Every previous time a shape was
// taken from documentation and not from a response, it was wrong: the `to`
// field of a route, the DASH manifest path, two TLS fields that existed
// nowhere at all. So this reads whatever cache-shaped keys are actually
// present, reports them by their real names, and says when it found nothing —
// rather than showing zeros for fields that may never have existed.

// The real field names, now known from a live fleet rather than guessed:
//
//   RamCacheSize=2735  FileCacheSize=0  MaxRamCacheSize=5096  MaxFileCacheSize=5096
//
// Two facts follow, and the second is the important one.
//
// First, these are occupancy and capacity, in the megabytes nimble.conf uses
// for `ram_cache_size`. So "how full is the cache" is answerable exactly.
//
// Second — **there are no hit and miss counters.** Not in this version, not
// under another name; the response carries sizes and nothing else. Cache hit
// ratio therefore cannot be measured from `/manage/server_status`, and the
// panel says so rather than continuing to look expectant. That is a definite
// answer to a question that has been open since the CDN discussion, and it is
// worth stating plainly instead of leaving a percentage field that will never
// fill in.
export const KNOWN_FIELDS = {
  RamCacheSize: { role: 'used', store: 'ram', unit: 'MB' },
  MaxRamCacheSize: { role: 'capacity', store: 'ram', unit: 'MB' },
  FileCacheSize: { role: 'used', store: 'file', unit: 'MB' },
  MaxFileCacheSize: { role: 'capacity', store: 'file', unit: 'MB' },
};

// Occupancy against capacity, per store, from whatever of the four are
// present. A pair with no capacity yields no percentage — the same rule as
// everywhere else: a number that needs two inputs is not reported on one.
export function cacheStores(fields) {
  const by = new Map();
  for (const f of fields) {
    const known = KNOWN_FIELDS[f.path.split('.').pop()];
    if (!known) continue;
    const cur = by.get(known.store) || { store: known.store, unit: known.unit };
    cur[known.role] = f.value;
    by.set(known.store, cur);
  }
  return [...by.values()].map(s => ({
    ...s,
    fullPct: (s.capacity > 0 && typeof s.used === 'number')
      ? Math.round((s.used / s.capacity) * 1000) / 10 : null,
  }));
}

// Keys worth surfacing, matched by meaning rather than by an exact name we do
// not have. Deliberately broad: a field this misses is invisible, a field it
// picks up wrongly is at least visible and named.
const CACHE_KEY = /cache|chunk|ram/i;
const COUNTER_KEY = /hit|miss|request|fetch/i;

const isNumeric = (v) => typeof v === 'number' && Number.isFinite(v);

// Walk the response and collect anything cache-shaped, keeping the path so an
// operator can see exactly which field a number came from.
export function findCacheFields(payload, prefix = '', out = []) {
  if (!payload || typeof payload !== 'object') return out;
  for (const [k, v] of Object.entries(payload)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      findCacheFields(v, path, out);
    } else if (isNumeric(v) && (CACHE_KEY.test(path) || COUNTER_KEY.test(path))) {
      out.push({ path, value: v, counter: COUNTER_KEY.test(k) });
    }
  }
  return out;
}

// A hit ratio, but only if the response actually carries the two numbers it
// takes. Anything else is arithmetic on data we do not have.
export function hitRatio(fields) {
  const find = (re) => fields.find(f => re.test(f.path));
  const hits = find(/hit/i);
  const misses = find(/miss/i);
  if (!hits || !misses) return null;
  const total = hits.value + misses.value;
  if (total <= 0) return { ratio: null, hits: hits.value, misses: misses.value, from: [hits.path, misses.path] };
  return {
    ratio: Math.round((hits.value / total) * 1000) / 10,
    hits: hits.value, misses: misses.value,
    from: [hits.path, misses.path],
  };
}

// The documented arithmetic, which is a different kind of answer and is
// labelled as such: how much RAM the cache *should* need, given what is being
// streamed. Softvelum: four chunks per stream stay in the playlist, and a
// chunk leaving it gets a 45-second timeout, so the resident count is
// 4 + 45/duration.
//
// Useful because it answers a question an operator has before an event —
// "will the cache hold" — which no counter can answer until it is too late.
export const RESIDENT_CHUNKS = (durationSec) =>
  durationSec > 0 ? 4 + Math.ceil(45 / durationSec) : null;

export function expectedCacheBytes(streams, { chunkSeconds = 6 } = {}) {
  const chunks = RESIDENT_CHUNKS(chunkSeconds);
  if (!chunks) return null;
  // An idle edge reports its streams at zero bitrate — a re-streaming route
  // pulls nothing until a viewer asks — so the sum comes to zero and the page
  // said "the cache should hold about 0.0 MB", which is not a size, it is the
  // absence of an input dressed as one.
  const known = streams.filter(s => Number(s.bandwidth) > 0);
  if (!known.length) {
    return { bytes: null, chunksPerStream: chunks, chunkSeconds,
             streams: streams.length, knownBitrates: 0, independentOfViewers: true };
  }
  let bytes = 0;
  for (const s of known) {
    bytes += chunks * chunkSeconds * (Number(s.bandwidth) || 0) / 8;
  }
  return {
    bytes: Math.round(bytes),
    chunksPerStream: chunks,
    chunkSeconds,
    streams: streams.length,
    // How many of them actually contributed. Extrapolating the rest from an
    // average would turn one measured stream into a confident total.
    knownBitrates: known.length,
    // Stated because it is the counter-intuitive part and the reason this is
    // worth showing: cache size does not grow with the audience. A thousand
    // viewers of one stream need the same chunks as one viewer.
    independentOfViewers: true,
  };
}

// The whole picture for one server, honest about which parts are measured and
// which are computed.
export function cacheReport({ status, streams = [], chunkSeconds = 6, node = null, viewers = 0 }) {
  const fields = findCacheFields(status);
  const ratio = hitRatio(fields);
  const stores = cacheStores(fields);
  return {
    // Occupancy against capacity, which is what this Nimble actually reports.
    stores,
    // Hit ratio's question, asked in the form the data can answer: how much
    // more went to viewers than came from the origin. Not called hit ratio,
    // because it is not one.
    amplification: amplification({ status, node, viewers }),
    // Stated as a fact about the server, not as a gap in the panel: no version
    // of `/manage/server_status` seen so far carries hit or miss counters, so
    // the ratio is not measurable here by any amount of further looking.
    ratioAvailable: ratio !== null,
    // Measured: whatever Nimble actually reported, named as it named it.
    reported: fields,
    // Derived from two reported counters, when both exist.
    hitRatio: ratio,
    // Computed from documented behaviour — not a measurement, and the UI says
    // so rather than putting it in the same row as the reported figures.
    expected: expectedCacheBytes(streams, { chunkSeconds }),
    // The honest summary when there is nothing: an operator should learn that
    // the panel looked and found nothing, not be shown a confident zero.
    hasAnyCacheData: fields.length > 0,
  };
}
