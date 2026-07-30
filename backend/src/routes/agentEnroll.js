import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NimbleServer } from '../models/NimbleServer.js';
import { AgentEnrollment, hashTicket, newTicket } from '../models/AgentEnrollment.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { installScript } from '../services/agentInstaller.js';
import { agent } from '../services/agentClient.js';
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
const AGENT_SRC = path.resolve(fileURLToPath(new URL('../../../agent/nnm-agent.mjs', import.meta.url)));

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

// RFC1918 / loopback / link-local. Used only to WARN: a private address is
// perfectly normal when the panel sits on the same network, and is a red flag
// when it does not.
export function isPrivateAddress(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '');
  if (/^(localhost|127\.|::1$)/i.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;
  return false;
}

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
  const panelUrl = `${req.protocol}://${req.get('host')}`;
  res.type('text/plain').send(installScript({
    panelUrl,
    ticket: req.params.ticket,
    baseUrl: doc.baseUrlHint,
    agentPort: doc.agentPort,
    bind: doc.bind,
    logDir: doc.logDir,
    confDir: doc.confDir,
    mediaDir: doc.mediaDir,
  }));
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
  const { ticket, agentToken, baseUrl, hostname, agentVersion } = req.body || {};
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

  // The hint wins when the operator gave one: only they know whether the
  // address the box sees on itself is the address the panel can use.
  const finalUrl = (doc.baseUrlHint || baseUrl || '').trim();
  if (!finalUrl) return res.status(400).json({ error: 'no reachable address for the agent' });

  server.agent = { enabled: true, baseUrl: finalUrl.replace(/\/+$/, ''), token: String(agentToken) };
  await server.save();

  doc.status = 'enrolled';
  doc.enrolledAt = new Date();
  doc.enrolledFrom = clientIp(req);
  doc.reportedHostname = String(hostname || '');
  doc.reportedVersion = Number(agentVersion) || 0;
  await doc.save();

  logEvent({
    req, username: `enroll:${doc.createdBy}`, action: 'agent:enroll', target: server.name,
    detail: { baseUrl: server.agent.baseUrl, hostname: doc.reportedHostname, agentVersion: doc.reportedVersion },
    outcome: 'ok', status: 200,
  });
  res.json({ ok: true, server: server.name });
});

// ----------------------------------------------------------- authenticated ---

const auth = Router();
auth.use(requireAuth);
agentEnrollRouter.use(auth);

auth.post('/servers/:id/agent/enrollment', requirePerm('servers.manage'), async (req, res) => {
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
  const doc = await AgentEnrollment.create({
    serverId: server._id,
    tokenHash: hashTicket(raw),
    baseUrlHint: String(b.baseUrl || (server.host ? `http://${server.host}:${port}` : '')).trim(),
    agentPort: port,
    bind: String(b.bind || '0.0.0.0'),
    logDir: String(b.logDir || '/var/log/nimble'),
    confDir: String(b.confDir || '/srv/nimble/conf'),
    mediaDir: String(b.mediaDir || '/srv/nimble/media/gallery'),
    expiresAt: new Date(Date.now() + TTL_MIN * 60_000),
    createdBy: req.user?.username || '',
  });

  const panelUrl = `${req.protocol}://${req.get('host')}`;
  logEvent({ req, action: 'agent:enrollment-issued', target: server.name, outcome: 'ok', status: 200 });
  res.json({
    ticket: raw,                       // shown once; only its hash is stored
    expiresAt: doc.expiresAt,
    panelUrl,
    baseUrlHint: doc.baseUrlHint,
    command: `curl -fsSL ${panelUrl}/api/agents/install/${raw} | sudo sh -s`,
    scriptUrl: `${panelUrl}/api/agents/install/${raw}`,
    // Both are the operator's problem to fix, not ours to hide.
    warnings: [
      ...(panelUrl.startsWith('https://') ? [] : ['panelNotHttps']),
      ...(isPrivateAddress(new URL(panelUrl).hostname) ? ['panelPrivateAddress'] : []),
    ],
  });
});

auth.get('/servers/:id/agent/enrollment', requirePerm('servers.view'), async (req, res) => {
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

auth.delete('/servers/:id/agent/enrollment', requirePerm('servers.manage'), async (req, res) => {
  await AgentEnrollment.updateMany(
    { serverId: req.params.id, status: { $in: ['pending', 'fetched'] } },
    { $set: { status: 'revoked' } },
  );
  logEvent({ req, action: 'agent:enrollment-revoked', target: req.params.id, outcome: 'ok', status: 200 });
  res.json({ ok: true });
});

// Enrollment proves the box could reach the PANEL. It proves nothing about
// the panel reaching the AGENT, which is the direction everything else uses.
// This says which of the two is actually true.
auth.post('/servers/:id/agent/verify', requirePerm('servers.view'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (!server.agent?.enabled || !server.agent?.baseUrl) return res.json({ reachable: false, reason: 'notConfigured' });
  let host = '';
  try { host = new URL(server.agent.baseUrl).hostname; } catch { /* malformed, reported below */ }
  try {
    const health = await agent.health(server);
    res.json({ reachable: true, health, privateAddress: isPrivateAddress(host) });
  } catch (e) {
    res.json({
      reachable: false,
      reason: 'unreachable',
      error: e.message,
      privateAddress: isPrivateAddress(host),
    });
  }
});
