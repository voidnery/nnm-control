import { Router } from 'express';
import { machineTrafficFilter, logEvent } from '../services/audit.js';
import { AuditLog } from '../models/AuditLog.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';

export const auditRouter = Router();
auditRouter.use(requireAuth, requirePerm('audit.view'));

// Filters: username, action substring, outcome, before (ts cursor). Max 200.
auditRouter.get('/', async (req, res) => {
  const { username, action, outcome, before } = req.query;
  const q = {};
  if (username) q.username = username;
  if (action) q.action = { $regex: String(action).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  if (outcome === 'ok' || outcome === 'error') q.outcome = outcome;
  if (before) q.ts = { $lt: new Date(String(before)) };
  const items = await AuditLog.find(q).sort({ ts: -1 }).limit(200).lean();
  res.json({ items });
});


// What a sweep would remove, before removing it.
//
// Counted rather than estimated, and shown before the button does anything:
// deleting millions of rows from a log people rely on is not something to
// discover the size of afterwards.
auditRouter.get('/sweepable', requireAuth, requirePerm('audit.view'), async (req, res) => {
  const filter = machineTrafficFilter();
  const [machine, total] = await Promise.all([
    AuditLog.countDocuments(filter),
    AuditLog.estimatedDocumentCount(),
  ]);
  const stats = await AuditLog.collection.stats().catch(() => null);
  res.json({
    machine,
    total,
    // What people did, which is what an audit log is for and what stays.
    keeping: Math.max(0, total - machine),
    // Bytes are what the operator is actually short of. Storage size rather
    // than data size, since that is the file on the disk.
    storageMb: stats ? Math.round(stats.storageSize / 1048576) : null,
    // Removing rows does not shrink a WiredTiger file. Said here rather than
    // discovered after a sweep that appears to free nothing.
    needsCompact: true,
  });
});

// Remove them.
//
// Confirmed by naming the count the operator was shown: a sweep is
// irreversible, and agreeing to "delete 8,598,036 rows" is a different act
// from clicking a button whose label happened to be under the cursor.
auditRouter.post('/sweep', requireAuth, requirePerm('audit.manage'), async (req, res) => {
  const filter = machineTrafficFilter();
  const expected = Number(req.body?.expect);
  const actual = await AuditLog.countDocuments(filter);

  if (!Number.isFinite(expected)) {
    return res.status(400).json({ error: 'confirm-count-required', code: 'confirm-count-required', actual });
  }
  // Within a margin, because agents keep writing nothing here now but the
  // count is a moment old regardless. A wildly different number means the
  // operator agreed to something else.
  if (Math.abs(actual - expected) > Math.max(1000, expected * 0.05)) {
    return res.status(409).json({ error: 'count-changed', code: 'count-changed', expected, actual });
  }

  const r = await AuditLog.deleteMany(filter);

  // Compaction, because deleting rows does not give the disk anything back.
  // Attempted and reported: it takes a lock, and a panel that silently hangs
  // for a minute is worse than one that says it is compacting.
  let compacted = null;
  try {
    const out = await AuditLog.db.command({ compact: AuditLog.collection.collectionName });
    compacted = Boolean(out?.ok);
  } catch (e) {
    compacted = false;
    // Not a failure of the sweep: the rows are gone either way, and the space
    // returns on the next compaction or restart.
    logEvent({ req, action: 'audit:compact-failed', outcome: 'error', status: 200,
               detail: { error: String(e?.message || e).slice(0, 200) } });
  }

  const stats = await AuditLog.collection.stats().catch(() => null);
  logEvent({ req, action: 'audit:sweep', outcome: 'ok', status: 200,
             detail: { removed: r.deletedCount, compacted } });
  res.json({
    removed: r.deletedCount,
    compacted,
    storageMb: stats ? Math.round(stats.storageSize / 1048576) : null,
  });
});
