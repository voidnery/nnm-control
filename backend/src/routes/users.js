import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { Role } from '../models/Role.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';

export const usersRouter = Router();
usersRouter.use(requireAuth, requirePerm('users.manage'));

const pub = (u) => ({
  id: u.id, username: u.username, roleType: u.roleType,
  roleId: u.roleId, active: u.active, createdAt: u.createdAt,
});

usersRouter.get('/', async (_req, res) => {
  const users = await User.find().sort({ createdAt: 1 });
  res.json(users.map(pub));
});

usersRouter.post('/', async (req, res) => {
  const { username, password, roleType, roleId } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (!['admin', 'custom'].includes(roleType)) return res.status(400).json({ error: 'roleType must be admin or custom' });
  // Only superadmin may create admins.
  if (roleType === 'admin' && req.user.roleType !== 'superadmin') {
    return res.status(403).json({ error: 'Only superadmin can create admins' });
  }
  if (roleType === 'custom') {
    if (!roleId || !(await Role.findById(roleId))) return res.status(400).json({ error: 'valid roleId required for custom role' });
  }
  if (await User.findOne({ username })) return res.status(409).json({ error: 'username already exists' });
  const user = await User.create({
    username,
    passwordHash: await bcrypt.hash(password, 10),
    roleType,
    roleId: roleType === 'custom' ? roleId : null,
  });
  res.status(201).json(pub(user));
});

usersRouter.put('/:id', async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  // The superadmin account can only be modified by the superadmin themself,
  // and its role can never change.
  if (target.roleType === 'superadmin' && req.user.id !== target.id) {
    return res.status(403).json({ error: 'Superadmin account is protected' });
  }
  const { password, roleType, roleId, active } = req.body || {};
  if (target.roleType !== 'superadmin') {
    if (roleType && ['admin', 'custom'].includes(roleType)) {
      if (roleType === 'admin' && req.user.roleType !== 'superadmin') {
        return res.status(403).json({ error: 'Only superadmin can grant admin' });
      }
      target.roleType = roleType;
      target.roleId = roleType === 'custom' ? (roleId || target.roleId) : null;
    } else if (roleId !== undefined && target.roleType === 'custom') {
      target.roleId = roleId;
    }
    if (active !== undefined) target.active = Boolean(active);
  }
  if (password) target.passwordHash = await bcrypt.hash(password, 10);
  await target.save();
  res.json(pub(target));
});

usersRouter.delete('/:id', async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  if (target.roleType === 'superadmin') return res.status(403).json({ error: 'Superadmin cannot be deleted' });
  if (target.roleType === 'admin' && req.user.roleType !== 'superadmin') {
    return res.status(403).json({ error: 'Only superadmin can delete admins' });
  }
  await target.deleteOne();
  res.json({ ok: true });
});
