import { logEvent } from '../services/audit.js';
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
  if (!user || !user.active) {
    logEvent({ req, username, action: 'auth:login', outcome: 'error', status: 401, detail: { reason: 'unknown or inactive user' } });
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    logEvent({ req, username, action: 'auth:login', outcome: 'error', status: 401, detail: { reason: 'bad password' } });
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ sub: user.id, username: user.username }, config.jwtSecret, { expiresIn: config.jwtTtl });
  const perms = await resolvePermissions(user);
  logEvent({ req, username: user.username, action: 'auth:login', outcome: 'ok', status: 200 });
  res.json({ token, user: { id: user.id, username: user.username, roleType: user.roleType, permissions: perms } });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, roleType: req.user.roleType, permissions: req.perms, preferences: req.user.preferences || {} });
});

// Self-service: update own UI preferences.
authRouter.put('/me/preferences', requireAuth, async (req, res) => {
  const { theme, lang, functionModalWidth } = req.body || {};
  const p = req.user.preferences || {};
  if (theme !== undefined) {
    if (!['system', 'dark', 'light'].includes(theme)) return res.status(400).json({ error: 'bad theme' });
    p.theme = theme;
  }
  if (lang !== undefined) {
    if (!['en', 'ru'].includes(lang)) return res.status(400).json({ error: 'bad lang' });
    p.lang = lang;
  }
  if (functionModalWidth !== undefined) {
    if (!['narrow', 'default', 'wide', 'xwide'].includes(functionModalWidth)) return res.status(400).json({ error: 'bad width' });
    p.functionModalWidth = functionModalWidth;
  }
  req.user.preferences = p;
  req.user.markModified('preferences');
  await req.user.save();
  res.json({ preferences: req.user.preferences });
});

// Self-service: change own password (requires current password).
authRouter.post('/me/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword and newPassword required' });
  if (String(newPassword).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const ok = await bcrypt.compare(currentPassword, req.user.passwordHash);
  if (!ok) {
    logEvent({ req, action: 'auth:password_change', outcome: 'error', status: 401, detail: { reason: 'wrong current password' } });
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  req.user.passwordHash = await bcrypt.hash(newPassword, 10);
  await req.user.save();
  logEvent({ req, action: 'auth:password_change', outcome: 'ok', status: 200 });
  res.json({ ok: true });
});
