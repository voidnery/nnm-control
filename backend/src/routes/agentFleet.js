import { Router } from 'express';
import { NimbleServer } from '../models/NimbleServer.js';
import { AgentEvent } from '../models/AgentEvent.js';
import { AgentTask } from '../models/AgentTask.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { agentRelease, versionState } from '../services/agentRelease.js';
import { diagnose, HINTS } from '../services/agentDiagnosis.js';
import { enqueueTask, runTask, reapExpiredTasks } from '../services/agentBus.js';
import { watchdogState, evaluateOnce } from '../services/agentWatchdog.js';
import { logEvent } from '../services/audit.js';
import { probeHostKey, runOverSsh, createJob, appendJob, finishJob, getJob } from '../services/sshInstaller.js';

// iter14 — everything about the fleet of agents in one place, because that is
// how an operator thinks about them: not "this server's agent" thirteen times,
// but "which of them are broken and which are behind".
export const agentFleetRouter = Router();
agentFleetRouter.use(requireAuth);

agentFleetRouter.get('/overview', requirePerm('servers.view'), async (req, res) => {
  await reapExpiredTasks();
  const rel = await agentRelease();
  const servers = await NimbleServer.find({}, {
    name: 1, host: 1, agent: 1,
  }).sort({ order: 1, name: 1 });

  const now = new Date();
  const rows = [];
  for (const s of servers) {
    const a = s.agent || {};
    if (!a.enabled) {
      rows.push({ id: String(s._id), name: s.name, host: s.host, enabled: false, code: 'not-configured' });
      continue;
    }
    const tasks = await AgentTask.find({ serverId: s._id }).sort({ createdAt: -1 }).limit(20).lean();
    const d = diagnose({
      now,
      agent: {
        enabled: true, hasToken: Boolean(a.token), lastContactAt: a.lastContactAt,
        instanceId: a.instanceId, version: a.version, restarts: a.restarts,
        restartWindowStart: a.restartWindowStart,
      },
      tasks: tasks.map(t => ({
        id: String(t._id), route: t.route, status: t.status,
        createdAt: t.createdAt, claimedAt: t.claimedAt, deadlineAt: t.deadlineAt,
      })),
    });
    rows.push({
      id: String(s._id), name: s.name, host: s.host, enabled: true,
      code: d.code, severity: d.severity, evidence: d.evidence, hint: HINTS[d.code] || '',
      lastContactAt: a.lastContactAt, sinceContactMs: d.sinceContactMs,
      restarts: a.restarts || 0,
      version: a.version || 0,
      versionState: versionState(a.version, rel.version),
      // An agent installed where it cannot rewrite itself is a real state and
      // the update button must not pretend otherwise.
      selfUpdate: a.lastHealth?.selfUpdate !== false,
      selfPath: a.lastHealth?.selfPath || '',
      pendingUpdate: tasks.some(t => t.route === 'POST /self-update' && ['queued', 'claimed'].includes(t.status)),
      // A self-update that failed left a task saying exactly why — and nothing
      // showed it, so an agent that refused to update looked identical to one
      // nobody had asked. The last attempt is reported either way.
      // A self-update that fails inside the agent's own download check cannot
      // be fixed by retrying: the agent doing the checking IS the code that
      // needs replacing. Agents up to v8 shipped a check that could never
      // pass, so the panel names the way out instead of offering the button
      // that will fail again.
      updateStuck: (() => {
        const t = tasks.find(x => x.route === 'POST /self-update' && x.status === 'failed');
        if (!t) return false;
        return /does not look like the agent/i.test(t.error || '');
      })(),
      lastUpdate: (() => {
        const t = tasks.find(x => x.route === 'POST /self-update' && ['done', 'failed', 'expired'].includes(x.status));
        if (!t) return null;
        return {
          status: t.status,
          at: t.finishedAt || t.createdAt,
          error: t.error || '',
          toVersion: t.body?.version || null,
        };
      })(),
    });
  }

  const unacked = await AgentEvent.countDocuments({ acknowledgedAt: null });
  res.json({
    shipped: { version: rel.version, sha256: rel.sha256, bytes: rel.bytes },
    watchdog: watchdogState(),
    unacknowledged: unacked,
    servers: rows,
    summary: {
      total: rows.length,
      configured: rows.filter(r => r.enabled).length,
      healthy: rows.filter(r => r.code === 'healthy').length,
      faulty: rows.filter(r => r.enabled && r.code !== 'healthy').length,
      outdated: rows.filter(r => r.enabled && r.versionState === 'outdated').length,
    },
  });
});

