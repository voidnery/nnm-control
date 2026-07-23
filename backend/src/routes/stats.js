import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { StatSample } from '../models/StatSample.js';

export const statsRouter = Router();
statsRouter.use(requireAuth);

// What has been sampled for this server recently, and which metrics each
// subject carries — the catalog is derived from live data, not hardcoded, so
// counters that differ between Nimble builds still show up.
statsRouter.get('/:serverId/subjects', requirePerm('streams.view'), async (req, res) => {
  const since = new Date(Date.now() - 15 * 60 * 1000);
  const rows = await StatSample.aggregate([
    { $match: { serverId: String(req.params.serverId), ts: { $gte: since } } },
    { $sort: { ts: -1 } },
    { $group: { _id: '$subject', group: { $first: '$group' }, label: { $first: '$label' },
                last: { $first: '$ts' }, metrics: { $first: { $objectToArray: '$metrics' } } } },
    { $project: { _id: 0, subject: '$_id', group: 1, label: 1, last: 1, metrics: '$metrics.k' } },
    { $sort: { group: 1, subject: 1 } },
  ]);
  res.json({ subjects: rows });
});

// Time series for one subject. Long ranges are bucketed server-side so the
// browser never has to chew through tens of thousands of raw points.
statsRouter.get('/:serverId/series', requirePerm('streams.view'), async (req, res) => {
  const { serverId } = req.params;
  const subject = String(req.query.subject || '');
  const metrics = String(req.query.metrics || '').split(',').map(m => m.trim()).filter(Boolean);
  if (!subject || !metrics.length) return res.status(400).json({ error: 'subject and metrics are required' });

  const minutes = Math.min(4320, Math.max(1, Number(req.query.minutes) || 30));  // cap at the 3-day retention
  const from = new Date(Date.now() - minutes * 60 * 1000);

  const raw = await StatSample.countDocuments({ serverId, subject, ts: { $gte: from } });
  const targetPoints = 600;
  const bucketMs = raw > targetPoints ? Math.ceil((minutes * 60 * 1000) / targetPoints) : 0;

  const project = { ts: 1 };
  metrics.forEach(m => { project[`metrics.${m}`] = 1; });

  let points;
  if (!bucketMs) {
    const docs = await StatSample.find({ serverId, subject, ts: { $gte: from } }, project).sort({ ts: 1 }).lean();
    points = docs.map(d => ({ ts: d.ts, v: metrics.map(m => d.metrics?.[m] ?? null) }));
  } else {
    const group = { _id: { $toDate: { $subtract: [{ $toLong: '$ts' }, { $mod: [{ $toLong: '$ts' }, bucketMs] }] } } };
    metrics.forEach((m, i) => { group[`m${i}`] = { $avg: `$metrics.${m}` }; });
    const docs = await StatSample.aggregate([
      { $match: { serverId, subject, ts: { $gte: from } } },
      { $group: group },
      { $sort: { _id: 1 } },
    ]);
    points = docs.map(d => ({ ts: d._id, v: metrics.map((_, i) => (d[`m${i}`] ?? null)) }));
  }

  res.json({ subject, metrics, bucketMs, points });
});

// Rough storage cost, so enabling collection is an informed decision.
statsRouter.get('/_usage', requirePerm('settings.manage'), async (_req, res) => {
  try {
    const stats = await mongoose.connection.db.command({ collStats: StatSample.collection.collectionName });
    res.json({ docs: stats.count || 0, sizeBytes: stats.size || 0, storageBytes: stats.storageSize || 0 });
  } catch (e) { res.json({ docs: 0, sizeBytes: 0, storageBytes: 0, error: e.message }); }
});
