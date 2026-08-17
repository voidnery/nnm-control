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
import { edgeState, channelPlan } from '../services/llhlsState.js';
import { buildSteps as certSteps, METHODS, inspectUploaded } from '../services/certPlan.js';
import { wmspanel } from '../services/wmspanelClient.js';
import { Settings } from '../models/Settings.js';

export const llhlsRouter = Router();
llhlsRouter.use(requireAuth);

const AGENT_NEED = 30;   // the version that answers GET /nimble/conf

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
    return { error: String(e?.message || e).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Where every edge stands.
llhlsRouter.get('/edges', requirePerm('servers.view'), async (req, res) => {
  const servers = await NimbleServer.find();
  const out = [];
  for (const s of servers) {
    if ((s.purpose || 'nimble') === 'gateway') continue;
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

  let tls = null;
  const sslPort = conf.content ? Number((conf.content.match(/^\s*ssl_port\s*=\s*(\d+)/m) || [])[1]) : null;
  if (sslPort) {
    try { tls = await probeTls({ host, port: sslPort }); }
    catch { tls = null; }
  }

  const state = edgeState({ server, conf: conf.content ? conf : null, tls });
  res.json({
    ...state,
    confError: conf.error || null,
    // Masked. The raw text exists in this process for exactly as long as it
    // takes to compute a plan from it, and never reaches a response.
    conf: conf.content ? maskConf(conf.content) : null,
    confSha: conf.sha256 || null,
    secretsPresent: conf.secrets || [],
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
    return res.status(422).json({ error: conf.error, code: conf.error, need: conf.need, have: conf.have });
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
    helper: { installed: server.agent?.privileged ?? null, eligible: eligible.ok, profile: eligible.profile },
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

  const eligible = privilegedEligibility(server);
  if (!eligible.ok) return res.status(422).json({ error: eligible.code, code: eligible.code });
  if (!server.agent?.privileged) {
    return res.status(422).json({ error: 'helper-not-installed', code: 'helper-not-installed' });
  }

  const conf = await readConf(server, req.user?.username);
  if (conf.error) return res.status(422).json({ error: conf.error, code: conf.error });
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
    role: eligible.profile === 'gateway' ? 'gateway' : 'edge',
  });
  if (!cert.ok) return res.status(422).json({ error: 'missing-inputs', code: 'missing-inputs', missing: cert.missing });

  const transport = buildPlan({
    conf: conf.content, certPath: cert.certPath, keyPath: cert.keyPath,
    sslPort, httpPort: server.httpPort,
  });
  if (!transport.ok) return res.status(422).json({ error: 'blocked', code: 'blocked', blockers: transport.blockers });

  const steps = [...cert.steps, ...transport.steps];
  if (!steps.length) return res.json({ applied: false, unchanged: true });

  // The certificate first, because the configuration points at files that have
  // to exist: Nimble refuses to start with an ssl_certificate that is not
  // there, and this order is why the restart is the last step rather than a
  // second outage.
  await logEvent(req, 'llhls.apply', {
    server: server.name, domain, method, sslPort,
    steps: steps.map(s => s.id),
  });

  let result;
  try {
    result = await runTask(server, 'POST /host/apply',
      { body: { steps }, timeoutMs: 15 * 60_000, createdBy: req.user?.username || '' });
  } catch (e) {
    return res.status(502).json({ error: 'apply-failed', code: 'apply-failed', detail: String(e?.message || e).slice(0, 300) });
  }

  // Verified by handshake, not by exit codes. A step that returned zero and a
  // port that answers HTTP/2 are different claims.
  let tls = null;
  const host = server.playbackEndpoints?.[0]?.host || server.host;
  try { tls = await probeTls({ host, port: transport.sslPort }); } catch { tls = null; }

  res.json({
    applied: true,
    result,
    tls,
    // Said in the same breath as the success, because it is the difference
    // between this working and this looking like it works.
    next: tls?.http2
      ? 'Transport is up. LL-HLS still needs the application half: alhls_enabled and hls_part_duration, and the input stream restarted afterwards.'
      : 'The configuration was written but HTTP/2 did not answer. Check nimble.log — a certificate path Nimble cannot read stops it from starting the SSL listener.',
    backups: result?.backups || [],
  });
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
