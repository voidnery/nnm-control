import { Router } from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { Playlist } from '../models/Playlist.js';
import { logEvent } from '../services/audit.js';

export const playlistsRouter = Router();
playlistsRouter.use(requireAuth);

const pub = (p) => ({
  id: p.id, name: p.name, description: p.description,
  model: p.model, updatedBy: p.updatedBy, updatedAt: p.updatedAt, createdAt: p.createdAt,
});

// List (view permission) — returns metadata + model (small enough).
playlistsRouter.get('/', requirePerm('playlist.view'), async (_req, res) => {
  const items = await Playlist.find().sort({ updatedAt: -1 });
  res.json(items.map(pub));
});

playlistsRouter.get('/:id', requirePerm('playlist.view'), async (req, res) => {
  const p = await Playlist.findById(req.params.id);
  if (!p) return res.status(404).json({ error: 'Playlist not found' });
  res.json(pub(p));
});

playlistsRouter.use(requirePerm('playlist.manage'));

playlistsRouter.post('/', async (req, res) => {
  const { name, description, model } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  const p = await Playlist.create({
    name: String(name).trim(),
    description: String(description || ''),
    model: model || undefined,
    updatedBy: req.user.username,
  });
  logEvent({ req, action: 'playlist:create', target: p.name, outcome: 'ok', status: 201 });
  res.status(201).json(pub(p));
});

playlistsRouter.put('/:id', async (req, res) => {
  const p = await Playlist.findById(req.params.id);
  if (!p) return res.status(404).json({ error: 'Playlist not found' });
  const { name, description, model } = req.body || {};
  if (name !== undefined) p.name = String(name).trim();
  if (description !== undefined) p.description = String(description);
  if (model !== undefined) p.model = model;
  p.updatedBy = req.user.username;
  await p.save();
  logEvent({ req, action: 'playlist:update', target: p.name, outcome: 'ok', status: 200 });
  res.json(pub(p));
});

playlistsRouter.delete('/:id', async (req, res) => {
  const p = await Playlist.findById(req.params.id);
  if (!p) return res.status(404).json({ error: 'Playlist not found' });
  await p.deleteOne();
  logEvent({ req, action: 'playlist:delete', target: p.name, outcome: 'ok', status: 200 });
  res.json({ ok: true });
});
