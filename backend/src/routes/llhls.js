// LL-HLS, from the operator's side.
//
// Five routes, and the shape is the one the gateway preparation already uses,
// because it is the shape that has survived contact with the fleet: show
// exactly what would be written, recompute it at apply and compare, verify by
// asking the wire rather than by reading an exit code, and keep the backup
// that makes the whole thing reversible.
//
// What is different here is that LL-HLS has two halves on two different
// systems — nimble.conf on the machine, `alhls_enabled` in WMSPanel — and
// each of them succeeds on its own while delivering nothing. So the state
// route answers about both, and the channel route refuses to pretend that
// writing one is finishing the job.

import { Router } from 'express';
import { NimbleServer } from '../models/NimbleServer.js';
import { Channel } from '../models/Channel.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { runTask } from '../services/agentBus.js';
import { probeTls } from '../services/tlsProbe.js';
import { logEvent } from '../services/audit.js';
import { privilegedEligibility } from '../services/privilegedHelper.js';
import { buildPlan, maskConf, describeChange, CONF_PATH, DEFAULT_SSL_PORT } from '../services/llhlsPlan.js';
import { parsePlaylist } from '../services/playlistProbe.js';
import { edgeState, channelPlan } from '../services/llhlsState.js';
import { capabilities, canChangeSystem, helperReported } from '../services/serverCapabilities.js';
import { buildSteps as certSteps, METHODS, inspectUploaded } from '../services/certPlan.js';
import { wmspanel } from '../services/wmspanelClient.js';
import { Settings } from '../models/Settings.js';
import { createJob, appendJob, finishJob, getJob } from '../services/sshInstaller.js';

export const llhlsRouter = Router();
llhlsRouter.use(requireAuth);

const AGENT_NEED = 30;   // the version that answers GET /nimble/conf

// Every way reading nimble.conf can fail, as codes.
//
// This list is the contract. `frontend/src/lib/confErrors.js` must handle all
// of it, and `backend/tests/error-codes.test.mjs` fails when the two disagree
// — because the alternative is what shipped: an exception's message used as a
// translation key, so a Russian interface displayed
// `llhls.confError.agent is not enabled for this server`.
//
// A message is for a human reading a log. A code is for the program deciding
// what to say. They are different things and the raw one now travels as
// `detail`, beside the code, never instead of it.
export const CONF_ERROR_CODES = [
  'agent-disabled',            // the agent is switched off for this server
  'agent-offline',             // it never picked the task up
  'agent-timeout',             // it picked it up and did not answer
  'agent-too-old',             // it answered, without knowing this route
  'nimble-conf-missing',       // no such file on the machine
  'nimble-conf-unreadable',    // there, and the agent may not read it
  'unknown',                   // anything else, with the message in `detail`
];

