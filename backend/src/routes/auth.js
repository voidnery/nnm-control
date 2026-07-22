import { logEvent } from '../services/audit.js';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { User } from '../models/User.js';
import { requireAuth, resolvePermissions } from '../middleware/auth.js';
import { generateSecret, verifyTotp, otpauthUri } from '../services/totp.js';
import crypto from 'crypto';

async function issueSession(user, req, res) {
  const token = jwt.sign({ sub: user.id, username: user.username }, config.jwtSecret, { expiresIn: config.jwtTtl });
  const perms = await resolvePermissions(user);
  logEvent({ req, username: user.username, action: 'auth:login', outcome: 'ok', status: 200 });
  res.json({ token, user: { id: user.id, username: user.username, roleType: user.roleType, permissions: perms, preferences: user.preferences || {} } });
}

function hashBackup(code) { return bcrypt.hash(code, 10); }
function genBackupCodes(n = 10) {
  return Array.from({ length: n }, () => crypto.randomBytes(5).toString('hex').replace(/(.{5})(.{5})/, '$1-$2'));
}

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
  // Password OK. If 2FA is enabled, issue a short-lived ticket instead of a
  // session token; the client must complete /login/2fa with a TOTP or backup
  // code. The ticket is a signed JWT that grants NOTHING except step 2.
  if (user.twoFactor?.enabled) {
    const ticket = jwt.sign({ sub: user.id, twofa: true }, config.jwtSecret, { expiresIn: '5m' });
    return res.json({ twoFactorRequired: true, ticket });
  }
  await issueSession(user, req, res);
});

// Login step 2: verify TOTP (or a one-time backup code) against the ticket.
authRouter.post('/login/2fa', async (req, res) => {
  const { ticket, code } = req.body || {};
  if (!ticket || !code) return res.status(400).json({ error: 'ticket and code required' });
  let payload;
  try { payload = jwt.verify(ticket, config.jwtSecret); } catch { return res.status(401).json({ error: 'Ticket expired, log in again' }); }
  if (!payload.twofa) return res.status(401).json({ error: 'Invalid ticket' });
  const user = await User.findById(payload.sub);
  if (!user || !user.active || !user.twoFactor?.enabled) return res.status(401).json({ error: 'Invalid ticket' });

  const clean = String(code).replace(/\s/g, '');
  if (verifyTotp(user.twoFactor.secret, clean)) {
    logEvent({ req, username: user.username, action: 'auth:2fa_verify', outcome: 'ok', status: 200 });
    return issueSession(user, req, res);
  }
  // backup code path: compare against stored hashes, consume on match
  for (let i = 0; i < user.twoFactor.backupCodes.length; i++) {
    if (await bcrypt.compare(clean, user.twoFactor.backupCodes[i])) {
      user.twoFactor.backupCodes.splice(i, 1);
      user.markModified('twoFactor');
      await user.save();
      logEvent({ req, username: user.username, action: 'auth:2fa_backup_used', outcome: 'ok', status: 200, detail: { remaining: user.twoFactor.backupCodes.length } });
      return issueSession(user, req, res);
    }
  }
  logEvent({ req, username: user.username, action: 'auth:2fa_verify', outcome: 'error', status: 401 });
  res.status(401).json({ error: 'Invalid code' });
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

// ---- Two-factor (TOTP) self-management ----

// Status for the profile page.
authRouter.get('/me/2fa', requireAuth, async (req, res) => {
  res.json({
    enabled: Boolean(req.user.twoFactor?.enabled),
    backupCodesRemaining: (req.user.twoFactor?.backupCodes || []).length,
  });
});

// Step 1: generate a pending secret; return provisioning URI + secret for QR /
// manual entry. Does NOT enable 2FA yet.
authRouter.post('/me/2fa/setup', requireAuth, async (req, res) => {
  if (req.user.twoFactor?.enabled) return res.status(409).json({ error: '2FA is already enabled' });
  const secret = generateSecret();
  req.user.twoFactor = { ...(req.user.twoFactor || {}), pendingSecret: secret, enabled: false };
  req.user.markModified('twoFactor');
  await req.user.save();
  res.json({ secret, otpauth: otpauthUri(secret, req.user.username) });
});

// Step 2: verify a code against the pending secret, then enable 2FA and return
// one-time backup codes (shown once).
authRouter.post('/me/2fa/enable', requireAuth, async (req, res) => {
  const { code } = req.body || {};
  const pending = req.user.twoFactor?.pendingSecret;
  if (!pending) return res.status(400).json({ error: 'Start setup first' });
  if (!verifyTotp(pending, String(code || '').replace(/\s/g, ''))) {
    return res.status(401).json({ error: 'Code did not match — check the time on your device' });
  }
  const codes = genBackupCodes();
  req.user.twoFactor = {
    enabled: true,
    secret: pending,
    pendingSecret: '',
    backupCodes: await Promise.all(codes.map(hashBackup)),
  };
  req.user.markModified('twoFactor');
  await req.user.save();
  logEvent({ req, action: 'auth:2fa_enabled', outcome: 'ok', status: 200 });
  res.json({ ok: true, backupCodes: codes });
});

// Disable: requires current password AND a valid TOTP/backup code.
authRouter.post('/me/2fa/disable', requireAuth, async (req, res) => {
  const { password, code } = req.body || {};
  if (!password || !code) return res.status(400).json({ error: 'password and code required' });
  if (!req.user.twoFactor?.enabled) return res.status(400).json({ error: '2FA is not enabled' });
  const pwOk = await bcrypt.compare(password, req.user.passwordHash);
  if (!pwOk) return res.status(401).json({ error: 'Password is incorrect' });
  const clean = String(code).replace(/\s/g, '');
  let ok = verifyTotp(req.user.twoFactor.secret, clean);
  if (!ok) {
    for (const h of req.user.twoFactor.backupCodes) { if (await bcrypt.compare(clean, h)) { ok = true; break; } }
  }
  if (!ok) return res.status(401).json({ error: 'Invalid 2FA code' });
  req.user.twoFactor = { enabled: false, secret: '', pendingSecret: '', backupCodes: [] };
  req.user.markModified('twoFactor');
  await req.user.save();
  logEvent({ req, action: 'auth:2fa_disabled', outcome: 'ok', status: 200 });
  res.json({ ok: true });
});

// Regenerate backup codes (requires a valid TOTP code).
authRouter.post('/me/2fa/backup-codes', requireAuth, async (req, res) => {
  if (!req.user.twoFactor?.enabled) return res.status(400).json({ error: '2FA is not enabled' });
  if (!verifyTotp(req.user.twoFactor.secret, String(req.body?.code || '').replace(/\s/g, ''))) {
    return res.status(401).json({ error: 'Invalid 2FA code' });
  }
  const codes = genBackupCodes();
  req.user.twoFactor.backupCodes = await Promise.all(codes.map(hashBackup));
  req.user.markModified('twoFactor');
  await req.user.save();
  logEvent({ req, action: 'auth:2fa_backup_regen', outcome: 'ok', status: 200 });
  res.json({ ok: true, backupCodes: codes });
});
