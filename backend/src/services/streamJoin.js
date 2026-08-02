// iter16 m1 — matching what Nimble reports live against what WMSPanel holds.
//
// The two systems name the same stream differently, and which field lines up
// with which is not documented. Guessing has cost this project twice already:
// `application`/`stream` written into a source-switch patch, and a picker full
// of `?/?` because an incoming object turned out to carry `name`.
//
// So this does not assume a key. It tries several, in order of how strongly
// each identifies a stream, takes the first that matches anything, and REPORTS
// which one it used along with everything that matched nothing. The first run
// against a real server therefore answers the question instead of me answering
// it in advance — and if none of them fit, that is visible rather than
// producing empty columns that look like an offline stream.

const clean = (v) => String(v ?? '').trim().toLowerCase();

/**
 * The list of entries in whatever envelope Nimble used.
 *
 * There were two of these — the collector's, which matched a fixed list of key
 * names, and the route's, which fell back to the first array of objects. The
 * SRT endpoints answer `{ SrtReceivers: [...] }` and `{ SrtSenders: [...] }`,
 * which the fixed list did not have, so the collector recorded NOTHING for SRT
 * while the table filled correctly from the route. That is the whole of "the
 * server is reporting but this stream never appears".
 *
 * Preferred names first, because a response can carry more than one array and
 * `stats` is the data where `rules` might be configuration.
 */
export function entryList(d) {
  if (Array.isArray(d)) return d;
  if (!d || typeof d !== 'object') return [];
  for (const k of ['streams', 'sockets', 'stats', 'rules']) if (Array.isArray(d[k])) return d[k];
  // Anything else: the one array of objects at the top level.
  for (const v of Object.values(d)) {
    if (Array.isArray(v) && (v.length === 0 || (v[0] && typeof v[0] === 'object'))) return v;
  }
  // Some endpoints key an object by stream or port instead of listing it; the
  // key is often the only identifier there is.
  const vals = Object.entries(d).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v));
  if (vals.length && vals.every(([, v]) => Object.values(v).some(x => typeof x === 'number'))) {
    return vals.map(([k, v]) => ({ ...v, _key: k, name: v.name ?? k }));
  }
  return [];
}

/**
 * How one native entry is identified in the stored series.
 *
 * There were two independent answers to "which stream is this" — the
 * collector's, which keys the series, and the join's, which fills the table —
 * and they used different id spaces. The live columns could therefore be
 * right while the history was empty, for ever, which is exactly what happened.
 * One function, used by both.
 *
 * Never the socket pair: its source port changes on every reconnect and a
 * series keyed on it shatters.
 */
export function entryIdentity(entry) {
  if (!entry) return '';
  const stable = entry.setting_id ?? entry.settingId ?? entry.name ?? entry.stream;
  if (stable) return String(stable);
  // What must be excluded is the SOCKET PAIR, not `id` in general: some
  // endpoints return a plain stable id there. A pair carries an address, and
  // its source port changes on every reconnect — so it becomes the local port,
  // which does not.
  const id = String(entry.id ?? '');
  if (!id) return '';
  return isSocketPair(id) ? (localPort(id) || '') : id;
}

// "a:1->b:2", or a bare "1.2.3.4:5678". Anything else is a name.
function isSocketPair(id) {
  return id.includes('->') || /^[\d.]+:\d+$/.test(id) || /^\[?[0-9a-f:]+\]?:\d+$/i.test(id);
}

// A socket address, normalised. `0.0.0.0:21041` and `:21041` describe the same
// listener, so a listen-mode object is identified by its port alone.
// The local side of a socket pair. "a:1->b:2" gives 2; "b:2" alone is a
// listener and gives 2 as well.
export function localPort(id) {
  const str = String(id ?? '');
  if (!str) return '';
  const local = str.includes('->') ? str.split('->').pop() : str;
  const m = /:(\d+)\s*$/.exec(local.trim());
  return m ? `port:${m[1]}` : '';
}

function addrKey(ip, port) {
  const p = String(port ?? '').trim();
  if (!p) return '';
  const host = clean(ip);
  return !host || host === '0.0.0.0' || host === '::' ? `*:${p}` : `${host}:${p}`;
}

