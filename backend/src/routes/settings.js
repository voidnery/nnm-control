import { Router } from 'express';
import { Settings } from '../models/Settings.js';
import { restartStatsCollector } from '../services/statsCollector.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { wmspanel } from '../services/wmspanelClient.js';
import { syncServersFromWmspanel } from '../services/wmspanelSync.js';

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

// Public subset for any authenticated user (UI needs the active control plane).
settingsRouter.get('/public', async (_req, res) => {
  const s = await Settings.load();
  res.json({ controlPlane: s.controlPlane, wmspanelConfigured: Boolean(s.wmspanel.clientId && s.wmspanel.apiKey), srtHelperEnabled: s.srtHelperEnabled !== false });
});

settingsRouter.use(requirePerm('settings.manage'));

const pub = (s) => ({
  controlPlane: s.controlPlane,
  srtHelperEnabled: s.srtHelperEnabled !== false,
  stats: {
    enabled: Boolean(s.stats?.enabled),
    intervalSec: s.stats?.intervalSec ?? 10,
    retentionDays: s.stats?.retentionDays ?? 3,
    groups: {
      streams: s.stats?.groups?.streams !== false,
      republish: s.stats?.groups?.republish !== false,
      srt: s.stats?.groups?.srt !== false,
      server: s.stats?.groups?.server !== false,
    },
  },
  wmspanel: {
    baseUrl: s.wmspanel.baseUrl,
    clientId: s.wmspanel.clientId,
    hasApiKey: Boolean(s.wmspanel.apiKey),
  },
});

settingsRouter.get('/', async (_req, res) => res.json(pub(await Settings.load())));

settingsRouter.put('/', async (req, res) => {
  const s = await Settings.load();
  const { controlPlane, wmspanel: wp, srtHelperEnabled, stats } = req.body || {};
  if (controlPlane !== undefined) {
    if (!['wmspanel', 'native'].includes(controlPlane)) return res.status(400).json({ error: 'controlPlane must be wmspanel or native' });
    if (controlPlane === 'wmspanel' && !( (wp?.clientId ?? s.wmspanel.clientId) && (wp?.apiKey ?? s.wmspanel.apiKey) )) {
      return res.status(400).json({ error: 'Set WMSPanel credentials before enabling wmspanel control plane' });
    }
    s.controlPlane = controlPlane;
  }
  if (srtHelperEnabled !== undefined) s.srtHelperEnabled = Boolean(srtHelperEnabled);
  let statsChanged = false;
  if (stats !== undefined) {
    s.stats = s.stats || {};
    if (stats.enabled !== undefined) s.stats.enabled = Boolean(stats.enabled);
    if (stats.intervalSec !== undefined) s.stats.intervalSec = Math.min(600, Math.max(5, Number(stats.intervalSec) || 10));
    if (stats.retentionDays !== undefined) s.stats.retentionDays = Math.min(30, Math.max(1, Number(stats.retentionDays) || 3));
    if (stats.groups) {
      s.stats.groups = s.stats.groups || {};
      for (const g of ['streams', 'republish', 'srt', 'server']) {
        if (stats.groups[g] !== undefined) s.stats.groups[g] = Boolean(stats.groups[g]);
      }
    }
    s.markModified('stats');
    statsChanged = true;
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
  if (statsChanged) await restartStatsCollector();
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
