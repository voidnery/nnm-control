import { Router } from 'express';
import crypto from 'node:crypto';
import { NimbleServer } from '../models/NimbleServer.js';
import { AgentTask } from '../models/AgentTask.js';
import { Settings } from '../models/Settings.js';
import { waitForTask, deliverResult } from '../services/agentBus.js';
import { RESTART_WINDOW_MS } from '../services/agentDiagnosis.js';
import { agentRelease } from '../services/agentRelease.js';
import { ingestBatch } from '../services/logCollector.js';
import { MediaTransfer } from '../models/MediaTransfer.js';
import { StatSample } from '../models/StatSample.js';
import { readSpooled, discardSpooled } from '../services/mediaSpool.js';

// iter12 m1 — everything an agent talks to, and nothing else.
//
// These routes are authenticated by the agent's own token rather than by an
// operator session, because there is no operator involved: the agent runs
// unattended and calls in. They are the complete inbound surface for a
// machine that the panel can never call back.
export const agentGatewayRouter = Router();

const LONG_POLL_MS = 25_000;   // under the 30s most proxies idle out at

// The token is compared in constant time. It is a bearer credential for a
// machine that can write files on a broadcast server; leaking its length or
// prefix through timing is a needless gift.
function tokenMatches(given, expected) {
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

async function authAgent(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const serverId = String(req.header('x-nnm-server') || req.body?.serverId || '');
  if (!token || !/^[0-9a-fA-F]{24}$/.test(serverId)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const server = await NimbleServer.findById(serverId);
  if (!server || !server.agent?.enabled || !tokenMatches(token, server.agent.token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.srv = server;
  next();
}

/**
 * The agent's whole life: park here, take a task if one appears, go do it.
 *
 * Every poll is also a heartbeat — `lastContactAt` is written before the wait
 * begins, not after, so a long park does not look like silence.
 */
agentGatewayRouter.post('/poll', authAgent, async (req, res) => {
  const server = req.srv;
  const { instanceId = '', version = 0, health = null } = req.body || {};

  const now = new Date();
  const seen = String(instanceId).slice(0, 64);
  // iter12 m4 — a new instance id means the process is not the one we spoke to
  // last time. Counted inside a rolling window so an ordinary restart is not
  // mistaken for a crash loop, and a crash loop is not mistaken for health.
  if (seen && server.agent.instanceId && seen !== server.agent.instanceId) {
    const start = server.agent.restartWindowStart;
    if (!start || now - start > RESTART_WINDOW_MS) {
      server.agent.restartWindowStart = now;
      server.agent.restarts = 1;
    } else {
      server.agent.restarts = (server.agent.restarts || 0) + 1;
    }
  }
  server.agent.lastContactAt = now;
  server.agent.instanceId = seen;
  server.agent.version = Number(version) || 0;
  if (health && typeof health === 'object') server.agent.lastHealth = health;
  await server.save();

  const take = async () => {
    // findOneAndUpdate so two agents for one server — which happens when an
    // operator installs on a cloned VM — cannot both claim the same task.
    return await AgentTask.findOneAndUpdate(
      { serverId: server._id, status: 'queued', deadlineAt: { $gt: new Date() } },
      { $set: { status: 'claimed', claimedAt: new Date(), claimedBy: String(instanceId).slice(0, 64) } },
      { new: true, sort: { createdAt: 1 } },
    );
  };

  let task = await take();
  if (!task) {
    await waitForTask(server._id, LONG_POLL_MS);
    task = await take();
  }

  // iter12 m2 — the agent has nothing to configure on the box: what to tail,
  // and whether to tail at all, rides along on the poll response.
  const s = await Settings.load();
  const config = {
    logs: { enabled: Boolean(s.logs?.enabled), files: s.logs?.files?.length ? s.logs.files : ['nimble.log'] },
    host: {
      enabled: Boolean(s.host?.enabled),
      intervalSec: Number(s.host?.intervalSec) || 10,
      // Empty means "every physical interface", decided on the box where the
      // list is actually known.
      interfaces: Array.isArray(server.agent?.interfaces) ? server.agent.interfaces : [],
    },
  };

  if (!task) return res.json({ task: null, config, pollAgainMs: 0 });
  res.json({
    task: { id: String(task._id), route: task.route, query: task.query || null, body: task.body ?? null },
    config,
    pollAgainMs: 0,
  });
});

// iter12 m2 — log batches, pushed. The panel no longer walks the fleet on a
// timer asking each server what is new; each server says so.
agentGatewayRouter.post('/logs', authAgent, async (req, res) => {
  const { file, ino, gen, offset, data } = req.body || {};
  if (typeof data !== 'string' || !file) return res.status(400).json({ error: 'file and data required' });
  try {
    const r = await ingestBatch(req.srv, { file: String(file), ino: String(ino || ''), gen: Number(gen) || 0, offset: Number(offset) || 0, data });
    req.srv.agent.lastContactAt = new Date();
    await req.srv.save();
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// iter14 — the agent's own source, for an agent updating itself. Served to a
// machine that has already authenticated as a known server; the digest it
// checks against came from the task, not from this response, so a tampered
// body fails the comparison rather than replacing the agent.
agentGatewayRouter.get('/agent-source', authAgent, async (_req, res) => {
  const rel = await agentRelease();
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.setHeader('x-nnm-agent-version', String(rel.version));
  res.send(rel.body);
});

// iter15 m1 — host metrics. They land in the same store as the stream metrics
// under group 'host', so one query serves both and retention is already
// governed by the TTL that was there.
agentGatewayRouter.post('/metrics', authAgent, async (req, res) => {
  const { ts, metrics } = req.body || {};
  if (!metrics || typeof metrics !== 'object') return res.status(400).json({ error: 'metrics required' });

  const clean = {};
  for (const [k, v] of Object.entries(metrics)) {
    // Only finite numbers, and only names that can be a metric key. A sample
    // is written unattended and read as a graph; anything else here becomes a
    // line that cannot be plotted or a key that cannot be queried.
    if (!/^[a-z0-9_]{1,64}$/i.test(k)) continue;
    const n = Number(v);
    if (Number.isFinite(n)) clean[k] = n;
  }
  if (!Object.keys(clean).length) return res.status(400).json({ error: 'no usable metrics' });

  const when = ts ? new Date(ts) : new Date();
  await StatSample.create({
    serverId: String(req.srv._id),
    subject: 'host',
    group: 'host',
    label: req.srv.name,
    ts: Number.isNaN(when.getTime()) ? new Date() : when,
    metrics: clean,
  });

  req.srv.agent.lastContactAt = new Date();
  await req.srv.save();
  res.json({ ok: true, stored: Object.keys(clean).length });
});

// iter12 m3 — the file itself. Streamed from the spool; the panel never holds
// a 2 GB media file in memory on either leg.
agentGatewayRouter.get('/media/:id/content', authAgent, async (req, res) => {
  const doc = await MediaTransfer.findOne({ _id: req.params.id, serverId: req.srv._id });
  if (!doc || !doc.spoolPath) return res.status(404).json({ error: 'no such transfer' });
  doc.status = 'fetching';
  doc.fetchedAt = new Date();
  await doc.save();
  res.setHeader('content-type', 'application/octet-stream');
  if (doc.size) res.setHeader('content-length', String(doc.size));
  readSpooled(doc)
    .on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); })
    .pipe(res);
});

agentGatewayRouter.post('/task/:id/result', authAgent, async (req, res) => {
  const task = await AgentTask.findOne({ _id: req.params.id, serverId: req.srv._id });
  if (!task) return res.status(404).json({ error: 'unknown task' });

  const { ok, result = null, error = '', status = 0 } = req.body || {};
  // A result for a task the panel already gave up on is accepted and recorded
  // — it is the evidence that the agent was alive but slow, which is a
  // different problem from an agent that never answered.
  task.status = ok ? 'done' : 'failed';
  task.result = ok ? result : null;
  task.error = ok ? '' : String(error).slice(0, 2000);
  task.finishedAt = new Date();
  await task.save();

  // iter12 m3 — a media fetch reports its outcome the same way every other
  // task does, so the transfer's fate is settled here rather than through a
  // second endpoint that would have to be kept in step with this one.
  if (task.route === 'POST /media/fetch' && task.body?.transferId) {
    const doc = await MediaTransfer.findOne({ _id: task.body.transferId, serverId: req.srv._id });
    if (doc && doc.status !== 'done') {
      doc.attempts += 1;
      if (ok) {
        doc.status = 'done';
        doc.confirmedAt = new Date();
        doc.error = '';
        // Only now: deleting on "the download finished" would drop the only
        // copy while the write on the far side could still have failed.
        await discardSpooled(doc);
      } else {
        // Kept on purpose — a failed write is exactly when an operator wants
        // to retry without re-uploading gigabytes.
        doc.status = 'failed';
        doc.error = task.error;
        await doc.save();
      }
    }
  }

  req.srv.agent.lastContactAt = new Date();
  await req.srv.save();

  deliverResult(task._id, ok ? { result } : { error: task.error || 'agent reported failure', status });
  res.json({ ok: true });
});
