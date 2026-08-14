import { Router } from 'express';
import { NimbleServer } from '../models/NimbleServer.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { nimble } from '../services/nimbleClient.js';
import { Settings } from '../models/Settings.js';
import { purposeChangeWarnings, readiness, PREPARE_MIN_AGENT } from '../services/hostReadiness.js';
import { runTask } from '../services/agentBus.js';
import { gatewayPlan, replacePlan } from '../services/gatewayPlan.js';
import { probeTls, tlsSummary } from '../services/tlsProbe.js';
import { createJob, appendJob, finishJob, getJob } from '../services/sshInstaller.js';
import { privilegedInstaller, privilegedEligibility } from '../services/privilegedHelper.js';
import { DeliveryNetwork } from '../models/DeliveryNetwork.js';
import { logEvent } from '../services/audit.js';
import { resolvePlaybackEndpoints, invalidatePlaybackCache } from '../services/playbackEndpoints.js';

export const serversRouter = Router();

// Keep only well-formed endpoints; ports fall back to Nimble's defaults.
const cleanEndpoints = (list) => (Array.isArray(list) ? list : [])
  .filter(e => e && String(e.host || '').trim())
  .slice(0, 20)
  .map(e => ({
    label: String(e.label || '').trim(),
    host: String(e.host).trim(),
    hlsPort: Number(e.hlsPort) > 0 ? Number(e.hlsPort) : 8081,
    rtmpPort: Number(e.rtmpPort) > 0 ? Number(e.rtmpPort) : 1935,
    ssl: Boolean(e.ssl),
  }));
serversRouter.use(requireAuth);

// Token is never returned to the UI — only a hasToken flag.
const pub = (s) => ({
  id: s.id, name: s.name, host: s.host, port: s.port, useSsl: s.useSsl,
  tags: s.tags, notes: s.notes, hasToken: Boolean(s.token), wmspanelServerId: s.wmspanelServerId || '',
  order: s.order ?? 0, httpPort: s.httpPort || 0,
  wmspanelDomains: Array.isArray(s.wmspanelDomains) ? s.wmspanelDomains : [],
  purpose: s.purpose || 'nimble',
  // Whether the privileged helper is on this machine, from the agent's own
  // health rather than from anything the panel remembers: the helper can be
  // removed with one systemctl command, and a panel that reports it from its
  // own records would keep claiming it for as long as nobody looked.
  //
  // `null` when no agent has reported yet — an unanswered question, not a
  // missing helper.
  // From the helper's own record rather than from whichever instance polled
  // last. Null when nothing has been heard at all — an unanswered question,
  // not a missing helper.
  privileged: s.helper?.seen ? true : (s.agent?.lastContactAt ? false : null),
  helper: s.helper?.seen ? {
    version: s.helper.version, lastContactAt: s.helper.lastContactAt,
  } : null,
  gateway: s.gateway?.state ? {
    domain: s.gateway.domain, mode: s.gateway.mode,
    state: s.gateway.state, at: s.gateway.at, haltedAt: s.gateway.haltedAt,
  } : null,
  httpsPort: s.httpsPort || 0,
  tls: {
    checkedAt: s.tls?.checkedAt || null, tls: Boolean(s.tls?.tls), http2: Boolean(s.tls?.http2),
    alpn: s.tls?.alpn || '', certTrusted: Boolean(s.tls?.certTrusted),
    certExpiresAt: s.tls?.certExpiresAt || null, reason: s.tls?.reason || '',
  },
  playbackEndpoints: (s.playbackEndpoints || []).map(e => ({ label: e.label || '', host: e.host, hlsPort: e.hlsPort, rtmpPort: e.rtmpPort, ssl: Boolean(e.ssl) })),
  syncedFromWmspanel: Boolean(s.syncedFromWmspanel), wmspanelStatus: s.wmspanelStatus || '', lastSyncAt: s.lastSyncAt, createdAt: s.createdAt,
  // iter20 m1 stored a resolved location and nothing ever sent it back. The
  // Resolve button worked, wrote the country, and the table it was supposed to
  // fill re-read a payload that had never carried the field — so the only
  // symptom was a button that appeared to do nothing at all. A field the panel
  // writes and does not return is invisible in exactly the way that looks like
  // a broken control.
  geo: {
    countryCode: s.geo?.countryCode || '', countryName: s.geo?.countryName || '',
    city: s.geo?.city || '',
    lat: typeof s.geo?.lat === 'number' ? s.geo.lat : null,
    lon: typeof s.geo?.lon === 'number' ? s.geo.lon : null,
    source: s.geo?.source || '', coordsSource: s.geo?.coordsSource || '',
    resolvedIp: s.geo?.resolvedIp || '', resolvedAt: s.geo?.resolvedAt || null,
    edition: s.geo?.edition || '', release: s.geo?.release || '',
  },
});

