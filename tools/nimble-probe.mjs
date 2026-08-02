#!/usr/bin/env node
//
// What Nimble actually reports, asked from the machine it runs on.
//
// Written because guessing has cost this epic several rounds: which endpoint
// holds which family of streams, what an entry's id looks like, where the rate
// lives. Every guess was plausible and several were wrong, and each correction
// needed another screenshot. This asks the server and writes down the answer.
//
//   node nimble-probe.mjs > nimble-probe.json
//
// Addresses are reduced before they are written: the last octet of an IPv4
// goes. Ids, ports and numbers are kept, because they are the whole point —
// what comes out is enough to build a join on and not enough to be a leak.
//
// Options:
//   --host 127.0.0.1   --port 8082    the native API (defaults shown)
//   --raw                             keep addresses intact (then don't share it)

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const RAW = args.includes('--raw');
const BASE = `http://${opt('host', '127.0.0.1')}:${opt('port', '8082')}`;

// Everything that could plausibly carry stream statistics. An endpoint this
// build does not have answers 404, and that is recorded rather than skipped —
// knowing what is absent is half the map.
const ENDPOINTS = [
  '/manage/srt_receiver_stats',
  '/manage/srt_sender_stats',
  '/manage/rtmp/republish/stats',
  '/manage/live_streams_status',
  '/manage/mpegts_status',
  '/manage/mpegts/incoming',
  '/manage/mpegts/outgoing',
  '/manage/server_status',
  '/manage/sessions',
];

const maskIp = (s) => String(s).replace(/(\d+\.\d+\.\d+)\.\d+/g, '$1.x');
const mask = (v) => (RAW ? String(v) : maskIp(v));

// A value's shape. Numbers are kept whole — a rate of 8.12 beside a link
// bandwidth of 2444 is exactly the distinction that was got wrong once.
function describe(v, depth = 0) {
  if (Array.isArray(v)) {
    return { type: 'array', length: v.length, first: v.length && depth < 3 ? describe(v[0], depth + 1) : undefined };
  }
  if (v && typeof v === 'object') {
    const out = { type: 'object', keys: Object.keys(v).slice(0, 60), fields: {} };
    for (const [k, x] of Object.entries(v).slice(0, 40)) {
      if (typeof x === 'number') out.fields[k] = { type: 'number', value: x };
      else if (typeof x === 'string') out.fields[k] = { type: 'string', value: mask(x).slice(0, 120) };
      else if (depth < 3) out.fields[k] = describe(x, depth + 1);
      else out.fields[k] = { type: typeof x };
    }
    return out;
  }
  return { type: typeof v, value: typeof v === 'number' ? v : undefined };
}

const listOf = (d) => {
  if (Array.isArray(d)) return d;
  if (!d || typeof d !== 'object') return [];
  for (const v of Object.values(d)) if (Array.isArray(v)) return v;
  return [];
};

// Every id-ish and port-ish value in an entry, wherever it sits. This is the
// question that keeps being answered wrongly: what could two systems possibly
// match on.
function identifiers(e, prefix = '', out = {}, depth = 0) {
  if (!e || typeof e !== 'object' || depth > 3) return out;
  for (const [k, v] of Object.entries(e)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string' && /id$|name|stream|url|addr|host|ip/i.test(k)) out[key] = mask(v);
    else if (typeof v === 'number' && /port/i.test(k)) out[key] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) identifiers(v, key, out, depth + 1);
  }
  return out;
}

const report = { base: RAW ? BASE : maskIp(BASE), at: new Date().toISOString(), endpoints: {} };

for (const path of ENDPOINTS) {
  const entry = { path };
  try {
    const res = await fetch(BASE + path, { signal: AbortSignal.timeout(10_000) });
    entry.status = res.status;
    if (!res.ok) {
      entry.body = (await res.text()).slice(0, 200);
      report.endpoints[path] = entry;
      continue;
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch { entry.notJson = text.slice(0, 200); report.endpoints[path] = entry; continue; }

    const list = listOf(data);
    entry.topLevel = Array.isArray(data) ? 'array' : Object.keys(data).slice(0, 20);
    entry.count = list.length;
    entry.shape = describe(list[0] ?? data);
    // Several entries, because a family only shows itself across more than one.
    entry.identifiers = list.slice(0, 8).map(x => identifiers(x));
  } catch (e) {
    entry.error = String((e && e.message) || e).slice(0, 200);
  }
  report.endpoints[path] = entry;
}

process.stdout.write(JSON.stringify(report, null, 1));
