import { Router } from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { StreamTag } from '../models/StreamTag.js';
import { logEvent } from '../services/audit.js';

export const streamTagsRouter = Router();
streamTagsRouter.use(requireAuth);

const norm = (arr) => Array.from(new Set((Array.isArray(arr) ? arr : [])
  .map(x => String(x).trim()).filter(Boolean))).slice(0, 50);

// All tag records for a server → map "kind:objId" -> tags[], plus a catalog of
// distinct tags on that server (for filter chips / autocomplete).
streamTagsRouter.get('/:serverId', requirePerm('wmsobjects.view'), async (req, res) => {
  const rows = await StreamTag.find({ serverId: req.params.serverId });
  const map = {};
  const catalog = new Set();
  for (const r of rows) {
    if (r.tags.length) map[`${r.kind}:${r.objId}`] = r.tags;
    r.tags.forEach(t => catalog.add(t));
  }
  res.json({ map, catalog: Array.from(catalog).sort((a, b) => a.localeCompare(b)) });
});

// Replace the tag list for one object. Panel-only write → no WMSPanel call,
// so the stream is never reloaded.
streamTagsRouter.put('/:serverId/:kind/:objId', requirePerm('wmsobjects.manage'), async (req, res) => {
  const { serverId, kind, objId } = req.params;
  const tags = norm(req.body?.tags);
  const doc = await StreamTag.findOneAndUpdate(
    { serverId, kind, objId },
    { $set: { tags } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  logEvent({ req, action: 'streamtag:set', target: `${kind}/${objId}`, outcome: 'ok', status: 200 });
  res.json({ kind, objId, tags: doc.tags });
});
