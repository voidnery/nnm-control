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

// ---- vocabulary-level CRUD (all objects of one kind on one server) ----
// Kept under /vocab/ so a tag name can never be mistaken for an object id.

// Rename a tag everywhere it is used on this kind.
streamTagsRouter.post('/:serverId/vocab/:kind/rename', requirePerm('wmsobjects.manage'), async (req, res) => {
  const { serverId, kind } = req.params;
  const from = String(req.body?.from || '').trim();
  const to = String(req.body?.to || '').trim();
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
  if (from === to) return res.json({ updated: 0 });

  const rows = await StreamTag.find({ serverId, kind, tags: from });
  let updated = 0;
  for (const r of rows) {
    // Rename, then de-duplicate in case the target tag was already present.
    const next = Array.from(new Set(r.tags.map(t => (t === from ? to : t))));
    r.tags = next;
    await r.save();
    updated++;
  }
  logEvent({ req, action: 'streamtag:rename', target: `${kind} "${from}"→"${to}" (${updated})`, outcome: 'ok', status: 200 });
  res.json({ updated });
});

// Remove a tag from every object of this kind.
streamTagsRouter.post('/:serverId/vocab/:kind/delete', requirePerm('wmsobjects.manage'), async (req, res) => {
  const { serverId, kind } = req.params;
  const tag = String(req.body?.tag || '').trim();
  if (!tag) return res.status(400).json({ error: 'tag is required' });
  const result = await StreamTag.updateMany({ serverId, kind, tags: tag }, { $pull: { tags: tag } });
  const updated = result.modifiedCount ?? result.nModified ?? 0;
  logEvent({ req, action: 'streamtag:delete', target: `${kind} "${tag}" (${updated})`, outcome: 'ok', status: 200 });
  res.json({ updated });
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
