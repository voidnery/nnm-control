// The half of LL-HLS that lives on the machine.
//
// The WMSPanel half — `alhls_enabled`, `hls_part_duration`, the container — is
// a write to a live application and is done through the API. This is the other
// half: without HTTP/2 over TLS a player falls back to ordinary HLS in
// silence, so the checkbox is on, the panel is pleased, and the viewer is six
// seconds behind.
//
// Parameter names are from Softvelum's configuration reference and their SSL
// article, not from memory:
//
//   ssl_port = 8443                       one or more ports, comma-separated
//   ssl_certificate = /path/fullchain.pem
//   ssl_certificate_key = /path/privkey.pem
//   ssl_http2_enabled = true              HTTP/2 only works over HTTPS
//   ssl_protocols = TLSv1.2 TLSv1.3       space-separated
//   port = 8081                           0 would mean HTTPS only
//
// and the change takes effect on `service nimble restart`.
//
// ---------------------------------------------------------------------------
// Why this is an upsert on the file that is there, rather than a template.
//
// `nimble.conf` on these machines is not ours. It carries the WMSPanel
// credentials that bind the server to the account, and whatever else fifteen
// machines have accumulated over years. Writing a file we composed would be a
// remote `rm` with extra steps.
//
// So: read what is there, change the keys that need changing, leave every
// other byte alone — including comments, blank lines and ordering, because a
// diff an operator cannot read is a diff an operator approves without reading.

export const CONF_PATH = '/etc/nimble/nimble.conf';

// Nimble's own default, and Softvelum's own example uses 8443. Not 443: the
// `443` that appears in nimble.conf is Nimble's *outbound* connection to
// WMSPanel and binds no local port, and choosing 443 here for that reason
// would be a coincidence mistaken for a requirement.
export const DEFAULT_SSL_PORT = 8443;

// Keys this plan will touch. Everything outside this list is left exactly as
// found — which is the whole safety argument, so it is a list rather than a
// pattern.
export const MANAGED_KEYS = [
  'ssl_port', 'ssl_certificate', 'ssl_certificate_key',
  'ssl_http2_enabled', 'ssl_protocols',
];

// Values that must never leave the machine. `nimble.conf` holds the WMSPanel
// client id and API key, and this file gets read into the panel, shown in a
// diff and written to an audit record. Masked at the source, not at the point
// of printing — the same rule that push credentials earned.
export const SECRET_KEYS = ['client_id', 'api_key', 'ssl_certificate_key_pass', 'token'];

// ---------------------------------------------------------------------------
// Reading.
//
// A parser rather than a regex over the whole file, because the answer to
// "is ssl_http2_enabled already set" has to distinguish a real setting from
// the same words inside a comment. A commented-out line is not a setting, and
// treating it as one produces a plan that changes nothing and reports success.
export function parseConf(text) {
  const lines = String(text ?? '').split('\n');
  const settings = new Map();      // key -> { value, line }
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq < 0) return;
    const key = line.slice(0, eq).trim();
    if (!/^[a-z0-9_]+$/i.test(key)) return;   // `ssl_server {` and the like
    settings.set(key, { value: line.slice(eq + 1).trim(), line: i });
  });
  return { lines, settings };
}

export function maskConf(text) {
  return String(text ?? '').split('\n').map(raw => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return raw;
    const eq = line.indexOf('=');
    if (eq < 0) return raw;
    const key = line.slice(0, eq).trim();
    if (!SECRET_KEYS.includes(key)) return raw;
    const value = line.slice(eq + 1).trim();
    return raw.slice(0, raw.indexOf(key)) + `${key} = <${value.length} characters, hidden>`;
  }).join('\n');
}

// ---------------------------------------------------------------------------
// Writing.
//
// A key that exists is changed in place, keeping its own spacing. A key that
// does not is appended in one block with a comment saying who wrote it and
// when — so somebody reading this file in a year knows where it came from.
export function upsert(text, changes) {
  const { lines, settings } = parseConf(text);
  const out = [...lines];
  const added = [];
  const changed = [];

  for (const [key, value] of Object.entries(changes)) {
    const existing = settings.get(key);
    if (existing) {
      if (existing.value === String(value)) continue;   // already right
      out[existing.line] = out[existing.line].replace(
        /^(\s*[a-z0-9_]+\s*=\s*).*$/i, `$1${value}`);
      changed.push({ key, from: existing.value, to: String(value) });
    } else {
      added.push({ key, to: String(value) });
    }
  }

  if (added.length) {
    // A trailing newline is not guaranteed on a file nobody has been careful
    // with, and appending to a file whose last line has no newline joins two
    // settings into one.
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push('# --- NNM Control: Low-Latency HLS transport -----------------------------');
    out.push('# HTTP/2 over TLS. Without it a player falls back to ordinary HLS silently.');
    for (const a of added) out.push(`${a.key} = ${a.to}`);
  }

  return { text: out.join('\n'), added, changed, unchanged: !added.length && !changed.length };
}