// Reading nimble.conf, with the one thing that must not be forgotten written
// where it happens: the raw text carries the WMSPanel credentials, so it is
// used to compute and never logged. `maskConf` is what any human sees.
async function readConf(server, user) {
  try {
    const r = await runTask(server, 'GET /nimble/conf', { createdBy: user || '' });
    if (r?.exists === false) return { error: 'nimble-conf-missing', path: r.path };
    if (r?.readable === false) return { error: 'nimble-conf-unreadable', path: r.path };
    if (typeof r?.content !== 'string') {
      // An older agent answers promptly and unhelpfully. That is a different
      // problem from a dead agent and is fixed differently.
      return { error: 'agent-too-old', need: AGENT_NEED, have: server.agent?.version ?? null };
    }
    return { content: r.content, sha256: r.sha256, secrets: r.secrets || [] };
  } catch (e) {
    // The bus attaches a code to the failures it knows. Anything else is
    // `unknown` — which is a code the interface has a sentence for, rather
    // than a sentence the interface will try to translate.
    const code = CONF_ERROR_CODES.includes(e?.code) ? e.code : 'unknown';
    return { error: code, detail: String(e?.message || e).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Where every edge stands.
llhlsRouter.get('/edges', requirePerm('servers.view'), async (req, res) => {
  const servers = await NimbleServer.find();
  const out = [];
  for (const s of servers) {
    // By purpose, decided in one place. A gateway has no Nimble to configure
    // and a processing media server has no viewers, so neither belongs here —
    // and the old filter, "not a gateway", listed all fourteen machines
    // including the ones that only transcode.
    if (!capabilities(s).llhls.applicable) continue;
    // Cheap fields only. Reading nimble.conf and probing TLS on fourteen
    // machines inside one held-open request is the pattern this project has
    // been caught by three times; the detail route does that for one machine.
    out.push(edgeState({ server: s }));
  }
  res.json({ edges: out, agentNeed: AGENT_NEED });
});

llhlsRouter.get('/edges/:id', requirePerm('servers.view'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'server-not-found', code: 'server-not-found' });

  const conf = await readConf(server, req.user?.username);
  const host = server.playbackEndpoints?.[0]?.host || server.host;

  // A probe that ran and failed is not a probe nobody made.
  //
  // This used to swallow the throw and leave `tls = null`, which the row draws
  // as `?` — the same mark it draws for "not asked". So a machine whose TLS
  // port refuses connections looked exactly like one nobody had looked at, and
  // the two are fixed differently.
  let tls = null;
  let tlsError = null;
  const sslPort = conf.content ? Number((conf.content.match(/^\s*ssl_port\s*=\s*(\d+)/m) || [])[1]) : null;
  if (sslPort) {
    try {
      // Positional, as the function is declared. Passing an object put the
      // whole object into `options.host`, node refused it, and every probe
      // this feature ever made threw before touching the network — so HTTP/2
      // was never checked once, on any machine. Every other caller in the
      // codebase gets this right; this one was written from the shape of the
      // call rather than from the function.
      tls = await probeTls(host, sslPort);
    } catch (e) {
      tlsError = String(e?.message || e).slice(0, 200);
      // Reached nothing, and say so as a reading rather than as silence.
      tls = { tls: false, http2: false, certTrusted: false, reached: false };
    }
  }

  // Being the viewer, when there is something to watch.
  //
  // Parts in the playlist is the only one of the four that says LL-HLS is
  // actually reaching anybody, and nothing was asking for it: the column was
  // permanently `?` because no code path ever fetched a playlist. It needs an
  // application and a stream, which only the operator knows, so it is asked
  // for rather than guessed.
  let playlist = null;
  let playlistError = null;
  const watch = String(req.query.stream || '').replace(/^\/+|\/+$/g, '');
  if (watch && sslPort) {
    const url = `https://${host}:${sslPort}/${watch}/playlist.m3u8`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (r.status !== 200) {
        playlistError = `HTTP ${r.status}`;
      } else {
        const master = parsePlaylist(await r.text());
        // Follow the master to its variant: the parts live there, not in the
        // list of variants, and a master with no parts says nothing either way.
        const first = master.valid && master.uris[0];
        if (first) {
          const child = await fetch(new URL(first, url).toString(),
            { signal: AbortSignal.timeout(10_000) });
          playlist = child.status === 200 ? parsePlaylist(await child.text()) : null;
          if (!playlist) playlistError = `variant HTTP ${child.status}`;
        } else {
          playlist = master.valid ? master : null;
          if (!playlist) playlistError = 'not a playlist';
        }
      }
    } catch (e) {
      playlistError = String(e?.message || e).slice(0, 200);
    }
  }

  // The certificate the wire presents, not the path in the file.
  //
  // "путь задан" was all the panel could say, because it only ever read
  // `ssl_certificate` out of nimble.conf — which says where one should be, not
  // whether one is there, covers this name, or has time left. The handshake
  // carries the real one; when the handshake fails there is nothing to read
  // and the answer stays unknown rather than becoming "none".
  const certificate = tls?.tls ? {
    validTo: tls.certExpiresAt || null,
    // `authorized` is what a player's own TLS stack decides, so this is the
    // question that matters and not whether a file exists.
    trusted: tls.certTrusted === true,
    error: tls.certError || null,
  } : null;

  const state = edgeState({ server, conf: conf.content ? conf : null, tls, playlist, certificate });
  res.json({
    ...state,
    confError: conf.error || null,
    // The raw message travels beside the code, never as one. It is useful and
    // it is not a translation key.
    confDetail: conf.detail || null,
    // Masked. The raw text exists in this process for exactly as long as it
    // takes to compute a plan from it, and never reaches a response.
    conf: conf.content ? maskConf(conf.content) : null,
    confSha: conf.sha256 || null,
    secretsPresent: conf.secrets || [],
    tlsError,
    playlistError,
    watched: watch || null,
    sslPort: sslPort || null,
  });
});

