#!/usr/bin/env node
//
// What does WMSPanel let us read about transmuxing settings?
//
// LL-HLS is two halves. The nimble.conf half — a certificate and
// `ssl_http2_enabled` — is a file on the machine, and the panel can write it.
// The other half is a WMSPanel setting: the container, the "Enable Apple's Low
// Latency HLS" checkbox, the part duration. Whether that family is reachable
// through the API is unknown, and three families here are already read-only —
// `geo`, `asn`, `dvr_streams` — each discovered by trying, after something had
// been built assuming otherwise.
//
// This asks. It reads and never writes: no code path sends a method or a body,
// and the paths are a written-down list rather than generated, because a
// script that probes an API by permutation is one that eventually POSTs
// something.
//
// Usage — no dependencies, no database, runs anywhere Node is:
//
//     node wms-recon.mjs <client_id> <api_key> [server_id ...]
//
// With no server ids it lists the servers first and asks about all of them.
// An earlier version read the credentials out of the panel's own database.
// That needed mongoose, the panel's models and a reachable Mongo — three
// things that are only together inside the container, which is not where
// somebody runs a one-off script. Arguments work everywhere.
//
const [, , CLIENT_ID, API_KEY, ...SERVER_IDS] = process.argv;
const BASE = (process.env.WMS_BASE || 'https://api.wmspanel.com/v1').replace(/\/+$/, '');
const TIMEOUT_MS = 12000;

const line = (s = '') => process.stdout.write(s + '\n');

if (!CLIENT_ID || !API_KEY) {
  line('usage: node wms-recon.mjs <client_id> <api_key> [server_id ...]');
  line('');
  line('  client_id / api_key — from WMSPanel, Settings → API');
  line('  server_id           — optional; without it every server is asked about');
  line('');
  line('  WMS_BASE=https://api.wmspanel.ru/v1  to use the mirror');
  process.exit(1);
}

// Paths worth asking about, and why each is here.
const PROBES = [
  // The feature is called "Live streams settings" in the WMSPanel UI; the API
  // reference does not name its route, so the plausible spellings are tried.
  { path: (sid) => `/server/${sid}/transmuxer/settings`, why: 'transmuxing settings, first spelling' },
  { path: (sid) => `/server/${sid}/hls/settings`,        why: 'transmuxing settings, second spelling' },
  { path: (sid) => `/server/${sid}/live/settings`,       why: 'transmuxing settings, third spelling' },
  { path: (sid) => `/server/${sid}/settings`,            why: 'per-server settings, if the family is flat' },
  // Per-application overrides exist in the UI; the toggle may live under one.
  { path: (sid) => `/server/${sid}/applications`,        why: 'per-application settings' },
  { path: (sid) => `/server/${sid}/apps`,                why: 'per-application settings, alternate' },
  // Known-good, as a control: if this fails too then the credentials or the IP
  // allow-list are the problem and nothing else here means anything.
  { path: (sid) => `/server/${sid}`,                     why: 'the server itself — a control probe' },
];

const auth = `client_id=${encodeURIComponent(CLIENT_ID)}&api_key=${encodeURIComponent(API_KEY)}`;

async function get(path) {
  const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}${auth}`;
  const started = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: r.status, ms: Date.now() - started, text: await r.text() };
  } catch (e) {
    return { status: null, ms: Date.now() - started, error: String(e?.message || e).slice(0, 200) };
  }
}

async function main() {
  line(`WMSPanel: ${BASE}`);
  line('Every request below is a GET. Nothing is written.');
  line('');

  let ids = SERVER_IDS;
  if (!ids.length) {
    const r = await get('/server');
    if (r.status !== 200) {
      line(`Could not list servers: ${r.status ?? r.error}`);
      line('If this is 403, check the credentials and that this host is in the API IP allow-list.');
      process.exit(1);
    }
    try {
      const j = JSON.parse(r.text);
      const servers = j.servers || j.data || (Array.isArray(j) ? j : []);
      ids = servers.map(s => s.id).filter(Boolean);
      line(`Servers: ${servers.map(s => `${s.name || '?'} (${s.id})`).join(', ')}`);
      line('');
    } catch {
      line('The server list did not parse as JSON; pass server ids explicitly.');
      process.exit(1);
    }
  }

  for (const sid of ids) {
    line(`=== server ${sid}`);
    for (const probe of PROBES) {
      const path = probe.path(encodeURIComponent(sid));
      const r = await get(path);

      // The status is the answer. 404 means the route is not there; 403 means
      // it is and we may not have it; 200 means the shape below decides what
      // the panel can offer.
      line(`  ${String(r.status ?? 'ERR').padEnd(4)} ${path}   (${r.ms} ms)  — ${probe.why}`);
      if (r.error) { line(`       ${r.error}`); continue; }

      if (r.status === 200) {
        let shown = r.text.slice(0, 1500);
        try {
          const j = JSON.parse(r.text);
          shown = JSON.stringify(j, null, 2).slice(0, 2000);
          // The whole point: is the LL-HLS toggle in here, and its part
          // duration?
          const hay = JSON.stringify(j).toLowerCase();
          const hits = ['low_latency', 'lowlatency', 'll_hls', 'llhls', 'part_duration',
                        'chunk_duration', 'fmp4', 'mpegts', 'hls', 'ssl', 'http2']
            .filter(k => hay.includes(k));
          if (hits.length) line(`       fields of interest: ${hits.join(', ')}`);
        } catch { /* not JSON; the raw head is still worth seeing */ }
        line(shown.split('\n').map(l => '       ' + l).join('\n'));
      } else if (r.text?.trim()) {
        line(`       ${r.text.slice(0, 300).replace(/\s+/g, ' ')}`);
      }
    }
    line('');
  }

  line('What to do with this:');
  line('  200 on a settings path  → the panel may be able to offer LL-HLS; the field names above say how.');
  line('  404 everywhere          → the family is not in the API; LL-HLS is enabled in WMSPanel by hand.');
  line('  403 including the control probe → credentials or the IP allow-list, not the feature.');
}

main().catch((e) => { line(`failed: ${e?.message || e}`); process.exit(1); });