// A line-level diff of what will change, for an operator to read before
// pressing anything. Masked, because this is the file with the credentials in
// it.
export function describeChange(before, after) {
  const b = maskConf(before).split('\n');
  const a = maskConf(after).split('\n');
  const out = [];
  const max = Math.max(b.length, a.length);
  for (let i = 0; i < max; i++) {
    if (b[i] === a[i]) continue;
    if (b[i] !== undefined && a[i] !== undefined) out.push({ line: i + 1, from: b[i], to: a[i] });
    else if (a[i] !== undefined) out.push({ line: i + 1, from: null, to: a[i] });
    else out.push({ line: i + 1, from: b[i], to: null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// What must be true before any of this is worth doing.
//
// Returned as a list rather than thrown at the first one: an operator missing
// two things should be told both.
export function blockers({ conf, certPath, keyPath, sslPort = DEFAULT_SSL_PORT, httpPort }) {
  const found = [];
  const { settings } = parseConf(conf);

  if (!certPath || !keyPath) found.push('no-certificate');

  const port = String(sslPort).trim();
  if (!/^\d+(\s*,\s*\d+)*$/.test(port)) found.push('ssl-port-not-a-port');

  // Turning HTTPS on while turning HTTP off would take every existing viewer
  // off the air in the same breath. `port = 0` means HTTPS only, and this plan
  // never writes it.
  if (settings.get('port')?.value === '0') found.push('http-already-disabled');

  // The one that would be found at restart otherwise: Nimble refuses to start
  // if ssl_port collides with a port it already listens on.
  const existingHttp = settings.get('port')?.value ?? String(httpPort ?? 8081);
  if (port.split(',').map(s => s.trim()).includes(String(existingHttp).trim())) {
    found.push('ssl-port-collides-with-http-port');
  }

  // An `ssl_server { }` block sets certificates per host name, and a global
  // `ssl_certificate` beside it is a second answer to the same question. This
  // plan does not know which wins, so it stops rather than guessing.
  if (/^\s*ssl_server\s*\{/m.test(String(conf ?? ''))) found.push('ssl-server-block-present');

  return found;
}

// ---------------------------------------------------------------------------
// The plan.
//
// Shapes the agent already executes — file and command — and nothing new for
// it to learn. The undo is the backup the apply itself reports, as everywhere
// else in this project.
export function buildPlan({ conf, certPath, keyPath, sslPort = DEFAULT_SSL_PORT,
                            httpPort, protocols = 'TLSv1.2 TLSv1.3' }) {
  const found = blockers({ conf, certPath, keyPath, sslPort, httpPort });
  if (found.length) return { ok: false, blockers: found, steps: [], diff: [] };

  const changes = {
    ssl_port: String(sslPort),
    ssl_certificate: certPath,
    ssl_certificate_key: keyPath,
    ssl_http2_enabled: 'true',
    ssl_protocols: protocols,
  };
  const result = upsert(conf, changes);

  return {
    ok: true,
    blockers: [],
    unchanged: result.unchanged,
    added: result.added,
    changed: result.changed,
    diff: describeChange(conf, result.text),
    sslPort: Number(String(sslPort).split(',')[0]),
    steps: result.unchanged ? [] : [
      {
        id: 'write-nimble-conf',
        kind: 'file',
        why: 'HTTP/2 over TLS, which LL-HLS needs and which nothing else turns on',
        path: CONF_PATH,
        content: result.text,
        mode: '0644',
        // The file carries the WMSPanel credentials, so the record of this
        // step must not carry the content.
        secretContent: true,
        backup: true,
        undo: 'restore',
      },
      {
        id: 'restart-nimble',
        kind: 'command',
        why: 'Nimble reads this file once, at start',
        command: ['systemctl', 'restart', 'nimble'],
        // Restarting again after the file is restored is what actually undoes
        // this; the file step's restore alone would leave the running process
        // on the new configuration.
        undo: ['systemctl', 'restart', 'nimble'],
      },
    ],
    // Stated with the plan, because it is the cost and it is not obvious: a
    // restart drops every session on the machine.
    interruption: 'Restarting Nimble ends every playback session on this server. Seconds, not minutes — but not zero.',
  };
}

// ---------------------------------------------------------------------------
// Whether it worked, which is not the same as whether it applied.
//
// Two questions and they fail differently. TLS with HTTP/2 is a handshake, and
// `tlsProbe.js` answers it. Parts in the playlist is a fetch, and
// `playlistProbe.js` answers that. A run that got one and not the other has
// not delivered LL-HLS, and reporting success on the first alone is precisely
// the silent fallback this feature exists to prevent.
export function verdict({ tls, playlist }) {
  const missing = [];
  if (!tls?.tls) missing.push('tls');
  if (!tls?.http2) missing.push('http2');
  if (!tls?.certTrusted) missing.push('cert-trusted');
  if (!playlist?.lowLatency?.confirmed) missing.push('parts');

  return {
    ok: missing.length === 0,
    missing,
    // The distinction that matters to an operator staring at a green tick:
    // everything applied and the viewer still gets ordinary HLS.
    // A code, not a sentence. This was composed here in English and rendered
    // verbatim into a Russian interface — the same fault as the error keys,
    // one layer down: the server decided the wording and the dictionary never
    // saw it.
    silentFallback: missing.length === 1 && missing[0] === 'parts' ? 'parts-only' : null,
  };
}