// How a native stats entry might be identified, best first.
const NATIVE_KEYS = [
  // Confirmed against a live server: Nimble's SRT stats carry `setting_id`,
  // which IS the WMSPanel object id. Its `id` field is a socket pair
  // ("31.28.6.149:60317->0.0.0.0:35001") and identifies a connection, not a
  // configured stream — matching on it would pair nothing.
  { name: 'setting_id', of: (e) => clean(e.setting_id ?? e.settingId) },
  { name: 'name', of: (e) => clean(e.name) },
  { name: 'stream', of: (e) => clean(e.stream) },
  // Nimble's `id` is a socket pair: "31.28.6.149:60317->0.0.0.0:35001", or
  // just "79.98.187.66:22213" for a listener. The LOCAL port is the one thing
  // that means the same on both sides — it is what the operator configured —
  // so it is worth trying even when no identifier lines up.
  { name: 'localPort', of: (e) => localPort(e.id) },
  { name: 'id', of: (e) => clean(e.id) },
  // Nimble reports the socket it uses; the field name varies by build, which
  // is exactly why several are tried rather than one assumed.
  { name: 'address', of: (e) => addrKey(e.ip ?? e.host ?? e.local_ip, e.port ?? e.local_port ?? e.listen_port) },
  { name: 'remote', of: (e) => addrKey(e.remote_ip ?? e.peer_ip, e.remote_port ?? e.peer_port) },
  { name: 'url', of: (e) => clean(e.url ?? e.source_url ?? e.dest_addr) },
];

// How a WMSPanel object might be identified, in the same order.
const WMS_KEYS = [
  { name: 'setting_id', of: (o) => clean(o.id) },
  { name: 'name', of: (o) => clean(o.name) },
  { name: 'stream', of: (o) => clean(o.stream ?? o.src_stream) },
  { name: 'localPort', of: (o) => (o.port ? `port:${o.port}` : '') },
  { name: 'id', of: (o) => clean(o.id) },
  { name: 'address', of: (o) => addrKey(o.ip ?? o.local_ip, o.port ?? o.local_port) },
  { name: 'remote', of: (o) => addrKey(o.ip, o.port) },
  { name: 'url', of: (o) => clean(o.url ?? o.dest_addr) },
];

/**
 * Match native stats entries to WMSPanel objects.
 *
 * Returns the pairing, the key that produced it, and — most importantly when
 * it fails — what was left over on each side.
 */
export function joinLive(entries = [], objects = []) {
  const candidates = [];
  let best = null;

  for (let i = 0; i < NATIVE_KEYS.length; i++) {
    const nk = NATIVE_KEYS[i];
    const wk = WMS_KEYS[i];
    // Several entries can belong to one object: an SRT Out setting reports one
    // socket per connected client, all sharing a setting_id. Keeping the last
    // one showed a single viewer's rate where the egress total was meant.
    const index = new Map();
    for (const e of entries) {
      const k = nk.of(e);
      // An empty key matches everything and therefore identifies nothing.
      if (!k) continue;
      if (!index.has(k)) index.set(k, []);
      index.get(k).push(e);
    }
    const pairs = [];
    for (const o of objects) {
      const k = wk.of(o);
      if (k && index.has(k)) pairs.push([String(o.id), index.get(k)]);
    }
    candidates.push({ key: nk.name, matched: pairs.length });
    // The key that pairs the MOST objects wins, ties broken by order.
    //
    // It used to be the first key to match anything, on the theory that the
    // order encoded how strongly each identifies a stream — which was another
    // assumption of mine. One accidental match on an earlier key then blocked
    // a later one that would have paired dozens, and the result looked exactly
    // like "these are different streams".
    if (pairs.length && (!best || pairs.length > best.pairs.length)) {
      best = { key: nk.name, pairs };
    }
  }

  const byObjectId = Object.fromEntries(best?.pairs || []);
  const used = new Set(Object.values(byObjectId).flat());

  return {
    byObjectId,
    strategy: best?.key || '',
    matched: best?.pairs.length || 0,
    unmatchedObjects: objects.filter(o => !(String(o.id) in byObjectId)).map(o => String(o.id)),
    // Kept whole rather than counted: when nothing matches, these are the only
    // evidence of what the fields are actually called.
    unmatchedEntries: entries.filter(e => !used.has(e)).slice(0, 10),
    candidates,
  };
}

