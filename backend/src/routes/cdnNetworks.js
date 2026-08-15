import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { DeliveryNetwork, ROLES, ALLOWED_UPSTREAM } from '../models/DeliveryNetwork.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { ATTRIBUTION } from '../services/geoip.js';
import { logEvent } from '../services/audit.js';

export const cdnNetworkRouter = Router();
cdnNetworkRouter.use(requireAuth);

const pubNode = (n) => ({
  id: String(n._id), server: String(n.server), role: n.role,
  upstream: (n.upstream || []).map(String), weight: n.weight,
  enabled: n.enabled, notes: n.notes,
});
const pub = (n) => ({
  id: n.id, name: n.name, description: n.description, audience: n.audience,
  nodes: (n.nodes || []).map(pubNode),
  // The gateway settings, which this list did not send at all.
  //
  // The panel initialises its form from `network.gateway`, so the form was
  // always empty no matter what had been saved — and reopening the page showed
  // the saved value gone. I fixed the form twice before checking whether the
  // field was ever sent. Second time in two days: a field nobody sends looks
  // exactly like a field nobody set.
  gateway: n.gateway ? {
    enabled: n.gateway.enabled,
    mode: n.gateway.mode,
    node: n.gateway.node ? String(n.gateway.node) : null,
    domain: n.gateway.domain || '',
    policy: n.gateway.policy,
    whenAllDown: n.gateway.whenAllDown,
  } : null,
  createdBy: n.createdBy, updatedAt: n.updatedAt,
});

// Everything a node can be wrong about, in one place, so the page and any
// other client get the same answer. Returned rather than thrown: a network
// mid-build is normally incomplete, and the operator needs to see what is
// missing while they work, not be blocked from saving.
export function validateNodes(nodes, servers) {
  const byId = new Map(nodes.map(n => [String(n._id ?? n.id), n]));
  const known = new Set(servers.map(s => String(s._id)));
  const problems = [];
  const seenServers = new Set();

  for (const n of nodes) {
    const nid = String(n._id ?? n.id);
    const where = `${n.role}:${nid}`;
    if (!ROLES.includes(n.role)) problems.push({ node: nid, code: 'bad-role', detail: n.role });
    if (!known.has(String(n.server))) problems.push({ node: nid, code: 'unknown-server' });
    if (seenServers.has(String(n.server))) problems.push({ node: nid, code: 'duplicate-server' });
    seenServers.add(String(n.server));

    const allowed = ALLOWED_UPSTREAM[n.role] || [];
    for (const up of n.upstream || []) {
      const u = byId.get(String(up));
      if (!u) { problems.push({ node: nid, code: 'unknown-upstream', detail: String(up) }); continue; }
      if (String(up) === nid) { problems.push({ node: nid, code: 'self-upstream' }); continue; }
      // Content flows one way. An origin pulling from an edge is not a
      // topology, it is a loop with a delay, and it is easy to build by
      // accident in a dialog with two dropdowns.
      if (!allowed.includes(u.role)) {
        problems.push({ node: nid, code: 'illegal-upstream', detail: `${u.role} -> ${n.role}` });
      }
    }
    if (allowed.length && !(n.upstream || []).length) {
      problems.push({ node: nid, code: 'no-upstream', detail: where, severity: 'warning' });
    }
  }

  // A cycle can still exist through legal edges once a mid layer is involved.
  const colour = new Map();
  const walk = (id) => {
    if (colour.get(id) === 'done') return false;
    if (colour.get(id) === 'open') return true;
    colour.set(id, 'open');
    for (const up of byId.get(id)?.upstream || []) {
      if (byId.has(String(up)) && walk(String(up))) return true;
    }
    colour.set(id, 'done');
    return false;
  };
  for (const id of byId.keys()) {
    if (walk(id)) { problems.push({ node: id, code: 'cycle' }); break; }
  }
  return problems;
}