agentFleetRouter.get('/events', requirePerm('servers.view'), async (req, res) => {
  const q = {};
  if (req.query.serverId) q.serverId = req.query.serverId;
  if (req.query.unacked === '1') q.acknowledgedAt = null;
  const rows = await AgentEvent.find(q).sort({ createdAt: -1 }).limit(100).lean();
  res.json(rows.map(e => ({
    id: String(e._id), serverId: String(e.serverId), serverName: e.serverName,
    code: e.code, kind: e.kind, severity: e.severity, evidence: e.evidence,
    detail: e.detail, createdAt: e.createdAt,
    acknowledgedAt: e.acknowledgedAt, acknowledgedBy: e.acknowledgedBy,
  })));
});

agentFleetRouter.post('/events/ack', requirePerm('servers.manage'), async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  const filter = ids ? { _id: { $in: ids } } : { acknowledgedAt: null };
  const r = await AgentEvent.updateMany(filter,
    { $set: { acknowledgedAt: new Date(), acknowledgedBy: req.user?.username || '' } });
  res.json({ ok: true, acknowledged: r.modifiedCount || 0 });
});

// Run the watchdog now rather than waiting for its tick — used when an
// operator has just fixed something and wants the verdict refreshed.
agentFleetRouter.post('/recheck', requirePerm('servers.view'), async (_req, res) => {
  const r = await evaluateOnce();
  res.json({ checked: r.checked, events: r.events.length });
});

// --- updates ----------------------------------------------------------------
//
// This does NOT push code. It queues a task asking the agent to run its own
// verified update, and the digest travels with the task so the agent compares
// what it downloaded against what the panel intended — not against whatever
// the download itself claimed.

async function queueUpdate(server, rel, username) {
  return enqueueTask(server, 'POST /self-update', {
    body: { sha256: rel.sha256, version: rel.version },
    timeoutMs: 5 * 60_000,
    createdBy: username,
  });
}

agentFleetRouter.post('/servers/:id/update', requirePerm('servers.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (!server.agent?.enabled) return res.status(409).json({ error: 'no agent on this server' });
  const rel = await agentRelease();
  const task = await queueUpdate(server, rel, req.user?.username);
  logEvent({ req, action: 'agent:update', target: `${server.name} → v${rel.version}`, outcome: 'ok', status: 200 });
  res.json({ ok: true, taskId: String(task._id), toVersion: rel.version });
});

// Update everything that is behind. Only agents that are actually polling —
// queueing an update for an agent that is not there produces a task that
// expires and an operator who thinks something happened.
agentFleetRouter.post('/update-outdated', requirePerm('servers.manage'), async (req, res) => {
  const rel = await agentRelease();
  const servers = await NimbleServer.find({ 'agent.enabled': true });
  const queued = [];
  const skipped = [];
  for (const s of servers) {
    const a = s.agent || {};
    if (versionState(a.version, rel.version) !== 'outdated') continue;
    const silent = !a.lastContactAt || Date.now() - new Date(a.lastContactAt).getTime() > 70_000;
    if (silent) { skipped.push({ name: s.name, reason: 'not-polling' }); continue; }
    if (a.lastHealth?.selfUpdate === false) { skipped.push({ name: s.name, reason: 'read-only-install' }); continue; }
    await queueUpdate(s, rel, req.user?.username);
    queued.push(s.name);
  }
  logEvent({
    req, action: 'agent:update-all', target: `${queued.length} agent(s) → v${rel.version}`,
    detail: { queued, skipped }, outcome: 'ok', status: 200,
  });
  res.json({ ok: true, toVersion: rel.version, queued, skipped });
});

// --- recovery ---------------------------------------------------------------
//
// Staged, and every stage is something an operator would do by hand. Nothing
// here runs on its own: an automatic action taken on a false positive would be
// the panel reaching into a live broadcast server because a heartbeat was
// late.

