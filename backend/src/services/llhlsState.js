// Is LL-HLS actually working on this edge, and if not, what is missing.
//
// Four things have to be true at once and each fails differently, which is why
// this exists as one assembled answer rather than four indicators an operator
// has to combine in their head:
//
//   1. the privileged helper is on the machine, or nothing can be written;
//   2. a certificate exists and has time left on it;
//   3. TLS answers with ALPN `h2` and a certificate a player will accept;
//   4. the playlist actually carries parts.
//
// The fourth is the one that matters and the one everything else exists to
// enable. Three out of four is not "nearly working" — a player gets ordinary
// HLS and nobody is told.
//
// Every field here is either something measured or `null` meaning not asked.
// There is no third state where the panel decided something was probably fine:
// this project has spent two weeks removing exactly that.

import { verdict } from './llhlsPlan.js';
import { profileFor } from './privilegedHelper.js';
import { helperReported } from './serverCapabilities.js';
import { PART_MIN_MS, partCeilingMs, partRangeMs, containerAdvice, expectedLatency,
         RESTART_REQUIRED_AFTER_ENABLE } from './llhls.js';

// Days of certificate left below which an operator should be told. Chosen to
// sit outside certbot's own renewal window — certbot renews at 30 days, so a
// warning at 30 would fire on every healthy machine for a month.
export const CERT_WARN_DAYS = 20;

export function edgeState({ server, conf = null, tls = null, playlist = null,
                            certificate = null, now = new Date() }) {
  const purpose = server?.purpose || 'nimble';
  const profile = profileFor(purpose);

  // 1. Can anything be written here at all.
  const helper = {
    // What the machine reported, not what the panel hopes — and read from the
    // record the helper actually writes, `helper.seen`, rather than from a
    // field nothing sets.
    installed: helperReported(server),
    // Shown beside it, because `seen` is never unset: a helper that was
    // removed still reads as installed, and the date is the only thing that
    // says otherwise.
    lastContactAt: server?.helper?.lastContactAt ?? null,
    version: server?.helper?.version || null,
    profile,
    // The edge profile is what a media server gets; a gateway asked about
    // LL-HLS is a question nobody meant to ask.
    appropriate: profile === 'edge',
  };

  // 2. The configuration, as read. `null` means the agent was not asked or
  // could not read it, which is not the same as "LL-HLS is off".
  let transport = null;
  if (conf && typeof conf.content === 'string') {
    const settings = new Map();
    for (const raw of conf.content.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      if (/^[a-z0-9_]+$/i.test(key)) settings.set(key, line.slice(eq + 1).trim());
    }
    transport = {
      sslPort: settings.get('ssl_port') ?? null,
      http2: settings.get('ssl_http2_enabled') === 'true',
      certPath: settings.get('ssl_certificate') ?? null,
      keyPath: settings.get('ssl_certificate_key') ?? null,
      httpPort: settings.get('port') ?? null,
      configured: Boolean(settings.get('ssl_port')) && settings.get('ssl_http2_enabled') === 'true'
                  && Boolean(settings.get('ssl_certificate')),
    };
  }

  // 3. The certificate, from whatever inspected it. Days are counted here so
  // that one place decides what "expiring" means.
  let cert = null;
  if (certificate) {
    const daysLeft = certificate.validTo
      ? Math.floor((new Date(certificate.validTo) - now) / 86400000)
      : null;
    cert = {
      ...certificate,
      daysLeft,
      expiring: daysLeft !== null && daysLeft <= CERT_WARN_DAYS && daysLeft >= 0,
      expired: daysLeft !== null && daysLeft < 0,
    };
  }

  // 4. The wire. `verdict` needs both the handshake and the playlist, and
  // treats a missing one as missing rather than as a pass.
  // A playlist nobody fetched is not a playlist without parts.
  //
  // `verdict` counts a missing playlist as missing parts, which is right when
  // one was fetched and wrong when none was. The row drew `✗` on every edge
  // the sweep had touched, saying "no parts" about a question nobody had
  // asked — the same conflation this file exists to prevent, one field over.
  const wire = (tls || playlist) ? verdict({ tls, playlist }) : null;
  if (wire && playlist === null) {
    wire.missing = wire.missing.filter(m => m !== 'parts');
    wire.partsUnknown = true;
    // Not ready either: three of four is not "nearly working", and an unasked
    // fourth cannot be assumed good.
    wire.ok = false;
    wire.silentFallback = null;
  }

  const blockers = [];
  if (helper.installed === false) blockers.push('helper-not-installed');
  if (helper.appropriate === false) blockers.push('not-an-edge');
  if (transport && !transport.certPath) blockers.push('no-certificate-configured');
  if (cert?.expired) blockers.push('certificate-expired');
  if (transport && !transport.http2) blockers.push('http2-off');
  if (tls && !tls.tls) blockers.push('tls-down');
  if (tls?.tls && !tls.certTrusted) blockers.push('certificate-not-trusted');

  // What has not been asked, kept apart from what has been asked and failed.
  // Conflating them is how "we have not checked this edge" became "this edge
  // cannot do LL-HLS" the first time round.
  const unknown = [];
  if (helper.installed === null) unknown.push('helper');
  if (transport === null) unknown.push('nimble-conf');
  if (cert === null) unknown.push('certificate');
  if (tls === null) unknown.push('tls');
  if (playlist === null) unknown.push('playlist');
  // A probe that ran and found nothing is an answer. It used to be handed in
  // as `null` on failure, which put it here — beside the things nobody had
  // asked about — and the two are fixed differently.
  if (tls && tls.reached === false && !blockers.includes('tls-down')) blockers.push('tls-down');

  return {
    // The id travels with the row. A list keyed on a name looks fine until two
    // machines are called the same thing, and the detail route needs an id
    // anyway.
    id: server?._id ? String(server._id) : (server?.id ?? null),
    server: server?.name ?? null,
    purpose,
    helper,
    transport,
    certificate: cert,
    wire,
    blockers,
    unknown,
    // Deliberately three-valued. `true` only when something was measured on
    // the wire and passed; `false` when something was measured and failed;
    // `null` when nobody asked.
    ready: wire ? wire.ok : null,
  };
}

