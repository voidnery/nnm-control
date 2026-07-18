import { Router } from 'express';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { PERMISSIONS, PERMISSION_KEYS } from '../permissions.js';

export const rolesRouter = Router();
rolesRouter.use(requireAuth);

// Any authenticated user may read the permission catalog (needed for UI).
rolesRouter.get('/permissions/catalog', (_req, res) => res.json(PERMISSIONS));

rolesRouter.use(requirePerm('roles.manage'));

rolesRouter.get('/', async (_req, res) => res.json(await Role.find().sort({ name: 1 })));

function sanitizePerms(perms) {
  if (!Array.isArray(perms)) return [];
  return perms.filter(p => PERMISSION_KEYS.includes(p));
}

rolesRouter.post('/', async (req, res) => {
  const { name, description = '', permissions = [] } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  if (await Role.findOne({ name })) return res.status(409).json({ error: 'role name already exists' });
  const role = await Role.create({ name, description, permissions: sanitizePerms(permissions) });
  res.status(201).json(role);
});

rolesRouter.put('/:id', async (req, res) => {
  const role = await Role.findById(req.params.id);
  if (!role) return res.status(404).json({ error: 'Not found' });
  const { name, description, permissions } = req.body || {};
  if (name) role.name = name;
  if (description !== undefined) role.description = description;
  if (permissions !== undefined) role.permissions = sanitizePerms(permissions);
  await role.save();
  res.json(role);
});

rolesRouter.delete('/:id', async (req, res) => {
  const inUse = await User.countDocuments({ roleId: req.params.id });
  if (inUse > 0) return res.status(409).json({ error: `Role is assigned to ${inUse} user(s)` });
  const role = await Role.findByIdAndDelete(req.params.id);
  if (!role) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});