cdnNetworkRouter.get('/networks', requirePerm('cdn.view'), async (_req, res) => {
  const items = await DeliveryNetwork.find().sort({ name: 1 });
  res.json({ networks: items.map(pub), roles: ROLES, allowedUpstream: ALLOWED_UPSTREAM, attribution: ATTRIBUTION });
});

cdnNetworkRouter.post('/networks', requirePerm('cdn.manage'), async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (await DeliveryNetwork.findOne({ name })) return res.status(409).json({ error: 'a network with this name already exists' });
  const n = await DeliveryNetwork.create({
    name,
    description: String(req.body?.description || ''),
    audience: req.body?.audience === 'public' ? 'public' : 'internal',
    createdBy: req.user?.username || '',
  });
  await logEvent(req, 'cdn.network.create', { name });
  res.status(201).json(pub(n));
});

cdnNetworkRouter.put('/networks/:id', requirePerm('cdn.manage'), async (req, res) => {
  const n = await DeliveryNetwork.findById(req.params.id);
  if (!n) return res.status(404).json({ error: 'Network not found' });
  const b = req.body || {};
  if (b.name !== undefined) n.name = String(b.name).trim();
  if (b.description !== undefined) n.description = String(b.description);
  if (b.audience !== undefined) n.audience = b.audience === 'public' ? 'public' : 'internal';
  if (Array.isArray(b.nodes)) {
    // A node the operator has just added does not have an id yet, so the page
    // gives it a temporary one. Putting that string into _id — and into the
    // upstream of whatever points at it — makes mongoose fail the cast, and the
    // save died as a bare 500 that took the whole topology with it. The ids are
    // minted here instead, and every upstream reference is rewritten through
    // the same map so a brand new edge can point at a brand new origin in one
    // save.
    const idMap = new Map();
    const minted = b.nodes.map(x => {
      const raw = String(x.id ?? '');
      const oid = mongoose.isValidObjectId(raw)
        ? new mongoose.Types.ObjectId(raw)
        : new mongoose.Types.ObjectId();
      if (raw) idMap.set(raw, oid);
      return { x, oid };
    });
    const resolveUp = (u) => {
      const raw = String(u);
      if (idMap.has(raw)) return idMap.get(raw);
      return mongoose.isValidObjectId(raw) ? new mongoose.Types.ObjectId(raw) : null;
    };
    n.nodes = minted.map(({ x, oid }) => ({
      _id: oid,
      server: x.server, role: x.role,
      // A reference to a node that is no longer in the payload is dropped
      // rather than carried as a dangling id.
      upstream: (Array.isArray(x.upstream) ? x.upstream : []).map(resolveUp).filter(Boolean),
      weight: Number.isFinite(Number(x.weight)) ? Number(x.weight) : 100,
      enabled: x.enabled !== false,
      notes: String(x.notes || ''),
    }));
  }
  const servers = await NimbleServer.find({}, { _id: 1 });
  const problems = validateNodes(n.nodes, servers);
  // Errors block the save; warnings do not, because a network is normally
  // incomplete while it is being built and refusing to save it would mean
  // building it in one sitting or not at all.
  const blocking = problems.filter(p => p.severity !== 'warning');
  if (blocking.length) return res.status(422).json({ error: 'invalid topology', problems });
  try {
    await n.save();
  } catch (e) {
    // Named, not swallowed. A save that fails validation used to reach the
    // operator as "Internal server error", which says nothing about which
    // field is wrong or that their edits were not stored.
    return res.status(422).json({ error: `network could not be saved: ${e.message}` });
  }
  await logEvent(req, 'cdn.network.update', { id: n.id, nodes: n.nodes.length });
  res.json({ ...pub(n), problems });
});

cdnNetworkRouter.delete('/networks/:id', requirePerm('cdn.manage'), async (req, res) => {
  const n = await DeliveryNetwork.findByIdAndDelete(req.params.id);
  if (!n) return res.status(404).json({ error: 'Network not found' });
  await logEvent(req, 'cdn.network.delete', { name: n.name });
  res.json({ ok: true });
});
