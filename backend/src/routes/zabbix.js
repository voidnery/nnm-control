import { Router } from 'express';
import os from 'node:os';
import fs from 'node:fs/promises';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { Settings } from '../models/Settings.js';
import { FunctionDef } from '../models/FunctionDef.js';
import { FunctionRun } from '../models/FunctionRun.js';
import { createRequire } from 'node:module';
const require0 = createRequire(import.meta.url);
const PKG_VERSION = (() => { try { return require0('../../package.json').version; } catch { return 'unknown'; } })();

// Token-protected plain endpoints for Zabbix HTTP Agent items.
// Auth: ?token=... or header X-Zabbix-Token. Static token from .env.
export const zabbixRouter = Router();

zabbixRouter.use((req, res, next) => {
  const token = req.query.token || req.headers['x-zabbix-token'];
  if (!config.zabbixToken || token !== config.zabbixToken) {
    return res.status(401).json({ error: 'Invalid zabbix token' });
  }
  next();
});

// Panel status — one item covering the whole control plane health.
zabbixRouter.get('/panel', async (_req, res) => {
  const settings = await Settings.load();
  const servers = await NimbleServer.find().lean();
  const mapped = servers.filter(s => s.wmspanelServerId);
  const lastSync = mapped.reduce((max, s) => (s.lastSyncAt && (!max || s.lastSyncAt > max)) ? s.lastSyncAt : max, null);
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
  const [functionsTotal, runsOk, runsBad, runsRunning] = await Promise.all([
    FunctionDef.countDocuments(),
    FunctionRun.countDocuments({ startedAt: { $gte: dayAgo }, status: 'success' }),
    FunctionRun.countDocuments({ startedAt: { $gte: dayAgo }, status: { $in: ['rolled_back', 'rollback_failed', 'preflight_failed'] } }),
    FunctionRun.countDocuments({ status: 'running' }),
  ]);
  res.json({
    app: 'nnm-control',
    version: PKG_VERSION,
    status: 'ok',
    uptime_sec: Math.round(process.uptime()),
    mongo_connected: mongoose.connection.readyState === 1 ? 1 : 0,
    control_plane: settings.controlPlane,
    wmspanel_configured: settings.wmspanel.clientId && settings.wmspanel.apiKey ? 1 : 0,
    servers_total: servers.length,
    servers_mapped: mapped.length,
    // Age of the freshest fleet sync; in wmspanel mode this growing beyond
    // ~15 min means sync (and likely the WMSPanel link) is unhealthy.
    fleet_sync_age_sec: lastSync ? Math.round((Date.now() - new Date(lastSync).getTime()) / 1000) : -1,
    functions_total: functionsTotal,
    runs_24h_success: runsOk,
    runs_24h_failed: runsBad,
    runs_running: runsRunning,
  });
});

// Application-level metrics.
zabbixRouter.get('/app', async (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    app: 'nnm-control',
    uptime_sec: Math.round(process.uptime()),
    node_version: process.version,
    rss_bytes: mem.rss,
    heap_used_bytes: mem.heapUsed,
    heap_total_bytes: mem.heapTotal,
    mongo_connected: mongoose.connection.readyState === 1 ? 1 : 0,
    managed_servers: await NimbleServer.countDocuments().catch(() => -1),
  });
});

// Machine-level metrics. Disk is read from the read-only host mount (HOST_FS)
// so numbers reflect the HOST filesystem, not the container overlay.
zabbixRouter.get('/system', async (_req, res) => {
  const load = os.loadavg();
  let disk = null;
  try {
    const st = await fs.statfs(config.hostFs);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    disk = {
      total_bytes: total,
      free_bytes: free,
      used_bytes: total - free,
      used_percent: total ? Math.round(((total - free) / total) * 1000) / 10 : 0,
    };
  } catch (e) {
    disk = { error: e.message };
  }
  res.json({
    hostname: os.hostname(),
    uptime_sec: Math.round(os.uptime()),
    cpu_cores: os.cpus().length,
    load_1m: load[0], load_5m: load[1], load_15m: load[2],
    mem_total_bytes: os.totalmem(),
    mem_free_bytes: os.freemem(),
    mem_used_percent: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 1000) / 10,
    disk_root: disk,
  });
});