const num = (...vals) => {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

// The few numbers worth putting in a table row. Everything else stays in the
// stored series, which is what the per-stream charts will read.
// Below this, a socket is connected but carrying no media.
//
// A threshold is unavoidable here and so it is stated rather than buried. An
// SRT socket with nothing flowing still costs a few tens of kbit/s in
// handshake and keepalive traffic — observed at 0.03 Mbps across a fleet — and
// the lowest real video feed on these servers runs at 6.5. The capture used to
// build this shows the same gap from the other side: every entry is either
// exactly 0 or above 8 Mbps, with nothing in between.
//
// 0.2 Mbps sits an order of magnitude above the overhead and an order below
// the quietest real stream, so no plausible feed is misread as empty and no
// empty socket is misread as a feed. Overridable, because a fleet carrying
// audio-only streams would need it lower.
const NO_MEDIA_MBPS = Number(process.env.NNM_NO_MEDIA_MBPS || 0.2);

/**
 * One row's numbers, from however many sockets belong to it.
 *
 * An SRT Out setting with five viewers is five sockets. The rate that matters
 * for the row is the sum — that is what is leaving the server — while RTT and
 * loss are worst-case, because one bad client is the one worth noticing. The
 * client count is itself information WMSPanel shows and we did not.
 */
export function liveSummary(entryOrList) {
  if (!entryOrList) return null;
  const list = Array.isArray(entryOrList) ? entryOrList : [entryOrList];
  if (!list.length) return null;
  if (list.length > 1) {
    const parts = list.map(e => summariseOne(e)).filter(Boolean);
    if (!parts.length) return null;
    const rates = parts.map(p => p.bps).filter(v => v != null);
    return {
      bps: rates.length ? rates.reduce((a, b) => a + b, 0) : null,
      online: parts.some(p => p.online),
      // Idle only when EVERY socket is: one client pulling nothing while four
      // others work is not an idle stream.
      idle: parts.every(p => p.idle),
      rtt: Math.max(...parts.map(p => p.rtt ?? 0)) || null,
      loss: Math.max(...parts.map(p => p.loss ?? 0)) || null,
      retries: parts.reduce((a, p) => a + (p.retries || 0), 0),
      clients: parts.length,
    };
  }
  return summariseOne(list[0]);
}

function summariseOne(entry) {
  if (!entry) return null;
  const st = entry.stats || {};
  const dir = st.recv || st.send || {};      // receiver on SRT In, sender on SRT Out

  // `stats.recv.mbpsRate` is the stream. `stats.link.mbpsBandwidth` is the
  // link's estimated capacity — 2444 Mbps on a live 8 Mbps feed — and putting
  // that in a bitrate column would have been badly wrong in a way that looks
  // plausible. Named explicitly rather than swept up by a "bandwidth" guess.
  const mbps = num(dir.mbpsRate, entry.mbpsRate, entry.bitrate_mbps);
  const rawBps = num(entry.bitrate, entry.bandwidth_bps);
  const bps = mbps != null ? mbps * 1e6 : rawBps;

  const state = clean(entry.state ?? entry.status);
  const connected = entry.connected === true || ['connected', 'active', 'online'].includes(state);

  const received = num(dir.packetsReceived, dir.packetsSent);
  const lost = num(dir.packetsLost);
  const loss = received && lost != null ? (100 * lost) / (received + lost) : null;

  return {
    bps,
    // Connected with nothing flowing is its own state and worth seeing: two of
    // seven live sockets were in it. Collapsing it into "offline" would hide a
    // stream that is up but silent — the one an operator most wants to catch.
    online: connected || (bps != null && bps > 0),
    // "Connected" and "delivering" are different claims, and a green lamp
    // beside 0.03 Mbps makes the first look like the second.
    idle: connected && bps != null && bps < NO_MEDIA_MBPS * 1e6,
    rtt: num(st.link?.rtt, entry.rtt, entry.msRTT),
    loss,
    // How many times Nimble has re-established this socket. A number that
    // climbs is a link that keeps dropping, which no instantaneous reading
    // shows.
    retries: num(entry.retryCount),
    clients: 1,
  };
}