// ---------------------------------------------------------------------------
// What would be written. Nothing is.
llhlsRouter.post('/edges/:id/plan', requirePerm('servers.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'server-not-found', code: 'server-not-found' });

  const eligible = privilegedEligibility(server);
  const domain = String(req.body?.domain || '').trim().toLowerCase();
  const method = String(req.body?.certMethod || 'acme-http');
  const sslPort = Number(req.body?.sslPort) > 0 ? Number(req.body.sslPort) : DEFAULT_SSL_PORT;

  if (!METHODS[method]) return res.status(400).json({ error: 'unknown-method', code: 'unknown-method' });

  const conf = await readConf(server, req.user?.username);
  if (conf.error) {
    return res.status(422).json({ error: conf.error, code: conf.error, detail: conf.detail,
                                  need: conf.need, have: conf.have });
  }

  // An uploaded certificate is read before anything is planned around it —
  // there is no point showing a plan built on a key that belongs to a
  // different certificate.
  let uploaded = null;
  if (method === 'upload') {
    uploaded = inspectUploaded({
      certificatePem: req.body?.certificatePem, privateKeyPem: req.body?.privateKeyPem, domain,
    });
    if (!uploaded.ok) {
      return res.status(422).json({ error: 'certificate-rejected', code: 'certificate-rejected', certificate: uploaded });
    }
  }

  const cert = certSteps({
    method, domain, email: String(req.body?.email || ''),
    dnsProvider: req.body?.dnsProvider, dnsToken: req.body?.dnsToken,
    certificatePem: req.body?.certificatePem, privateKeyPem: req.body?.privateKeyPem,
    role: eligible.profile === 'gateway' ? 'gateway' : 'edge',
  });
  if (!cert.ok) return res.status(422).json({ error: 'missing-inputs', code: 'missing-inputs', missing: cert.missing });

  const transport = buildPlan({
    conf: conf.content, certPath: cert.certPath, keyPath: cert.keyPath,
    sslPort, httpPort: server.httpPort,
  });

  await logEvent(req, 'llhls.plan', { server: server.name, domain, method, sslPort });

  res.json({
    helper: { installed: helperReported(server), eligible: eligible.ok, profile: eligible.profile },
    agent: { version: server.agent?.version ?? null, need: AGENT_NEED },
    certificate: { method, ...cert, uploaded, renewalNote: cert.renewalNote },
    transport: {
      ...transport,
      // The steps carry the whole new file, credentials included. It is not
      // sent to the browser: the diff is what an operator needs, and it is
      // masked.
      steps: transport.steps.map(s => (s.kind === 'file' ? { ...s, content: undefined } : s)),
    },
    confSha: conf.sha256,
    path: CONF_PATH,
  });
});

