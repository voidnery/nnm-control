import { Router } from 'express';
import { Settings } from '../models/Settings.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { wmspanel } from '../services/wmspanelClient.js';
import { syncServersFromWmspanel } from '../services/wmspanelSync.js';

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

// Public subset for any authenticated user (UI needs the active control plane).
settingsRouter.get('/public', async (_req, res) => {
  const s = await Settings.load();
  res.json({ controlPlane: s.controlPlane, wmspanelConfigured: Boolean(s.wmspanel.clientId && s.wmspanel.apiKey) });
});

settingsRouter.use(requirePerm('settings.manage'));

const pub = (s) => ({
  controlPlane: s.controlPlane,
  wmspanel: {
    baseUrl: s.wmspanel.baseUrl,
    clientId: s.wmspanel.clientId,
    hasApiKey: Boolean(s.wmspanel.apiKey),
  },
});

settingsRouter.get('/', async (_req, res) => res.json(pub(await Settings.load())));

settingsRouter.put('/', async (req, res) => {
  const s = await Settings.load();
  const { controlPlane, wmspanel: wp } = req.body || {};
  if (controlPlane !== undefined) {
    if (!['wmspanel', 'native'].includes(controlPlane)) return res.status(400).json({ error: 'controlPlane must be wmspanel or native' });
    if (controlPlane === 'wmspanel' && !( (wp?.clientId ?? s.wmspanel.clientId) && (wp?.apiKey ?? s.wmspanel.apiKey) )) {
      return res.status(400).json({ error: 'Set WMSPanel credentials before enabling wmspanel control plane' });
    }
    s.controlPlane = controlPlane;
  }
  if (wp) {
    if (wp.baseUrl !== undefined) {
      const url = String(wp.baseUrl).trim();
      if (!/^https:\/\/[^\s]+$/.test(url)) return res.status(400).json({ error: 'baseUrl must be an https:// URL' });
      s.wmspanel.baseUrl = url.replace(/\/+$/, '');
    }
    if (wp.clientId !== undefined) s.wmspanel.clientId = String(wp.clientId).trim();
    // apiKey: undefined = keep, '' = clear, string = replace
    if (wp.apiKey !== undefined) s.wmspanel.apiKey = String(wp.apiKey);
  }
  await s.save();
  // Entering wmspanel control plane => pull the fleet right away (best-effort).
  let sync = null;
  if (s.controlPlane === 'wmspanel') {
    try { sync = await syncServersFromWmspanel(); }
    catch (e) { sync = { skipped: true, reason: e.message }; }
  }
  res.json({ ...pub(s), sync });
});

// Live connectivity test: lists WMSPanel servers with current (or provided) creds.
settingsRouter.post('/wmspanel/test', async (req, res) => {
  const s = await Settings.load();
  const cfg = {
    baseUrl: req.body?.baseUrl || s.wmspanel.baseUrl,
    clientId: req.body?.clientId || s.wmspanel.clientId,
    apiKey: req.body?.apiKey || s.wmspanel.apiKey,
  };
  try {
    const data = await wmspanel.listServers(cfg);
    res.json({ ok: true, servers: data.servers || [] });
  } catch (e) {
    res.json({ ok: false, error: e.message, upstream: e.data ?? null });
  }
});
