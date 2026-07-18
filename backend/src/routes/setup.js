import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { User } from '../models/User.js';
import { config } from '../config.js';

// First-run setup: superadmin is created from the web UI on first open.
// Guarded by SETUP_TOKEN generated at install time and printed in the CLI.
export const setupRouter = Router();

setupRouter.get('/status', async (_req, res) => {
  const exists = await User.exists({ roleType: 'superadmin' });
  res.json({ needsSetup: !exists });
});

// Constant-time-ish token comparison.
function tokenOk(given) {
  if (!config.setupToken || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(config.setupToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

setupRouter.post('/', async (req, res) => {
  if (await User.exists({ roleType: 'superadmin' })) {
    return res.status(409).json({ error: 'Setup already completed' });
  }
  const { token, username, password } = req.body || {};
  if (!tokenOk(token)) return res.status(403).json({ error: 'Invalid setup token' });
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const user = await User.create({
    username: String(username).trim(),
    passwordHash: await bcrypt.hash(password, 10),
    roleType: 'superadmin',
    active: true,
  });
  res.status(201).json({ ok: true, username: user.username });
});
