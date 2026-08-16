#!/usr/bin/env node
//
// What does WMSPanel let us read and write about transmuxing?
//
// LL-HLS is two halves. The nimble.conf half — a certificate and
// `ssl_http2_enabled` — is a file on the machine, and the panel can write it.
// The other half is a WMSPanel setting: the container, the "Enable Apple's Low
// Latency HLS" checkbox, the part duration. Whether that family accepts writes
// is unknown, and three families here are already read-only — `geo`, `asn`,
// `dvr_streams` — each discovered by trying, after something had been built
// assuming otherwise.
//
// This asks. It reads and it never writes: every request is a GET, there is no
// code path that sends a body, and a POST discovered by this script would be a
// POST somebody else has to make deliberately.
//
// Run it on the panel host:
//
//     cd /opt/nnm-control/backend      (or wherever the panel is installed)
//     node tools/wms-recon.mjs                 # every mapped server
//     node tools/wms-recon.mjs <server-name>   # one of them
//
// It lives under backend/ so that Node finds mongoose and the panel's models
// where they actually are — from the repository root neither resolves.
//
// Credentials come from the panel's own settings — the same ones it already
// uses — so there is nothing to paste and nothing to leak into a shell history.
//
// The panel's own models, not raw collections.
//
// `apiKey` is stored encrypted, with the decryption on the schema's getter —
// so reading the document through the driver returns ciphertext, every request
// comes back 403, and the output would read as "the API refuses us" when in
// fact nothing had been asked properly. The models decrypt on the way out.
import mongoose from 'mongoose';
import { Settings } from '../src/models/Settings.js';
import { NimbleServer } from '../src/models/NimbleServer.js';

const MONGO = process.env.MONGO_URL || process.env.NNM_MONGO_URL
  || 'mongodb://mongo:27017/nnm_control';
const TIMEOUT_MS = 12000;
const only = process.argv[2] || '';

// Paths worth asking about, and why each is here. Named rather than generated,
// because a script that probes an API by permutation is a script that will
// eventually POST something.
const PROBES = [
  // The documented feature is "Live streams settings" in the WMSPanel UI; the
  // API reference does not name its route, so both plausible spellings are
  // tried.
  { path: (sid) => `/server/${sid}/transmuxer/settings`, why: 'transmuxing settings, first spelling' },
  { path: (sid) => `/server/${sid}/hls/settings`,        why: 'transmuxing settings, second spelling' },
  { path: (sid) => `/server/${sid}/live/settings`,       why: 'transmuxing settings, third spelling' },
  { path: (sid) => `/server/${sid}/settings`,            why: 'per-server settings, if the family is flat' },
  // Applications carry per-app overrides in the UI; if they are reachable, the
  // LL-HLS toggle may live under one of them.
  { path: (sid) => `/server/${sid}/applications`,        why: 'per-application settings' },
  { path: (sid) => `/server/${sid}/apps`,                why: 'per-application settings, alternate' },
  // Known-good, as a control: if this fails too, the credentials or the IP
  // allow-list are the problem and nothing else in this output means anything.
  { path: (sid) => `/server/${sid}`,                     why: 'the server itself — a control probe' },
];

const line = (s = '') => process.stdout.write(s + '\n');

async function main() {
  await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 8000 });

  const settings = await Settings.findOne({});
  const cfg = {
    baseUrl: (settings?.wmspanel?.baseUrl || 'https://api.wmspanel.com/v1').replace(/\/+$/, ''),
    clientId: settings?.wmspanel?.clientId || '',
    apiKey: settings?.wmspanel?.apiKey || '',
  };

  if (!cfg.clientId || !cfg.apiKey) {
    line('WMSPanel credentials are not configured in the panel — nothing to ask with.');
    process.exit(1);
  }

  // Not .lean(): it skips the schema getters, which is exactly how the
  // encrypted key would have come back as ciphertext.
  const servers = await NimbleServer
    .find({ wmspanelServerId: { $nin: [null, ''] } }, { name: 1, wmspanelServerId: 1 });

  const chosen = only
    ? servers.filter(s => s.name === only || String(s.wmspanelServerId) === only)
    : servers;

  if (!chosen.length) {
    line(only
      ? `No mapped server matches "${only}". Mapped servers: ${servers.map(s => s.name).join(', ') || 'none'}`
      : 'No server in the panel is mapped to a WMSPanel server id.');
    process.exit(1);
  }

  line(`WMSPanel: ${cfg.baseUrl}`);
  line(`Servers to ask: ${chosen.map(s => s.name).join(', ')}`);
  line('Every request below is a GET. Nothing is written.');
  line('');

  for (const srv of chosen) {
    line(`=== ${srv.name}  (wmspanel id ${srv.wmspanelServerId})`);
    for (const probe of PROBES) {
      const path = probe.path(encodeURIComponent(srv.wmspanelServerId));
      const url = `${cfg.baseUrl}${path}?client_id=${encodeURIComponent(cfg.clientId)}`
                + `&api_key=${encodeURIComponent(cfg.apiKey)}`;
      const started = Date.now();
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        const text = await r.text();
        const ms = Date.now() - started;

        // The status is the answer. 404 means the route is not there; 403
        // means it is and we may not have it; 200 means the shape below
        // decides what the panel can offer.
        line(`  ${String(r.status).padEnd(4)} ${path}   (${ms} ms)  — ${probe.why}`);

        if (r.status === 200) {
          let shown = text.slice(0, 1200);
          try {
            const j = JSON.parse(text);
            shown = JSON.stringify(j, null, 2).slice(0, 1800);
            // The whole point: does anything in here look like the LL-HLS
            // toggle and its part duration?
            const hay = JSON.stringify(j).toLowerCase();
            const hits = ['low_latency', 'lowlatency', 'll_hls', 'llhls', 'part_duration',
                          'chunk_duration', 'fmp4', 'mpegts', 'hls']
              .filter(k => hay.includes(k));
            if (hits.length) line(`       fields of interest: ${hits.join(', ')}`);
          } catch { /* not JSON; the raw head is still worth seeing */ }
          line(shown.split('\n').map(l => '       ' + l).join('\n'));
        } else if (text.trim()) {
          line(`       ${text.slice(0, 300).replace(/\s+/g, ' ')}`);
        }
      } catch (e) {
        line(`  ERR  ${path}   — ${String(e?.message || e).slice(0, 160)}`);
      }
    }
    line('');
  }

  line('What to do with this:');
  line('  200 on a settings path  → the panel may be able to offer LL-HLS; the field names above say how.');
  line('  404 everywhere          → the family is not in the API; LL-HLS is enabled in WMSPanel by hand.');
  line('  403 including the control probe → credentials or the IP allow-list, not the feature.');

  await mongoose.disconnect();
}

main().catch(async (e) => {
  line(`failed: ${e?.message || e}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
