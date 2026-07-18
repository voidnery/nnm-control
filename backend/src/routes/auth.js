import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { User } from '../models/User.js';
import { requireAuth, resolvePermissions } from '../middleware/auth.js';

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const user = await User.findOne({ username });
  if (!user || !user.active) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ sub: user.id, username: user.username }, config.jwtSecret, { expiresIn: config.jwtTtl });
  const perms = await resolvePermissions(user);
  res.json({ token, user: { id: user.id, username: user.username, roleType: user.roleType, permissions: perms } });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, roleType: req.user.roleType, permissions: req.perms });
});