// ---------------------------------------------------------------------------
// The two halves as one operation.
//
// The panel writes `alhls_enabled` and `hls_part_duration` to the application
// and `ssl_*` to nimble.conf, and neither alone produces low latency. Worse,
// each *succeeds* alone — which is the failure this project keeps finding.
//
// So the plan for a channel names both halves, what each will change, and the
// two costs that are not obvious: restarting Nimble drops every session on the
// server, and the application half does nothing at all until the input stream
// is restarted.
export function channelPlan({ channel, application, transportReady, partMs }) {
  const chunk = Number(application?.chunk_duration);
  const range = partRangeMs(chunk);
  const wanted = Number(partMs);
  const problems = [];

  if (!application) problems.push('application-not-found');
  if (!range) {
    problems.push(chunk >= 1 ? 'chunk-unreadable' : 'chunk-below-one-second');
  } else if (!Number.isFinite(wanted) || wanted < range.min || wanted > range.max) {
    problems.push('part-outside-range');
  }

  const protocols = Array.isArray(application?.protocols) ? application.protocols : [];
  const container = containerAdvice(protocols);
  if (!container.ok) problems.push('container-cannot-carry-llhls');

  // The measured behaviour, not the documented one: adding HLS_FMP4 removes
  // plain HLS rather than joining it, so this is a switch and it interrupts.
  const switchesContainer = protocols.includes('HLS') && !protocols.includes('HLS_FMP4');

  return {
    ok: problems.length === 0,
    problems,
    partRange: range,
    latency: range && Number.isFinite(wanted) ? expectedLatency(wanted) : null,
    containerNote: container.reason,
    halves: {
      application: {
        write: problems.length ? null : { alhls_enabled: true, hls_part_duration: wanted },
        // Softvelum: the input stream must be restarted or Nimble keeps
        // producing the old output. The panel cannot do this for a stream
        // somebody publishes into Nimble, so it says so instead of reporting
        // a write as a working feature.
        restartRequired: RESTART_REQUIRED_AFTER_ENABLE,
      },
      transport: {
        // Not this function's job to compose — `llhlsPlan.buildPlan` does it
        // per server — but its state belongs in the same answer, because a
        // channel with one half done is the case an operator must see.
        ready: transportReady ?? null,
      },
    },
    warnings: [
      ...(switchesContainer
        ? ['Switching to HLS_FMP4 removes plain HLS: measured, the server does not keep both. Every current viewer of this application changes container, and the change only takes effect after the input restarts.']
        : []),
      ...(range && wanted === range.min
        ? [`${PART_MIN_MS} ms is the shortest the vendor allows and costs the most bandwidth and CPU. Their recommendation at this chunk is longer.`]
        : []),
      ...(transportReady === false
        ? ['The transport half is not ready on at least one edge. Turning this on now gives a setting that applies and a viewer who sees ordinary HLS.']
        : []),
    ],
    ceiling: partCeilingMs(chunk),
  };
}
