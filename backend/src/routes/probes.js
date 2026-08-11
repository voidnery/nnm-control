import { Router } from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { DeliveryNetwork } from '../models/DeliveryNetwork.js';
import { runTask } from '../services/agentBus.js';
import { agentIsLive } from '../services/nimbleClient.js';
import { runProbes, matrixTargets, classifyReferenceResults, cell, PROBE_ROUTE, PROBE_MIN_AGENT }
  from '../services/probeService.js';
import { REFERENCE_POINTS, pointsNear } from '../services/referencePoints.js';
import { logEvent } from '../services/audit.js';

export const probeRouter = Router();
probeRouter.use(requireAuth);

// Only one probe run at a time per network. Two runs racing means every node
// measuring while another node is measuring it, which is a way to produce
// numbers nobody can reproduce.
const running = new Set();

const nodeView = (n, server) => ({
  id: String(n.id ?? n._id), name: server.name, host: server.host,
  port: Number(server.httpPort) || 8081,
  role: n.role,
  agentEnabled: Boolean(server.agent?.enabled),
  agentLive: agentIsLive(server),
  agentVersion: server.agent?.version ?? null,
  lat: server.geo?.lat ?? null, lon: server.geo?.lon ?? null,
  country: server.geo?.countryCode || '',
});

async function nodesOf(networkId) {
  const network = await DeliveryNetwork.findById(networkId);
  if (!network) return { error: 'Network not found' };
  const servers = await NimbleServer.find();
  const byId = new Map(servers.map(s => [String(s._id), s]));
  const nodes = (network.nodes || [])
    .filter(n => n.enabled !== false && byId.has(String(n.server)))
    .map(n => ({ ...nodeView(n, byId.get(String(n.server))), server: byId.get(String(n.server)) }));
  return { network, nodes };
}

const ask = (attempts, timeoutMs) => async (from, targets) => {
  const out = await runTask(from.server, PROBE_ROUTE, {
    body: { targets, attempts, timeoutMs },
    // Room for every attempt against every target, plus the round trip.
    timeoutMs: Math.min(90_000, targets.length * attempts * timeoutMs + 15_000),
    createdBy: 'probe',
  });
  return out?.json ?? out ?? null;
};

probeRouter.get('/reference-points', requirePerm('cdn.view'), (_req, res) => {
  res.json({ points: REFERENCE_POINTS, minAgent: PROBE_MIN_AGENT });
});

// Node to node: can each box reach each other box on the port that carries the
// stream between them.
probeRouter.post('/networks/:id/probe/matrix', requirePerm('cdn.view'), async (req, res) => {
  const g = await nodesOf(req.params.id);
  if (g.error) return res.status(404).json({ error: g.error });
  if (running.has(req.params.id)) return res.status(409).json({ error: 'a probe run is already in progress' });
  running.add(req.params.id);
  try {
    const attempts = Math.min(Math.max(Number(req.body?.attempts) || 3, 1), 5);
    const timeoutMs = Math.min(Math.max(Number(req.body?.timeoutMs) || 3000, 200), 10_000);
    const byId = new Map(g.nodes.map(n => [String(n.id), n]));
    const { rows, skipped } = await runProbes({
      nodes: g.nodes, targetsByNode: matrixTargets(g.nodes), ask: ask(attempts, timeoutMs),
    });
    const cells = rows.map(r => cell(r.fromNode, byId.get(String(r.target.id).replace(/^node:/, '')) || {}, r.result));
    await logEvent(req, 'cdn.probe.matrix', { network: req.params.id, cells: cells.length, skipped: skipped.length });
    res.json({ cells, skipped, attempts, timeoutMs, at: new Date().toISOString() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  } finally { running.delete(req.params.id); }
});

// Towards a place we do not own. The caller says where on the map they are
// asking about; the panel picks the reference points for it and asks every
// node that can be asked.
probeRouter.post('/networks/:id/probe/region', requirePerm('cdn.view'), async (req, res) => {
  const g = await nodesOf(req.params.id);
  if (g.error) return res.status(404).json({ error: g.error });
  const lat = Number(req.body?.lat), lon = Number(req.body?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'lat and lon are required' });
  }
  const country = String(req.body?.country || '').toUpperCase();
  const points = pointsNear({ lat, lon, country }, { limit: Math.min(Number(req.body?.limit) || 4, 8) });
  if (!points.length) return res.json({ points: [], rows: [], skipped: [], suspect: [] });

  if (running.has(req.params.id)) return res.status(409).json({ error: 'a probe run is already in progress' });
  running.add(req.params.id);
  try {
    const targets = new Map(g.nodes.map(n => [String(n.id),
      points.map(p => ({ id: `ref:${p.id}`, host: p.host, port: p.port }))]));
    const { rows, skipped } = await runProbes({ nodes: g.nodes, targetsByNode: targets, ask: ask(3, 3000) });
    const byPoint = new Map(points.map(p => [`ref:${p.id}`, p]));
    const flat = rows.map(r => {
      const p = byPoint.get(String(r.target.id));
      const c = cell(r.fromNode, { name: p.label, host: p.host, port: p.port }, r.result);
      return { ...c, pointId: p.id, label: p.label, country: p.country,
               distanceKm: p.distanceKm, lat: p.lat, lon: p.lon };
    });
    const probedNodes = new Set(rows.map(r => r.fromNode.name)).size;
    const { suspect } = classifyReferenceResults(flat, { probedNodes });
    res.json({ points, rows: flat, skipped, suspect, at: new Date().toISOString() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  } finally { running.delete(req.params.id); }
});
