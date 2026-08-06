#!/usr/bin/env node
//
// What every object family actually looks like.
//
// The panel shows six kinds of stream and each is a different WMSPanel
// resource with its own fields. Which of them carry a pausable state, and
// under what name, has been guessed twice in this project and got wrong twice:
// once from reading our own edit form (which does not show every field), once
// from a five-entry sample.
//
// So this asks the panel for one object of each family and writes down every
// field with its type — and, where a family reports a state, every distinct
// value that state takes across the whole list. That last part is the one that
// settles it: a field is only a pause switch if something is actually paused
// in it.
//
//   node nnm-api-probe.mjs --url https://panel --user NAME --pass SECRET --server <id>
//
// Values are reduced to shapes before printing. Addresses lose their last
// octet; anything that looks like a key or a token is replaced outright.

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const URL_ = (opt('url') || process.env.NNM_URL || '').replace(/\/+$/, '');
const USER = opt('user') || process.env.NNM_USER;
const PASS = opt('pass') || process.env.NNM_PASS;
const SERVER = opt('server');

if (!URL_ || !USER || !PASS || !SERVER) {
  console.error('usage: node nnm-api-probe.mjs --url https://panel --user NAME --pass SECRET --server <serverId>');
  process.exit(2);
}

// The families the panel shows as tabs, and where each lives.
// Taken from what the panel itself calls, not from what the WMSPanel
// documentation names the resources. The first run of this probe used
// `mpegts/incoming` — the upstream name — and three families answered 404,
// which is the same mistake as calling an agent route on the wrong router.
const FAMILIES = [
  { tab: 'SRT In',         path: 'incoming' },
  { tab: 'SRT Out',        path: 'udp' },
  { tab: 'SRT in Nimble',  path: 'outgoing' },
  { tab: 'RTMP Push',      path: 'republish' },
  { tab: 'RTMP Pull',      path: 'livepull' },
  { tab: 'Hotswap',        path: 'hotswap' },
];

// Anything that could be a switch. Collected by name rather than assumed,
// because the last two guesses were both about a name.
const STATEFUL = /^(paused|enabled|disabled|active|status|state|running|stopped|suspended)$/i;

const SECRET = /(token|password|secret|key|auth|passphrase|pass)/i;
const mask = (v) => String(v).replace(/(\d+\.\d+\.\d+)\.\d+/g, '$1.x');

const shapeOf = (v, key = '') => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array[${v.length}]`;
  if (typeof v === 'object') return `object{${Object.keys(v).slice(0, 6).join(',')}}`;
  if (typeof v === 'string') {
    if (SECRET.test(key)) return `string(${v.length}) «hidden»`;
    return `string "${mask(v).slice(0, 60)}"`;
  }
  return `${typeof v} ${v}`;
};

let token = null;
const api = async (path) => {
  const res = await fetch(`${URL_}/api${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
};

{
  const res = await fetch(`${URL_}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
    signal: AbortSignal.timeout(30_000),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.token) { console.error(`login failed (HTTP ${res.status})`); process.exit(1); }
  token = d.token;
}

const report = { at: new Date().toISOString(), server: SERVER, families: {} };

// The list endpoints wrap their array under different keys per family, which
// is itself worth recording.
const listOf = (d) => {
  if (Array.isArray(d)) return { key: '(array)', items: d };
  for (const [k, v] of Object.entries(d || {})) if (Array.isArray(v)) return { key: k, items: v };
  return { key: null, items: [] };
};

for (const fam of FAMILIES) {
  const entry = { tab: fam.tab, path: fam.path };
  try {
    const d = await api(`/wmspanel/server/${SERVER}/${fam.path}`);
    const { key, items } = listOf(d);
    entry.wrapperKey = key;
    entry.count = items.length;

    if (items.length) {
      // Every field name seen anywhere in the family, not just on the first
      // object: an optional field absent from item zero is exactly the kind
      // that gets missed.
      const fields = new Set();
      for (const it of items) for (const k of Object.keys(it || {})) fields.add(k);
      entry.fields = [...fields].sort();

      entry.sample = Object.fromEntries(
        Object.entries(items[0]).map(([k, v]) => [k, shapeOf(v, k)]));

      // The decisive part: which fields could be a switch, and what values
      // they actually take across the list. A field that is `false` on every
      // object tells you nothing; one that is `true` somewhere is the switch.
      entry.stateful = {};
      for (const f of entry.fields) {
        if (!STATEFUL.test(f)) continue;
        const values = new Map();
        for (const it of items) {
          const v = it?.[f];
          if (v === undefined) continue;
          const s = typeof v === 'string' ? v : String(v);
          values.set(s, (values.get(s) || 0) + 1);
        }
        entry.stateful[f] = [...values].sort((a, b) => b[1] - a[1])
          .map(([v, n]) => `${v} ×${n}`);
      }
    }
  } catch (e) {
    // A family this server does not have is a fact, not a failure — but an
    // HTML 404 is neither: it is this probe asking for a route the panel does
    // not serve, and saying so beats recording it as an absent family.
    const msg = String(e.message);
    entry.error = msg.slice(0, 200);
    if (/HTTP 404/.test(msg) && /DOCTYPE html/i.test(msg)) {
      entry.error = `no such route in the panel: /wmspanel/server/<id>/${fam.path} — the probe is asking for the wrong path`;
    }
  }
  report.families[fam.path] = entry;
}

// ---- transcoders -----------------------------------------------------------
//
// A whole one, not a shape summary. The pipeline is nested — lines, then
// input/filter/output, each with its own fields — and which fields appear
// depends on what the stage is. A summary of the top level says nothing about
// that, and rebuilding the editor from what the editor currently assumes is
// how it came to show fields nobody has and hide fields people set.
report.transcoders = { note: 'one full pipeline, field names intact, values reduced' };
try {
  const d = await api(`/wmspanel/transcoders`);
  const all = (d?.transcoders || d?.settings || (Array.isArray(d) ? d : [])) || [];
  report.transcoders.count = all.length;
  const mine = all.filter(x => !SERVER || String(x.server_id) === SERVER);
  const one = mine[0] || all[0];
  if (one) {
    report.transcoders.topLevelFields = Object.keys(one).sort();
    // The pipeline verbatim: names and structure are the point, so only leaf
    // values are reduced and nothing is dropped.
    const reduce = (v, key = '') => {
      if (Array.isArray(v)) return v.map(x => reduce(x));
      if (v && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, reduce(x, k)]));
      }
      return shapeOf(v, key);
    };
    report.transcoders.sample = reduce(one);
  }
} catch (e) {
  report.transcoders.error = String(e.message).slice(0, 200);
}

process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