serversRouter.get('/', requirePerm('servers.view'), async (_req, res) => {
  const servers = await NimbleServer.find().sort({ order: 1, name: 1 });
  res.json(servers.map(pub));
});

serversRouter.post('/', requirePerm('servers.manage'), async (req, res) => {
  const { name, host, port = 8082, token = '', useSsl = false, tags = [], notes = '', wmspanelServerId = '', playbackEndpoints = [], httpPort = 0, httpsPort = 0, purpose = 'nimble' } = req.body || {};
  if (!name || !host) return res.status(400).json({ error: 'name and host required' });
  const server = await NimbleServer.create({ name, host, port, token, useSsl, tags, notes, wmspanelServerId, httpPort: Number(httpPort) > 0 ? Number(httpPort) : 0, httpsPort: Number(httpsPort) > 0 ? Number(httpsPort) : 0,
    purpose: ['nimble', 'nimble-cdn', 'gateway'].includes(purpose) ? purpose : 'nimble',
    playbackEndpoints: cleanEndpoints(playbackEndpoints) });
  res.status(201).json(pub(server));
});

// Persist the operator's ordering. Declared before '/:id' so "order" can never
// be parsed as a server id.
serversRouter.put('/order', requirePerm('servers.manage'), async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  await NimbleServer.bulkWrite(ids.map((id, i) => ({
    updateOne: { filter: { _id: id }, update: { $set: { order: i } } },
  })));
  logEvent({ req, action: 'servers:reorder', target: `${ids.length} server(s)`, outcome: 'ok', status: 200 });
  res.json({ ok: true });
});

serversRouter.put('/:id', requirePerm('servers.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  const { name, host, port, token, useSsl, tags, notes, wmspanelServerId, playbackEndpoints, httpPort, httpsPort, purpose } = req.body || {};
  if (name !== undefined) server.name = name;
  if (host !== undefined) server.host = host;
  if (port !== undefined) server.port = port;
  // token semantics: undefined = keep, '' = clear, string = replace
  if (token !== undefined) server.token = token;
  if (useSsl !== undefined) server.useSsl = useSsl;
  if (tags !== undefined) server.tags = tags;
  if (notes !== undefined) server.notes = notes;
  if (wmspanelServerId !== undefined) server.wmspanelServerId = String(wmspanelServerId).trim();
  if (playbackEndpoints !== undefined) server.playbackEndpoints = cleanEndpoints(playbackEndpoints);
  if (httpPort !== undefined) server.httpPort = Number(httpPort) > 0 ? Number(httpPort) : 0;
  // The TLS port the operator tells us about. Written here as well as by the
  // check, which remembers a port that answered — a field the panel writes and
  // does not accept back is the fault this whole feature was born from.
  if (httpsPort !== undefined) server.httpsPort = Number(httpsPort) > 0 ? Number(httpsPort) : 0;
  // Changing what a machine is for. Blocked while a media server is running on
  // it: something is serving video, and that is not a field edit.
  if (purpose !== undefined && purpose !== server.purpose) {
    const warnings = purposeChangeWarnings(server.purpose, purpose, {
      nimbleRunning: server.lastReadiness?.['nimble-running'] ?? null,
    });
    if (warnings.some(w => w.severity === 'block')) {
      return res.status(422).json({ error: 'purpose-change-blocked', code: 'purpose-change-blocked', warnings });
    }
    server.purpose = purpose;
  }
  await server.save();
  // Any of host / mapping / ports invalidates a resolved playback answer.
  invalidatePlaybackCache(server.id);
  res.json(pub(server));
});