// ---------------------------------------------------------------------------
// Do it.
//
// The plan is recomputed here and the file it was computed from is compared by
// digest. If nimble.conf moved between the preview and the press, the operator
// approved something else, and this stops.
llhlsRouter.post('/edges/:id/apply', requirePerm('servers.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'server-not-found', code: 'server-not-found' });

  // One function decides this for the button, the route and the message, so
  // they cannot disagree. Unknown blocks exactly as absent does: the screen
  // offered "write it and restart Nimble" on a machine whose helper state had
  // never been reported, and the refusal arrived after the press.
  const allowed = canChangeSystem(server);
  if (!allowed.ok) return res.status(422).json({ error: allowed.code, code: allowed.code, purpose: allowed.purpose });

  const conf = await readConf(server, req.user?.username);
  if (conf.error) return res.status(422).json({ error: conf.error, code: conf.error, detail: conf.detail });
  if (req.body?.confSha && req.body.confSha !== conf.sha256) {
    return res.status(409).json({
      error: 'configuration-changed', code: 'configuration-changed',
      detail: 'nimble.conf changed between the preview and this request. Look again before applying.',
    });
  }

  const domain = String(req.body?.domain || '').trim().toLowerCase();
  const method = String(req.body?.certMethod || 'acme-http');
  const sslPort = Number(req.body?.sslPort) > 0 ? Number(req.body.sslPort) : DEFAULT_SSL_PORT;

  const cert = certSteps({
    method, domain, email: String(req.body?.email || ''),
    dnsProvider: req.body?.dnsProvider, dnsToken: req.body?.dnsToken,
    certificatePem: req.body?.certificatePem, privateKeyPem: req.body?.privateKeyPem,
    role: allowed.profile === 'gateway' ? 'gateway' : 'edge',
  });
  if (!cert.ok) return res.status(422).json({ error: 'missing-inputs', code: 'missing-inputs', missing: cert.missing });

  const transport = buildPlan({
    conf: conf.content, certPath: cert.certPath, keyPath: cert.keyPath,
    sslPort, httpPort: server.httpPort,
  });
  if (!transport.ok) return res.status(422).json({ error: 'blocked', code: 'blocked', blockers: transport.blockers });

  const steps = [...cert.steps, ...transport.steps];
  if (!steps.length) return res.json({ applied: false, unchanged: true });

  // Started, then polled.
  //
  // This used to run inside the request. Installing certbot and issuing a
  // certificate takes minutes, and whatever proxies the panel closed the
  // connection at sixty seconds and answered 504 — while the work carried on
  // underneath and, as far as the operator could tell, vanished.
  //
  // Fourth time in this project: work measured in minutes inside a held-open
  // HTTP request. The gateway preparation had already solved it with exactly
  // this job store, one file away, and this route did not use it.
  await logEvent(req, 'llhls.apply', {
    server: server.name, domain, method, sslPort, steps: steps.map(s => s.id),
  });

  const jobId = createJob({ server: server.name, domain, kind: 'llhls' });
  appendJob(jobId, `${server.name}: ${steps.length} step(s) for ${domain}\n`);
  appendJob(jobId, `certificate: ${method}\n`);
  for (const st of steps) appendJob(jobId, `  · ${st.id} — ${st.why || ''}\n`);
  appendJob(jobId, '\n');

  // Deliberately not awaited. The response goes out now; the browser follows
  // the job.
  (async () => {
    let result = null;
    try {
      appendJob(jobId, 'sending the steps to the machine…\n');
      result = await runTask(server, 'POST /host/apply',
        { body: { steps }, timeoutMs: 15 * 60_000, createdBy: req.user?.username || '' });
      for (const st of result?.steps || []) {
        appendJob(jobId, `${st.ok ? 'ok  ' : st.skipped ? 'skip' : 'FAIL'} ${st.id}`
          + `${st.skipped ? ' — already so' : ''}${st.error ? ' — ' + st.error : ''}\n`);
      }
    } catch (e) {
      appendJob(jobId, `\nthe machine did not finish: ${String(e?.message || e)}\n`);
      return finishJob(jobId, { status: 'failed', error: String(e?.message || e).slice(0, 300),
                                code: e?.code || null });
    }

    // Verified by handshake, not by exit codes. A step that returned zero and
    // a port that answers HTTP/2 are different claims.
    let tls = null;
    appendJob(jobId, '\nchecking the wire — ALPN and the certificate a player would see…\n');
    const host = server.playbackEndpoints?.[0]?.host || server.host;
    try { tls = await probeTls(host, transport.sslPort); } catch { tls = null; }
    appendJob(jobId, tls?.http2
      ? `HTTP/2 negotiated on ${host}:${transport.sslPort}, certificate ${tls.certTrusted ? 'trusted' : 'NOT trusted by a default store'}\n`
      : `no HTTP/2 on ${host}:${transport.sslPort} — the configuration was written and Nimble is not serving it\n`);

    const ok = Boolean(result?.ok) && Boolean(tls?.http2);
    appendJob(jobId, ok
      ? '\ntransport is up. LL-HLS still needs the application half: alhls_enabled and\n'
        + 'hls_part_duration, and the input stream restarted afterwards.\n'
      : '\nnot finished. If the steps succeeded and HTTP/2 did not answer, look at\n'
        + 'nimble.log — a certificate path Nimble cannot read stops it starting the\n'
        + 'SSL listener, and it says so there and nowhere else.\n');

    finishJob(jobId, {
      status: ok ? 'done' : 'failed',
      result: { applied: true, ...result, tls, backups: result?.backups || [] },
    });
  })();

  res.json({ jobId, steps: steps.map(s => ({ id: s.id, why: s.why })) });
});

llhlsRouter.get('/edges/:id/jobs/:jobId', requirePerm('servers.manage'), (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job-not-found', code: 'job-not-found' });
  res.json(job);
});

