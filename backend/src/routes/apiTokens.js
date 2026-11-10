import { Router } from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { ApiToken } from '../models/ApiToken.js';
import { logEvent } from '../services/audit.js';
import { generateToken, grantable, cidrList, publicToken } from '../services/apiTokens.js';

// Issuing and revoking API tokens from the panel (nnm-api/1 §2.2). The token is returned ONCE, in the
// answer to its creation; the panel never shows it again and keeps only its hash.
export const apiTokensRouter = Router();
apiTokensRouter.use(requireAuth);
apiTokensRouter.use(requirePerm('apitokens.manage'));

apiTokensRouter.get('/', async (_req, res) => {
  const list = await ApiToken.find().sort({ createdAt: -1 });
  res.json(list.map(publicToken));
});

apiTokensRouter.post('/', async (req, res) => {
  const { name, permissions, allowCidrs = [], expiresInDays = null } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'name required', code: 'name_required' });
  const g = grantable(permissions, req.perms);
  if (!g.ok) {
    return res.status(422).json({
      error: g.reason || `these permissions cannot be put into a token: ${g.refused.join(', ')}`,
      code: 'permissions_refused', refused: g.refused,
    });
  }
  const cidrs = (Array.isArray(allowCidrs) ? allowCidrs : []).map(String).filter(s => s.trim());
  const bad = cidrList(cidrs).bad;
  if (bad.length) return res.status(422).json({ error: `not an address or a CIDR range: ${bad.join(', ')}`, code: 'bad_cidr' });
  const days = expiresInDays === null || expiresInDays === '' ? null : Number(expiresInDays);
  if (days !== null && !(Number.isInteger(days) && days > 0 && days <= 3650)) {
    return res.status(422).json({ error: 'expiry is a whole number of days, 1–3650, or none', code: 'bad_expiry' });
  }
  const gen = generateToken();
  const t = await ApiToken.create({
    name: String(name).trim(), tokenId: gen.tokenId, secretHash: gen.secretHash,
    permissions: g.permissions, allowCidrs: cidrs,
    expiresAt: days ? new Date(Date.now() + days * 86400000) : null,
    createdBy: req.user.username,
  });
  logEvent({ req, action: 'apitoken:create', target: `${t.name}#${t.tokenId}`, detail: { permissions: t.permissions }, outcome: 'ok', status: 201 });
  // `token` is in this one response and nowhere else.
  res.status(201).json({ ...publicToken(t), token: gen.raw });
});

apiTokensRouter.post('/:id/revoke', async (req, res) => {
  const t = await ApiToken.findById(req.params.id).catch(() => null);
  if (!t) return res.status(404).json({ error: 'token not found', code: 'not_found' });
  if (!t.revokedAt) { t.revokedAt = new Date(); await t.save(); }
  logEvent({ req, action: 'apitoken:revoke', target: `${t.name}#${t.tokenId}`, outcome: 'ok', status: 200 });
  res.json(publicToken(t));
});