agentFleetRouter.post('/servers/:id/probe', requirePerm('servers.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  try {
    // Cheapest possible question: is anyone there? A short deadline, because
    // the answer "no" is what is being tested for.
    const health = await runTask(server, 'GET /health', { timeoutMs: 12_000, createdBy: req.user?.username });
    res.json({ reachable: true, health });
  } catch (e) {
    res.json({ reachable: false, reason: e.reason || 'error', error: e.message });
  }
});

// Recovery over SSH: restart the service, then look at why it was down.
//
// Same terms as the SSH install — the credential is used for this one
// operation and never stored, and the host key must be confirmed first, so a
// root password is never offered to whatever happened to answer. The commands
// are fixed: restart the unit, then read its status and its last lines. This
// is not a shell.
agentFleetRouter.post('/servers/:id/ssh/probe', requirePerm('servers.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const host = String(req.body?.host || server.host || '').trim();
  const port = Number(req.body?.port) > 0 ? Number(req.body.port) : 22;
  try { res.json({ host, port, ...(await probeHostKey({ host, port })) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

const RECOVER = [
  { key: 'restart', cmd: 'systemctl restart nnm-agent' },
  { key: 'status', cmd: 'systemctl is-active nnm-agent; systemctl status nnm-agent --no-pager -n 5 2>&1 | tail -n 12' },
  // Read last, so that whatever the restart printed is included.
  { key: 'journal', cmd: 'journalctl -u nnm-agent -n 60 --no-pager 2>&1 | tail -n 60' },
  { key: 'env', cmd: 'grep -v TOKEN /etc/nnm-agent.env 2>/dev/null || echo "no env file"' },
];

agentFleetRouter.post('/servers/:id/recover', requirePerm('servers.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const b = req.body || {};
  const host = String(b.host || server.host || '').trim();
  const port = Number(b.port) > 0 ? Number(b.port) : 22;
  const username = String(b.username || '').trim();
  const fingerprint = String(b.fingerprint || '').trim();
  if (!host || !username) return res.status(400).json({ error: 'host and username are required' });
  if (!fingerprint.startsWith('SHA256:')) return res.status(400).json({ error: 'confirm the host fingerprint first' });
  if (!b.password && !b.privateKey) return res.status(400).json({ error: 'a password or a private key is required' });

  const jobId = createJob({ server: server.name, host, username, kind: 'recover' });
  logEvent({
    req, action: 'agent:recover', target: `${server.name} (${username}@${host}:${port})`,
    detail: { fingerprint }, outcome: 'ok', status: 202,
  });
  res.status(202).json({ jobId });

  // The credential is captured by this closure and by nothing else.
  (async () => {
    try {
      for (const step of RECOVER) {
        appendJob(jobId, `\n==> ${step.key}\n`);
        const r = await runOverSsh({
          host, port, username,
          password: b.password, privateKey: b.privateKey, passphrase: b.passphrase,
          expectedFingerprint: fingerprint,
          command: step.cmd,
          useSudo: Boolean(b.useSudo) && username !== 'root',
          onOutput: (c) => appendJob(jobId, c),
          timeoutMs: 60_000,
        });
        // A non-zero exit from a diagnostic step is information, not a reason
        // to stop collecting the rest of it.
        if (r.exitCode !== 0) appendJob(jobId, `(exit ${r.exitCode})\n`);
      }
      // Whether it worked is not decided here: the agent has to come back and
      // say so on its own poll. Claiming success from a restart command that
      // returned zero would be claiming something nobody checked.
      appendJob(jobId, '\n==> done. The agent reports back on its next poll, within about half a minute.\n');
      finishJob(jobId, { status: 'done', exitCode: 0 });
      await AgentEvent.create({
        serverId: server._id, serverName: server.name, code: 'recovery-attempted',
        kind: 'action', severity: 'info',
        message: `restart attempted over SSH by ${req.user?.username || '?'}`,
      });
    } catch (e) {
      appendJob(jobId, `\n==> failed: ${e.message}\n`);
      finishJob(jobId, { status: 'failed', error: e.message });
    }
  })();
});

agentFleetRouter.get('/jobs/:jobId', requirePerm('servers.manage'), (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'unknown or expired job' });
  res.json({
    id: job.id, status: job.status, exitCode: job.exitCode, error: job.error,
    output: job.output, startedAt: job.startedAt, finishedAt: job.finishedAt || null,
  });
});