llhlsRouter.post('/edges/:id/rollback', requirePerm('servers.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'server-not-found', code: 'server-not-found' });

  const backups = Array.isArray(req.body?.backups) ? req.body.backups : [];
  if (!backups.length) return res.status(400).json({ error: 'no-backups', code: 'no-backups' });

  await logEvent(req, 'llhls.rollback', { server: server.name, backups: backups.length });
  try {
    const result = await runTask(server, 'POST /host/rollback',
      { body: { backups }, timeoutMs: 10 * 60_000, createdBy: req.user?.username || '' });
    res.json({ rolledBack: true, result });
  } catch (e) {
    res.status(502).json({ error: 'rollback-failed', code: 'rollback-failed', detail: String(e?.message || e).slice(0, 300) });
  }
});

// ---------------------------------------------------------------------------
// The application half, for one channel.
//
// Separate route, deliberately: it writes to WMSPanel rather than to a
// machine, it interrupts a different set of people, and pretending the two are
// one button would hide which of them failed.
llhlsRouter.post('/channels/:id/plan', requirePerm('channels.manage'), async (req, res) => {
  const channel = await Channel.findById(req.params.id);
  if (!channel) return res.status(404).json({ error: 'channel-not-found', code: 'channel-not-found' });

  // Same accessor every other WMSPanel caller uses. Reassembling the shape by
  // hand is how a field gets renamed in one place and read in another.
  const cfg = (await Settings.load()).wmspanel;
  const serverId = String(req.body?.wmspanelServerId || '');
  if (!serverId) return res.status(400).json({ error: 'server-required', code: 'server-required' });

  let application = null;
  try {
    const list = await wmspanel.liveAppList(cfg, serverId);
    application = (list?.applications || []).find(a => a.application === channel.application) || null;
  } catch (e) {
    return res.status(502).json({ error: 'wmspanel-failed', code: 'wmspanel-failed', detail: String(e?.message || e).slice(0, 200) });
  }

  const plan = channelPlan({
    channel, application,
    transportReady: req.body?.transportReady ?? null,
    partMs: Number(req.body?.partMs) || 2000,
  });
  res.json({ ...plan, application: application ? { id: application.id, name: application.application,
    chunk: application.chunk_duration, protocols: application.protocols,
    alhls: application.alhls_enabled ?? null, part: application.hls_part_duration ?? null } : null });
});

llhlsRouter.post('/channels/:id/apply', requirePerm('channels.manage'), async (req, res) => {
  const channel = await Channel.findById(req.params.id);
  if (!channel) return res.status(404).json({ error: 'channel-not-found', code: 'channel-not-found' });

  const cfg = (await Settings.load()).wmspanel;
  const serverId = String(req.body?.wmspanelServerId || '');
  const appId = String(req.body?.applicationId || '');
  if (!serverId || !appId) return res.status(400).json({ error: 'server-and-application-required', code: 'server-and-application-required' });

  const partMs = Number(req.body?.partMs) || 2000;
  const body = { alhls_enabled: true, hls_part_duration: partMs };
  // The container switch is a separate consent: measured, adding HLS_FMP4
  // removes plain HLS, so it is not something to slip into a request about a
  // checkbox.
  if (req.body?.switchToFmp4 === true) {
    const protocols = Array.isArray(req.body?.protocols) ? req.body.protocols : [];
    body.protocols = [...protocols.filter(p => p !== 'HLS'), 'HLS_FMP4'];
  }

  await logEvent(req, 'llhls.channel.apply', { channel: channel.name, application: channel.application, partMs, switched: req.body?.switchToFmp4 === true });

  try {
    await wmspanel.liveAppUpdate(cfg, serverId, appId, body);
    // Accepted is not applied. Read it back before saying anything, because
    // this API has already been seen to store three of four fields sent and
    // report success.
    const back = await wmspanel.liveAppList(cfg, serverId);
    const after = (back?.applications || []).find(a => String(a.id) === appId) || null;
    const stored = after?.alhls_enabled === true && Number(after?.hls_part_duration) === partMs;
    const dropped = Array.isArray(body.protocols)
      ? body.protocols.filter(p => !(after?.protocols || []).includes(p)) : [];

    res.json({
      applied: stored,
      after: after ? { alhls: after.alhls_enabled, part: after.hls_part_duration, protocols: after.protocols } : null,
      dropped,
      // The step nothing here can do, said every time rather than once in a
      // manual: Nimble keeps packaging a running stream the way it was when it
      // started.
      next: 'Restart the input stream into this application. Until then Nimble keeps producing the old output and nothing about this change is visible to a viewer.',
    });
  } catch (e) {
    res.status(502).json({ error: 'wmspanel-failed', code: 'wmspanel-failed', detail: String(e?.message || e).slice(0, 200) });
  }
});
