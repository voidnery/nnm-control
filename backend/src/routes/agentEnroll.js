import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NimbleServer } from '../models/NimbleServer.js';
import { AgentEnrollment, hashTicket, newTicket } from '../models/AgentEnrollment.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import crypto from 'node:crypto';
import { installScript } from '../services/agentInstaller.js';
import { probeHostKey, runOverSsh, createJob, appendJob, finishJob, getJob } from '../services/sshInstaller.js';
import { logEvent } from '../services/audit.js';

// iter11 m1 — agent installation by one-time ticket.
//
// Two of these routes are UNAUTHENTICATED, because the machine running the
// installer has no panel account and cannot get one. They are safe only
// because the ticket itself is the entire authority: single-use, expiring,
// bound to one server, and accepted nowhere else. Everything that issues or
// inspects a ticket sits behind normal permissions.
export const agentEnrollRouter = Router();

const TTL_MIN = 30;
// The agent source has to be INSIDE the backend's own tree. Reaching up to
// agent/ meant the api image could only be built from the repository root,
// which broke every existing build command — see docs/iter11-agent-install.md.
// src/assets/ is a vendored copy of agent/nnm-agent.mjs, kept byte-identical
// by `npm run audit:agent-sync`.
const AGENT_SRC = path.resolve(fileURLToPath(new URL('../assets/nnm-agent.mjs', import.meta.url)));

// A ticket is 32 random bytes, so brute force is not the threat — but an
// unauthenticated endpoint with no ceiling is a free amplifier for anyone who
// finds it. Small, in-memory, per-IP; the panel is a single process.
const hits = new Map();
function rateLimit(req, res, next) {
  const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '?').trim();
  const now = Date.now();
  const rec = hits.get(ip) || { n: 0, until: now + 60_000 };
  if (now > rec.until) { rec.n = 0; rec.until = now + 60_000; }
  rec.n++;
  hits.set(ip, rec);
  if (hits.size > 5000) hits.clear();          // crude, bounded, good enough
  if (rec.n > 30) return res.status(429).json({ error: 'too many attempts' });
  next();
}

const clientIp = (req) =>
  (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '').trim();

