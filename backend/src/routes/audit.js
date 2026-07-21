import { Router } from 'express';
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