// iter9 m2 — resolved playback endpoints. Answers "where can this server's
// streams be watched", deriving hosts and the RTMP port from WMSPanel rather
// than requiring an operator to type them in for every box. Costs up to 2
// upstream calls, cached for 10 minutes; ?fresh=1 forces a re-read.
serversRouter.get('/:id/playback', requirePerm('streams.view'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  const s = await Settings.load();
  const cfg = s.controlPlane === 'wmspanel' && s.wmspanel?.clientId ? s.wmspanel : null;
  try {
    res.json(await resolvePlaybackEndpoints(server, cfg, { fresh: req.query.fresh === '1' }));
  } catch (e) {
    res.status(502).json({ error: e.message, endpoints: [], source: 'none', notes: ['resolveFailed'] });
  }
});

serversRouter.delete('/:id', requirePerm('servers.manage'), async (req, res) => {
  const server = await NimbleServer.findByIdAndDelete(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// Connectivity test — hits /manage/server_status (native API; backup mode only).
serversRouter.post('/:id/test', requirePerm('servers.view'), async (req, res) => {
  const settings = await Settings.load();
  if (settings.controlPlane === 'wmspanel') {
    return res.status(409).json({ error: 'Native API test is disabled: control plane is WMSPanel API' });
  }
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  try {
    const status = await nimble.serverStatus(server);
    res.json({ ok: true, status });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});


// What this machine has, for the job it has been given.
//
// A read, and only a read: the agent's endpoint installs nothing. Stored so
// the agents page can show a fleet at a glance without asking every machine
// on every render.
serversRouter.post('/:id/readiness', requirePerm('servers.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'server-not-found', code: 'server-not-found' });

  let report = null;
  try {
    // Through the agent bus like every other agent call: the panel does not
    // dial a box that has an agent, and a second way of reaching one would be
    // a second set of rules about when it is allowed to.
    report = await runTask(server, 'GET /host/readiness', { createdBy: req.user?.username || '' });
  } catch {
    // An agent that cannot be asked is not a machine that lacks things. The
    // readiness function is given no report and says which of the two it is.
    report = null;
  }
  const r = readiness({
    purpose: server.purpose || 'nimble',
    report,
    agentVersion: report?.agent ?? server.agent?.version ?? 0,
  });
  if (report) {
    server.lastReadiness = report;
    server.lastReadinessAt = new Date();
    await server.save();
  }
  await logEvent(req, 'server.readiness', { server: server.name, purpose: server.purpose, code: r.code });
  res.json({ ...r, at: server.lastReadinessAt, minAgent: PREPARE_MIN_AGENT });
});


// What would be done to turn this machine into a gateway.
//
// A preview and nothing else: no package manager runs, no file is written.
// The apply path — which does not exist yet — will execute these very objects
// rather than recomputing them, because a preview computed separately from the
// work is a preview that drifts, and the drift is invisible until the day it
// matters.
serversRouter.post('/:id/gateway/plan', requirePerm('servers.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'server-not-found', code: 'server-not-found' });

  // Asked, never guessed. The certificate is issued for this name and nothing
  // else, and a name the panel invented would produce a certificate nobody can
  // use — after burning one of a rate-limited number of issuances.
  const domain = String(req.body?.domain || '').trim().toLowerCase();
  const mode = req.body?.mode === 'proxy' ? 'proxy' : 'redirect';

  // Who holds 80 and 443, from the machine itself. Asked every time rather
  // than remembered: something can start listening between a plan and an
  // apply, and this is the check whose staleness breaks a service.
  let ports = null;
  let portsError = null;
  try {
    const r = await runTask(server, 'GET /host/ports', { createdBy: req.user?.username || '' });
    ports = r?.ports || null;
    // A result with no ports is not the same as no result. An older agent
    // answers "unknown endpoint" perfectly promptly, and reporting that as
    // "the agent did not answer" sends the operator to check a network that
    // is fine.
    if (!ports) portsError = r?.error || 'the agent answered without port information';
  } catch (e) {
    portsError = String(e?.message || e).slice(0, 200);
  }

  // The edges this gateway would send viewers to, for proxy mode.
  const nets = await DeliveryNetwork.find({ 'nodes.server': server._id });
  const all = await NimbleServer.find();
  const byId = new Map(all.map(x => [String(x._id), x]));
  const edges = nets.flatMap(n => (n.nodes || [])
    .filter(x => x.role === 'edge' && x.enabled !== false)
    .map(x => byId.get(String(x.server)))
    .filter(Boolean)
    .map(x => ({ host: x.playbackEndpoints?.[0]?.host || x.host, httpPort: x.httpPort || 8081 })));

  const plan = gatewayPlan({ server, domain, mode, edges, ports, email: String(req.body?.email || '') });
  const held = plan.blocking.find(b => b.code === 'ports-held')?.held || [];

  await logEvent(req, 'server.gateway.plan', { server: server.name, domain, mode, blocked: plan.blocking.length });
  res.json({
    ...plan,
    ports,
    // Offered separately and only when needed: stopping somebody else's
    // service is the one destructive thing here and gets its own consent
    // rather than riding along inside a longer list.
    replace: held.length ? replacePlan(held) : [],
    // Why the ports are unknown, when they are. "Not checked" without a
    // reason is a dead end: the operator cannot tell an old agent from a dead
    // one, and the two are fixed differently.
    portsError,
    agent: { version: server.agent?.version ?? null, need: 22 },
  });
});


// Do it.
//
// The first thing the panel does that changes a machine. What makes that
// acceptable is not care in this function — it is that the plan was computed
// once, shown, and is now recomputed here and compared: if the machine moved
// between the preview and the press, the operator approved something else.
serversRouter.post('/:id/gateway/apply', requirePerm('servers.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'server-not-found', code: 'server-not-found' });
  if ((server.agent?.version ?? 0) < 23) {
    return res.status(422).json({ error: 'agent-too-old', code: 'agent-too-old', need: 23, have: server.agent?.version ?? null });
  }

  const domain = String(req.body?.domain || '').trim().toLowerCase();
  const mode = req.body?.mode === 'proxy' ? 'proxy' : 'redirect';

  // Ports are re-read, not remembered. Something can start listening between a
  // plan and a press, and this is precisely the check whose staleness breaks
  // somebody else's service.
  let ports = null;
  try { ports = (await runTask(server, 'GET /host/ports', { createdBy: req.user?.username || '' }))?.ports || null; }
  catch { ports = null; }

  const nets = await DeliveryNetwork.find({ 'nodes.server': server._id });
  const all = await NimbleServer.find();
  const byId = new Map(all.map(x => [String(x._id), x]));
  const edges = nets.flatMap(n => (n.nodes || [])
    .filter(x => x.role === 'edge' && x.enabled !== false)
    .map(x => byId.get(String(x.server))).filter(Boolean)
    .map(x => ({ host: x.playbackEndpoints?.[0]?.host || x.host, httpPort: x.httpPort || 8081 })));

  const plan = gatewayPlan({ server, domain, mode, edges, ports, email: String(req.body?.email || '') });
  if (plan.blocking.length) {
    return res.status(422).json({ error: 'gateway-blocked', code: 'gateway-blocked', ...plan });
  }

  // Can the domain be proved at all, asked from the machine before certbot
  // spends an attempt on it.
  //
  // Let's Encrypt rate-limits failures, and "some challenges have failed" with
  // the reason in a log file on a box nobody is sitting at is the least useful
  // sentence in this whole flow. Each of these answers has a different fix.
  let acme = null;
  let acmeSkipped = null;
  try {
    acme = await runTask(server, 'POST /host/acme-precheck', {
      body: { domain }, timeoutMs: 30_000, createdBy: req.user?.username || '',
    });
  } catch (e) {
    // Why it could not be asked, kept rather than swallowed. A precheck that
    // silently does not happen is worse than none: it leaves the operator
    // believing the domain was verified and certbot the only thing that
    // disagreed. An agent below v25 has no such endpoint, which is a fact
    // about the fleet and not about the domain.
    acme = null;
    acmeSkipped = (server.helper?.version ?? 0) < 25
      ? { code: 'agent-too-old', have: server.helper?.version ?? null, need: 25 }
      : { code: 'precheck-failed', detail: String(e?.message || e).slice(0, 200) };
  }
  // Anything other than a clear pass. `=== false` let an undefined through,
  // and undefined is what a probe that could not run produced — so a check
  // that did not happen read as a check that found nothing wrong. The same
  // conflation as everywhere else in this project, made by me, in the code
  // written to prevent it.
  // The same file, fetched from here. The machine's own answer covers its
  // config and its local firewall; this covers the leg from another network,
  // which is what Let's Encrypt actually uses. Neither of us is Let's Encrypt,
  // but a machine that answers itself and not the panel is a machine behind a
  // closed inbound port — and that was passing the precheck while certbot
  // failed on it.
  if (acme?.token) {
    try {
      const r = await fetch(`http://${domain}/.well-known/acme-challenge/${acme.token}`,
                            { signal: AbortSignal.timeout(8000), redirect: 'follow' });
      const text = await r.text();
      acme.fromPanel = { status: r.status, served: r.status === 200 && text.trim() === acme.token };
    } catch (e) {
      acme.fromPanel = { status: null, served: false, error: String(e?.message || e).slice(0, 160) };
    }
  }

  if (acme && (acme.challengeServed !== true || acme.fromPanel?.served === false)) {
    return res.status(422).json({
      error: 'acme-would-fail', code: 'acme-would-fail', acme,
      // Named rather than left to be read off the fields: the operator needs
      // to know which of four things to go and change.
      reason: acme.resolves === null ? 'dns-missing'
            : acme.pointsHere === false ? 'dns-elsewhere'
            : acme.challengeError ? 'unreachable'
            // The machine reaches itself and the panel does not: inbound is
            // blocked somewhere between them, which is exactly the leg Let's
            // Encrypt has to cross.
            : (acme.challengeServed === true && acme.fromPanel?.served === false) ? 'closed-from-outside'
            : 'not-served',
    });
  }

  // The steps the operator saw, by their ids. Sending anything the plan did
  // not produce would make this a remote shell with extra ceremony.
  const wanted = new Set((req.body?.stepIds || plan.steps.map(s => s.id)));
  const steps = plan.steps.filter(s => wanted.has(s.id));

  // Answered immediately, then polled.
  //
  // Installing nginx and issuing a certificate takes minutes, and an HTTP
  // request held open that long is at the mercy of whatever sits in front of
  // the panel — which returned 504 while the work carried on to completion
  // underneath. The install flow solved this with a job long ago; this one was
  // written synchronously and should not have been.
  if (req.body?.async !== false) {
    const jobId = createJob({ server: server.name, domain, mode });
    appendJob(jobId, `preparing ${server.name} as a ${mode} gateway for ${domain}\n`);
    if (acmeSkipped) {
      // Said before the steps rather than after the failure, because the
      // operator can still stop and update the helper. It silently did not
      // happen once, and certbot failed with the sentence this exists to
      // replace.
      appendJob(jobId, acmeSkipped.code === 'agent-too-old'
        ? `note: the domain was not pre-checked — the privileged helper is v${acmeSkipped.have ?? '?'}`
          + ` and v${acmeSkipped.need} is needed. Reinstall it to have this checked before certbot runs.\n`
        : `note: the domain could not be pre-checked — ${acmeSkipped.detail}\n`);
    } else if (acme?.challengeServed) {
      appendJob(jobId, 'the domain answers its own challenge — certbot should succeed\n');
    }
    (async () => {
      try {
        const r = await runTask(server, 'POST /host/apply', {
          body: { steps }, timeoutMs: 15 * 60_000, createdBy: req.user?.username || '',
        });
        for (const st of r?.steps || []) {
          appendJob(jobId, `${st.ok ? 'ok  ' : 'FAIL'} ${st.id}${st.error ? ' — ' + st.error : ''}\n`);
        }
        let verify = null;
        if (r?.ok) {
          verify = await probeTls(domain, 443).catch(() => null);
          if (verify) { server.tls = tlsSummary(verify); server.httpsPort = 443; }
          server.purpose = 'gateway';
        }
        const sandboxed = (r?.steps || []).some(x => x.sandboxed);
        server.gateway = {
          domain, mode, at: new Date(),
          state: r?.ok ? 'applied' : sandboxed ? 'refused-by-sandbox' : 'failed',
          haltedAt: r?.halted || null,
        };
        await server.save().catch(() => { /* the machine is done either way */ });
        finishJob(jobId, { status: r?.ok ? 'done' : 'failed', result: { ...r, verify, sandboxed } });
      } catch (e) {
        appendJob(jobId, `${String(e?.message || e)}\n`);
        finishJob(jobId, { status: 'failed', error: String(e?.message || e), code: e?.code || null });
      }
    })();
    return res.status(202).json({ jobId, plan });
  }

  let result;
  try {
    result = await runTask(server, 'POST /host/apply', { body: { steps }, timeoutMs: 15 * 60_000,
                                                    createdBy: req.user?.username || '' });
  } catch (e) {
    await logEvent(req, 'server.gateway.apply', { server: server.name, domain, ok: false });
    // The reason, not just the fact. "apply-failed" on its own sent us looking
    // in the wrong place for an afternoon; the message underneath said exactly
    // what was wrong.
    return res.status(e?.status === 409 ? 409 : 502).json({
      error: 'apply-failed',
      code: e?.code || 'apply-failed',
      detail: String(e?.message || e),
    });
  }

  // Verified by being a client, not by exit codes. Every step can return zero
  // and the machine still not serve — the same rule as delivery, and the
  // reason the panel checks playlists rather than configurations.
  let verify = null;
  // Whether this machine has been prepared, and as what. Without it an
  // operator looking at a list of servers cannot tell a gateway that is
  // serving from one that was created five minutes ago and never touched —
  // which is the state the panel leaves them in for as long as it stays
  // silent.
  const sandboxed = (result?.steps || []).some(x => x.sandboxed);
  server.gateway = {
    domain, mode,
    at: new Date(),
    state: result?.ok ? 'applied' : sandboxed ? 'refused-by-sandbox' : 'failed',
    haltedAt: result?.halted || null,
  };

  if (result?.ok) {
    verify = await probeTls(domain, 443).catch(() => null);
    if (verify) {
      server.tls = tlsSummary(verify);
      server.httpsPort = 443;
    }
    server.purpose = 'gateway';
  }
  // Saved either way: a failed attempt is a fact about this machine too, and
  // forgetting it is how the same wall is walked into twice.
  await server.save();

  await logEvent(req, 'server.gateway.apply', {
    server: server.name, domain, mode, ok: Boolean(result?.ok), halted: result?.halted || null,
    tls: Boolean(verify?.tls), http2: Boolean(verify?.http2),
  });
  res.json({ ...result, verify, plan, gateway: server.gateway, sandboxed });
});

// Put it back.
serversRouter.post('/:id/gateway/rollback', requirePerm('servers.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'server-not-found', code: 'server-not-found' });

  // Built from what the apply reported, not from the plan: only steps that
  // actually ran need undoing, and only the backups it actually made can be
  // restored.
  const applied = Array.isArray(req.body?.steps) ? req.body.steps : [];
  const plan = gatewayPlan({ server, domain: String(req.body?.domain || 'x.invalid'), ports: { 80: { taken: false }, 443: { taken: false } } });
  const byId = new Map(plan.steps.map(s => [s.id, s]));

  const undo = applied.filter(a => a.ok).map((a) => {
    const step = byId.get(a.id);
    if (a.backup && step?.undo === 'restore') return { id: a.id, path: step.path, restore: a.backup };
    if (Array.isArray(step?.undo)) return { id: a.id, command: step.undo };
    return { id: a.id };
  });

  const result = await runTask(server, 'POST /host/rollback', { body: { steps: undo }, timeoutMs: 10 * 60_000,
                                                           createdBy: req.user?.username || '' })
    .catch(e => ({ steps: [], error: String(e?.message || e) }));
  await logEvent(req, 'server.gateway.rollback', { server: server.name, steps: undo.length });
  res.json(result);
});


// The installer for the privileged helper, as a script to read and run.
//
// Handed over rather than executed: installing something that runs as root is
// a decision made by a person on a machine, not a consequence of pressing a
// button in a browser. The panel composes it, shows it, and stays out of the
// way — which also means an operator who does not like what it says can
// simply not run it.
serversRouter.post('/:id/privileged/script', requirePerm('servers.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'server-not-found', code: 'server-not-found' });

  const eligible = privilegedEligibility(server);
  if (!eligible.ok) {
    return res.status(422).json({ error: eligible.code, code: eligible.code, purpose: eligible.purpose });
  }

  const panelUrl = String(req.body?.panelUrl || '').trim() || `${req.protocol}://${req.get('host')}`;
  const script = privilegedInstaller({ panelUrl, token: server.agent?.token || '' });

  // Recorded because it is the moment a machine gained the ability to be
  // changed remotely, and that is worth being able to find later.
  await logEvent(req, 'server.privileged.script', { server: server.name, purpose: server.purpose });
  res.json({ script, port: 8091 });
});


// How a gateway preparation is going. Polled, because the work takes minutes
// and a request held open that long is at the mercy of whatever proxies the
// panel.
serversRouter.get('/:id/gateway/jobs/:jobId', requirePerm('servers.manage'), (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job-not-found', code: 'job-not-found' });
  res.json(job);
});


// Stop what is holding the ports.
//
// I built this plan in iter23 and did not wire a button to it, on the grounds
// that stopping somebody else's service should not happen behind a Next
// button. That was my judgement substituted for the operator's, and the
// operator had already asked for the choice.
//
// So it is here, and what keeps it safe is that it is explicit rather than
// absent: a separate call, naming each process, after the plan has shown who
// they are. Nobody reaches it without having read the list.
serversRouter.post('/:id/gateway/free-ports', requirePerm('servers.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'server-not-found', code: 'server-not-found' });

  // Re-read, never taken from the request. The list the operator saw is a
  // minute old at best, and stopping a pid from a stale list can stop
  // something that started since.
  let ports = null;
  try { ports = (await runTask(server, 'GET /host/ports', { createdBy: req.user?.username || '' }))?.ports || null; }
  catch (e) { return res.status(502).json({ error: 'ports-unreadable', code: 'ports-unreadable', detail: String(e?.message || e) }); }
  if (!ports) return res.status(502).json({ error: 'ports-unreadable', code: 'ports-unreadable' });

  const plan = gatewayPlan({ server, domain: String(req.body?.domain || 'x.invalid'), ports });
  const held = plan.blocking.find(b => b.code === 'ports-held')?.held || [];
  if (!held.length) return res.json({ ok: true, stopped: [], note: 'nothing is holding the ports now' });

  // Only what the operator confirmed, matched by pid: a list that has changed
  // since they looked is a list they did not agree to.
  const confirmed = new Set((req.body?.pids || []).map(Number));
  const steps = replacePlan(held).filter(s2 => confirmed.has(Number(/stop-(\d+)/.exec(s2.id)?.[1])));
  if (!steps.length) {
    return res.status(422).json({ error: 'nothing-confirmed', code: 'nothing-confirmed', held });
  }

  const result = await runTask(server, 'POST /host/apply', {
    body: { steps }, timeoutMs: 60_000, createdBy: req.user?.username || '',
  }).catch(e => ({ ok: false, steps: [{ id: 'stop', ok: false, error: String(e?.message || e) }] }));

  await logEvent(req, 'server.gateway.free-ports', {
    server: server.name,
    stopped: steps.map(s2 => s2.why),
    irreversible: steps.filter(s2 => !s2.reversible).map(s2 => s2.why),
  });
  res.json(result);
});