// One generator used by both the issue path (to hash) and the fetch path (to
// serve), so the published checksum is always the checksum of what is served.
//
// This and sha256 below were deleted by accident during the iter12 m5 cleanup
// of the pull path, while their three call sites stayed. The result was a
// ReferenceError inside an async route, which Node turns into an unhandled
// rejection and a process exit — a 502 and a restarted panel.
function scriptFor(doc, rawTicket) {
  return installScript({
    panelUrl: doc.panelUrl,
    ticket: rawTicket,
    agentPort: doc.agentPort,
    bind: doc.bind,
    logDir: doc.logDir,
    confDir: doc.confDir,
    mediaDir: doc.mediaDir,
  });
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

async function findLive(rawTicket) {
  if (!rawTicket || !/^[0-9a-f]{64}$/.test(rawTicket)) return null;
  const doc = await AgentEnrollment.findOne({ tokenHash: hashTicket(rawTicket) });
  if (!doc) return null;
  if (doc.status === 'enrolled' || doc.status === 'revoked') return null;
  if (doc.expiresAt.getTime() < Date.now()) return null;
  return doc;
}

// ---------------------------------------------------------------- public ---

// The installer, generated for this ticket. Fetching does not consume it: a
// half-finished install has to be re-runnable without a new ticket.
agentEnrollRouter.get('/agents/install/:ticket', rateLimit, async (req, res) => {
  const doc = await findLive(req.params.ticket);
  if (!doc) return res.status(404).type('text/plain').send('# ticket is unknown, already used, revoked or expired\n');
  if (doc.status === 'pending') {
    doc.status = 'fetched';
    doc.fetchedAt = new Date();
    doc.fetchedFrom = clientIp(req);
    await doc.save();
  }
  res.type('text/plain').send(scriptFor(doc, req.params.ticket));
});

// The agent binary itself, behind the same ticket so it is not an anonymous
// download from an authenticated panel.
agentEnrollRouter.get('/agents/install/:ticket/nnm-agent.mjs', rateLimit, async (req, res) => {
  if (!(await findLive(req.params.ticket))) return res.status(404).type('text/plain').send('# invalid ticket\n');
  try {
    res.type('text/plain').send(await fs.readFile(AGENT_SRC, 'utf8'));
  } catch {
    res.status(500).type('text/plain').send('# agent source is not bundled in this deployment\n');
  }
});

// The box reports the token it generated for itself. This is the only route
// that will ever write an agent credential without a logged-in operator, and
// it consumes the ticket doing so.
agentEnrollRouter.post('/agents/enroll', rateLimit, async (req, res) => {
  const { ticket, agentToken, hostname, agentVersion } = req.body || {};
  const doc = await findLive(ticket);
  if (!doc) {
    logEvent({ req, action: 'agent:enroll', target: 'unknown ticket', outcome: 'error', status: 404 });
    return res.status(404).json({ error: 'ticket is unknown, already used, revoked or expired' });
  }
  if (!agentToken || String(agentToken).length < 24) {
    return res.status(400).json({ error: 'agentToken missing or too short' });
  }
  const server = await NimbleServer.findById(doc.serverId);
  if (!server) return res.status(410).json({ error: 'the server this ticket was issued for no longer exists' });

  // iter12 m5 — no address is recorded, because none is needed. From here the
  // agent calls in; the panel never dials out. That is what makes this work on
  // a machine with no inbound route at all.
  server.agent.enabled = true;
  server.agent.token = String(agentToken);
  await server.save();

  doc.status = 'enrolled';
  doc.enrolledAt = new Date();
  doc.enrolledFrom = clientIp(req);
  doc.reportedHostname = String(hostname || '');
  doc.reportedVersion = Number(agentVersion) || 0;
  await doc.save();

  logEvent({
    req, username: `enroll:${doc.createdBy}`, action: 'agent:enroll', target: server.name,
    detail: { hostname: doc.reportedHostname, agentVersion: doc.reportedVersion },
    outcome: 'ok', status: 200,
  });
  // iter12 m1 — the agent needs to know which server it is before it can
  // poll, and the panel is the only one who knows. Handing it back here is
  // what closes the loop: from this point the agent connects to us and no
  // address of its own is ever needed.
  res.json({ ok: true, server: server.name, serverId: String(server._id), panelUrl: doc.panelUrl });
});

// ----------------------------------------------------------- authenticated ---

// Each authenticated route names its own middleware. The previous shape —
// a sub-router with `use(requireAuth)` mounted at '/' — ran requireAuth, and
// therefore an extra user lookup, on every /api request that fell through to
// it, and answered 401 for paths belonging to routers mounted later.
agentEnrollRouter.post('/servers/:id/agent/enrollment', requireAuth, requirePerm('servers.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  // One live ticket per server: two outstanding tickets for one box is a way
  // to enrol the wrong agent and never notice.
  await AgentEnrollment.updateMany(
    { serverId: server._id, status: { $in: ['pending', 'fetched'] } },
    { $set: { status: 'revoked' } },
  );

  const raw = newTicket();
  const b = req.body || {};
  const port = Number(b.agentPort) > 0 ? Number(b.agentPort) : 8090;
  // The operator can override how the server should reach us. They have to be
  // able to: the address this request arrived on may be a public name whose
  // certificate does not match, or one the servers cannot resolve at all.
  const panelUrl = String(b.panelUrl || `${req.protocol}://${req.get('host')}`).trim().replace(/\/+$/, '');
  const doc = await AgentEnrollment.create({
    panelUrl,
    serverId: server._id,
    tokenHash: hashTicket(raw),
    agentPort: port,
    bind: String(b.bind || '0.0.0.0'),
    logDir: String(b.logDir || '/var/log/nimble'),
    confDir: String(b.confDir || '/srv/nimble/conf'),
    mediaDir: String(b.mediaDir || '/srv/nimble/media/gallery'),
    expiresAt: new Date(Date.now() + TTL_MIN * 60_000),
    createdBy: req.user?.username || '',
  });

  const url = `${panelUrl}/api/agents/install/${raw}`;
  const digest = sha256(scriptFor(doc, raw));

  logEvent({ req, action: 'agent:enrollment-issued', target: server.name, outcome: 'ok', status: 200 });
  res.json({
    ticket: raw,                       // shown once; only its hash is stored
    expiresAt: doc.expiresAt,
    panelUrl,
    scriptUrl: url,
    scriptSha256: digest,
    // The convenient form.
    command: `curl -fsSL ${url} | sudo sh -s`,
    // The form to prefer: a script about to run as root should be checked
    // against a digest the operator got over a different channel — this one,
    // through the browser — rather than trusted because the download worked.
    safeCommand: [
      `curl -fsSL ${url} -o /tmp/nnm-install.sh \\`,
      `  && echo "${digest}  /tmp/nnm-install.sh" | sha256sum -c - \\`,
      `  && sudo sh /tmp/nnm-install.sh`,
    ].join('\n'),
    // Only one warning survives: the agent's token crosses this link at
    // enrollment. The panel's address being private is no longer a problem —
    // the server has to reach the panel, and that is the only direction.
    warnings: panelUrl.startsWith('https://') ? [] : ['panelNotHttps'],
  });
});

agentEnrollRouter.get('/servers/:id/agent/enrollment', requireAuth, requirePerm('servers.view'), async (req, res) => {
  const doc = await AgentEnrollment.findOne({ serverId: req.params.id }).sort({ createdAt: -1 }).lean();
  if (!doc) return res.json({ enrollment: null });
  res.json({
    enrollment: {
      status: doc.expiresAt.getTime() < Date.now() && doc.status !== 'enrolled' ? 'expired' : doc.status,
      expiresAt: doc.expiresAt,
      createdBy: doc.createdBy,
      fetchedAt: doc.fetchedAt, fetchedFrom: doc.fetchedFrom,
      enrolledAt: doc.enrolledAt, enrolledFrom: doc.enrolledFrom,
      reportedHostname: doc.reportedHostname, reportedVersion: doc.reportedVersion,
    },
  });
});

agentEnrollRouter.delete('/servers/:id/agent/enrollment', requireAuth, requirePerm('servers.manage'), async (req, res) => {
  await AgentEnrollment.updateMany(
    { serverId: req.params.id, status: { $in: ['pending', 'fetched'] } },
    { $set: { status: 'revoked' } },
  );
  logEvent({ req, action: 'agent:enrollment-revoked', target: req.params.id, outcome: 'ok', status: 200 });
  res.json({ ok: true });
});


// ---- iter11 m2: install over SSH -------------------------------------------
//
// This is the same enrollment as the copy-and-paste path — same ticket, same
// checksum-verified command — with the panel doing the typing. Nothing about
// the credential is kept: it arrives in one request, is used, and goes when
// the request does.

// Step one: what am I about to trust? Runs before any credential is asked for,
// because ssh2 offers the host key during the handshake and this aborts there.
agentEnrollRouter.post('/servers/:id/agent/ssh/probe', requireAuth, requirePerm('servers.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const host = String(req.body?.host || server.host || '').trim();
  const port = Number(req.body?.port) > 0 ? Number(req.body.port) : 22;
  if (!host) return res.status(400).json({ error: 'host is required' });
  try {
    const key = await probeHostKey({ host, port });
    logEvent({ req, action: 'agent:ssh-probe', target: `${host}:${port}`, outcome: 'ok', status: 200 });
    res.json({ host, port, ...key });
  } catch (e) {
    logEvent({ req, action: 'agent:ssh-probe', target: `${host}:${port}`, outcome: 'error', status: 502 });
    res.status(502).json({ error: e.message });
  }
});

// Step two: install. The fingerprint the operator confirmed is required, and
// the command is built here from a fresh ticket — the request cannot influence
// what runs.
agentEnrollRouter.post('/servers/:id/agent/ssh/install', requireAuth, requirePerm('servers.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const b = req.body || {};
  const host = String(b.host || server.host || '').trim();
  const port = Number(b.port) > 0 ? Number(b.port) : 22;
  const username = String(b.username || '').trim();
  const expectedFingerprint = String(b.fingerprint || '').trim();
  if (!host || !username) return res.status(400).json({ error: 'host and username are required' });
  if (!expectedFingerprint.startsWith('SHA256:')) {
    return res.status(400).json({ error: 'confirm the host fingerprint first' });
  }
  if (!b.password && !b.privateKey) return res.status(400).json({ error: 'a password or a private key is required' });

  // One live ticket per server, as with the manual path.
  await AgentEnrollment.updateMany(
    { serverId: server._id, status: { $in: ['pending', 'fetched'] } },
    { $set: { status: 'revoked' } },
  );
  const raw = newTicket();
  const agentPort = Number(b.agentPort) > 0 ? Number(b.agentPort) : 8090;
  const panelUrl = String(b.panelUrl || `${req.protocol}://${req.get('host')}`).trim().replace(/\/+$/, '');
  const doc = await AgentEnrollment.create({
    serverId: server._id,
    tokenHash: hashTicket(raw),
    panelUrl,
    agentPort,
    bind: String(b.bind || '127.0.0.1'),
    logDir: String(b.logDir || '/var/log/nimble'),
    expiresAt: new Date(Date.now() + TTL_MIN * 60_000),
    createdBy: req.user?.username || '',
  });

  const url = `${panelUrl}/api/agents/install/${raw}`;
  const digest = sha256(scriptFor(doc, raw));
  // The verified form, not the one-liner: the panel is about to run this as
  // root on a broadcast server, and "it downloaded, so it must be fine" is not
  // a standard we hold operators to either.
  const command =
    `curl -fsSL ${url} -o /tmp/nnm-install.sh` +
    ` && echo "${digest}  /tmp/nnm-install.sh" | sha256sum -c -` +
    ` && sh /tmp/nnm-install.sh; rc=$?; rm -f /tmp/nnm-install.sh; exit $rc`;

  const jobId = createJob({ server: server.name, host, username });
  logEvent({
    req, action: 'agent:ssh-install', target: `${server.name} (${username}@${host}:${port})`,
    detail: { fingerprint: expectedFingerprint, panelUrl }, outcome: 'ok', status: 202,
  });
  res.status(202).json({ jobId });

  // Deliberately not awaited: the browser follows the job. The credential is
  // captured by this closure and by nothing else — it is never written down.
  runOverSsh({
    host, port, username,
    password: b.password, privateKey: b.privateKey, passphrase: b.passphrase,
    expectedFingerprint, command, useSudo: Boolean(b.useSudo) && username !== 'root',
    onOutput: (chunk) => appendJob(jobId, chunk),
  })
    .then(r => finishJob(jobId, { status: r.exitCode === 0 ? 'done' : 'failed', exitCode: r.exitCode }))
    .catch(e => finishJob(jobId, { status: 'failed', error: e.message }));
});

agentEnrollRouter.get('/servers/:id/agent/ssh/jobs/:jobId', requireAuth, requirePerm('servers.manage'), (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'unknown or expired job' });
  res.json({
    id: job.id, status: job.status, exitCode: job.exitCode, error: job.error,
    output: job.output, startedAt: job.startedAt, finishedAt: job.finishedAt || null,
  });
});
